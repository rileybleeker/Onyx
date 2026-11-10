import DeviceActivity
import FamilyControls
import Foundation
import ManagedSettings

enum ExportError: LocalizedError {
    case noDataAccess(String)
    case noData

    var errorDescription: String? {
        switch self {
        case .noDataAccess(let status):
            return "Screen Time data access is not granted (status: \(status)). Open the app and tap Grant access."
        case .noData:
            return "Apple returned no Screen Time data for that range."
        }
    }
}

/// Collects segments as the system streams them. A later copy of the same
/// hour replaces the earlier one (the live policy can re-emit as it refreshes).
private actor SegmentStore {
    private var byStart: [Date: UsageSegment] = [:]
    private(set) var deviceName: String?
    private(set) var deviceModel: String?
    private(set) var lastUpdate = Date()
    private(set) var finished = false
    private(set) var failure: Error?

    func put(_ segment: UsageSegment) {
        byStart[segment.start] = segment
        lastUpdate = Date()
    }

    func setDevice(name: String?, model: String) {
        deviceName = name
        deviceModel = model
    }

    func finish(_ error: Error?) {
        finished = true
        failure = error
    }

    var count: Int { byStart.count }
    var segments: [UsageSegment] { byStart.values.sorted { $0.start < $1.start } }
}

enum ScreenTimeExporter {
    static var authorizationStatus: AuthorizationStatus {
        AuthorizationCenter.shared.authorizationStatus
    }

    static var hasDataAccess: Bool {
        authorizationStatus == .approvedWithDataAccess
    }

    /// Reads hourly Screen Time segments for the last `days` days (today included).
    ///
    /// The export API returns an async sequence that may never end under the
    /// live policy, so a watchdog stops it once nothing new has arrived for
    /// `idle` seconds, or after `timeout` seconds in total.
    static func fetch(
        days: Int,
        policy: DeviceActivityData.Policy,
        timeout: TimeInterval = 25,
        idle: TimeInterval = 4
    ) async throws -> ExportResult {
        guard hasDataAccess else {
            throw ExportError.noDataAccess(authorizationStatus.description)
        }

        let now = Date()
        let calendar = Calendar.current
        let firstDay = calendar.date(byAdding: .day, value: -(max(1, days) - 1), to: calendar.startOfDay(for: now)) ?? now
        let filter = DeviceActivityFilter(
            segment: .hourly(during: DateInterval(start: firstDay, end: now)),
            users: .all,
            devices: .init([.iPhone])
        )

        let store = SegmentStore()
        let reader = Task {
            do {
                for try await data in DeviceActivityData.activityData(filteredBy: filter, using: policy) {
                    await ingest(data, into: store)
                }
                await store.finish(nil)
            } catch {
                await store.finish(error)
            }
        }

        let deadline = now.addingTimeInterval(timeout)
        while Date() < deadline {
            if await store.finished { break }
            let count = await store.count
            let last = await store.lastUpdate
            if count > 0 && Date().timeIntervalSince(last) > idle { break }
            try? await Task.sleep(nanoseconds: 250_000_000)
        }
        reader.cancel()

        let segments = await store.segments
        let ended = await store.finished
        if segments.isEmpty {
            if let failure = await store.failure, !(failure is CancellationError) { throw failure }
            throw ExportError.noData
        }
        return ExportResult(
            segments: segments,
            deviceName: await store.deviceName,
            deviceModel: await store.deviceModel,
            streamEnded: ended
        )
    }

    private static func ingest(_ data: DeviceActivityData, into store: SegmentStore) async {
        await store.setDevice(name: data.device.name, model: String(describing: data.device.model))

        for await segment in data.activitySegments {
            var items: [String: UsageItem] = [:]

            for await categoryActivity in segment.categories {
                let category = categoryActivity.category.localizedDisplayName

                for await appActivity in categoryActivity.applications {
                    let app = appActivity.application
                    guard let id = app.bundleIdentifier ?? app.localizedDisplayName else { continue }
                    let key = "app|\(id)"
                    if var existing = items[key] {
                        existing.seconds += appActivity.totalActivityDuration
                        existing.pickups = (existing.pickups ?? 0) + appActivity.numberOfPickups
                        existing.notifications = (existing.notifications ?? 0) + appActivity.numberOfNotifications
                        items[key] = existing
                    } else {
                        items[key] = UsageItem(
                            kind: "app",
                            identifier: id,
                            name: app.localizedDisplayName,
                            category: category,
                            seconds: appActivity.totalActivityDuration,
                            pickups: appActivity.numberOfPickups,
                            notifications: appActivity.numberOfNotifications
                        )
                    }
                }

                for await webActivity in categoryActivity.webDomains {
                    guard let domain = webActivity.webDomain.domain else { continue }
                    let key = "web|\(domain)"
                    if var existing = items[key] {
                        existing.seconds += webActivity.totalActivityDuration
                        items[key] = existing
                    } else {
                        items[key] = UsageItem(
                            kind: "web",
                            identifier: domain,
                            name: nil,
                            category: category,
                            seconds: webActivity.totalActivityDuration,
                            pickups: nil,
                            notifications: nil
                        )
                    }
                }
            }

            await store.put(UsageSegment(
                start: segment.dateInterval.start,
                end: segment.dateInterval.end,
                total_seconds: segment.totalActivityDuration,
                first_pickup: segment.firstPickup,
                pickups_without_app: segment.totalPickupsWithoutApplicationActivity,
                longest_start: segment.longestActivity?.start,
                longest_end: segment.longestActivity?.end,
                items: items.values.sorted { $0.seconds > $1.seconds }
            ))
        }
    }
}
