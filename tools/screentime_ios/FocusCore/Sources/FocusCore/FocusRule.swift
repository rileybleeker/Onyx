import Foundation

public enum UnlockMode: String, Codable, CaseIterable {
    case choose, timeOnly, tasksOnly, both, either
}

public struct FocusTask: Codable, Identifiable, Equatable {
    public var id: UUID
    public var title: String
    public var completedDay: String?
    public init(id: UUID = UUID(), title: String, completedDay: String? = nil) {
        self.id = id; self.title = title; self.completedDay = completedDay
    }
}

/// Pure policy. No network, OS permissions, or implicit activation.
public struct FocusRule: Codable, Equatable {
    public var enabled = false
    public var mode: UnlockMode = .choose
    public var unlockMinute = 12 * 60
    public var tasks: [FocusTask] = []
    public init() {}

    public static func dayKey(_ date: Date, calendar: Calendar) -> String {
        let d = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", d.year!, d.month!, d.day!)
    }

    public var validationError: String? {
        if mode == .choose { return "Choose how time and tasks combine." }
        // Keep the monitor interval >= 15 minutes and below 24 hours.
        if !(15...1439).contains(unlockMinute) { return "Choose an unlock time between 00:15 and 23:59." }
        if mode != .timeOnly && tasks.isEmpty { return "Add at least one required task." }
        if tasks.contains(where: { $0.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) { return "Task names cannot be empty." }
        if Set(tasks.map(\.id)).count != tasks.count { return "Task identifiers must be unique." }
        return nil
    }

    public func shouldShield(at date: Date, calendar: Calendar) -> Bool {
        guard enabled, validationError == nil else { return false }
        let parts = calendar.dateComponents([.hour, .minute], from: date)
        let timeReady = (parts.hour! * 60 + parts.minute!) >= unlockMinute
        let today = Self.dayKey(date, calendar: calendar)
        let tasksReady = !tasks.isEmpty && tasks.allSatisfy { $0.completedDay == today }
        switch mode {
        case .choose: return false
        case .timeOnly: return !timeReady
        case .tasksOnly: return !tasksReady
        case .both: return !(timeReady && tasksReady)
        case .either: return !(timeReady || tasksReady)
        }
    }
}
