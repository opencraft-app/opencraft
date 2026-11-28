import Foundation
import Security

enum MobileContentSource: Equatable {
    case bundled
    case selfHosted(url: String)

    var kind: String {
        switch self {
        case .bundled: return "bundled"
        case .selfHosted: return "self-hosted"
        }
    }

    var urlString: String {
        switch self {
        case .bundled: return ""
        case .selfHosted(let url): return url
        }
    }
}

enum ContentSourceError: Error {
    case invalidUrl
    case keychainFailure(OSStatus)
}

struct NativeMobileCopy {
    let sourceLabel: String
    let sourceDescription: String
    let bundledLabel: String
    let selfHostedLabel: String
    let urlLabel: String
    let urlPlaceholder: String
    let clearLabel: String
    let privacyHint: String
    let applyLabel: String
    let cancelLabel: String
    let invalidUrlError: String
    let saveFailedError: String
    let failedLabel: String
    let retryLabel: String

    static func loadFromBundle() -> NativeMobileCopy {
        let prefersChinese = (Locale.preferredLanguages.first ?? "").lowercased().hasPrefix("zh")
        var catalog: [String: String] = [:]
        if prefersChinese,
           let url = Bundle.main.url(forResource: "zh-CN", withExtension: "json", subdirectory: "WebBundle"),
           let data = try? Data(contentsOf: url),
           let parsed = (try? JSONSerialization.jsonObject(with: data)) as? [String: String] {
            catalog = parsed
        }
        func msg(_ key: String, _ fallback: String) -> String {
            return catalog[key] ?? fallback
        }
        return NativeMobileCopy(
            sourceLabel: msg("mobile.source", "Workspace source"),
            sourceDescription: msg("mobile.description", "Use the built-in workspace or open your own OpenCraft website."),
            bundledLabel: msg("mobile.bundled", "Built-in workspace"),
            selfHostedLabel: msg("mobile.consent", "Load my self-hosted website"),
            urlLabel: msg("mobile.url", "HTTPS address"),
            urlPlaceholder: "https://",
            clearLabel: msg("mobile.cancel", "Clear"),
            privacyHint: msg("mobile.privacy", "Sign in on your server. This mode uses a private browsing session and does not receive the built-in workspace's credentials or native bridge. Switching workspaces closes the current view."),
            applyLabel: msg("mobile.apply", "Open workspace"),
            cancelLabel: msg("mobile.cancel", "Cancel"),
            invalidUrlError: msg("mobile.invalid", "Enter an HTTPS address without credentials, query parameters or a fragment."),
            saveFailedError: msg("mobile.saveFailed", "The selection could not be saved. Your current workspace has not changed."),
            failedLabel: msg("mobile.failed", "The workspace could not open. Retry or choose another source."),
            retryLabel: msg("mobile.retry", "Retry")
        )
    }
}

enum SourceStore {
    private static let service = "app.opencraft.mobile"
    private static let account = "opencraft.mobile.content-source.v1"

    static func validateSelfHostedUrl(_ raw: String) throws -> MobileContentSource {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.utf8.count <= 2048,
              let components = URLComponents(string: trimmed),
              components.scheme?.lowercased() == "https",
              let host = components.host, !host.isEmpty,
              components.user == nil,
              components.password == nil,
              components.query == nil,
              components.fragment == nil,
              let normalized = components.url?.absoluteString else {
            throw ContentSourceError.invalidUrl
        }
        return .selfHosted(url: normalized)
    }

    static func read() throws -> MobileContentSource {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound {
            return .bundled
        }
        if status == errSecMissingEntitlement {
            guard let raw = UserDefaults.standard.string(forKey: account) else { return .bundled }
            return try decodeJsonData(Data(raw.utf8))
        }
        guard status == errSecSuccess, let data = item as? Data else {
            throw ContentSourceError.keychainFailure(status)
        }
        return try decodeJsonData(data)
    }

    private static func decodeJsonData(_ data: Data) throws -> MobileContentSource {
        guard let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let version = json["version"] as? Int, version == 1,
              let kind = json["kind"] as? String else {
            throw ContentSourceError.invalidUrl
        }
        if kind == "bundled" {
            return .bundled
        }
        if kind == "self-hosted", let url = json["url"] as? String {
            return try validateSelfHostedUrl(url)
        }
        throw ContentSourceError.invalidUrl
    }

    static func write(_ source: MobileContentSource) throws {
        var payload: [String: Any] = ["version": 1, "kind": source.kind]
        if case .selfHosted(let url) = source {
            payload["url"] = url
        }
        let data = try JSONSerialization.data(withJSONObject: payload)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let updateStatus = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if updateStatus == errSecMissingEntitlement {
            UserDefaults.standard.set(String(decoding: data, as: UTF8.self), forKey: account)
            return
        }
        if updateStatus == errSecItemNotFound {
            var insert = query
            for (k, v) in attributes { insert[k] = v }
            let addStatus = SecItemAdd(insert as CFDictionary, nil)
            if addStatus == errSecMissingEntitlement {
                UserDefaults.standard.set(String(decoding: data, as: UTF8.self), forKey: account)
                return
            }
            guard addStatus == errSecSuccess else {
                throw ContentSourceError.keychainFailure(addStatus)
            }
        } else if updateStatus != errSecSuccess {
            throw ContentSourceError.keychainFailure(updateStatus)
        }
    }

    static func httpsOrigin(_ raw: String) -> String? {
        guard let components = URLComponents(string: raw),
              components.scheme?.lowercased() == "https",
              let host = components.host?.lowercased(), !host.isEmpty else {
            return nil
        }
        if let port = components.port, port != 443 {
            return "https://\(host):\(port)"
        }
        return "https://\(host)"
    }

    static func isAllowedSelfHostedNavigation(source: MobileContentSource, targetUrl: String) -> Bool {
        guard case .selfHosted(let configuredUrl) = source,
              let sourceOrigin = httpsOrigin(configuredUrl),
              let targetOrigin = httpsOrigin(targetUrl) else {
            return false
        }
        if targetOrigin == sourceOrigin {
            return true
        }
        let env = ProcessInfo.processInfo.environment
        if let siteOriginRaw = env["OPENCRAFT_SELF_HOSTED_SITE_ORIGIN"],
           let authOriginRaw = env["OPENCRAFT_SELF_HOSTED_AUTH_ORIGIN"],
           let siteOrigin = httpsOrigin(siteOriginRaw),
           let authOrigin = httpsOrigin(authOriginRaw),
           siteOrigin != authOrigin,
           siteOrigin == sourceOrigin,
           targetOrigin == authOrigin {
            return true
        }
        return false
    }
}
