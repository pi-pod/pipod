import SwiftUI

/// The one place a personal workstation coming up is drawn.
///
/// Deliberately unlike both neighbours it could be confused with. A pod asleep
/// is a moon and a keystroke away; a fleet capacity wait is a queue behind other
/// people's sandboxes with a countdown. This is neither: it is one machine
/// belonging to one person, it takes minutes, nothing is lost while it starts,
/// and no keystroke makes it faster. So it gets its own glyph, its own heading,
/// a live elapsed counter instead of a countdown, and no number the server did
/// not send.
public struct WorkstationWaitCard: View {
    public let progress: WorkstationWaitProgress
    public let onCheckNow: (() -> Void)?
    public let onCancel: (() -> Void)?

    public init(
        progress: WorkstationWaitProgress,
        onCheckNow: (() -> Void)? = nil,
        onCancel: (() -> Void)? = nil
    ) {
        self.progress = progress
        self.onCheckNow = onCheckNow
        self.onCancel = onCancel
    }

    /// What Cancel really does. It ends this app's waiting and nothing else:
    /// the server keeps starting the workstation, and every file survives.
    public static let cancelExplanation = """
        Waiting here is optional — the workstation keeps starting on the server either way, \
        and your files are kept. The same action later attaches to the same workstation.
        """

    public var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
            Text(progress.message)
                .font(.subheadline)
                .foregroundStyle(AppColors.label)
                .fixedSize(horizontal: false, vertical: true)
            if let technical = progress.technicalDetail {
                Text(technical)
                    .font(.caption.monospaced())
                    .foregroundStyle(AppColors.tertiaryLabel)
                    .accessibilityLabel("Workstation progress: \(technical)")
            }
            Text(Self.cancelExplanation)
                .font(.footnote)
                .foregroundStyle(AppColors.secondaryLabel)
                .fixedSize(horizontal: false, vertical: true)
            if onCheckNow != nil || onCancel != nil {
                WorkstationWaitActions(onCheckNow: onCheckNow, onCancel: onCancel)
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("workstation.wait")
    }

    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: "desktopcomputer")
                .foregroundStyle(AppColors.accent)
                .accessibilityHidden(true)
            Text("Workstation")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(AppColors.label)
            ProgressView()
                .controlSize(.mini)
                .accessibilityHidden(true)
            Spacer(minLength: 8)
            Text(progress.elapsedLabel)
                .font(.caption.monospacedDigit())
                .foregroundStyle(AppColors.secondaryLabel)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Workstation starting, waiting \(progress.elapsedLabel)")
        .accessibilityValue(progress.message)
        .accessibilityAddTraits(.updatesFrequently)
    }
}

/// The wait card's two controls, in their own view so their tap targets can be
/// measured on their own rather than inferred from a card full of prose.
struct WorkstationWaitActions: View {
    let onCheckNow: (() -> Void)?
    let onCancel: (() -> Void)?

    var body: some View {
        HStack(spacing: 12) {
            // A footnote label inside `.bordered` is well under 44pt tall. These
            // two are the only way out of a wait that takes minutes, so they get
            // the same minimum as every other control in the app.
            if let onCheckNow {
                Button("Check now", action: onCheckNow)
                    .font(.footnote.weight(.semibold))
                    .buttonStyle(.bordered)
                    .tint(AppColors.accent)
                    .frame(minWidth: 44, minHeight: 44)
                    .contentShape(Rectangle())
                    .accessibilityLabel("Check the workstation now")
                    .accessibilityIdentifier("workstation.checkNow")
            }
            if let onCancel {
                Button("Stop waiting", action: onCancel)
                    .font(.footnote.weight(.semibold))
                    .buttonStyle(.bordered)
                    .frame(minWidth: 44, minHeight: 44)
                    .contentShape(Rectangle())
                    .accessibilityLabel("Stop waiting for the workstation")
                    .accessibilityIdentifier("workstation.cancel")
            }
        }
    }
}

