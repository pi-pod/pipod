import Foundation

/// SGR-only ANSI parsing for remote extension UI lines.
///
/// Frames are whole-line repaints produced by pi's own renderer in the pod, so
/// styling is all that has to survive: there is no cursor addressing, scrollback
/// or vt state to emulate. Anything that is not an SGR sequence is noise here
/// and is stripped, which is also what the pod-side line sanitizer assumes.
public enum AnsiColor: Hashable, Sendable {
    /// An index into the terminal's 256-colour palette. 0–15 are the named
    /// colours a theme is expected to remap; 16–255 are the fixed cube and
    /// greyscale ramp.
    case palette(Int)
    case rgb(red: Int, green: Int, blue: Int)
}

public struct AnsiStyle: Hashable, Sendable {
    public var bold: Bool
    public var dim: Bool
    public var italic: Bool
    public var underline: Bool
    public var inverse: Bool
    public var strikethrough: Bool
    public var foreground: AnsiColor?
    public var background: AnsiColor?

    public init(
        bold: Bool = false,
        dim: Bool = false,
        italic: Bool = false,
        underline: Bool = false,
        inverse: Bool = false,
        strikethrough: Bool = false,
        foreground: AnsiColor? = nil,
        background: AnsiColor? = nil
    ) {
        self.bold = bold
        self.dim = dim
        self.italic = italic
        self.underline = underline
        self.inverse = inverse
        self.strikethrough = strikethrough
        self.foreground = foreground
        self.background = background
    }

    public static let none = AnsiStyle()

    public var isPlain: Bool {
        !bold && !dim && !italic && !underline && !inverse && !strikethrough
            && foreground == nil && background == nil
    }
}

public struct AnsiSpan: Hashable, Sendable {
    public let text: String
    public let style: AnsiStyle

    public init(_ text: String, _ style: AnsiStyle) {
        self.text = text
        self.style = style
    }
}

public enum Ansi {
    private static let escape: Character = "\u{1b}"
    private static let tabStop = 8

    /// Splits one rendered line into styled runs. Adjacent runs that share a
    /// style are merged, so a line with no styling yields exactly one span.
    public static func parse(_ line: String) -> [AnsiSpan] {
        let characters = Array(line)
        var spans: [AnsiSpan] = []
        var buffer = ""
        var style = AnsiStyle.none
        var column = 0

        func flush() {
            guard !buffer.isEmpty else { return }
            let text = buffer
            buffer = ""
            if let last = spans.last, last.style == style {
                spans[spans.count - 1] = AnsiSpan(last.text + text, style)
                return
            }
            spans.append(AnsiSpan(text, style))
        }

        var index = 0
        while index < characters.count {
            let character = characters[index]
            guard character == escape else {
                if character == "\t" {
                    // Terminals advance to the next tab stop; spaces reproduce
                    // that on a monospace grid.
                    let width = tabStop - column % tabStop
                    buffer += String(repeating: " ", count: width)
                    column += width
                } else if let scalar = character.unicodeScalars.first,
                          character.unicodeScalars.count > 1
                            || (scalar.value >= 0x20 && scalar.value != 0x7f) {
                    buffer.append(character)
                    column += 1
                }
                index += 1
                continue
            }
            guard let sequenceEnd = sequenceEnd(characters, from: index) else { break }
            if let parameters = sgrParameters(characters, start: index, end: sequenceEnd) {
                flush()
                style = applySGR(style, parameters)
            }
            index = sequenceEnd
        }
        flush()
        return spans
    }

    /// The line as it reads without any styling — the accessibility label and
    /// the text a golden test compares.
    public static func strip(_ line: String) -> String {
        parse(line).map(\.text).joined()
    }

