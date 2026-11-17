#if !ONYX_FOCUS
import Foundation
import HealthKit

// Apple Health -> Onyx (POST /api/apple-health/import, frontend/src/lib/apple-health.ts).
//
// HealthKit data is encrypted while the phone is locked, so this only works with the phone unlocked:
// the app syncs itself when it comes to the foreground (AppModel / ContentView), and the Shortcuts action
// "Sync Apple Health to Onyx" (run by a "when Onyx is opened" automation) does the same.
//
// Only phone-measured data that WHOOP / Garmin / Eight Sleep do not carry is read: steps, walking +
// running distance, flights, walking speed, walking steadiness, headphone audio level, mindful minutes,
// workouts other apps wrote to Health, State of Mind. Never heart rate, HRV or sleep (copies of the
// devices Onyx already reads), never locations or routes, never raw samples: values are summed or
// averaged per hour on the phone.
//
// HealthKit never says whether READ permission was refused (an empty answer looks the same), so a
// metric the user turned off simply returns nothing; the summary says "no data" for it.

struct HealthHourly: Codable {
    let metric: String
    let start: Date
    let value: Double
    let samples: Int?
}

struct HealthWorkout: Codable {
    let uuid: String
    let type: String
    let start: Date
    let end: Date
    let duration_s: Double
    let distance_m: Double?
    let energy_kcal: Double?
    let source: String?
}

struct HealthMind: Codable {
    let uuid: String
    let at: Date
    let kind: String            // momentary_emotion | daily_mood
    let valence: Double         // -1 ... 1
    let labels: [String]
    let associations: [String]
}

struct HealthPayload: Codable {
    let device: String
    let app_version: String
    let hourly: [HealthHourly]
    let workouts: [HealthWorkout]
    let mind: [HealthMind]
}

struct HealthFailureReport: Codable {
    struct Failure: Codable {
        let stage: String
        let message: String
    }
    let device: String
    let app_version: String
    let failure: Failure
}

/// Where a Health sync broke, as reported to Onyx (HEALTH_FAILURE_STAGES in frontend/src/lib/apple-health.ts).
enum HealthStage: String {
    case access     // Health is unavailable, or the permission request failed (often: the build lacks the HealthKit entitlement)
    case read       // a HealthKit query failed
    case encode
    case network
    case http
}

struct HealthSnapshot {
    let hourly: [HealthHourly]
    let workouts: [HealthWorkout]
    let mind: [HealthMind]
}

enum HealthSync {
    private struct Spec {
        let key: String
        let id: HKQuantityTypeIdentifier
        let unit: HKUnit
        let cumulative: Bool
        let scale: Double
    }

    private static let specs: [Spec] = [
        Spec(key: "steps", id: .stepCount, unit: .count(), cumulative: true, scale: 1),
        Spec(key: "distance_m", id: .distanceWalkingRunning, unit: .meter(), cumulative: true, scale: 1),
        Spec(key: "flights", id: .flightsClimbed, unit: .count(), cumulative: true, scale: 1),
        Spec(key: "walking_speed_ms", id: .walkingSpeed, unit: HKUnit.meter().unitDivided(by: .second()), cumulative: false, scale: 1),
        // HKUnit.percent() is a fraction (0.97); Onyx stores percent.
        Spec(key: "walking_steadiness_pct", id: .appleWalkingSteadiness, unit: .percent(), cumulative: false, scale: 100),
        Spec(key: "headphone_db", id: .headphoneAudioExposure, unit: .decibelAWeightedSoundPressureLevel(), cumulative: false, scale: 1),
    ]

    private static let store = HKHealthStore()
    private static let reportTimeout: TimeInterval = 4
    /// The foreground auto-sync runs at most this often.
    static let minInterval: TimeInterval = 30 * 60

    static var readTypes: Set<HKObjectType> {
        var types = Set<HKObjectType>(specs.map { HKQuantityType($0.id) })
        types.insert(HKCategoryType(.mindfulSession))
        types.insert(HKObjectType.workoutType())
        types.insert(HKObjectType.stateOfMindType())
        return types
    }

    static var isAvailable: Bool { HKHealthStore.isHealthDataAvailable() }

    /// Asks for read access (the system sheet shows once per type; later calls are silent).
    static func requestAccess() async throws {
        guard isAvailable else { throw HealthError.unavailable }
        try await store.requestAuthorization(toShare: Set<HKSampleType>(), read: readTypes)
    }

    // MARK: reading

    static func read(days: Int) async throws -> HealthSnapshot {
        let calendar = Calendar.current
        let end = Date()
        let start = calendar.date(byAdding: .day, value: -(max(1, days) - 1), to: calendar.startOfDay(for: end)) ?? end.addingTimeInterval(-86400)
        let window = HKQuery.predicateForSamples(withStart: start, end: end, options: [])

        var hourly: [HealthHourly] = []
        for spec in specs {
            hourly += try await hourlyStatistics(spec, start: start, end: end)
        }
        hourly += try await mindfulHours(window: window, start: start, end: end)
        return HealthSnapshot(
            hourly: hourly,
            workouts: try await workouts(window: window),
            mind: try await stateOfMind(window: window)
        )
    }

