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

enum SyncService {
    /// Hours per request — keeps each POST well under the route's limits.
    private static let chunkSize = 168

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
    @discardableResult
    static func sync(days: Int, policy: DeviceActivityData.Policy = .live) async throws -> String {
        guard let token = Settings.token else { throw SyncError.noToken }
        guard let url = URL(string: Settings.baseURL + "/api/screen-time/usage"), url.scheme == "https" else {
            throw SyncError.badURL(Settings.baseURL)
        }

        let result = try await ScreenTimeExporter.fetch(days: days, policy: policy)

        var sent = 0
        var index = 0
        while index < result.segments.count {
            let chunk = Array(result.segments[index..<min(index + chunkSize, result.segments.count)])
            var request = URLRequest(url: url, timeoutInterval: 30)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue(token, forHTTPHeaderField: "x-onyx-ci-token")
            request.httpBody = try encoder().encode(payload(for: result, segments: chunk))

            let (data, response) = try await URLSession.shared.data(for: request)
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard code == 200 else {
                throw SyncError.server(code, String(String(data: data, encoding: .utf8)?.prefix(300) ?? ""))
            }
            sent += chunk.count
            index += chunkSize
        }

        let summary = describe(result, sent: sent)
        Settings.lastSync = Date()
        Settings.lastSummary = summary
        return summary
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
