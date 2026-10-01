import SwiftUI

/// A small status pill: coloured text on a matching 14%-alpha fill.
public struct StatusChip: View {
    public let text: String
    public let tone: StatusTone
    public let systemImage: String?

    public init(_ text: String, tone: StatusTone, systemImage: String? = nil) {
        self.text = text
        self.tone = tone
        self.systemImage = systemImage
    }

    public var body: some View {
        HStack(spacing: 4) {
            if let systemImage {
                Image(systemName: systemImage).imageScale(.small)
            }
            Text(text)
        }
        .font(.caption.weight(.medium))
        .foregroundStyle(tone.color)
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(tone.fill, in: Capsule())
        .accessibilityElement(children: .combine)
        .accessibilityLabel(text)
    }
}

/// The empty state every list shows before it has rows.
public struct EmptyStateView: View {
    public let title: String
    public let message: String?
    public let systemImage: String
    public let actionTitle: String?
    public let action: (() -> Void)?

    public init(
        title: String,
        message: String? = nil,
        systemImage: String = "tray",
        actionTitle: String? = nil,
        action: (() -> Void)? = nil
    ) {
        self.title = title
        self.message = message
        self.systemImage = systemImage
        self.actionTitle = actionTitle
        self.action = action
    }

    public var body: some View {
        ContentUnavailableView {
            Label(title, systemImage: systemImage)
        } description: {
            if let message { Text(message) }
        } actions: {
            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .buttonStyle(BrandProminentButtonStyle())
            }
        }
    }
}

/// A failure that did not empty the screen: the list still has its old rows and
/// this explains why they did not change.
public struct RefreshErrorTile: View {
    public let message: String
    public let retry: (() -> Void)?

    public init(message: String, retry: (() -> Void)? = nil) {
        self.message = message
        self.retry = retry
    }

    public var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(AppColors.destructive)
                .accessibilityHidden(true)
            Text(message)
                .font(.footnote)
                .foregroundStyle(AppColors.label)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let retry {
                Button("Retry", action: retry)
                    .font(.footnote.weight(.semibold))
                    .buttonStyle(.plain)
                    .foregroundStyle(AppColors.accent)
                    // Seven screens share this tile; a `.plain` footnote button
                    // is ~13pt tall without an explicit minimum.
                    .frame(minWidth: 44, minHeight: 44)
                    .contentShape(Rectangle())
                    .accessibilityIdentifier("refreshError.retry")
            }
        }
        .padding(12)
        .background(AppColors.destructiveFill, in: RoundedRectangle(cornerRadius: 10))
        .accessibilityElement(children: .contain)
    }
}

/// Rows the client could not decode. Saying how many are missing is honest; a
/// silently shorter list is not.
public struct UnparsedRowsNotice: View {
    public let count: Int
    public let resourceName: String

    public init(count: Int, resourceName: String) {
        self.count = count
        self.resourceName = resourceName
    }

    public var body: some View {
        if count > 0 {
            Label(
                count == 1
                    ? "1 \(resourceName) couldn’t be shown — this app may need an update."
                    : "\(count) \(resourceName)s couldn’t be shown — this app may need an update.",
                systemImage: "questionmark.square.dashed"
            )
            .font(.footnote)
            .foregroundStyle(AppColors.secondaryLabel)
        }
    }
}

/// The centred spinner used while a whole screen is loading.
public struct LoadingView: View {
    public let label: String

    public init(label: String) { self.label = label }

    public var body: some View {
        VStack(spacing: 14) {
            ProgressView()
            Text(label)
                .font(.subheadline)
                .foregroundStyle(AppColors.secondaryLabel)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(label)
        .accessibilityAddTraits(.updatesFrequently)
    }
}

/// A labelled key/value row used across the detail screens.
public struct DetailRow: View {
    public let label: String
    public let value: String
    public let tone: StatusTone?

    public init(_ label: String, value: String, tone: StatusTone? = nil) {
        self.label = label
        self.value = value
        self.tone = tone
    }

    public var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label)
                .foregroundStyle(AppColors.secondaryLabel)
            Spacer(minLength: 12)
            Text(value)
                .foregroundStyle(tone?.color ?? AppColors.label)
                .multilineTextAlignment(.trailing)
        }
        .font(.subheadline)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(label): \(value)")
    }
}

/// The filled brand action.
///
/// `.borderedProminent` takes its fill from the tint but keeps choosing its own
/// label colour — white, in every scheme. On the dark-mode accent, which is
/// lightened to #C38CE3 so it does not go muddy, white measures ~2.9:1 and the
/// caption on a filled button becomes unreadable. Naming both halves is the only
/// way to keep the pair legible, so the style owns the fill *and* the label.
public struct BrandProminentButtonStyle: ButtonStyle {
    private static let shape = RoundedRectangle(cornerRadius: 10, style: .continuous)

    public init() {}

    public func makeBody(configuration: Configuration) -> some View {
        // A nested view, not `@Environment` on the style: a `ButtonStyle` is not
        // a `View` and never has an environment of its own, so `isEnabled` read
        // there would always be true.
        Filled(configuration: configuration)
    }

    /// A disabled button flattens to the neutral fill rather than fading the
    /// accent: fading both halves together drops the label back below the
    /// contrast floor this style exists to clear.
    public static func fill(isEnabled: Bool) -> Color {
        isEnabled ? AppColors.accent : AppColors.fill
    }

    public static func label(isEnabled: Bool) -> Color {
        isEnabled ? AppColors.onAccent : AppColors.tertiaryLabel
    }

    private struct Filled: View {
        let configuration: Configuration

        @Environment(\.isEnabled) private var isEnabled

        var body: some View {
            configuration.label
                .font(.body.weight(.semibold))
                .foregroundStyle(BrandProminentButtonStyle.label(isEnabled: isEnabled))
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .frame(minHeight: 44)
                .background(
                    BrandProminentButtonStyle.fill(isEnabled: isEnabled),
                    in: BrandProminentButtonStyle.shape
                )
                .contentShape(BrandProminentButtonStyle.shape)
                .opacity(configuration.isPressed ? 0.82 : 1)
        }
    }
}

extension View {
    /// Applies the brand's filled button style to a prominent action.
    public func brandProminent() -> some View {
        buttonStyle(BrandProminentButtonStyle())
    }
}
