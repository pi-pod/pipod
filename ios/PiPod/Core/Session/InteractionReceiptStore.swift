import Foundation

/// Durable phrasing of approval transcript receipts, keyed by interaction id.
///
/// The reducer writes "You confirmed …" / "You chose X for …" / "You answered …"
/// while the answer is still known locally, but a reattach or a cold restart
/// replays an `interaction_resolved` event that carries no answer. Without this
/// every receipt would come back as the generic "Resolved {title}.", so the
/// specific wording is kept here when it is emitted and read back when a
/// replayed resolution has none.
///
/// An in-memory cache keeps reads synchronous, a backing store that refuses to
/// answer must not take the transcript down with it, and the store is bounded so
/// it cannot grow forever.
@MainActor
public enum InteractionReceiptStore {
    /// Upper bound on retained receipts.
    public static let maxEntries = 200

    private static let orderKey = "interaction-receipt-order"
    private static let keyPrefix = "interaction-receipt-"

    private static var cache: [String: String] = [:]
    /// Insertion order, oldest first, for FIFO eviction. Persisted alongside the
    /// receipts so a restart keeps the same bound.
    private static var order: [String] = []
    private static var hydrated = false

    private static var defaults: UserDefaults? = .standard

    public static func key(for interactionID: String) -> String {
        keyPrefix + interactionID
    }

    /// The receipt stored for `interactionID`, or nil when none was kept.
    public static func readCached(_ interactionID: String) -> String? {
        guard !interactionID.isEmpty else { return nil }
        hydrateIfNeeded()
        if let cached = cache[interactionID], !cached.isEmpty { return cached }
        guard let stored = defaults?.string(forKey: key(for: interactionID)),
              !stored.isEmpty
        else { return nil }
        cache[interactionID] = stored
        if !order.contains(interactionID) {
            order.append(interactionID)
            evictExcess()
        }
        return stored
    }

    /// Keeps `receipt` for `interactionID`, evicting the oldest entries past
    /// `maxEntries`. An empty id or an empty receipt is ignored: a generic
    /// fallback must never overwrite a specific wording with nothing.
    public static func writeCached(_ interactionID: String, _ receipt: String) {
        guard !interactionID.isEmpty, !receipt.isEmpty else { return }
        hydrateIfNeeded()
        cache[interactionID] = receipt
        order.removeAll { $0 == interactionID }
        order.append(interactionID)
        evictExcess()
        defaults?.set(receipt, forKey: key(for: interactionID))
        persistOrder()
    }

    // MARK: - Hydration and bounds

    private static func hydrateIfNeeded() {
        guard !hydrated else { return }
        hydrated = true
        guard let defaults else { return }
        var seen = Set(cache.keys).union(order)
        for id in defaults.stringArray(forKey: orderKey) ?? [] {
            guard order.count < maxEntries else { break }
            guard cache[id] == nil, seen.insert(id).inserted else { continue }
            if let text = defaults.string(forKey: key(for: id)), !text.isEmpty {
                cache[id] = text
                order.append(id)
            }
        }
        // Entries that predate the order list still count toward the bound.
        for storedKey in defaults.dictionaryRepresentation().keys {
            guard order.count < maxEntries else { break }
            guard storedKey.hasPrefix(keyPrefix) else { continue }
            let id = String(storedKey.dropFirst(keyPrefix.count))
            guard !id.isEmpty, cache[id] == nil, seen.insert(id).inserted else { continue }
            if let text = defaults.string(forKey: storedKey), !text.isEmpty {
                cache[id] = text
                order.append(id)
            }
        }
        evictExcess()
        persistOrder()
    }

    private static func evictExcess() {
        while order.count > maxEntries {
            let oldest = order.removeFirst()
            cache.removeValue(forKey: oldest)
            defaults?.removeObject(forKey: key(for: oldest))
        }
    }

    private static func persistOrder() {
        defaults?.set(order, forKey: orderKey)
    }

    /// Drops every receipt, on sign-out: they quote what the last person
    /// answered, and the transcripts they belong to are no longer readable.
    public static func purgeAll() {
        cache.removeAll()
        order.removeAll()
        hydrated = false
        guard let defaults else { return }
        for storedKey in defaults.dictionaryRepresentation().keys
        where storedKey.hasPrefix(keyPrefix) || storedKey == orderKey {
            defaults.removeObject(forKey: storedKey)
        }
    }

    // MARK: - Testing

    public static var cacheCountForTesting: Int { cache.count }

    /// Points the store at a scratch suite and empties the cache, so a test can
    /// exercise eviction without touching the real user's receipts.
    public static func resetForTesting(defaults replacement: UserDefaults? = nil) {
        purgeAll()
        Self.defaults = replacement ?? .standard
    }
}
