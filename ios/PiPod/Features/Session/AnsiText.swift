import SwiftUI

/// The terminal palette, resolved for a colour scheme and kept legible.
///
/// A pod renders against a real terminal, where the theme decides what `black`
/// and `bright white` actually look like. Painting those raw would make half a
/// line invisible: index 0 vanishes on the dark surface, index 15 vanishes on
/// the light one, and the 256-colour cube contains plenty of near-surface
/// values. So the named colours below are a fixed, measured pair of ramps, and
/// every computed colour is pulled back to at least 4.5:1 against its own
/// surface by `legible(_:scheme:)`.
public enum AnsiPalette {
    /// WCAG's floor for body text. Terminal output *is* body text here.
    static let minimumContrast = 4.5

    public static func color(_ color: AnsiColor, scheme: ColorScheme) -> Color {
        switch color {
        case .palette(let index) where index >= 0 && index < 16:
            let hex = scheme == .dark ? namedOnDark[index] : namedOnLight[index]
            return Color(hex: hex)
        case .palette(let index) where index >= 16 && index < 232:
            return legible(cube(index), scheme: scheme)
        case .palette(let index) where index >= 232 && index < 256:
            let level = 8 + (index - 232) * 10
            return legible((level, level, level), scheme: scheme)
        case .palette:
            // Out of range: leave it to the surrounding label colour.
            return scheme == .dark ? Color(hex: 0xD0D0D0) : Color(hex: 0x1A1A1A)
        case .rgb(let red, let green, let blue):
            return legible((red, green, blue), scheme: scheme)
        }
    }

    /// Measured against white. Every value clears 4.5:1; the two greys that
    /// stand in for terminal `white` and `bright white` are darkened, because a
    /// literal white would be a blank line on this surface.
    private static let namedOnLight: [UInt32] = [
        0x000000,  // black          21.0:1
        0xA32017,  // red             6.4:1
        0x1B5E20,  // green           7.4:1
        0x8A4300,  // yellow          7.0:1
        0x0D47A1,  // blue            9.9:1
        0x6A1B9A,  // magenta         8.4:1
        0x00696B,  // cyan            5.4:1
        0x5A5A5A,  // white           6.4:1
        0x6E6E6E,  // bright black    4.9:1
        0xC62828,  // bright red      5.6:1
        0x2E7D32,  // bright green    5.1:1
        0x9A5B00,  // bright yellow   5.5:1
        0x1565C0,  // bright blue     5.8:1
        0x8E24AA,  // bright magenta  7.0:1
        0x00838F,  // bright cyan     4.5:1
        0x3C3C3C,  // bright white   11.0:1
    ]

    /// Measured against black, with terminal `black` lifted to a readable grey
    /// for the same reason.
    private static let namedOnDark: [UInt32] = [
        0x7A7A7A,  // black           4.9:1
        0xF2A29A,  // red            10.4:1
        0x7FD98C,  // green          12.1:1
        0xFFB77A,  // yellow         12.3:1
        0x9CC4F8,  // blue           11.6:1
        0xD6A8F0,  // magenta        10.7:1
        0x7FD5D9,  // cyan           12.3:1
        0xD0D0D0,  // white          14.9:1
        0x9A9A9A,  // bright black    7.5:1
        0xFFB3AC,  // bright red     12.0:1
        0xA8ECB4,  // bright green   15.3:1
        0xFFD08F,  // bright yellow  15.0:1
        0xBBD8FF,  // bright blue    14.0:1
        0xE8C0FF,  // bright magenta 13.0:1
        0xA8EAEE,  // bright cyan    15.2:1
        0xFFFFFF,  // bright white   21.0:1
    ]

    private static func cube(_ index: Int) -> (Int, Int, Int) {
        let offset = index - 16
        let steps = [0, 95, 135, 175, 215, 255]
        return (steps[offset / 36], steps[(offset / 6) % 6], steps[offset % 6])
    }

