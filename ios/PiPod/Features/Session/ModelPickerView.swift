import SwiftUI

/// The composer entry point. Keep the confirmed selection visible beside Send
/// without requiring a tap to discover which model a prompt will use.
struct ModelPickerButton: View {
    let model: any ModelSelecting
    let action: () -> Void
    let identifier: String

    @Environment(\.dynamicTypeSize) private var typeSize

    init(
        model: any ModelSelecting,
        action: @escaping () -> Void,
        identifier: String = "session.modelPicker"
    ) {
        self.model = model
        self.action = action
        self.identifier = identifier
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Image(systemName: "cpu").imageScale(.small)
                if showsText {
                    Text(displayName)
                        .lineLimit(modelLineLimit)
                        .truncationMode(.middle)
                        .fixedSize(horizontal: false, vertical: wrapsComposerLabel)
                    if let level = model.currentThinkingLevel, level != "off" {
                        Text("· \(ThinkingLevelChoice.label(level))")
                            .foregroundStyle(AppColors.secondaryLabel)
                            .lineLimit(1)
                    }
                }
            }
            .font(.caption)
            .frame(maxWidth: 220)
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(AppColors.accent)
        .accessibilityLabel(Self.accessibilityLabel(model))
        .accessibilityIdentifier(identifier)
    }

    private var isComposerPicker: Bool { identifier == "composer.modelPicker" }
    private var wrapsComposerLabel: Bool { isComposerPicker && typeSize.isAccessibilitySize }
    private var modelLineLimit: Int { wrapsComposerLabel ? 2 : 1 }
    private var showsText: Bool { isComposerPicker || !typeSize.isAccessibilitySize }

    private var displayName: String { Self.displayName(for: model) }

    static func displayName(for model: any ModelSelecting) -> String {
        if model.selectionNeedsAttention { return "Model needs attention" }
        if let pending = model.pendingModel { return "Switching to \(pending.name)" }
        if let pending = model.pendingThinkingLevel {
            return "Changing thinking to \(ThinkingLevelChoice.label(pending))"
        }
        if let current = model.currentModel { return current.name }
        if model.hasModelSnapshot { return "Choose model" }
        return model.isConnected ? "Loading models…" : "Models after connection"
    }

    static func accessibilityLabel(_ model: any ModelSelecting) -> String {
        var parts: [String] = []
        if model.selectionNeedsAttention { parts.append("Model change needs attention") }
        if let pending = model.pendingModel {
            parts.append("Switching to model: \(pending.name)")
        } else if let current = model.currentModel {
            parts.append("Model: \(current.name)")
        } else {
            parts.append(model.hasModelSnapshot ? "Choose provider and model"
                         : (model.isConnected ? "Loading models" : "Models after connection"))
        }
        if let pending = model.pendingThinkingLevel {
            parts.append("Changing thinking to \(ThinkingLevelChoice.label(pending))")
        } else if let level = model.currentThinkingLevel {
            parts.append("Thinking: \(ThinkingLevelChoice.label(level))")
        }
        if model.currentModel != nil { parts.append("Choose provider and model") }
        return parts.joined(separator: ". ")
    }
}

/// Status/recovery actions stay thumb-sized and reflow when accessibility text
/// leaves no room for one horizontal row.
private struct ModelSelectionRecoveryActions: View {
    let model: any ModelSelecting
    let retryTitle: String

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) { actions }
            VStack(alignment: .leading, spacing: 4) { actions }
        }
        .font(.footnote.weight(.semibold))
        .buttonStyle(.bordered)
    }

    @ViewBuilder
    private var actions: some View {
        Button("Check status") { model.checkModelStatus() }
            .frame(minWidth: 44, minHeight: 44)
        Button(retryTitle) { _ = model.retryPendingSelection() }
            .frame(minWidth: 44, minHeight: 44)
        if model.currentModel != nil || model.currentThinkingLevel != nil {
            Button("Use current") { _ = model.useConfirmedSelection() }
                .frame(minWidth: 44, minHeight: 44)
        }
    }
}

/// One searchable model list, with the selected model first and thinking
/// controls progressively disclosed below it.
struct ModelPickerView: View {
    let model: any ModelSelecting
    var onDone: (() -> Void)?

