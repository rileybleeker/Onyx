import DeviceActivity
import Foundation
import UIKit

enum SyncError: LocalizedError {
    case noToken
    case badURL(String)
    case server(Int, String)

    var errorDescription: String? {
        switch self {
        case .noToken: return "No Onyx token saved. Open the app and paste it once."
        case .badURL(let url): return "Bad Onyx URL: \(url)"
        case .server(let code, let body): return "Onyx answered \(code): \(body)"
        }
    }
}

/// Where a sync broke, as reported to Onyx (FAILURE_STAGES in
/// frontend/src/app/api/screen-time/usage/route.ts).
enum SyncStage: String {
    case access     // Screen Time data access is not granted
    case read       // the DeviceActivity export failed or returned nothing
    case encode     // the JSON body could not be built
    case network    // no answer from Onyx (offline, DNS, TLS, timeout)
    case http       // Onyx answered with an error it did not log itself
}

enum SyncService {
    /// Hours per request — keeps each POST well under the route's limits.
    private static let chunkSize = 168
    /// A failure report has to fit in what is left of a background run
    /// (Apple allows an intent about 30 s; the export itself may use 25).
    private static let reportTimeout: TimeInterval = 4

    static var appVersion: String {
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String ?? "?"
        let build = info?["CFBundleVersion"] as? String ?? "?"
        return "\(version) (\(build))"
    }

