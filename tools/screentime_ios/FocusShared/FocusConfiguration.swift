import Foundation
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
        if !linkedInConfirmed || allowed.applicationTokens.isEmpty { return "Select LinkedIn in Allowed apps and confirm it stays available." }
        if !allowed.categoryTokens.isEmpty { return "Choose individual allowed apps and websites, not whole allowed categories." }
        if blocked.applicationTokens.isEmpty && blocked.categoryTokens.isEmpty && blocked.webDomainTokens.isEmpty { return "Choose social apps or websites to block." }
        if blocked.categoryTokens.count > 50 || allowed.applicationTokens.count > 50 || allowed.webDomainTokens.count > 50 { return "Selection exceeds Apple's 50-category or exception limit." }
        return nil
    }
}

enum FocusStorage {
    static let group = "group.com.rileybleeker.onyxscreentime.focus"
    static var file: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)?.appendingPathComponent("focus.json")
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
        guard let config = try? FocusStorage.load(), config.validationError == nil,
              config.rule.shouldShield(at: Date(), calendar: .autoupdatingCurrent) else {
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
        try FocusStorage.save(staged)
        clear()
        let minute = draft.rule.unlockMinute
        do {
            try DeviceActivityCenter().startMonitoring(activity, during: DeviceActivitySchedule(
                intervalStart: DateComponents(hour: 0, minute: 0),
                intervalEnd: DateComponents(hour: minute / 60, minute: minute % 60), repeats: true))
            staged.rule.enabled = true
            try FocusStorage.save(staged)
            reconcile()
        } catch {
            DeviceActivityCenter().stopMonitoring([activity])
            clear()
            throw error
        }
    }

    static func disable() throws {
        // Persist off before stopping callbacks. If persistence fails, clear now
        // and surface the error rather than falsely reporting a durable disable.
        var config = try FocusStorage.load(); config.rule.enabled = false
        do { try FocusStorage.save(config) }
        catch { clear(); throw error }
        DeviceActivityCenter().stopMonitoring([activity]); clear()
    }
}
