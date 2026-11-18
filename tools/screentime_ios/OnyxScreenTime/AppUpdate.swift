import Foundation
import SwiftUI
import UIKit

/// In-app update: on every open the app says hello to Onyx (its installed version, so Today's banner is right
/// without any shortcut) and learns the newest signed build. If it is newer, ContentView shows ONE button that
/// opens the over-the-air install link, so iOS shows its own install prompt.
///
/// Installs over the top need no re-trust and no Developer Mode change because every build is signed with the same
/// development certificate and bundle id (docs/iphone-updates.md). Only after a certificate change does iOS ask for
/// a trust step; the server then says needs_trust and the app offers a button straight to that Settings page.
///
/// POST /api/screen-time/latest-build is the third exact-path CI-token route this app uses (after /api/screen-time/usage
/// and /api/apple-health/import). No background task: it runs when the app comes to the foreground, at most every 5 minutes.
@MainActor
final class AppUpdateModel: ObservableObject {
    static let shared = AppUpdateModel()

    @Published var availableLabel: String?
    @Published var installURL: URL?
    @Published var needsTrust = false
    @Published var tapped = false
    /// "Updated to 0.1.0 (12)": set once, only when this build is not the one Onyx last confirmed AND the hello was accepted.
    @Published var confirmedLabel: String?

    private var lastCheck: Date?
    private let minInterval: TimeInterval = 5 * 60

    private struct Hello: Encodable {
        let variant: String
        let app_version: String
        let build: String
    }

    private struct Answer: Decodable {
        let version: String?
        let build: String?
        let install_url: String?
        let needs_trust: Bool?
    }

    static var variant: String {
#if ONYX_FOCUS
        return "focus"
#else
        return "default"
#endif
    }

    static var shortVersion: String { Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0" }
    static var buildNumber: String { Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "0" }

    /// Hello + newest build. Silent on any failure (offline, no token): the app works without it.
    func check(force: Bool = false) async {
        if !force, let last = lastCheck, Date().timeIntervalSince(last) < minInterval { return }
        guard let token = Settings.token,
              let url = URL(string: Settings.baseURL + "/api/screen-time/latest-build"), url.scheme == "https" else { return }
        lastCheck = Date()
        var request = URLRequest(url: url, timeoutInterval: 15)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(token, forHTTPHeaderField: "x-onyx-ci-token")
        let hello = Hello(variant: Self.variant, app_version: Self.shortVersion, build: Self.buildNumber)
        guard let body = try? JSONEncoder().encode(hello) else { return }
        request.httpBody = body
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let answer = try? JSONDecoder().decode(Answer.self, from: data),
              let version = answer.version, let build = answer.build else { return }
        confirmIfNew()
        if Self.isNewer(version: version, build: build),
           let text = answer.install_url, let link = URL(string: text), link.scheme == "itms-services" {
            availableLabel = "\(version) (\(build))"
            installURL = link
            needsTrust = answer.needs_trust ?? false
        } else {
            availableLabel = nil
            installURL = nil
            tapped = false
        }
    }

    /// The hello was accepted (HTTP 200), so Onyx now knows this build. Shown once per build, and not on the very first
    /// install (nothing was updated then): the confirmation the Today page waits for is also visible here.
    private func confirmIfNew() {
        let key = "onyx.confirmedBuild"
        let current = "\(Self.shortVersion) (\(Self.buildNumber))"
        let previous = UserDefaults.standard.string(forKey: key)
        guard previous != current else { return }
        UserDefaults.standard.set(current, forKey: key)
        if previous != nil { confirmedLabel = current }
    }

    /// Dotted numeric comparison, version first, then build.
    static func isNewer(version: String, build: String) -> Bool {
        func parts(_ s: String) -> [Int] { s.split(separator: ".").map { Int($0) ?? 0 } }
        func cmp(_ a: String, _ b: String) -> Int {
            let x = parts(a), y = parts(b)
            for i in 0..<max(x.count, y.count) {
                let d = (i < x.count ? x[i] : 0) - (i < y.count ? y[i] : 0)
                if d != 0 { return d < 0 ? -1 : 1 }
            }
            return 0
        }
        let v = cmp(shortVersion, version)
        return v != 0 ? v < 0 : cmp(buildNumber, build) < 0
    }

    func install() {
        guard let url = installURL else { return }
        tapped = true
        UIApplication.shared.open(url)
    }

    /// Straight to VPN & Device Management (the trust step after a new certificate). App-Prefs is not a documented
    /// scheme, so it may be refused on a given iOS; the fallback is this app's own Settings page.
    func openTrustSettings() {
        guard let prefs = URL(string: "App-Prefs:General&path=ManagedConfigurationList") else { return }
        UIApplication.shared.open(prefs) { ok in
            if !ok, let fallback = URL(string: UIApplication.openSettingsURLString) {
                UIApplication.shared.open(fallback)
            }
        }
    }
}

/// Screen Time sync on open: on the first launch of a new build, and otherwise at most every 30 minutes, so Onyx has
/// fresh Screen Time data without the Shortcut (which stays an optional background trigger).
enum AutoScreenTimeSync {
    static let minInterval: TimeInterval = 30 * 60
    private static var running = false

    @MainActor
    static func runIfDue() async {
        guard Settings.token != nil, !running else { return }
        let firstOfBuild = Settings.lastSeenBuild != AppUpdateModel.buildNumber
        if !firstOfBuild, let last = Settings.lastSync, Date().timeIntervalSince(last) < minInterval { return }
        running = true
        defer { running = false }
        _ = try? await SyncService.sync(days: 30)
        Settings.lastSeenBuild = AppUpdateModel.buildNumber
    }
}