    /// Pulls a colour toward the far end of the scheme until it clears
    /// `minimumContrast` against the surface, so a mid-grey stays mid-grey but a
    /// near-surface value stops disappearing.
    static func legible(_ rgb: (Int, Int, Int), scheme: ColorScheme) -> Color {
        var (red, green, blue) = (
            Double(rgb.0) / 255, Double(rgb.1) / 255, Double(rgb.2) / 255
        )
        let targetLuminance = scheme == .dark
            ? 0.05 * minimumContrast - 0.05  // (L + 0.05) / 0.05 >= 4.5
            : 1.05 / minimumContrast - 0.05  // 1.05 / (L + 0.05) >= 4.5

        var steps = 0
        while steps < 24 {
            let luminance = relativeLuminance(red, green, blue)
            if scheme == .dark ? luminance >= targetLuminance : luminance <= targetLuminance {
                break
            }
            let anchor: Double = scheme == .dark ? 1 : 0
            red += (anchor - red) * 0.12
            green += (anchor - green) * 0.12
            blue += (anchor - blue) * 0.12
            steps += 1
        }
        return Color(.sRGB, red: red, green: green, blue: blue, opacity: 1)
    }

    private static func relativeLuminance(_ red: Double, _ green: Double, _ blue: Double) -> Double {
        func linear(_ channel: Double) -> Double {
            channel <= 0.03928 ? channel / 12.92 : pow((channel + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue)
    }
}

/// One rendered terminal line, styled and legible in both light and dark.
///
/// The line does not wrap: a terminal frame is a grid, and rewrapping it turns
/// aligned output into noise. The container scrolls horizontally instead.
public struct AnsiText: View {
    @Environment(\.colorScheme) private var scheme

    private let line: String
    private let font: Font

    public init(_ line: String, font: Font = .system(.footnote, design: .monospaced)) {
        self.line = line
        self.font = font
    }

    public var body: some View {
        Text(attributed)
            .lineLimit(1)
            .fixedSize(horizontal: true, vertical: false)
            .accessibilityLabel(Ansi.strip(line))
    }

    /// One `AttributedString` rather than concatenated `Text`s: SwiftUI's `Text`
    /// has no background modifier that stays a `Text`, and a terminal run with a
    /// background is exactly how a TUI draws a selected row.
    private var attributed: AttributedString {
        var result = AttributedString()
        for span in Ansi.parse(line) {
            var piece = AttributedString(span.text)
            let style = span.style

            // `inverse` swaps the roles, which is how a terminal draws a
            // selection or a cursor line; the swapped pair still resolves
            // through the palette.
            let rawForeground = style.inverse ? style.background : style.foreground
            let rawBackground = style.inverse ? style.foreground : style.background

            var foreground = rawForeground.map { AnsiPalette.color($0, scheme: scheme) }
                ?? (style.inverse ? AppColors.background : AppColors.label)
            // Dimming below the contrast floor would undo the whole palette, so
            // it stops well short of transparent.
            if style.dim { foreground = foreground.opacity(0.75) }
            piece.foregroundColor = foreground

            if let rawBackground {
                piece.backgroundColor = AnsiPalette.color(rawBackground, scheme: scheme)
            } else if style.inverse {
                piece.backgroundColor = AppColors.label
            }

            var runFont = font
            if style.bold { runFont = runFont.bold() }
            if style.italic { runFont = runFont.italic() }
            piece.font = runFont

            if style.underline { piece.underlineStyle = .single }
            if style.strikethrough { piece.strikethroughStyle = .single }
            result.append(piece)
        }
        return result
    }
}

#Preview {
    VStack(alignment: .leading, spacing: 2) {
        AnsiText("\u{1b}[1;32m✓\u{1b}[0m  build succeeded")
        AnsiText("\u{1b}[31merror:\u{1b}[0m  missing argument")
        AnsiText("\u{1b}[38;5;208mwarning\u{1b}[0m  deprecated API")
        AnsiText("\u{1b}[7minverse\u{1b}[0m  and \u{1b}[4munderlined\u{1b}[0m")
        AnsiText("plain\tcolumns\taligned")
    }
    .padding()
}
