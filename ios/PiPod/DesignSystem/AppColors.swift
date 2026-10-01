import SwiftUI

/// The pi pod brand palette.
///
/// Canonical values, not approximations: they are pinned in the workspace colour
/// -palette guide, the landing site's `:root`, and Zitadel's branding slots. Never
/// substitute generic system purple or the default iOS blue tint.
public enum Brand {
    /// Primary brand accent.
    public static let simplePurple = Color(hex: 0x6D2598)
    /// Light scaffold.
    public static let ivoryPorcelain = Color(hex: 0xEDE4D1)
    /// Warm fill. Never a text colour — 1.61:1 on ivory.
    public static let mutedFawn = Color(hex: 0xDBAC8F)
    /// Tertiary / notice accent. 3.92:1 on ivory: large or bold text only.
    public static let byzantine = Color(hex: 0xBF34A4)
    /// Darker magenta container.
    public static let traditionalPurple = Color(hex: 0xAA1C7D)
    /// Dark scaffold — stays in the brand family rather than going charcoal.
    public static let darkSurface = Color(hex: 0x160A1F)
    /// Dark raised panel.
    public static let darkRaised = Color(hex: 0x201230)

    /// The accent, lightened for dark mode where Simple Purple goes muddy.
    public static let simplePurpleOnDark = Color(hex: 0xC38CE3)

    /// Foreground drawn on the accent in dark mode, where white on the
    /// lightened accent fails text contrast. Android's dark `onPrimary`.
    public static let onAccentOnDark = Color(hex: 0x350A52)

    /// The one interactive tint the whole app uses.
    public static let accent = Color(
        UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(Brand.simplePurpleOnDark) : UIColor(Brand.simplePurple)
        }
    )
}

/// The colour vocabulary the whole app is written against.
///
/// Text, separator and surface roles resolve from the system's semantic colours,
/// so the UI inherits their light/dark, contrast and accessibility behaviour
/// instead of freezing a palette. Only the accent and the status tones are pinned
/// — those are brand and legibility decisions the system cannot make for us.
public enum AppColors {
    /// Interactive tint: links, selected tabs, primary actions.
    public static let accent = Brand.accent
    /// Text and glyphs drawn on the accent: outgoing bubbles, filled buttons.
    /// White in light mode; in dark mode the accent lightens to #C38CE3, where
    /// white drops to ~2.9:1, so the foreground drops to deep plum — Android's
    /// dark `onPrimary`, a canonical value, not a new hue — which clears 4.5:1.
    public static let onAccent = Color(
        UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(Brand.onAccentOnDark) : .white
        }
    )

    /// Primary body text.
    public static let label = Color(uiColor: .label)
    /// Supporting text: subtitles, metadata, captions.
    public static let secondaryLabel = Color(uiColor: .secondaryLabel)
    /// De-emphasised text and disabled glyphs.
    public static let tertiaryLabel = Color(uiColor: .tertiaryLabel)
    /// Hairlines between rows and sections.
    public static let separator = Color(uiColor: .separator)

    /// Backdrop for screens whose content is not a grouped list.
    public static let background = Color(uiColor: .systemBackground)
    /// Backdrop behind inset grouped lists.
    public static let groupedBackground = Color(uiColor: .systemGroupedBackground)
    /// Surface of a row, section or card sitting on `groupedBackground`.
    public static let card = Color(uiColor: .secondarySystemGroupedBackground)
    /// Subtle filled surface for chips, code blocks and inline badges.
    public static let fill = Color(uiColor: .tertiarySystemFill)
    /// Surface of a bar against the edge of the screen, such as the composer.
    public static let bar = Color(uiColor: .secondarySystemBackground)

    /// Errors and destructive actions. NOT brand — a legibility-tuned red.
    public static let destructive = StatusTone.danger.color
    public static let destructiveFill = StatusTone.danger.fill
    /// Attention that is not an error, such as a pending approval.
    public static let notice = StatusTone.caution.color
    public static let noticeFill = StatusTone.caution.fill

    public static let success = StatusTone.positive.color
    public static let warning = StatusTone.caution.color
    public static let info = StatusTone.info.color
    public static let neutral = StatusTone.neutral.color

    public static func tone(_ tone: StatusTone) -> Color { tone.color }
}
