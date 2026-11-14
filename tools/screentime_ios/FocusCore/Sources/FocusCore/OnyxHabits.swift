import Foundation

/// Habit unlock: the habits Riley chose in Onyx (web, /install) can unlock the
/// Focus block. Pure policy and parsing; the network call lives in the app
/// (FocusUI/FocusHabitSync.swift) and the monitor extension only reads what
/// the app stored. The TypeScript copy of `shouldUnlock` is
/// frontend/src/lib/focus-unlock.ts; keep the two tables identical.

/// How the chosen habits combine with the phone's unlock time. Set in Onyx.
public enum OnyxUnlockRule: String, Codable, Sendable {
    /// Finishing the habits unlocks early; the unlock time unlocks regardless.
    case or
    /// Stays blocked after the unlock time until the habits are done.
    case and
}

public struct OnyxHabit: Codable, Equatable, Sendable {
    public var name: String
    public var done: Bool
    public init(name: String, done: Bool) { self.name = name; self.done = done }
}

/// One successful answer from GET /api/focus/unlock-status.
public struct OnyxHabitStatus: Codable, Equatable, Sendable {
    /// The Onyx behavioral day the done flags are for (yyyy-MM-dd).
    public var day: String
    public var rule: OnyxUnlockRule
    /// The habits chosen in Onyx. Empty = none chosen.
    public var habits: [OnyxHabit]
    public var fetchedAt: Date

    public init(day: String, rule: OnyxUnlockRule, habits: [OnyxHabit], fetchedAt: Date) {
        self.day = day; self.rule = rule; self.habits = habits; self.fetchedAt = fetchedAt
    }

    public var allDone: Bool { !habits.isEmpty && habits.allSatisfy { $0.done } }
    public var outstanding: [String] { habits.filter { !$0.done }.map { $0.name } }

    public enum ParseError: Error, Equatable { case malformed }

    private struct Wire: Decodable {
        struct Habit: Decodable { let name: String; let done: Bool }
        let behavioral_date: String
        let rule: String
        let habits: [Habit]
    }

    /// Parses the route's JSON. Anything unexpected (unknown rule, bad date,
    /// too many habits) is refused, and a refused answer counts as a failed
    /// check: the phone then uses the time-only rule.
    public static func parse(_ data: Data, fetchedAt: Date) throws -> OnyxHabitStatus {
        guard let wire = try? JSONDecoder().decode(Wire.self, from: data),
              let rule = OnyxUnlockRule(rawValue: wire.rule),
              isDay(wire.behavioral_date),
              wire.habits.count <= 20
        else { throw ParseError.malformed }
        let habits = wire.habits.map { OnyxHabit(name: String($0.name.prefix(120)), done: $0.done) }
        return OnyxHabitStatus(day: wire.behavioral_date, rule: rule, habits: habits, fetchedAt: fetchedAt)
    }

    static func isDay(_ text: String) -> Bool {
        let parts = text.split(separator: "-", omittingEmptySubsequences: false)
        guard text.utf8.count == 10, parts.count == 3,
              parts[0].count == 4, parts[1].count == 2, parts[2].count == 2 else { return false }
        return parts.allSatisfy { part in part.allSatisfy { $0.isASCII && $0.isNumber } }
    }
}

/// What the habits mean for the rule right now.
public enum OnyxHabitGate: Equatable, Sendable {
    /// Onyx has never answered, or no habits are chosen there: the phone's
    /// own rule applies unchanged.
    case notConfigured
    /// Habits are chosen and the phone has not asked Onyx about today yet.
    /// Counts as "not done": under OR that is the time rule; under AND the
    /// block stays after the unlock time until the app is opened and checks.
    case notCheckedToday(rule: OnyxUnlockRule)
    /// Habits are chosen, the phone asked today, and got no usable answer:
    /// time-only rule.
    case unknown(OnyxUnknownReason)
    case known(rule: OnyxUnlockRule, done: Bool)
}

public enum OnyxUnknownReason: Equatable, Sendable {
    /// Onyx answered today, but for a different day than the phone's (its
    /// clock and the phone's disagree, for example on a trip).
    case otherDay
    /// Today's latest check failed and no answer says "done".
    case checkFailed
}

