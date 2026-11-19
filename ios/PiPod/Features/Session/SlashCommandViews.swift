import SwiftUI

/// Floating slash-command picker shown directly above the composer when typing
/// `/` or opening the command list. Tapping a row fills the composer rather
/// than sending immediately, so the user can review arguments or confirm.
struct SlashCommandPalette: View {
    let commands: [SlashCommand]
    let isLoadingPodCommands: Bool
    let onSelect: (SlashCommand) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(commands.enumerated()), id: \.element.id) { index, command in
                        if index > 0 {
                            Divider().padding(.leading, 12)
                        }
                        Button {
                            onSelect(command)
                        } label: {
                            SlashCommandRow(command: command)
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("composer.slashOption.\(command.name)")
                    }
                }
            }
            .frame(maxHeight: 220)

            if isLoadingPodCommands {
                Divider()
                HStack(spacing: 8) {
                    ProgressView().controlSize(.mini)
                    Text("Loading pod commands…")
                        .font(.caption)
                        .foregroundStyle(AppColors.secondaryLabel)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
            }
        }
        .background(AppColors.card, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(AppColors.separator, lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.08), radius: 6, y: 2)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("composer.slashPalette")
    }
}

private struct SlashCommandRow: View {
    let command: SlashCommand

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(command.displayName)
                    .font(.subheadline.monospaced().weight(.semibold))
                    .foregroundStyle(AppColors.accent)
                    .lineLimit(1)
                if let hint = command.argumentHint {
                    Text(hint)
                        .font(.caption.monospaced())
                        .foregroundStyle(AppColors.tertiaryLabel)
                        .lineLimit(1)
                }
                Spacer(minLength: 4)
                SlashSourceBadge(source: command.source)
            }
            Text(command.description)
                .font(.caption)
                .foregroundStyle(AppColors.secondaryLabel)
                .lineLimit(2)
                .multilineTextAlignment(.leading)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .contentShape(Rectangle())
    }
}

/// Compact validation strip above the text field that confirms whether the
/// typed slash command is valid, what it will do, or why it cannot run.
struct SlashCommandStatusBar: View {
    let evaluation: SlashCommandDraftEvaluation

    var body: some View {
        switch evaluation {
        case .valid(let command, _, let summary, let warning, let canExecute, _):
            let toneColor: Color = warning == nil
                ? AppColors.success
                : (canExecute ? AppColors.warning : AppColors.destructive)
            let fillColor: Color = warning == nil
                ? AppColors.fill.opacity(0.75)
                : (canExecute ? AppColors.noticeFill : AppColors.destructiveFill)
            let iconName = warning == nil ? "checkmark.circle.fill" : "exclamationmark.triangle.fill"
            let detailText = warning ?? summary

            HStack(alignment: .center, spacing: 8) {
                Image(systemName: iconName)
                    .font(.footnote)
                    .foregroundStyle(toneColor)
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 6) {
                        Text(command.displayName)
                            .font(.caption.monospaced().weight(.semibold))
                            .foregroundStyle(AppColors.label)
                            .lineLimit(1)
                        SlashSourceBadge(source: command.source)
                    }
                    Text(detailText)
                        .font(.caption)
                        .foregroundStyle(warning != nil && !canExecute ? AppColors.destructive : AppColors.secondaryLabel)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(fillColor, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .accessibilityElement(children: .combine)
            .accessibilityLabel("\(command.displayName), \(command.source.badgeLabel), \(detailText)")
            .accessibilityIdentifier(
                canExecute ? "composer.slashStatus.valid" : "composer.slashStatus.blocked"
            )

        case .unknown(let name, _, let isLoadingCatalog, let isConnected):
            let message: String = isLoadingCatalog
                ? "Checking /\(name) against pod commands…"
                : (!isConnected
                    ? "/\(name) isn’t a built-in command — pod commands load once connected."
                    : "Unknown command /\(name) — check the spelling or pick a command.")
            let toneColor: Color = isLoadingCatalog
                ? AppColors.secondaryLabel
                : (isConnected ? AppColors.destructive : AppColors.warning)
            let fillColor: Color = isLoadingCatalog
                ? AppColors.fill.opacity(0.6)
                : (isConnected ? AppColors.destructiveFill : AppColors.noticeFill)

            HStack(alignment: .center, spacing: 8) {
                if isLoadingCatalog {
                    ProgressView().controlSize(.mini)
                } else {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.footnote)
                        .foregroundStyle(toneColor)
                }
                Text(message)
                    .font(.caption)
                    .foregroundStyle(toneColor)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(fillColor, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .accessibilityElement(children: .combine)
            .accessibilityLabel(message)
            .accessibilityIdentifier("composer.slashStatus.unknown")

        case .none, .browsing:
            EmptyView()
        }
    }
}

private struct SlashSourceBadge: View {
    let source: SlashCommandSource

    var body: some View {
        Text(source.badgeLabel)
            .font(.caption2.weight(.medium))
            .foregroundStyle(AppColors.secondaryLabel)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(AppColors.fill, in: Capsule())
    }
}
