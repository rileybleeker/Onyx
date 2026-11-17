import AppIntents

/// "Sync Screen Time to Onyx" — the action a daily Shortcuts automation runs.
/// It works without opening the app; the default re-sends the last 3 days so a
/// missed run heals itself (the server overwrites hours it already has).
struct SyncScreenTimeIntent: AppIntent {
    static var title: LocalizedStringResource = "Sync Screen Time to Onyx"
    static var description = IntentDescription("Reads recent Screen Time usage and sends it to Onyx.")
    static var openAppWhenRun: Bool = false

    @Parameter(title: "Days", default: 3, inclusiveRange: (1, 30))
    var days: Int

    func perform() async throws -> some IntentResult & ReturnsValue<String> {
        let summary = try await SyncService.sync(days: days)
        return .result(value: summary)
    }
}

#if !ONYX_FOCUS
/// "Sync Apple Health to Onyx" - for a Shortcuts automation "when Onyx is opened". HealthKit is
/// unreadable while the phone is locked, so a time-of-day automation cannot run this one (it would
/// find nothing); the app also syncs itself whenever it comes to the foreground.
struct SyncHealthIntent: AppIntent {
    static var title: LocalizedStringResource = "Sync Apple Health to Onyx"
    static var description = IntentDescription("Reads recent steps, walking metrics, mindful minutes, workouts and State of Mind from Apple Health and sends them to Onyx. Needs the phone unlocked.")
    static var openAppWhenRun: Bool = false

    @Parameter(title: "Days", default: 3, inclusiveRange: (1, 30))
    var days: Int

    func perform() async throws -> some IntentResult & ReturnsValue<String> {
        let summary = try await HealthSync.sync(days: days)
        return .result(value: summary)
    }
}

struct OnyxShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: SyncScreenTimeIntent(),
            phrases: ["Sync \(.applicationName)"],
            shortTitle: "Sync Screen Time",
            systemImageName: "hourglass"
        )
        AppShortcut(
            intent: SyncHealthIntent(),
            phrases: ["Sync health with \(.applicationName)"],
            shortTitle: "Sync Apple Health",
            systemImageName: "heart.text.square"
        )
    }
}
#else
struct OnyxShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: SyncScreenTimeIntent(),
            phrases: ["Sync \(.applicationName)"],
            shortTitle: "Sync Screen Time",
            systemImageName: "hourglass"
        )
    }
}
#endif
