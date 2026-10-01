import Foundation

/// A secret is injected into pods as an environment variable, so its name has to
/// be a legal one: `^[A-Z_][A-Z0-9_]*$` (the server's rule), at most 128
/// characters. People type and paste these the way the service that issued them
/// writes them — `anthropic-api-key`, `github token` — and the server's answer is
/// a round trip later and phrased for whoever wrote the validator. This fixes the
/// name as it is typed instead, and says what is left to fix when it cannot.
public enum SecretName {
    /// `SECRET_NAME_MAX_LENGTH` in the server's secret store.
    public static let maxLength = 128

    /// The name as it will be sent: uppercased, with the separators people
    /// actually type folded to underscores and anything else dropped.
    ///
    /// The character test is deliberately ASCII: `Character.isUppercase` and
    /// `isNumber` are Unicode-wide, so `Ä_KEY` and `٣` passed this filter and
    /// then failed the server's `[A-Z0-9_]` regex — the exact round trip this
    /// type exists to prevent.
    public static func normalized(_ raw: String) -> String {
        let folded = raw
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .uppercased()
            .map { character -> Character in
                switch character {
                case "-", " ", ".", "/", ":": return "_"
                default: return character
                }
            }
        // A name may not open with a digit, so a leading run of them cannot be kept.
        return String(
            String(folded.filter(isLegalCharacter))
                .drop(while: { $0.isASCII && $0.isNumber })
        )
    }

    private static func isLegalCharacter(_ character: Character) -> Bool {
        guard character.isASCII else { return false }
        return (character.isLetter && character.isUppercase) || character.isNumber
            || character == "_"
    }

    public static func isValid(_ raw: String) -> Bool {
        let name = normalized(raw)
        guard let first = name.first, name.count <= maxLength else { return false }
        return first == "_" || (first.isASCII && first.isLetter)
    }

    /// What is still wrong, for the person looking at the field. nil once the name
    /// is usable.
    public static func problem(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !isValid(trimmed) else { return nil }
        if normalized(trimmed).count > maxLength {
            return "A name can be at most \(maxLength) characters."
        }
        return """
            A name needs an A–Z letter or underscore to start with — pods receive it as an \
            environment variable.
            """
    }

    /// Shown once the typed name and the name that will be saved differ, so nobody
    /// has to guess what the field did to their input.
    public static func normalizationNotice(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let name = normalized(trimmed)
        guard !name.isEmpty, name != trimmed else { return nil }
        return "Saved as \(name)"
    }
}
