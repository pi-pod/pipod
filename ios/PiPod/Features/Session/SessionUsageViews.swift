import SwiftUI

/// pi's footer line for the phone: tokens in and out, cost, and how full the
/// context is, beside the model it was spent on. Tapping it opens the breakdown.
struct SessionUsageButton: View {
    let usage: SessionUsage
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            // The model name beside this keeps priority; the token counts are
            // the first thing to go when the row runs short.
            ViewThatFits(in: .horizontal) {
                line(showsTokens: true)
                line(showsTokens: false)
            }
            .font(.caption.monospacedDigit())
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(usage.accessibilitySummary)
        .accessibilityHint("Shows the usage breakdown")
        .accessibilityIdentifier("composer.usage")
    }

    private func line(showsTokens: Bool) -> some View {
        HStack(spacing: 6) {
            if showsTokens, let tokens = usage.tokenSummary { Text(tokens) }
            if let cost = usage.costSummary { Text(cost) }
            if let context = usage.contextSummary {
                Text(context).foregroundStyle(usage.contextTone?.color ?? AppColors.secondaryLabel)
            }
        }
        .lineLimit(1)
        .fixedSize()
        .foregroundStyle(AppColors.secondaryLabel)
    }
}

/// Everything behind the footer line, exact rather than abbreviated. Reads the
/// tracker rather than a snapshot, so it keeps up while pi is still working.
struct SessionUsageSheet: View {
    let tracker: SessionUsageTracker

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if let usage = tracker.latest {
                    breakdown(usage)
                } else {
                    Text("Usage appears once pi has replied.")
                        .foregroundStyle(AppColors.secondaryLabel)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .navigationTitle("Session usage")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .accessibilityIdentifier("session.usageSheet")
    }

    private func breakdown(_ usage: SessionUsage) -> some View {
        List {
            Section("Tokens") {
                DetailRow("Input", value: SessionUsage.exact(usage.inputTokens))
                DetailRow("Output", value: SessionUsage.exact(usage.outputTokens))
                DetailRow("Cache read", value: SessionUsage.exact(usage.cacheReadTokens))
                DetailRow("Cache write", value: SessionUsage.exact(usage.cacheWriteTokens))
                DetailRow("Total", value: SessionUsage.exact(usage.totalTokens))
            }
            Section {
                DetailRow("Estimated cost", value: SessionUsage.money(usage.cost))
                if let context = usage.contextDetail {
                    DetailRow("Context", value: context, tone: usage.contextTone)
                }
            }
            Section {
                DetailRow("Your messages", value: SessionUsage.exact(usage.userMessages))
                DetailRow("pi replies", value: SessionUsage.exact(usage.assistantMessages))
                DetailRow("Tool calls", value: SessionUsage.exact(usage.toolCalls))
            } header: {
                Text("Activity")
            } footer: {
                Text(SessionUsage.footnote)
            }
        }
        .listStyle(.insetGrouped)
    }
}
