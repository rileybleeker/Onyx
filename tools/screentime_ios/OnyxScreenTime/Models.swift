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

struct UsagePayload: Codable {
    let device: String
    let device_name: String?
    let device_model: String?
    let app_version: String
    let generated_at: Date
    let segments: [UsageSegment]
}

struct ExportResult {
    let segments: [UsageSegment]
    let deviceName: String?
    let deviceModel: String?
    let streamEnded: Bool       // false = stopped by the idle/timeout watchdog

    var totalMinutes: Double { segments.reduce(0) { $0 + $1.total_seconds } / 60 }
    var firstStart: Date? { segments.map(\.start).min() }
    var lastEnd: Date? { segments.map(\.end).max() }
}