    private static func hourlyStatistics(_ spec: Spec, start: Date, end: Date) async throws -> [HealthHourly] {
        let type = HKQuantityType(spec.id)
        let predicate = HKQuery.predicateForSamples(withStart: start, end: end, options: .strictStartDate)
        let descriptor = HKStatisticsCollectionQueryDescriptor(
            predicate: HKSamplePredicate.quantitySample(type: type, predicate: predicate),
            options: spec.cumulative ? .cumulativeSum : .discreteAverage,
            anchorDate: start,
            intervalComponents: DateComponents(hour: 1)
        )
        let collection = try await descriptor.result(for: store)
        var rows: [HealthHourly] = []
        collection.enumerateStatistics(from: start, to: end) { statistics, _ in
            let quantity = spec.cumulative ? statistics.sumQuantity() : statistics.averageQuantity()
            guard let quantity else { return }
            let value = quantity.doubleValue(for: spec.unit) * spec.scale
            // An hour with nothing recorded is a missing hour, never a zero (a phone left at home).
            guard value.isFinite, value > 0 else { return }
            rows.append(HealthHourly(metric: spec.key, start: statistics.startDate, value: value, samples: nil))
        }
        return rows
    }

    /// Mindful sessions split across the hours they overlap (seconds per hour).
    private static func mindfulHours(window: NSPredicate, start: Date, end: Date) async throws -> [HealthHourly] {
        let descriptor = HKSampleQueryDescriptor(
            predicates: [HKSamplePredicate.categorySample(type: HKCategoryType(.mindfulSession), predicate: window)],
            sortDescriptors: [SortDescriptor(\.startDate)]
        )
        let sessions = try await descriptor.result(for: store)
        let calendar = Calendar.current
        var seconds: [Date: Double] = [:]
        for session in sessions {
            var cursor = max(session.startDate, start)
            let stop = min(session.endDate, end)
            while cursor < stop {
                guard let hour = calendar.dateInterval(of: .hour, for: cursor) else { break }
                let slice = min(hour.end, stop).timeIntervalSince(cursor)
                if slice > 0 { seconds[hour.start, default: 0] += slice }
                cursor = hour.end
            }
        }
        return seconds.sorted { $0.key < $1.key }.map {
            HealthHourly(metric: "mindful_seconds", start: $0.key, value: min($0.value, 3600), samples: nil)
        }
    }

    private static func workouts(window: NSPredicate) async throws -> [HealthWorkout] {
        let descriptor = HKSampleQueryDescriptor(
            predicates: [HKSamplePredicate.workout(window)],
            sortDescriptors: [SortDescriptor(\.startDate)]
        )
        let found = try await descriptor.result(for: store)
        return found.map { workout in
            HealthWorkout(
                uuid: workout.uuid.uuidString,
                type: activityName(workout.workoutActivityType),
                start: workout.startDate,
                end: workout.endDate,
                duration_s: workout.duration,
                distance_m: distance(of: workout),
                energy_kcal: workout.statistics(for: HKQuantityType(.activeEnergyBurned))?.sumQuantity()?.doubleValue(for: .kilocalorie()),
                source: workout.sourceRevision.source.name
            )
        }
    }

    private static func distance(of workout: HKWorkout) -> Double? {
        let ids: [HKQuantityTypeIdentifier] = [.distanceWalkingRunning, .distanceCycling, .distanceSwimming, .distanceWheelchair]
        for id in ids {
            if let meters = workout.statistics(for: HKQuantityType(id))?.sumQuantity()?.doubleValue(for: .meter()), meters > 0 {
                return meters
            }
        }
        return nil
    }

    private static func activityName(_ type: HKWorkoutActivityType) -> String {
        switch type {
        case .running: return "running"
        case .walking: return "walking"
        case .cycling: return "cycling"
        case .hiking: return "hiking"
        case .swimming: return "swimming"
        case .yoga: return "yoga"
        case .pilates: return "pilates"
        case .rowing: return "rowing"
        case .elliptical: return "elliptical"
        case .stairClimbing: return "stair_climbing"
        case .dance: return "dance"
        case .mindAndBody: return "mind_and_body"
        case .functionalStrengthTraining: return "functional_strength"
        case .traditionalStrengthTraining: return "strength"
        case .highIntensityIntervalTraining: return "hiit"
        case .other: return "other"
        default: return "type_\(type.rawValue)"
        }
    }

