import Foundation
import OSLog
import Security

enum SessionTokenKeys {
    static let access = "oidc.access_token"
    static let refresh = "oidc.refresh_token"
    static let id = "oidc.id_token"
}

/// Where the refresh token, ID token and in-flight authorization proof live
/// between launches.
public protocol SessionTokenStorage: Sendable {
    func read(_ key: String) async -> String?
    func write(_ key: String, value: String) async
    func delete(_ key: String) async
}

/// Keychain-backed storage, scoped to this app and this device.
///
/// `AfterFirstUnlockThisDeviceOnly` is deliberate: a background push can wake the
/// app and refresh, which needs the token readable while the phone is locked, but
/// the credential must not ride an iCloud backup onto another device.
public struct KeychainTokenStorage: SessionTokenStorage {
    public static let service = "com.pipod.app.auth"

    private let service: String
    private let log = Logger(subsystem: "com.pipod.app", category: "keychain")

    public init(service: String = KeychainTokenStorage.service) {
        self.service = service
    }

    public func read(_ key: String) async -> String? {
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: key,
            kSecReturnData: true,
            kSecMatchLimit: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else {
            log.error("Keychain read for \(key, privacy: .public) failed: \(status)")
            return nil
        }
        return String(data: data, encoding: .utf8)
    }

    public func write(_ key: String, value: String) async {
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: key,
        ]
        SecItemDelete(query as CFDictionary)
        var attributes = query
        attributes[kSecValueData] = Data(value.utf8)
        attributes[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(attributes as CFDictionary, nil)
        if status != errSecSuccess {
            // A refused write costs the person a sign-in next launch; it must not
            // take down the launch that is happening now.
            log.error("Keychain write for \(key, privacy: .public) failed: \(status)")
        }
    }

    public func delete(_ key: String) async {
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: key,
        ]
        SecItemDelete(query as CFDictionary)
    }
}

/// In-memory storage for tests and previews.
public actor MemoryTokenStorage: SessionTokenStorage {
    private var values: [String: String]

    public init(values: [String: String] = [:]) {
        self.values = values
    }

    public func read(_ key: String) async -> String? { values[key] }
    public func write(_ key: String, value: String) async { values[key] = value }
    public func delete(_ key: String) async { values.removeValue(forKey: key) }
}

struct PersistedCredentials: Sendable {
    let accessToken: String?
    let refreshToken: String?
    let idToken: String?
}

/// Serializes complete credential snapshots and reads. The lock only appends a
/// task to the tail; keychain work itself is asynchronous and never holds it.
final class CredentialPersistenceLane: @unchecked Sendable {
    private let lock = NSLock()
    private let storage: SessionTokenStorage
    private let tokens: TokenStore
    private var tail: Task<Void, Never>?
    private var latestSubmittedRevision: UInt64 = 0

    init(storage: SessionTokenStorage, tokens: TokenStore) {
        self.storage = storage
        self.tokens = tokens
    }

    /// Called synchronously from TokenStore's actor mutation, preserving the
    /// accepted snapshot's place in the local credential write order.
    func submit(_ snapshot: TokenSnapshot) {
        lock.withLock {
            guard snapshot.version.revision > latestSubmittedRevision else { return }
            latestSubmittedRevision = snapshot.version.revision
            let previous = tail
            let storage = self.storage
            let tokens = self.tokens
            tail = Task {
                await previous?.value
                guard await tokens.matches(snapshot.version) else { return }
                await Self.persist(snapshot, to: storage)
            }
        }
    }

    func drain() async {
        let pending = lock.withLock { tail }
        await pending?.value
    }

    /// Reads the tuple as one queued operation so it cannot observe the middle
    /// of a replacement or clear batch.
    func read() async -> PersistedCredentials {
        let task: Task<PersistedCredentials, Never> = lock.withLock {
            let previous = tail
            let storage = self.storage
            let readTask = Task<PersistedCredentials, Never> {
                await previous?.value
                let access = await storage.read(SessionTokenKeys.access)
                let refresh = await storage.read(SessionTokenKeys.refresh)
                let id = await storage.read(SessionTokenKeys.id)
                return PersistedCredentials(
                    accessToken: access, refreshToken: refresh, idToken: id
                )
            }
            tail = Task { _ = await readTask.value }
            return readTask
        }
        return await task.value
    }

    private static func persist(_ snapshot: TokenSnapshot, to storage: SessionTokenStorage) async {
        if let refresh = snapshot.refreshToken, !refresh.isEmpty {
            await storage.delete(SessionTokenKeys.access)
            await storage.write(SessionTokenKeys.refresh, value: refresh)
        } else {
            await storage.delete(SessionTokenKeys.refresh)
            if let access = snapshot.accessToken, !access.isEmpty {
                await storage.write(SessionTokenKeys.access, value: access)
            } else {
                await storage.delete(SessionTokenKeys.access)
            }
        }
        if let id = snapshot.idToken, !id.isEmpty {
            await storage.write(SessionTokenKeys.id, value: id)
        } else {
            await storage.delete(SessionTokenKeys.id)
        }
    }
}
