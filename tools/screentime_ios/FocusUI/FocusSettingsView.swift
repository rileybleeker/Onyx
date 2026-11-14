import SwiftUI
import FamilyControls
import FocusCore

struct FocusSettingsView: View {
    @State private var config = FocusConfiguration()
    @State private var message = "Focus is off until you explicitly enable it."
    @State private var taskTitle = ""
    @State private var showBlocked = false
    @State private var showAllowed = false
    @State private var confirmEnable = false
    @State private var loaded = false
    @ObservedObject private var habits = FocusHabitModel.shared
    @Environment(\.scenePhase) private var scenePhase

    private var timeBinding: Binding<Date> {
        Binding(get: {
            Calendar.current.date(from: DateComponents(year: 2001, month: 1, day: 1, hour: config.rule.unlockMinute / 60, minute: config.rule.unlockMinute % 60)) ?? Date()
        }, set: { date in
            let parts = Calendar.current.dateComponents([.hour, .minute], from: date)
            config.rule.unlockMinute = parts.hour! * 60 + parts.minute!
        })
    }

    var body: some View {
        Form {
            Section("Status") {
                Text(message)
                Text("Native iPhone enforcement. The time, apps and tasks below stay on this phone. Habits chosen in Onyx are read from Onyx (see Onyx habits).")
                    .font(.footnote).foregroundStyle(.secondary)
                Button("Turn off and unblock", role: .destructive) {
                    do { try FocusEnforcement.disable(); config.rule.enabled = false; message = "Focus is off." }
                    catch { message = "Could not save disabled state: \(error.localizedDescription). Revoke Onyx Screen Time access in Settings if needed." }
                }
            }
            Section("Onyx habits") {
                Text(FocusHabitSync.summary(habits.state))
                if let status = habits.state.status, !status.habits.isEmpty {
                    Text(status.rule == .and
                         ? "Rule from Onyx: habits AND time. Stays blocked after the unlock time until these are done."
                         : "Rule from Onyx: habits OR time. Finishing these unlocks early; the unlock time unlocks regardless.")
                        .font(.footnote).foregroundStyle(.secondary)
                    ForEach(Array(status.habits.enumerated()), id: \.offset) { _, habit in
                        HStack {
                            Text(habit.name)
                            Spacer()
                            Text(habit.done ? "Done" : "To do")
                                .foregroundStyle(habit.done ? Color.secondary : Color.orange)
                        }
                    }
                    Text("Answer for Onyx day \(status.day), received \(status.fetchedAt.formatted(date: .abbreviated, time: .shortened)).")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                LabeledContent("Last checked", value: habits.state.lastAttempt.map { $0.formatted(date: .abbreviated, time: .shortened) } ?? "Never")
                Button(habits.checking ? "Checking…" : "Check now") { Task { await habits.refresh() } }
                    .disabled(habits.checking)
                Text("Choose the habits and the rule in Onyx on the web (the install page). A habit counts once it is answered Yes for the day. This phone only checks when Onyx is opened, when you tap Check now, or when the \"Check Onyx Focus habits\" shortcut runs: iOS does not let it check in the background, so open Onyx after finishing your habits. If Onyx cannot be reached, the unlock time alone decides, so a failed check never keeps apps blocked past that time.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            Section("Unlock rules") {
                Picker("Unlock when", selection: $config.rule.mode) {
                    Text("Choose a rule").tag(UnlockMode.choose)
                    Text("Time reached only").tag(UnlockMode.timeOnly)
                    Text("All tasks done only").tag(UnlockMode.tasksOnly)
                    Text("Time reached AND all tasks done").tag(UnlockMode.both)
                    Text("Time reached OR all tasks done").tag(UnlockMode.either)
                }
                DatePicker("Not before", selection: timeBinding, displayedComponents: .hourAndMinute)
                Text("Default time: noon. Uses the iPhone's local calendar day. Daily tasks reset at midnight. Choose AND if both requirements must hold. When habits are chosen in Onyx, they and the Onyx rule replace this choice and the task list below; the time still applies.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            Section("Daily tasks") {
                ForEach(config.rule.tasks) { task in
                    HStack {
                        Text(task.title)
                        Spacer()
                        let done = task.completedDay == FocusRule.dayKey(Date(), calendar: .autoupdatingCurrent)
                        Button(done ? "Done" : "Mark done") { complete(task.id) }
                            .disabled(done || !config.rule.enabled)
                    }
                }
                .onDelete { offsets in config.rule.tasks.remove(atOffsets: offsets) }
                TextField("New daily task", text: $taskTitle)
                Button("Add task") {
                    let title = taskTitle.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !title.isEmpty { config.rule.tasks.append(FocusTask(title: title)); taskTitle = "" }
                }
                Text("Completions are self-reported here. Editing rules or tasks requires Save and enable below.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            Section("Apps and websites") {
                Button("Choose social apps to block") { showBlocked = true }
                Text("\(config.blocked.applicationTokens.count) apps, \(config.blocked.categoryTokens.count) categories, \(config.blocked.webDomainTokens.count) websites selected")
                Button("Allowed: choose LinkedIn app and website") { showAllowed = true }
                Toggle("I selected BOTH LinkedIn app and website", isOn: $config.linkedInConfirmed)
                Text("Select the LinkedIn app and its website in Allowed. Apple hides app identities from Onyx, so you must verify the selection. Exceptions take precedence within Onyx; other blockers can still restrict LinkedIn.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            Section {
                if let error = config.validationError { Text(error).foregroundStyle(.secondary) }
                Button("Save and enable Focus") { confirmEnable = true }
                    .disabled(!loaded || config.validationError != nil)
                Text("The preview is not enforcement: \(preview)")
                    .font(.footnote).foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Focus")
        .familyActivityPicker(isPresented: $showBlocked, selection: $config.blocked)
        .sheet(isPresented: $showAllowed) {
            NavigationStack {
                FamilyActivityPicker(selection: Binding(
                    get: { config.allowed },
                    set: { config.allowed = $0; config.linkedInConfirmed = false }
                ))
                    .navigationTitle("Allow LinkedIn")
                    .toolbar { Button("Done") { showAllowed = false } }
            }
        }
        .alert("Enable iPhone app blocking?", isPresented: $confirmEnable) {
            Button("Cancel", role: .cancel) {}
            Button("Enable") {
                do {
                    try FocusEnforcement.enable(config)
                    config = try FocusStorage.load()
                    message = "Focus enabled. iOS will shield the selected targets while your rule is unmet."
                } catch {
                    let problem = error.localizedDescription
                    reload()
                    message = "Could not update Focus: \(problem). Check the saved status before relying on enforcement."
                }
            }
        } message: {
            Text("Onyx will block your selected apps and websites using the rule above, with your selected LinkedIn app and website exceptions. You can turn Focus off here or revoke access in iOS Settings. This is a voluntary blocker, not tamper-proof.")
        }
        .task { reload(); await habits.refresh() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                FocusEnforcement.reconcile(); reload()
                Task { await habits.refresh() }
            }
        }
        .onChange(of: habits.revision) { _, _ in reload() }
    }

    private var preview: String {
        var rule = config.rule; rule.enabled = true
        guard config.validationError == nil else { return "finish configuration first." }
        return rule.shouldShield(at: Date(), calendar: .autoupdatingCurrent, onyx: habits.state) ? "your rule would block now." : "your rule would allow now."
    }

    private func reload() {
        do {
            config = try FocusStorage.load(); loaded = true
            message = config.rule.enabled ? "Focus is enabled. \(preview)" : "Focus is off."
        } catch { loaded = false; message = error.localizedDescription }
    }

    private func complete(_ id: UUID) {
        do {
            // Never save unrelated draft edits while marking a task done.
            try FocusEnforcement.complete(id)
            reload()
        } catch { message = "Completion could not be saved: \(error.localizedDescription)" }
    }
}