    /// End index (exclusive) of the escape sequence starting at `start`, or nil
    /// when the line ends mid-sequence.
    private static func sequenceEnd(_ characters: [Character], from start: Int) -> Int? {
        guard start + 1 < characters.count else { return nil }
        let next = characters[start + 1]
        if next == "[" {
            var end = start + 2
            while end < characters.count {
                if let value = characters[end].asciiValue, value >= 0x40, value <= 0x7e {
                    return end + 1
                }
                end += 1
            }
            return nil
        }
        if next == "]" || next == "P" || next == "_" || next == "^" || next == "X" {
            // String sequences (OSC, DCS, APC, PM, SOS) run to BEL or ST.
            var end = start + 2
            while end < characters.count {
                if characters[end].asciiValue == 0x07 { return end + 1 }
                if characters[end] == "\\", characters[end - 1] == escape { return end + 1 }
                end += 1
            }
            return nil
        }
        var end = start + 1
        while end < characters.count, let value = characters[end].asciiValue,
              value >= 0x20, value <= 0x2f {
            end += 1
        }
        if end < characters.count, let value = characters[end].asciiValue,
           value >= 0x30, value <= 0x7e {
            end += 1
        }
        return end > start ? end : start + 1
    }

    /// Flattened SGR parameters, or nil when the sequence is not an SGR. `;` and
    /// `:` are both accepted as separators so the ITU colour forms
    /// (`38:2::r:g:b`) parse alongside the common `38;2;r;g;b`.
    private static func sgrParameters(
        _ characters: [Character], start: Int, end: Int
    ) -> [Int?]? {
        guard characters[end - 1] == "m", characters[start + 1] == "[" else { return nil }
        let body = String(characters[(start + 2)..<(end - 1)])
        var parameters: [Int?] = []
        for token in body.split(
            omittingEmptySubsequences: false, whereSeparator: { $0 == ";" || $0 == ":" }
        ) {
            if token.isEmpty {
                parameters.append(nil)
                continue
            }
            guard let value = Int(token) else { return nil }
            parameters.append(value)
        }
        return parameters.isEmpty ? [0] : parameters
    }

    private static func applySGR(_ style: AnsiStyle, _ parameters: [Int?]) -> AnsiStyle {
        var result = style
        var index = 0
        while index < parameters.count {
            let parameter = parameters[index] ?? 0
            switch parameter {
            case 0: result = .none
            case 1: result.bold = true
            case 2: result.dim = true
            case 3: result.italic = true
            case 4: result.underline = true
            case 7: result.inverse = true
            case 9: result.strikethrough = true
            case 21, 22:
                result.bold = false
                result.dim = false
            case 23: result.italic = false
            case 24: result.underline = false
            case 27: result.inverse = false
            case 29: result.strikethrough = false
            case 39: result.foreground = nil
            case 49: result.background = nil
            case 38, 48:
                // A malformed extended colour aborts the rest of the sequence
                // rather than guessing at the parameters that follow it.
                guard let extended = extendedColor(parameters, from: index) else { return result }
                index = extended.nextIndex
                if parameter == 38 {
                    result.foreground = extended.color
                } else {
                    result.background = extended.color
                }
            default:
                if (30...37).contains(parameter) {
                    result.foreground = .palette(parameter - 30)
                } else if (40...47).contains(parameter) {
                    result.background = .palette(parameter - 40)
                } else if (90...97).contains(parameter) {
                    result.foreground = .palette(parameter - 90 + 8)
                } else if (100...107).contains(parameter) {
                    result.background = .palette(parameter - 100 + 8)
                }
            }
            index += 1
        }
        return result
    }

    private static func extendedColor(
        _ parameters: [Int?], from start: Int
    ) -> (color: AnsiColor, nextIndex: Int)? {
        var index = start + 1
        func next() -> Int? {
            // The ITU form pads with empty parameters (`38:2::r:g:b`); they are
            // placeholders, not values.
            while index < parameters.count, parameters[index] == nil { index += 1 }
            guard index < parameters.count else { return nil }
            defer { index += 1 }
            return parameters[index]
        }

        let mode = next()
        if mode == 5 {
            guard let value = next(), (0...255).contains(value) else { return nil }
            return (.palette(value), index - 1)
        }
        if mode == 2 {
            guard let red = next(), let green = next(), let blue = next() else { return nil }
            return (
                .rgb(
                    red: min(max(red, 0), 255),
                    green: min(max(green, 0), 255),
                    blue: min(max(blue, 0), 255)
                ),
                index - 1
            )
        }
        return nil
    }
}
