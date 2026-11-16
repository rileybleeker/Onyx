import Foundation

// Wire format for POST /api/screen-time/usage (frontend/src/app/api/screen-time/usage/route.ts).
// Field names are snake_case on purpose — they are the JSON keys the route reads.

struct UsageItem: Codable {
    let kind: String            // "app" | "web"
    let identifier: String      // bundle id | web domain
    let name: String?
    let category: String?
    var seconds: Double
    var pickups: Int?
    var notifications: Int?
}

struct UsageSegment: Codable {
    let start: Date
    let end: Date
    let total_seconds: Double
    let first_pickup: Date?
    let pickups_without_app: Int
    let longest_start: Date?
    let longest_end: Date?
    let items: [UsageItem]
}

/// Completeness of the export a chunk belongs to (PIPE-11; frontend/src/lib/screen-time-upload.ts).
/// Every chunk of one sync carries the same run_id, window and stream_ended. Onyx marks the run's
/// hours verified only when every chunk arrived and stream_ended is true; a watchdog stop, a failed
/// chunk or an app stopped halfway leaves them unverified (not counted as complete days).
struct RunInfo: Codable {
    let run_id: String          // one UUID per sync run
    let window_start: Date      // the start of the window asked for (local midnight, days back)
    let window_end: Date        // when the export was read
    let stream_ended: Bool      // false = stopped by the idle/timeout watchdog
    let segment_count: Int      // hours in the whole run
    let chunk_index: Int        // 0-based
    let chunk_count: Int
}

struct UsagePayload: Codable {
    let device: String
    let device_name: String?
    let device_model: String?
    let app_version: String
    let generated_at: Date
    let segments: [UsageSegment]
    let run: RunInfo?           // nil only in the in-app preview; omitted from the JSON then
}

/// A failed sync, reported to the same route so /status turns red at once.
/// The route reads `failure` and writes a failed screen_time|usage heartbeat.
struct FailureReport: Codable {
    struct Failure: Codable {
        let stage: String       // SyncStage raw value: access | read | encode | network | http
        let message: String
    }
    let device: String
    let app_version: String
    let failure: Failure
}

struct ExportResult {
    let segments: [UsageSegment]
    let deviceName: String?
    let deviceModel: String?
    let streamEnded: Bool       // true only when Apple's stream ended by itself with no error
    let streamFailed: Bool      // the stream threw an error (so streamEnded is false and the hours are not certified)
    let windowStart: Date       // the requested window (the DeviceActivityFilter interval)
    let windowEnd: Date

    var totalMinutes: Double { segments.reduce(0) { $0 + $1.total_seconds } / 60 }
    var firstStart: Date? { segments.map(\.start).min() }
    var lastEnd: Date? { segments.map(\.end).max() }
}
