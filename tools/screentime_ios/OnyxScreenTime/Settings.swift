import Foundation
import Security

/// App settings. The Onyx CI token lives in the Keychain (readable after the
/// first unlock, so the Shortcuts automation can run with the phone locked);
/// everything else is plain UserDefaults.
enum Settings {
    static let defaultBaseURL = "https://frontend-six-alpha-69.vercel.app"

    private static let defaults = UserDefaults.standard
    private static let service = "com.rileybleeker.onyxscreentime"
    private static let tokenAccount = "onyx-ci-token"

    static var baseURL: String {
        get { defaults.string(forKey: "baseURL") ?? defaultBaseURL }
        set { defaults.set(newValue.trimmingCharacters(in: .whitespacesAndNewlines), forKey: "baseURL") }
    }

    static var lastSync: Date? {
        get { defaults.object(forKey: "lastSync") as? Date }
        set { defaults.set(newValue, forKey: "lastSync") }
    }

    static var lastSummary: String? {
        get { defaults.string(forKey: "lastSummary") }
        set { defaults.set(newValue, forKey: "lastSummary") }
    }

    static var token: String? {
        get {
            let query: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service,
                kSecAttrAccount as String: tokenAccount,
                kSecReturnData as String: true,
                kSecMatchLimit as String: kSecMatchLimitOne,
            ]
            var out: AnyObject?
            guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess,
                  let data = out as? Data,
                  let value = String(data: data, encoding: .utf8),
                  !value.isEmpty
            else { return nil }
            return value
        }
        set {
            let base: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service,
                kSecAttrAccount as String: tokenAccount,
            ]
            SecItemDelete(base as CFDictionary)
            guard let value = newValue?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { return }
            var add = base
            add[kSecValueData as String] = Data(value.utf8)
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
            SecItemAdd(add as CFDictionary, nil)
        }
    }
}
