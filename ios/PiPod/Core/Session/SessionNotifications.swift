import Foundation

/// A resolution, carrying the answer when the resolver knows it so a live
/// session transcript can phrase the specific "You confirmed / chose / answered"
/// receipt instead of the generic replay fallback. Badge listeners ignore the
/// response; transcript listeners use it while they still hold the card.
public struct InteractionResolvedEvent: Sendable {
    public let id: String
    public let response: JSONValue?

    public init(id: String, response: JSONValue? = nil) {
        self.id = id
        self.response = response
    }
}

/// Cancels an observer registration. Dropping it unsubscribes, so a screen that
/// simply lets its token go out of scope cannot leak a stale callback.
@MainActor
public final class NotificationToken {
    private let cancel: () -> Void

    init(cancel: @escaping () -> Void) { self.cancel = cancel }

    deinit {
        // The last reference to a token can be released from any isolation —
        // a detached task holding the object that owns it, a URLSession
        // callback, an autorelease pool drained off the main thread. There is
        // no way to assert otherwise from a `deinit`, and `assumeIsolated` off
        // the main actor is a crash rather than a fallback, so the cancel is
        // handed to the main actor instead of assumed to be on it.
        let cancel = cancel
        Task { @MainActor in cancel() }
    }
}

/// A main-actor broadcast with no global `NotificationCenter` name to collide
/// with, and typed payloads so a listener cannot mis-read `userInfo`.
@MainActor
public final class SessionBroadcast<Payload> {
    private var observers: [UUID: (Payload) -> Void] = [:]

    public init() {}

    public func addObserver(_ handler: @escaping (Payload) -> Void) -> NotificationToken {
        let key = UUID()
        observers[key] = handler
        return NotificationToken { [weak self] in self?.observers[key] = nil }
    }

    public func post(_ payload: Payload) {
        // A copy, so an observer that unsubscribes while being called does not
        // mutate the collection mid-iteration.
        for handler in Array(observers.values) { handler(payload) }
    }
}

/// Process-local channels that keep approval state in step across the live
/// session, the approvals inbox, and the tab badge.
@MainActor
public enum SessionNotifications {
    public static let interactionResolved = SessionBroadcast<InteractionResolvedEvent>()
    /// A new approval was raised. Carries the interaction id.
    public static let interactionPending = SessionBroadcast<String>()

    public static func postResolved(id: String, response: JSONValue? = nil) {
        interactionResolved.post(InteractionResolvedEvent(id: id, response: response))
    }

    public static func postPending(id: String) {
        interactionPending.post(id)
    }
}
