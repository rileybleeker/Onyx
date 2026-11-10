import DeviceActivity
import FamilyControls
import SwiftUI
import UIKit

@MainActor
final class AppModel: ObservableObject {
    @Published var status = ""
    @Published var hasDataAccess = false
    @Published var busy = false
    @Published var log = ""
    @Published var baseURL = Settings.baseURL
    @Published var tokenInput = ""
    @Published var tokenSaved = Settings.token != nil
    @Published var days = 30
    @Published var useLivePolicy = true
    @Published var lastSummary = Settings.lastSummary ?? "Never synced"

    private var lastJSON: String?

    init() {
        refreshStatus()
    }

    func refreshStatus() {
        status = ScreenTimeExporter.authorizationStatus.description
        hasDataAccess = ScreenTimeExporter.hasDataAccess
    }

    func append(_ line: String) {
        let stamp = Date().formatted(date: .omitted, time: .standard)
        log = "[\(stamp)] \(line)\n" + log
    }

    func authorize() async {
        busy = true
        defer { busy = false }
        do {
            try await ScreenTimeExporter.requestAccess()
            append("Authorization request finished.")
        } catch {
            append("Authorization failed: \(error.localizedDescription) (\(error))")
        }
        refreshStatus()
        append("Status: \(status)")
    }

    func saveSettings() {
        Settings.baseURL = baseURL
        if !tokenInput.isEmpty {
            Settings.token = tokenInput
            tokenInput = ""
        }
        tokenSaved = Settings.token != nil
        append("Settings saved. Token \(tokenSaved ? "stored in Keychain" : "missing").")
    }

    private var policy: DeviceActivityData.Policy { useLivePolicy ? .live : .cached }

    /// Reads Screen Time and shows what came back, without sending anything.
    func preview() async {
        busy = true
        defer { busy = false }
        refreshStatus()
        do {
            let result = try await ScreenTimeExporter.fetch(days: days, policy: policy)
            append(SyncService.describe(result, sent: nil))
            append("Device: \(result.deviceName ?? "?") / \(result.deviceModel ?? "?")")

            var perApp: [String: Double] = [:]
            for segment in result.segments {
                for item in segment.items where item.kind == "app" {
                    perApp[item.name ?? item.identifier, default: 0] += item.seconds
                }
            }
            let top = perApp.sorted { $0.value > $1.value }.prefix(8)
                .map { "\($0.key) \(Int($0.value / 60))m" }
                .joined(separator: ", ")
            append("Top apps: \(top.isEmpty ? "(no per-app rows)" : top)")

            let encoder = SyncService.encoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            let sample = SyncService.payload(for: result, segments: Array(result.segments.suffix(24)))
            lastJSON = String(data: try encoder.encode(sample), encoding: .utf8)
        } catch {
            append("Preview failed: \(error.localizedDescription) (\(error))")
        }
    }

    func sync() async {
        busy = true
        defer { busy = false }
        refreshStatus()
        do {
            let summary = try await SyncService.sync(days: days, policy: policy)
            lastSummary = summary
            append(summary)
        } catch {
            append("Sync failed: \(error.localizedDescription) (\(error))")
        }
    }

    func copyJSON() {
        guard let lastJSON else {
            append("Nothing to copy yet — run Preview first.")
            return
        }
        UIPasteboard.general.string = lastJSON
        append("Copied the last 24 hours as JSON (\(lastJSON.count) characters).")
    }

    func copyLog() {
        UIPasteboard.general.string = log
    }
}

struct ContentView: View {
    @StateObject private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        NavigationStack {
            Form {
                Section("Screen Time access") {
                    LabeledContent("Status", value: model.status)
                    if model.hasDataAccess {
                        Label("Data access granted", systemImage: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                    } else {
                        Button("Grant access") { Task { await model.authorize() } }
                        Text("Needs “approvedWithDataAccess”. Only one app can hold it at a time.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }

                Section("Onyx") {
                    TextField("Base URL", text: $model.baseURL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField(model.tokenSaved ? "Token saved — paste to replace" : "Paste ONYX_CI_TOKEN", text: $model.tokenInput)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Button("Save") { model.saveSettings() }
                }

                Section("Sync") {
                    Stepper("Days back: \(model.days)", value: $model.days, in: 1...30)
                    Toggle("Live data (off = cached)", isOn: $model.useLivePolicy)
                    Button("Preview (read only)") { Task { await model.preview() } }
                    Button("Sync to Onyx") { Task { await model.sync() } }
                        .disabled(!model.tokenSaved)
                    Text(model.lastSummary)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                .disabled(model.busy)

                Section("Log") {
                    HStack {
                        Button("Copy log") { model.copyLog() }
                        Spacer()
                        Button("Copy JSON sample") { model.copyJSON() }
                    }
                    .buttonStyle(.borderless)
                    Text(model.log.isEmpty ? "No activity yet." : model.log)
                        .font(.system(.footnote, design: .monospaced))
                        .textSelection(.enabled)
                }
            }
            .navigationTitle("Onyx Screen Time")
            .overlay {
                if model.busy { ProgressView().controlSize(.large) }
            }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { model.refreshStatus() }
            }
            // A new process always starts at "notDetermined"; asking again on
            // launch restores the granted status (and shows the system prompt
            // on the very first launch, as Apple recommends).
            .task {
                _ = await ScreenTimeExporter.restoreDataAccess()
                model.refreshStatus()
            }
        }
    }
}