    private static func stateOfMind(window: NSPredicate) async throws -> [HealthMind] {
        let descriptor = HKSampleQueryDescriptor<HKSample>(
            predicates: [HKSamplePredicate.sample(type: HKObjectType.stateOfMindType(), predicate: window)],
            sortDescriptors: [SortDescriptor(\.startDate)]
        )
        let samples = try await descriptor.result(for: store)
        var rows: [HealthMind] = []
        for case let entry as HKStateOfMind in samples {
            rows.append(HealthMind(
                uuid: entry.uuid.uuidString,
                at: entry.startDate,
                kind: entry.kind == .dailyMood ? "daily_mood" : "momentary_emotion",
                valence: entry.valence,
                labels: entry.labels.map { String(describing: $0) },
                associations: entry.associations.map { String(describing: $0) }
            ))
        }
        return rows
    }

    // MARK: sending

    /// Reads the last `days` days from Health and sends them to Onyx. Returns a one-line summary.
    /// A failure after the token check is also reported to Onyx (so /status goes red on the same run).
    @discardableResult
    static func sync(days: Int) async throws -> String {
        guard let token = Settings.token else { throw SyncError.noToken }
        guard let url = URL(string: Settings.baseURL + "/api/apple-health/import"), url.scheme == "https" else {
            throw SyncError.badURL(Settings.baseURL)
        }

        do {
            try await requestAccess()
        } catch {
            await reportFailure(.access, error.localizedDescription, token: token, url: url)
            throw error
        }

        let snapshot: HealthSnapshot
        do {
            snapshot = try await read(days: days)
        } catch {
            await reportFailure(.read, error.localizedDescription, token: token, url: url)
            throw error
        }

        let body: Data
        do {
            body = try SyncService.encoder().encode(HealthPayload(
                device: "iphone",
                app_version: SyncService.appVersion,
                hourly: snapshot.hourly,
                workouts: snapshot.workouts,
                mind: snapshot.mind
            ))
        } catch {
            await reportFailure(.encode, error.localizedDescription, token: token, url: url)
            throw error
        }

        var request = URLRequest(url: url, timeoutInterval: 30)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(token, forHTTPHeaderField: "x-onyx-ci-token")
        request.httpBody = body

        let reply: (Data, URLResponse)
        do {
            reply = try await URLSession.shared.data(for: request)
        } catch {
            await reportFailure(.network, error.localizedDescription, token: token, url: url)
            throw error
        }
        let (data, response) = reply
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard code == 200 else {
            let text = String(String(data: data, encoding: .utf8)?.prefix(300) ?? "")
            if code != 401 && code != 403 && !SyncService.serverLogged(data) {
                await reportFailure(.http, "HTTP \(code): \(text.prefix(120))", token: token, url: url)
            }
            throw SyncError.server(code, text)
        }

        let summary = describe(snapshot, days: days)
        Settings.lastHealthSync = Date()
        Settings.lastHealthSummary = summary
        Settings.healthEnabled = true
        return summary
    }

    /// The foreground auto-sync: only after Health was set up once, with a token, at most every 30 minutes.
    /// Errors are already reported to Onyx by sync(); nothing is thrown into the UI.
    static func syncIfDue(days: Int = 3) async {
        guard Settings.healthEnabled, Settings.token != nil else { return }
        if let last = Settings.lastHealthSync, Date().timeIntervalSince(last) < minInterval { return }
        _ = try? await sync(days: days)
    }

    static func describe(_ snapshot: HealthSnapshot, days: Int) -> String {
        var perMetric: [String: Int] = [:]
        for row in snapshot.hourly { perMetric[row.metric, default: 0] += 1 }
        let steps = snapshot.hourly.filter { $0.metric == "steps" }.reduce(0) { $0 + $1.value }
        let metrics = perMetric.isEmpty ? "no hourly data" : "\(perMetric.count) metrics, \(snapshot.hourly.count) hours"
        return "Sent \(metrics), \(Int(steps)) steps, \(snapshot.workouts.count) workouts, \(snapshot.mind.count) mood entries (last \(days) days)"
    }

    /// Best effort, never throws: posts `{ failure: { stage, message } }`, which writes a failed heartbeat.
    static func reportFailure(_ stage: HealthStage, _ message: String, token: String, url: URL) async {
        let report = HealthFailureReport(
            device: "iphone",
            app_version: SyncService.appVersion,
            failure: HealthFailureReport.Failure(stage: stage.rawValue, message: String(message.prefix(300)))
        )
        guard let body = try? SyncService.encoder().encode(report) else { return }
        var request = URLRequest(url: url, timeoutInterval: reportTimeout)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(token, forHTTPHeaderField: "x-onyx-ci-token")
        request.httpBody = body
        _ = try? await URLSession.shared.data(for: request)
    }
}

enum HealthError: LocalizedError {
    case unavailable

    var errorDescription: String? {
        switch self {
        case .unavailable: return "Health data is not available on this device."
        }
    }
}
#endif