/// Everything the phone remembers about Onyx habits. Stored in the App Group
/// (focus-habits.json) so the monitor extension can read it.
public struct OnyxHabitState: Codable, Equatable, Sendable {
    /// The last successful answer. Kept when a later check fails.
    public var status: OnyxHabitStatus?
    /// When the phone last tried, successful or not.
    public var lastAttempt: Date?
    /// Why the latest try failed; nil after a success.
    public var lastError: String?

    public init(status: OnyxHabitStatus? = nil, lastAttempt: Date? = nil, lastError: String? = nil) {
        self.status = status; self.lastAttempt = lastAttempt; self.lastError = lastError
    }

    public mutating func recordSuccess(_ status: OnyxHabitStatus) {
        self.status = status; lastAttempt = status.fetchedAt; lastError = nil
    }

    public mutating func recordFailure(_ message: String, at date: Date) {
        lastAttempt = date; lastError = String(message.prefix(200))
    }

    /// Onyx's behavioral day starts at 06:00 local: before that hour Onyx
    /// still reports the previous day, so an answer fetched then says nothing
    /// about the phone's new calendar day.
    public static let onyxDayStartHour = 6

    /// An answer only counts when Onyx's behavioral day is the phone's
    /// calendar day, so yesterday's ticks never unlock today.
    ///
    /// A failed check turns "not done" into unknown (time-only), so a check
    /// that fails can never keep apps blocked past the unlock time. It does
    /// not undo a "done" that Onyx already confirmed today.
    public func gate(at date: Date, calendar: Calendar) -> OnyxHabitGate {
        guard let status, !status.habits.isEmpty else { return .notConfigured }
        let today = FocusRule.dayKey(date, calendar: calendar)
        if status.day == today {
            if status.allDone { return .known(rule: status.rule, done: true) }
            if lastError != nil { return .unknown(.checkFailed) }
            return .known(rule: status.rule, done: false)
        }
        // No answer for today. Did the phone ask today?
        if lastError != nil, let lastAttempt, FocusRule.dayKey(lastAttempt, calendar: calendar) == today {
            return .unknown(.checkFailed)
        }
        let fetchedToday = FocusRule.dayKey(status.fetchedAt, calendar: calendar) == today
        let fetchedHour = calendar.component(.hour, from: status.fetchedAt)
        if fetchedToday && fetchedHour >= Self.onyxDayStartHour { return .unknown(.otherDay) }
        return .notCheckedToday(rule: status.rule)
    }
}

public enum OnyxUnlock {
    /// true = the blocked apps open. `habitsDone` nil = unknown. Unknown and
    /// "no habits chosen" both mean the time alone decides, under both rules.
    public static func shouldUnlock(rule: OnyxUnlockRule, habitsDone: Bool?, timeReady: Bool, configPresent: Bool) -> Bool {
        guard configPresent, let habitsDone else { return timeReady }
        switch rule {
        case .and: return habitsDone && timeReady
        case .or: return habitsDone || timeReady
        }
    }
}

extension FocusRule {
    public func timeReady(at date: Date, calendar: Calendar) -> Bool {
        let parts = calendar.dateComponents([.hour, .minute], from: date)
        return (parts.hour! * 60 + parts.minute!) >= unlockMinute
    }

    /// The rule including Onyx habits. With no habits chosen in Onyx (or no
    /// answer ever) this is exactly `shouldShield(at:calendar:)`. Once habits
    /// are chosen, they replace this phone's own "Unlock when" choice and task
    /// list; the "Not before" time is still the time half of the rule.
    /// Uses the stored answer only: no network.
    public func shouldShield(at date: Date, calendar: Calendar, onyx: OnyxHabitState?) -> Bool {
        guard enabled, validationError == nil else { return false }
        let ready = timeReady(at: date, calendar: calendar)
        switch onyx?.gate(at: date, calendar: calendar) ?? .notConfigured {
        case .notConfigured:
            return shouldShield(at: date, calendar: calendar)
        case .unknown:
            return !OnyxUnlock.shouldUnlock(rule: .or, habitsDone: nil, timeReady: ready, configPresent: true)
        case .notCheckedToday(let rule):
            return !OnyxUnlock.shouldUnlock(rule: rule, habitsDone: false, timeReady: ready, configPresent: true)
        case .known(let rule, let done):
            return !OnyxUnlock.shouldUnlock(rule: rule, habitsDone: done, timeReady: ready, configPresent: true)
        }
    }
}
