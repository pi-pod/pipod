import SwiftUI

/// The colours status text and status icons are allowed to use.
///
/// The system palette is tuned for its own surfaces, and this app draws status as
/// small text: `Color.green` measures 2.2:1 against the ivory light surface and
/// `Color.orange` 1.7:1, well under the 4.5:1 that text needs. Every value here
/// clears 4.5:1 against its own scheme's surface and against the 14%-alpha chip
/// drawn from it.
public enum StatusTone: String, CaseIterable, Sendable {
    case positive
    case info
    case caution
    case danger
    case neutral
    case unreachable

    public var onLight: Color {
        switch self {
        case .positive: return Color(hex: 0x1B5E20)
        case .info: return Color(hex: 0x0D47A1)
        case .caution: return Color(hex: 0x8A4300)
        case .danger: return Color(hex: 0xA32017)
        case .neutral: return Color(hex: 0x5A5A5A)
        case .unreachable: return Color(hex: 0x6A1B9A)
        }
    }

    public var onDark: Color {
        switch self {
        case .positive: return Color(hex: 0x7FD98C)
        case .info: return Color(hex: 0x9CC4F8)
        case .caution: return Color(hex: 0xFFB77A)
        case .danger: return Color(hex: 0xF2A29A)
        case .neutral: return Color(hex: 0xB5B0BA)
        case .unreachable: return Color(hex: 0xD6A8F0)
        }
    }

    /// Resolves per scheme automatically, so a row does not have to read the
    /// environment to colour itself.
    public var color: Color {
        Color(
            UIColor { traits in
                traits.userInterfaceStyle == .dark
                    ? UIColor(self.onDark) : UIColor(self.onLight)
            }
        )
    }

    /// The filled chip behind status text, at the alpha the contrast was measured at.
    public var fill: Color { color.opacity(0.14) }
}

extension Color {
    /// `Color(hex: 0x6D2598)` — the palette is written as hex everywhere else
    /// (brand docs, the landing site, Zitadel branding), so it is written as hex
    /// here too rather than re-derived into 0–1 components by hand.
    public init(hex: UInt32, opacity: Double = 1) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: opacity
        )
    }
}