    @Environment(\.dismiss) private var dismiss
    @Environment(AppRouter.self) private var router
    @State private var query = ""
    @State private var showsThinking = false
    @State private var toast: String?

    private var visibleModels: [ModelChoice] {
        ModelCatalog.modelsMatching(
            query, available: model.availableModels, current: model.currentModel
        )
    }

    var body: some View {
        List {
            noticeSection
            credentialSettingsSection
            modelSection
            thinkingSection
        }
        .listStyle(.insetGrouped)
        .searchable(text: $query, prompt: "Search models, providers, or IDs")
        .navigationTitle("Choose model")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Done") {
                    if let onDone { onDone() } else { dismiss() }
                }
                .accessibilityLabel("Done choosing model and thinking level")
            }
        }
        .task { model.refreshModels() }
        .overlay(alignment: .bottom) {
            if let toast {
                Text(toast)
                    .font(.footnote)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(AppColors.card, in: Capsule())
                    .overlay(Capsule().stroke(AppColors.separator))
                    .padding(.bottom, 24)
                    .transition(.opacity)
                    .accessibilityAddTraits(.updatesFrequently)
            }
        }
    }

    @ViewBuilder
    private var noticeSection: some View {
        if model.selectionNeedsAttention {
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    if let error = model.error {
                        Label(error, systemImage: "exclamationmark.triangle")
                            .font(.footnote)
                            .foregroundStyle(AppColors.destructive)
                    }
                    Label(
                        "The model change is unconfirmed. Check status before sending.",
                        systemImage: "questionmark.circle"
                    )
                    .font(.footnote)
                    .foregroundStyle(AppColors.notice)
                    ModelSelectionRecoveryActions(model: model, retryTitle: "Retry selection")
                }
                .accessibilityIdentifier("modelPicker.recovery")
            }
        } else if let pending = model.pendingModel {
            Section {
                Label(
                    "Switching to \(pending.name)… You can keep editing your prompt, but send becomes available after the server confirms it.",
                    systemImage: "arrow.triangle.2.circlepath"
                )
                .font(.footnote)
                .foregroundStyle(AppColors.notice)
                .accessibilityLabel("Switching to \(pending.name). Sending waits for confirmation.")
            }
        } else if let pending = model.pendingThinkingLevel {
            Section {
                Label(
                    "Changing thinking to \(ThinkingLevelChoice.label(pending))… Sending waits for confirmation.",
                    systemImage: "arrow.triangle.2.circlepath"
                )
                .font(.footnote)
                .foregroundStyle(AppColors.notice)
            }
        } else if let error = model.error {
            Section {
                Label(error, systemImage: "exclamationmark.triangle")
                    .font(.footnote)
                    .foregroundStyle(AppColors.destructive)
                    .accessibilityLabel("Model catalog error: \(error)")
            }
        } else if !model.isConnected, model.hasModelSnapshot {
            Section {
                Label(
                    "The pod is disconnected. Reconnect before switching models.",
                    systemImage: "wifi.slash"
                )
                .font(.footnote)
                .foregroundStyle(AppColors.secondaryLabel)
            }
        }
    }

    @ViewBuilder
    private var credentialSettingsSection: some View {
        if model.credentialSettingsNeeded {
            Section {
                Label(
                    "Reconnect your model provider in Settings before switching models.",
                    systemImage: "key"
                )
                .font(.footnote)
                .foregroundStyle(AppColors.notice)
                Button("Manage model providers") {
                    router.selectedTab = .settings
                    router.settingsPath = [.credentials]
                }
                .frame(minHeight: 44)
                .accessibilityIdentifier("modelPicker.manageCredentials")
            }
        }
    }

    @ViewBuilder
    private var modelSection: some View {
        Section("Models") {
            if !model.hasModelSnapshot {
                Label(
                    model.isConnected
                        ? "Loading available models…"
                        : "Connect to the pod to load its models.",
                    systemImage: model.isConnected
                        ? "arrow.triangle.2.circlepath" : "wifi.slash"
                )
                .font(.footnote)
                .foregroundStyle(AppColors.secondaryLabel)
                .accessibilityIdentifier("modelPicker.loading")
            } else if visibleModels.isEmpty {
                EmptyStateView(
                    title: query.isEmpty ? "No models available" : "No matching models",
                    message: emptyModelsMessage,
                    systemImage: "magnifyingglass"
                )
                Button("Refresh models") { model.checkModelStatus() }
                    .frame(minHeight: 44)
                    .accessibilityIdentifier("modelPicker.refresh")
            } else {
                ForEach(visibleModels) { choice in
                    Button {
                        if model.selectModel(choice) {
                            show(toast: "Switching to \(choice.name)…")
                        }
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(choice.name)
                                Text("\(choice.provider) · \(choice.modelId)")
                                    .font(.footnote)
                                    .foregroundStyle(AppColors.secondaryLabel)
                                    .lineLimit(2)
                            }
                            Spacer()
                            if choice == model.pendingModel {
                                ProgressView().controlSize(.small)
                            } else if choice == model.currentModel {
                                Image(systemName: "checkmark")
                                    .foregroundStyle(AppColors.accent)
                            }
                        }
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(!isEnabled(choice))
                    .accessibilityLabel(
                        "Model \(choice.name), provider \(choice.provider), ID \(choice.modelId). "
                            + (choice == model.pendingModel
                                ? "Switching to this model"
                                : (choice == model.currentModel
                                    ? "Currently selected" : "Switch to this model"))
                    )
                    .accessibilityIdentifier("modelPicker.model.\(choice.id)")
                }
                Text("\(visibleModels.count) \(visibleModels.count == 1 ? "model" : "models")")
                    .font(.footnote)
                    .foregroundStyle(AppColors.secondaryLabel)
            }
        }
    }

    private var thinkingSection: some View {
        Section {
            DisclosureGroup(isExpanded: $showsThinking) {
                if model.availableThinkingLevels.isEmpty {
                    DetailRow(
                        "Thinking",
                        value: model.currentThinkingLevel.map(ThinkingLevelChoice.label)
                            ?? "Not available"
                    )
                } else {
                    ForEach(model.availableThinkingLevels, id: \.self) { level in
                        Button {
                            if model.selectThinkingLevel(level) {
                                show(toast: "Changing thinking to \(ThinkingLevelChoice.label(level))…")
                            }
                        } label: {
                            HStack {
                                Text(ThinkingLevelChoice.label(level))
                                Spacer()
                                if level == model.pendingThinkingLevel {
                                    ProgressView().controlSize(.small)
                                } else if level == model.currentThinkingLevel {
                                    Image(systemName: "checkmark")
                                        .foregroundStyle(AppColors.accent)
                                }
                            }
                            .frame(minHeight: 44)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .disabled(!isThinkingEnabled(level))
                        .accessibilityLabel(
                            "Thinking \(ThinkingLevelChoice.label(level)). "
                                + (level == model.pendingThinkingLevel
                                    ? "Changing to this thinking level"
                                    : (level == model.currentThinkingLevel
                                        ? "Currently selected" : "Use this thinking level"))
                        )
                    }
                }
            } label: {
                LabeledContent(
                    "Thinking",
                    value: model.currentThinkingLevel.map(ThinkingLevelChoice.label)
                        ?? "Not available"
                )
            }
            .accessibilityIdentifier("modelPicker.thinking")
        }
    }

    private var emptyModelsMessage: String {
        if !query.isEmpty {
            return "No model from any provider matches “\(query)”. Search by provider, model name, or ID."
        }
        if !model.isConnected {
            return "The pod is disconnected. Reconnect and refresh its catalog."
        }
        return "This pod did not report any available models. Refresh or ask its owner to check the pod configuration."
    }

    /// The current row stays tappable while disconnected so the confirmed
    /// selection remains legible; other rows require a live socket.
    private func isEnabled(_ choice: ModelChoice) -> Bool {
        (model.isConnected && !model.isModelSwitchInFlight && !model.isThinkingSwitchInFlight)
            || (choice == model.currentModel
                && !model.isModelSwitchInFlight && !model.isThinkingSwitchInFlight)
    }

    private func isThinkingEnabled(_ level: String) -> Bool {
        (model.isConnected && !model.isModelSwitchInFlight && !model.isThinkingSwitchInFlight)
            || (level == model.currentThinkingLevel
                && !model.isModelSwitchInFlight && !model.isThinkingSwitchInFlight)
    }

    private func show(toast message: String) {
        toast = message
        Task {
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            if toast == message { toast = nil }
        }
    }
}