    static func encoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }

    static func payload(for result: ExportResult, segments: [UsageSegment], run: RunInfo? = nil) -> UsagePayload {
        UsagePayload(
            device: "iphone",
            device_name: result.deviceName,
            device_model: result.deviceModel,
            app_version: appVersion,
            generated_at: Date(),
            segments: segments,
            run: run
        )
    }

    /// How many requests a run of `segments` hours takes.
    static func chunkCount(for segments: Int) -> Int {
        max(1, (segments + chunkSize - 1) / chunkSize)
    }

    /// The completeness metadata of one chunk. The whole run shares runID, window and stream_ended.
    static func runInfo(_ result: ExportResult, runID: String, chunkIndex: Int, chunkCount: Int) -> RunInfo {
        RunInfo(
            run_id: runID,
            window_start: result.windowStart,
            window_end: result.windowEnd,
            source_updated_at: result.sourceUpdatedAt,
            stream_ended: result.streamEnded,
            segment_count: result.segments.count,
            chunk_index: chunkIndex,
            chunk_count: chunkCount
        )
    }

    /// The run status Onyx answered for the last chunk ("complete", "stream_open", "receiving", ...).
    static func completeness(_ data: Data) -> String? {
        guard let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
        return object["completeness"] as? String
    }

    /// How far Onyx says the run is current (Apple's own last update can be older than the export time).
    static func coveredThrough(_ data: Data) -> Date? {
        guard let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let text = object["covered_through"] as? String else { return nil }
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return withFraction.date(from: text) ?? ISO8601DateFormatter().date(from: text)
    }

    /// Reads the last `days` days from Screen Time and sends them to Onyx.
    /// Returns a one-line summary (shown in the app and as the Shortcut result).
    ///
    /// A failure after the token check is also reported to Onyx (reportFailure)
    /// before the error is rethrown, so /status goes red on the same run. A
    /// missing token, a bad URL or a refused token (401/403) cannot be reported:
    /// those still surface only when the last heartbeat ages out (36 h).
    @discardableResult
    static func sync(days: Int, policy: DeviceActivityData.Policy = .live) async throws -> String {
        guard let token = Settings.token else { throw SyncError.noToken }
        guard let url = URL(string: Settings.baseURL + "/api/screen-time/usage"), url.scheme == "https" else {
            throw SyncError.badURL(Settings.baseURL)
        }

        let result: ExportResult
        do {
            result = try await ScreenTimeExporter.fetch(days: days, policy: policy)
        } catch {
            let denied = (error as? ExportError)?.isAccessDenied ?? false
            await reportFailure(denied ? .access : .read, error.localizedDescription, token: token, url: url)
            throw error
        }

        // One run id per sync: a retry is a new run, so a half-sent run is never completed by another.
        let runID = UUID().uuidString.lowercased()
        let chunks = chunkCount(for: result.segments.count)
        var chunkIndex = 0
        var lastCompleteness: String?
        var lastCoveredThrough: Date?
        var sent = 0
        var index = 0
        while index < result.segments.count {
            let chunk = Array(result.segments[index..<min(index + chunkSize, result.segments.count)])
            let run = runInfo(result, runID: runID, chunkIndex: chunkIndex, chunkCount: chunks)
            var request = URLRequest(url: url, timeoutInterval: 30)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue(token, forHTTPHeaderField: "x-onyx-ci-token")
            do {
                request.httpBody = try encoder().encode(payload(for: result, segments: chunk, run: run))
            } catch {
                await reportFailure(.encode, error.localizedDescription, token: token, url: url)
                throw error
            }

            let reply: (Data, URLResponse)
            do {
                reply = try await URLSession.shared.data(for: request)
            } catch {
                let progress = "after \(sent) of \(result.segments.count) hours"
                await reportFailure(.network, "\(error.localizedDescription) (\(progress))", token: token, url: url)
                throw error
            }
            let (data, response) = reply
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard code == 200 else {
                let body = String(String(data: data, encoding: .utf8)?.prefix(300) ?? "")
                // 401/403: the token was refused, so a report would be refused too.
                // A route error that answers "logged": true is already in sync_log.
                if code != 401 && code != 403 && !serverLogged(data) {
                    let progress = "after \(sent) of \(result.segments.count) hours"
                    await reportFailure(.http, "HTTP \(code) \(progress): \(body.prefix(120))", token: token, url: url)
                }
                throw SyncError.server(code, body)
            }
            lastCompleteness = completeness(data)
            lastCoveredThrough = coveredThrough(data)
            sent += chunk.count
            index += chunkSize
            chunkIndex += 1
        }

        let summary = describe(result, sent: sent, completeness: lastCompleteness, coveredThrough: lastCoveredThrough)
        Settings.lastSync = Date()
        Settings.lastSummary = summary
        return summary
    }

    /// Best effort, never throws: posts `{ failure: { stage, message } }` to the
    /// usage route, which writes a failed screen_time|usage heartbeat. If this
    /// request fails too (offline), the age-out on /status still catches it.
    static func reportFailure(_ stage: SyncStage, _ message: String, token: String, url: URL) async {
        let report = FailureReport(
            device: "iphone",
            app_version: appVersion,
            failure: FailureReport.Failure(stage: stage.rawValue, message: String(message.prefix(300)))
        )
        guard let body = try? encoder().encode(report) else { return }
        var request = URLRequest(url: url, timeoutInterval: reportTimeout)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(token, forHTTPHeaderField: "x-onyx-ci-token")
        request.httpBody = body
        _ = try? await URLSession.shared.data(for: request)
    }

    /// The route answers `"logged": true` when it already wrote the failed heartbeat.
    static func serverLogged(_ data: Data) -> Bool {
        guard let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return false }
        return (object["logged"] as? Bool) == true
    }

    static func describe(_ result: ExportResult, sent: Int?, completeness: String? = nil, coveredThrough: Date? = nil) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "MMM d HH:mm"
        let from = result.firstStart.map(formatter.string) ?? "?"
        let to = result.lastEnd.map(formatter.string) ?? "?"
        let hours = String(format: "%.1f", result.totalMinutes / 60)
        let head = sent.map { "Sent \($0) hours" } ?? "Read \(result.segments.count) hours"
        return "\(head) (\(from) → \(to)), \(hours) h of screen time"
            + (result.streamEnded ? "" : (result.streamFailed ? " [stream failed before it ended]" : " [stream stopped by watchdog]"))
            + completenessNote(completeness, coveredThrough: coveredThrough)
    }

    /// What Onyx made of the run, in words (nil: not sent, or an Onyx version that does not answer it).
    static func completenessNote(_ status: String?, coveredThrough: Date? = nil) -> String {
        switch status {
        case "complete"?:
            guard let through = coveredThrough else { return " · verified complete" }
            let formatter = DateFormatter()
            formatter.dateFormat = "MMM d HH:mm"
            return " · verified complete through \(formatter.string(from: through))"
        case "stream_open"?: return " · not verified: the stream did not end"
        case "receiving"?: return " · not verified: a chunk is missing"
        case "inconsistent"?: return " · not verified: the chunks disagree"
        case .some: return " · not verified"
        case .none: return ""
        }
    }
}
