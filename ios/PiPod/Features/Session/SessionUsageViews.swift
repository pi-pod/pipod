import SwiftUI

/// pi's footer line for the phone: tokens in and out, cost, and how full the
/// context is, beside the model it was spent on. Tapping it opens the breakdown.
struct SessionUsageButton: View {
    let usage: SessionUsage
    let action: () -> Void

    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        Button(action: action) {
            line
                .lineLimit(1)
                // Cut from the start: the token counts go first, and the context figure,
                // which warns before compaction, is the last to go.
                .truncationMode(.head)
                .font(.caption.monospacedDigit())
                .frame(minHeight: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(usage.accessibilitySummary)
        .accessibilityHint("Shows the usage breakdown")
        .accessibilityIdentifier("composer.usage")
    }

    /// One `Text`, so truncation treats the line as a whole. At accessibility sizes
    /// the spend is left to the breakdown: cut to fit, it would only show fragments.
    private var line: Text {
        let compact = typeSize.isAccessibilitySize && usage.contextSummary != nil
        let spend = compact ? "" : [usage.tokenSummary, usage.costSummary].compactMap { $0 }
            .joined(separator: " ")
        var line = Text(spend).foregroundStyle(AppColors.secondaryLabel)
        if let context = usage.contextSummary {
            line = line + Text(spend.isEmpty ? context : " " + context)
                .foregroundStyle(usage.contextTone?.color ?? AppColors.secondaryLabel)
        }
        return line
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
