import AppIntents
import Combine
import Foundation
import FocusCore

/// Asks Onyx whether today's chosen habits are done and re-applies the Focus
/// shield. App only: the monitor extension never uses the network, it reads
/// the answer this stored in the App Group.
///
/// Runs when the app comes to the foreground, when the Focus screen's
/// "Check now" is tapped, and when the "Check Onyx Focus habits" shortcut
/// action runs. iOS gives the app no other moment to check, so finishing the
/// habits does not unlock anything until one of those happens.
enum FocusHabitSync {
    /// Short: this runs on every foreground and must not hold the screen up.
    static let timeout: TimeInterval = 8

    enum Failure: Error {
        case noToken, badURL, network(String), refused(Int), server(Int), unreadable

        var message: String {
            switch self {
            case .noToken: return "No Onyx token is saved in this app."
            case .badURL: return "The Onyx URL in this app is not valid."
            case .network(let detail): return "No answer from Onyx (\(detail))."
            case .refused(let code): return "Onyx refused the token (HTTP \(code))."
            case .server(let code): return "Onyx answered with an error (HTTP \(code))."
            case .unreadable: return "Onyx's answer could not be read."
            }
        }
    }

    /// One GET to the route the token opens. Read-only; sends nothing but the token header.
    static func fetch(now: Date = Date()) async -> Result<OnyxHabitStatus, Failure> {
        guard let token = Settings.token else { return .failure(.noToken) }
        guard let url = URL(string: Settings.baseURL + "/api/focus/unlock-status"), url.scheme == "https" else {
            return .failure(.badURL)
        }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        request.httpMethod = "GET"
        request.setValue(token, forHTTPHeaderField: "x-onyx-ci-token")
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        let reply: (Data, URLResponse)
        do {
            reply = try await URLSession.shared.data(for: request)
        } catch {
            return .failure(.network(error.localizedDescription))
        }
        let (data, response) = reply
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        if code == 401 || code == 403 { return .failure(.refused(code)) }
        guard code == 200 else { return .failure(.server(code)) }
        guard let status = try? OnyxHabitStatus.parse(data, fetchedAt: now) else { return .failure(.unreadable) }
        return .success(status)
    }

    /// Fetches, stores the outcome and re-applies the shield. Never throws: a
    /// failure is stored too, and the rule then falls back to the unlock time
    /// alone (OnyxHabitState.gate), so a failed check never blocks past it.
    @discardableResult
    static func check() async -> OnyxHabitState {
        let now = Date()
        let outcome = await fetch(now: now)
        var state = OnyxHabitState()
        do {
            state = try FocusStorage.withLock { () -> OnyxHabitState in
                var stored = FocusHabitStorage.load()
                switch outcome {
                case .success(let status): stored.recordSuccess(status)
                case .failure(let failure): stored.recordFailure(failure.message, at: now)
                }
                try FocusHabitStorage.save(stored)
                return stored
            }
        } catch {
            // The App Group is unavailable, so nothing can be stored and the
            // phone's own rule keeps applying. Report the failure on screen.
            state.recordFailure("Could not store the answer: \(error.localizedDescription)", at: now)
        }
        FocusEnforcement.reconcile()
        return state
    }

    /// One line for the Focus screen and the shortcut result.
    static func summary(_ state: OnyxHabitState, now: Date = Date()) -> String {
        switch state.gate(at: now, calendar: .autoupdatingCurrent) {
        case .notConfigured:
            if state.status == nil, let error = state.lastError { return "Onyx could not be checked: \(error) This phone's own rule applies." }
            return state.status == nil ? "Onyx habits have not been checked yet." : "No habits are chosen in Onyx. This phone's own rule applies."
        case .unknown(.checkFailed):
            return "Last check failed: \(state.lastError ?? "unknown error") Using the unlock time only until a check succeeds."
        case .unknown(.otherDay):
            return "Onyx answered for \(state.status?.day ?? "another day"), not for this phone's today. Using the unlock time only."
        case .notCheckedToday(let rule):
            let head = "No answer for today yet (before 6 AM Onyx still counts the previous day). "
            return head + (rule == .and
                ? "Stays blocked after the unlock time until Onyx is opened and the habits are done."
                : "Unlocks at the unlock time; to unlock earlier, finish the habits and open Onyx.")
        case .known(let rule, let done):
            let left = state.status?.outstanding.count ?? 0
            let failed = state.lastError.map { " Last check failed (\($0)); keeping the answer Onyx confirmed earlier today." } ?? ""
            switch (rule, done) {
            case (.or, true): return "All chosen habits are done: unlocked early." + failed
            case (.or, false): return "\(left) habit\(left == 1 ? "" : "s") to do. Unlocks when done, or at the unlock time."
            case (.and, true): return "All chosen habits are done: unlocks at the unlock time." + failed
            case (.and, false): return "\(left) habit\(left == 1 ? "" : "s") to do. Stays blocked after the unlock time until done."
            }
        }
    }
}

/// Shared by the app root (checks on every foreground) and the Focus screen.
@MainActor
final class FocusHabitModel: ObservableObject {
    static let shared = FocusHabitModel()

    @Published private(set) var state = FocusHabitStorage.load()
    @Published private(set) var checking = false
    /// Bumped after every finished check so views can re-read the saved rule.
    @Published private(set) var revision = 0

    private var inFlight: Task<OnyxHabitState, Never>?

    /// Coalesces overlapping calls (app root and Focus screen both fire on foreground).
    func refresh() async {
        if let inFlight {
            _ = await inFlight.value
            return
        }
        let task = Task.detached { await FocusHabitSync.check() }
        inFlight = task
        checking = true
        let next = await task.value
        state = next
        inFlight = nil
        checking = false
        revision += 1
    }
}

/// "Check Onyx Focus habits": the same check as opening the app, as a
/// Shortcuts action, so a personal automation can run it without opening Onyx.
struct CheckFocusHabitsIntent: AppIntent {
    static var title: LocalizedStringResource = "Check Onyx Focus habits"
    static var description = IntentDescription("Asks Onyx whether today's chosen habits are done and updates the Focus block.")
    static var openAppWhenRun: Bool = false

    func perform() async throws -> some IntentResult & ReturnsValue<String> {
        let state = await FocusHabitSync.check()
        return .result(value: FocusHabitSync.summary(state))
    }
}
