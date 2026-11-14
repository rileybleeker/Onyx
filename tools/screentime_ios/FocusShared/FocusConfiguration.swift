import Foundation
import Darwin
import FamilyControls
import ManagedSettings
import DeviceActivity
import FocusCore

struct FocusConfiguration: Codable {
    var rule = FocusRule()
    var blocked = FamilyActivitySelection()
    var allowed = FamilyActivitySelection()
    var linkedInConfirmed = false

    var validationError: String? {
        if let error = rule.validationError { return error }
        if let error = FocusExceptions.validationError(
            appCount: allowed.applicationTokens.count,
            domainCount: allowed.webDomainTokens.count,
            categoryCount: allowed.categoryTokens.count,
            confirmed: linkedInConfirmed
        ) { return error }
        if blocked.applicationTokens.isEmpty && blocked.categoryTokens.isEmpty && blocked.webDomainTokens.isEmpty { return "Choose social apps or websites to block." }
        if blocked.categoryTokens.count > 50 || allowed.applicationTokens.count > 50 || allowed.webDomainTokens.count > 50 { return "Selection exceeds Apple's 50-category or exception limit." }
        if blocked.applicationTokens.subtracting(allowed.applicationTokens).count > 50 || blocked.webDomainTokens.subtracting(allowed.webDomainTokens).count > 50 { return "Select at most 50 blocked apps and 50 blocked websites after exceptions." }
        return nil
    }
}

enum FocusStorage {
    static let group = "group.com.rileybleeker.onyxscreentime.focus"
    static var file: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)?.appendingPathComponent("focus.json")
    }
    /// Serializes the app and extension's read/decide/apply cycle, not just JSON writes.
    static func withLock<T>(_ action: () throws -> T) throws -> T {
        guard let file else { throw FocusFailure.message("Focus App Group is not provisioned.") }
        let descriptor = open(file.appendingPathExtension("lock").path, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
        guard descriptor >= 0 else { throw FocusFailure.message("Cannot open Focus state lock.") }
        defer { close(descriptor) }
        guard flock(descriptor, LOCK_EX) == 0 else { throw FocusFailure.message("Cannot lock Focus state.") }
        defer { flock(descriptor, LOCK_UN) }
        return try action()
    }
    static func load() throws -> FocusConfiguration {
        guard let file else { throw FocusFailure.message("Focus App Group is not provisioned.") }
        guard FileManager.default.fileExists(atPath: file.path) else { return FocusConfiguration() }
        return try JSONDecoder().decode(FocusConfiguration.self, from: Data(contentsOf: file))
    }
    static func save(_ value: FocusConfiguration) throws {
        guard let file else { throw FocusFailure.message("Focus App Group is not provisioned.") }
        try JSONEncoder().encode(value).write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
}

/// What the phone last learned from Onyx about the chosen habits. A separate
/// file from focus.json, so saving a settings draft never overwrites a newer
/// answer. Written only by the app (FocusUI/FocusHabitSync.swift); the monitor
/// extension reads it. Call these inside FocusStorage.withLock.
enum FocusHabitStorage {
    static var file: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: FocusStorage.group)?.appendingPathComponent("focus-habits.json")
    }
    /// A missing or unreadable file is "nothing known": the phone's own rule applies.
    static func load() -> OnyxHabitState {
        guard let file, let data = try? Data(contentsOf: file),
              let state = try? JSONDecoder().decode(OnyxHabitState.self, from: data) else { return OnyxHabitState() }
        return state
    }
    static func save(_ value: OnyxHabitState) throws {
        guard let file else { throw FocusFailure.message("Focus App Group is not provisioned.") }
        try JSONEncoder().encode(value).write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
}

enum FocusFailure: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let value) = self { return value }; return nil }
}

enum FocusEnforcement {
    static let activity = DeviceActivityName("onyx.focus.daily")
    static let store = ManagedSettingsStore(named: ManagedSettingsStore.Name("onyx.focus"))

    /// Removes only this feature's restrictions, never another application's.
    static func clear() { store.clearAllSettings() }

    static func reconcile() {
        do {
            try FocusStorage.withLock {
                guard let config = try? FocusStorage.load() else { clear(); return }
                apply(config)
            }
        } catch { clear() }
    }

    private static func apply(_ config: FocusConfiguration) {
        // Onyx habits come from the stored answer only: nothing here uses the network.
        guard config.validationError == nil,
              config.rule.shouldShield(at: Date(), calendar: .autoupdatingCurrent, onyx: FocusHabitStorage.load()) else {
            clear(); return
        }
        // Exceptions must also be subtracted from individually selected targets.
        let apps = config.blocked.applicationTokens.subtracting(config.allowed.applicationTokens)
        let domains = config.blocked.webDomainTokens.subtracting(config.allowed.webDomainTokens)
        store.shield.applications = apps.isEmpty ? nil : apps
        store.shield.webDomains = domains.isEmpty ? nil : domains
        store.shield.applicationCategories = config.blocked.categoryTokens.isEmpty ? nil : .specific(config.blocked.categoryTokens, except: config.allowed.applicationTokens)
        store.shield.webDomainCategories = config.blocked.categoryTokens.isEmpty ? nil : .specific(config.blocked.categoryTokens, except: config.allowed.webDomainTokens)
    }

    @MainActor static func enable(_ draft: FocusConfiguration) throws {
        if let error = draft.validationError { throw FocusFailure.message(error) }
        let status = AuthorizationCenter.shared.authorizationStatus
        guard status == .approved || status == .approvedWithDataAccess else {
            throw FocusFailure.message("Grant Screen Time access before enabling Focus.")
        }
        var staged = draft; staged.rule.enabled = false
        try FocusStorage.withLock { try FocusStorage.save(staged); clear() }
        let minute = draft.rule.unlockMinute
        do {
            try DeviceActivityCenter().startMonitoring(activity, during: DeviceActivitySchedule(
                intervalStart: DateComponents(hour: 0, minute: 0),
                intervalEnd: DateComponents(hour: minute / 60, minute: minute % 60), repeats: true))
            staged.rule.enabled = true
            try FocusStorage.withLock { try FocusStorage.save(staged); apply(staged) }
        } catch {
            DeviceActivityCenter().stopMonitoring([activity])
            clear()
            throw error
        }
    }

    static func complete(_ id: UUID) throws {
        try FocusStorage.withLock {
            var saved = try FocusStorage.load()
            guard let index = saved.rule.tasks.firstIndex(where: { $0.id == id }) else { return }
            saved.rule.tasks[index].completedDay = FocusRule.dayKey(Date(), calendar: .autoupdatingCurrent)
            try FocusStorage.save(saved)
            apply(saved)
        }
    }

    static func disable() throws {
        // Always stop and clear, even if the file is missing or unreadable.
        // Persist a clean off configuration on recovery so future opens stay off.
        DeviceActivityCenter().stopMonitoring([activity])
        defer { clear() }
        try FocusStorage.withLock {
            var config = (try? FocusStorage.load()) ?? FocusConfiguration()
            config.rule.enabled = false
            try FocusStorage.save(config)
            clear()
        }
    }
}
