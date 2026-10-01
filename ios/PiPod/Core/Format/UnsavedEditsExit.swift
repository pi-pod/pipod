import Foundation

/// What leaving a screen with unsaved edits should do.
///
/// The system back button cannot be intercepted: by the time a view hears about
/// it the pop has happened and the typed text is gone. Every editor that can
/// hold unsaved work therefore hides that button while it matters and offers a
/// Cancel of its own, and this is the one rule all of them ask.
public enum UnsavedEditsExit: Equatable, Sendable {
    /// Nothing is at stake: leaving is just leaving.
    case leave
    /// Ask before dropping what was typed.
    case confirmDiscard
    /// A save is in flight. Leaving now would strand it mid-write.
    case stay

    public static func decide(isDirty: Bool, isSaving: Bool) -> UnsavedEditsExit {
        if isSaving { return .stay }
        return isDirty ? .confirmDiscard : .leave
    }

    /// Whether the screen has to own its own exit — hiding the system back
    /// button, refusing an interactive dismissal, and showing a Cancel.
    public var interceptsNavigation: Bool { self != .leave }
}
