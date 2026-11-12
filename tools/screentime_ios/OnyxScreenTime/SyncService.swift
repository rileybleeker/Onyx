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

    static func payload(for result: ExportResult, segments: [UsageSegment]) -> UsagePayload {
        UsagePayload(
            device: "iphone",
            device_name: result.deviceName,
            device_model: result.deviceModel,
            app_version: appVersion,
            generated_at: Date(),
            segments: segments
        )
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

        var sent = 0
        var index = 0
        while index < result.segments.count {
            let chunk = Array(result.segments[index..<min(index + chunkSize, result.segments.count)])
            var request = URLRequest(url: url, timeoutInterval: 30)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue(token, forHTTPHeaderField: "x-onyx-ci-token")
            do {
                request.httpBody = try encoder().encode(payload(for: result, segments: chunk))
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
            sent += chunk.count
            index += chunkSize
        }

        let summary = describe(result, sent: sent)
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

    static func describe(_ result: ExportResult, sent: Int?) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "MMM d HH:mm"
        let from = result.firstStart.map(formatter.string) ?? "?"
        let to = result.lastEnd.map(formatter.string) ?? "?"
        let hours = String(format: "%.1f", result.totalMinutes / 60)
        let head = sent.map { "Sent \($0) hours" } ?? "Read \(result.segments.count) hours"
        return "\(head) (\(from) → \(to)), \(hours) h of screen time"
            + (result.streamEnded ? "" : " [stream stopped by watchdog]")
    }
}
