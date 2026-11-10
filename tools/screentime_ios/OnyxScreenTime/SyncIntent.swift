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
