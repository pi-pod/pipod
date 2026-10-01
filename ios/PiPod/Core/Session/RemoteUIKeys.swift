import SwiftUI

/// Translates key presses into the raw bytes pi-tui would have read from stdin.
///
/// Extension components in the pod run against a real terminal input stream, so
/// the app has to speak the sequences a terminal emits — anything else arrives
/// as garbage characters in someone's TUI.
public enum RemoteUIKeys {
    /// Returns nil for keys a terminal does not report at all (bare modifiers,
    /// media keys), so the caller can leave them to the app's own shortcuts.
    public static func encode(_ press: KeyPress) -> String? {
        let modifiers = press.modifiers
        return encode(
            key: press.key,
            characters: press.characters,
            control: modifiers.contains(.control),
            alt: modifiers.contains(.option),
            shift: modifiers.contains(.shift),
            meta: modifiers.contains(.command)
        )
    }

    /// The same mapping over plain values. `KeyPress` has no public
    /// initializer, so this is the seam the tests drive.
    static func encode(
        key: KeyEquivalent,
        characters: String,
        control: Bool = false,
        alt: Bool = false,
        shift: Bool = false,
        meta: Bool = false
    ) -> String? {
        // A command chord belongs to the app (copy, paste), not the pod.
        if meta { return nil }

        if let named = named(key, shift: shift) {
            return alt ? "\u{1b}" + named : named
        }
        if control {
            guard let controlled = controlSequence(characters) else { return nil }
            return alt ? "\u{1b}" + controlled : controlled
        }
        guard !characters.isEmpty else { return nil }
        return alt ? "\u{1b}" + characters : characters
    }

    private static func named(_ key: KeyEquivalent, shift: Bool) -> String? {
        switch key {
        case .return: return "\r"
        case .tab: return shift ? "\u{1b}[Z" : "\t"
        case .delete: return "\u{7f}"
        case .escape: return "\u{1b}"
        case .deleteForward: return "\u{1b}[3~"
        case .upArrow: return "\u{1b}[A"
        case .downArrow: return "\u{1b}[B"
        case .rightArrow: return "\u{1b}[C"
        case .leftArrow: return "\u{1b}[D"
        case .home: return "\u{1b}[H"
        case .end: return "\u{1b}[F"
        case .pageUp: return "\u{1b}[5~"
        case .pageDown: return "\u{1b}[6~"
        case .clear: return "\u{1b}[2~"
        default: return functionKeys[key]
        }
    }

    /// F1–F4 are the SS3 forms; F5–F12 are CSI with a numeric parameter, which
    /// is what pi-tui reads.
    private static let functionKeys: [KeyEquivalent: String] = [
        KeyEquivalent("\u{F704}"): "\u{1b}OP",
        KeyEquivalent("\u{F705}"): "\u{1b}OQ",
        KeyEquivalent("\u{F706}"): "\u{1b}OR",
        KeyEquivalent("\u{F707}"): "\u{1b}OS",
        KeyEquivalent("\u{F708}"): "\u{1b}[15~",
        KeyEquivalent("\u{F709}"): "\u{1b}[17~",
        KeyEquivalent("\u{F70A}"): "\u{1b}[18~",
        KeyEquivalent("\u{F70B}"): "\u{1b}[19~",
        KeyEquivalent("\u{F70C}"): "\u{1b}[20~",
        KeyEquivalent("\u{F70D}"): "\u{1b}[21~",
        KeyEquivalent("\u{F70E}"): "\u{1b}[23~",
        KeyEquivalent("\u{F70F}"): "\u{1b}[24~",
    ]

    /// Ctrl-A…Ctrl-Z become 0x01–0x1a; the punctuation chords a terminal also
    /// reports are listed explicitly.
    private static func controlSequence(_ characters: String) -> String? {
        guard let first = characters.lowercased().first else { return nil }
        if let ascii = first.asciiValue, ascii >= 0x61, ascii <= 0x7a {
            return String(UnicodeScalar(ascii - 0x60))
        }
        if let punctuation = controlPunctuation[first] { return punctuation }
        // A platform that already reports the control character passes it through.
        if let scalar = characters.unicodeScalars.first, characters.unicodeScalars.count == 1,
           scalar.value < 0x20 {
            return characters
        }
        return nil
    }

    private static let controlPunctuation: [Character: String] = [
        "[": "\u{1b}",
        "]": "\u{1d}",
        "\\": "\u{1c}",
        "_": "\u{1f}",
        "/": "\u{1f}",
        "@": "\u{0}",
        " ": "\u{0}",
        "?": "\u{7f}",
    ]
}