/// What a finished workstation wait left behind: the reader stopped waiting, the
/// budget ran out, or the reason will not clear on its own.
///
/// Never a tombstone and never a prompt to launch a duplicate — the workstation
/// and its files are still there in every one of those cases.
public struct WorkstationNoticeTile: View {
    public let message: String
    public let retryTitle: String?
    public let onRetry: (() -> Void)?
    public let secondaryTitle: String?
    public let onSecondary: (() -> Void)?
    public let secondaryDisabled: Bool

    public init(
        message: String, retryTitle: String? = "Keep waiting",
        onRetry: (() -> Void)? = nil, secondaryTitle: String? = nil,
        onSecondary: (() -> Void)? = nil, secondaryDisabled: Bool = false
    ) {
        self.message = message
        self.retryTitle = retryTitle
        self.onRetry = onRetry
        self.secondaryTitle = secondaryTitle
        self.onSecondary = onSecondary
        self.secondaryDisabled = secondaryDisabled
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Image(systemName: "desktopcomputer")
                    .foregroundStyle(AppColors.accent)
                    .accessibilityHidden(true)
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(AppColors.label)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
                if (secondaryTitle == nil || onSecondary == nil),
                   let onRetry, let retryTitle {
                    retryButton(retryTitle, action: onRetry)
                }
            }
            if let secondaryTitle, let onSecondary {
                HStack(spacing: 12) {
                    Button(secondaryTitle, action: onSecondary)
                        .font(.footnote.weight(.semibold))
                        .buttonStyle(.bordered)
                        .disabled(secondaryDisabled)
                        .frame(minHeight: 44)
                        .accessibilityIdentifier("workstation.checkStatus")
                    if let onRetry, let retryTitle {
                        retryButton(retryTitle, action: onRetry)
                    }
                }
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("workstation.notice")
    }

    private func retryButton(_ title: String, action: @escaping () -> Void) -> some View {
        Button(title, action: action)
            .font(.footnote.weight(.semibold))
            .buttonStyle(.plain)
            .foregroundStyle(AppColors.accent)
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(Rectangle())
            .accessibilityIdentifier("workstation.retry")
    }
}

/// One line of account state on the pods screen.
///
/// SaaS only. The self-hosted backend sends no billing fields at all, and this
/// view is then never built — no placeholder, no zeroes, no empty header, and no
/// layout space held for something that is not coming.
public struct BillingSummaryRow: View {
    public let summary: BillingSummary

    public init(summary: BillingSummary) { self.summary = summary }

    public var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Image(systemName: summary.startsBlocked ? "exclamationmark.circle.fill" : "creditcard")
                    .foregroundStyle(
                        summary.startsBlocked ? summary.tone.color : AppColors.secondaryLabel
                    )
                    .accessibilityHidden(true)
                Text(summary.summaryLine)
                    .font(.footnote)
                    .foregroundStyle(AppColors.secondaryLabel)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
                if let state = summary.stateLabel {
                    StatusChip(state, tone: summary.tone)
                }
            }
            // A chip names the state; the sentence is what the reader can act
            // on. Only a refusal earns one — nothing else here is actionable.
            if let blocked = summary.startBlockedSentence {
                Text(blocked)
                    .font(.footnote)
                    .foregroundStyle(AppColors.label)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("pods.billingBlockedReason")
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(spokenLabel)
        .accessibilityIdentifier("pods.billing")
    }

    /// Line, chip, then the sentence — in the order a sighted reader meets them.
    var spokenLabel: String {
        var parts: [String] = []
        if !summary.summaryLine.isEmpty { parts.append(summary.summaryLine) }
        if let state = summary.stateLabel { parts.append(state) }
        if let blocked = summary.startBlockedSentence { parts.append(blocked) }
        return parts.joined(separator: ". ")
    }
}
