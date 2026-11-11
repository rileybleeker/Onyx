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
                Text("Native iPhone enforcement. These settings and tasks stay on this phone; web tasks are not synced yet.")
                    .font(.footnote).foregroundStyle(.secondary)
                Button("Turn off and unblock", role: .destructive) {
                    do { try FocusEnforcement.disable(); config.rule.enabled = false; message = "Focus is off." }
                    catch { message = "Could not save disabled state: \(error.localizedDescription). Revoke Onyx Screen Time access in Settings if needed." }
                }
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
                Text("Default time: noon. Uses the iPhone's local calendar day. Daily tasks reset at midnight. Choose AND if both requirements must hold.")
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
                Button("Allowed: choose LinkedIn") { showAllowed = true }
                Toggle("I selected LinkedIn in Allowed apps", isOn: $config.linkedInConfirmed)
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
                FamilyActivityPicker(selection: $config.allowed)
                    .navigationTitle("Allow LinkedIn")
                    .toolbar { Button("Done") { showAllowed = false } }
            }
        }
        .onChange(of: config.allowed) { _, _ in config.linkedInConfirmed = false }
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
            Text("Onyx will block your selected apps and websites using the rule above, with your selected LinkedIn exception. You can turn Focus off here or revoke access in iOS Settings. This is a voluntary blocker, not tamper-proof.")
        }
        .task { reload() }
        .onChange(of: scenePhase) { _, phase in if phase == .active { FocusEnforcement.reconcile(); reload() } }
    }

    private var preview: String {
        var rule = config.rule; rule.enabled = true
        guard config.validationError == nil else { return "finish configuration first." }
        return rule.shouldShield(at: Date(), calendar: .autoupdatingCurrent) ? "your rule would block now." : "your rule would allow now."
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
