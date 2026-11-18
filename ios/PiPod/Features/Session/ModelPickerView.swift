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
                    if let level = model.selectedThinkingLevel, level != "off" {
                        Text("· \(ThinkingLevelChoice.label(level))")
                            .foregroundStyle(AppColors.secondaryLabel)
                            .lineLimit(1)
                    }
                }
            }
            .font(.caption)
            // Leading, so the chip sits at the start of the composer row however much
            // of the row its button is given.
            .frame(maxWidth: 220, alignment: .leading)
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
        // A choice waiting for the pod is what the next message will run on.
        if let selected = model.selectedModel { return selected.name }
        if model.isConnected, !model.hasModelSnapshot { return "Loading models…" }
        return "Choose model"
    }

    static func accessibilityLabel(_ model: any ModelSelecting) -> String {
        var parts: [String] = []
        if model.selectionNeedsAttention { parts.append("Model change needs attention") }
        if let pending = model.pendingModel {
            parts.append("Switching to model: \(pending.name)")
        } else if let selected = model.selectedModel {
            parts.append("Model: \(selected.name)")
        } else {
            parts.append(
                model.isConnected && !model.hasModelSnapshot ? "Loading models" : "Choose model"
            )
        }
        if let pending = model.pendingThinkingLevel {
            parts.append("Changing thinking to \(ThinkingLevelChoice.label(pending))")
        } else if let level = model.selectedThinkingLevel {
            parts.append("Thinking: \(ThinkingLevelChoice.label(level))")
        }
        if model.deferredModel != nil || model.deferredThinkingLevel != nil {
            parts.append("Applies when the pod connects")
        }
        if model.selectedModel != nil { parts.append("Choose model and thinking level") }
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

/// The model and thinking level the next message runs on.
///
/// One list, top to bottom in the order a choice is made: the thinking level, a
/// search field that is always there, the models the pod's user keeps in scope,
/// then every other model. A catalog is dozens of models across several
/// providers, so the handful in scope lead and one search covers names,
/// providers and ids together. Choosing a model closes the picker, because that
/// is what the reader came to do; choosing a thinking level does not, because
/// it usually goes with a model.
///
/// Nothing here needs the pod to be connected. Until it is, the list is the
/// last catalog seen on this server and a choice is kept by the stream, which
/// makes the switch as soon as the pod's own catalog arrives.
struct ModelPickerView: View {
    let model: any ModelSelecting
    var onDone: (() -> Void)?

    @Environment(\.dismiss) private var dismiss
    @Environment(AppRouter.self) private var router
    @State private var query = ""

    private var allModels: [ModelChoice] {
        ModelCatalog.models(available: model.availableModels, current: model.selectedModel)
    }

    private var isSearching: Bool {
        !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// A switch in flight freezes the rows: a second one on top of it would
    /// race. Being disconnected does not, because a choice made then is simply
    /// kept until the pod connects.
    private var rowsEnabled: Bool {
        !model.isModelSwitchInFlight && !model.isThinkingSwitchInFlight
    }

    var body: some View {
        let models = allModels
        List {
            noticeSection
            credentialSettingsSection
            thinkingSection
            if models.isEmpty {
                emptySection
            } else if isSearching {
                let matches = ModelCatalog.search(query, in: models)
                if matches.isEmpty {
                    Section {
                        EmptyStateView(
                            title: "No matching models",
                            message: "No model matches “\(query)”. Search by name, provider or ID.",
                            systemImage: "magnifyingglass"
                        )
                    }
                } else {
                    modelSection(
                        "\(matches.count) \(matches.count == 1 ? "match" : "matches")",
                        matches, idPrefix: "match"
                    )
                }
            } else {
                let scoped = model.scopedModels.filter { models.contains($0) }
                // What is selected is always in the first screenful, even when
                // it is outside the scope that would otherwise lead the list.
                if let selected = model.selectedModel, !scoped.isEmpty, !scoped.contains(selected) {
                    modelSection("Selected", [selected], idPrefix: "selected")
                }
                if !scoped.isEmpty {
                    modelSection("Scoped models", scoped, idPrefix: "scoped")
                }
                modelSection(scoped.isEmpty ? "Models" : "All models", models, idPrefix: "all")
            }
        }
        .listStyle(.insetGrouped)
        // Always showing: a search field that appears only after pulling the
        // list down is one most people never find.
        .searchable(
            text: $query,
            placement: .navigationBarDrawer(displayMode: .always),
            prompt: "Search models, providers or IDs"
        )
        .autocorrectionDisabled()
        .textInputAutocapitalization(.never)
        .navigationTitle("Model & Thinking")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Done") { done() }
                    .accessibilityLabel("Done choosing model and thinking level")
            }
        }
        .task { model.refreshModels() }
    }

    private func done() {
        if let onDone { onDone() } else { dismiss() }
    }

    // MARK: Notices

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
                    "Switching to \(pending.name)… Sending waits until the pod confirms it.",
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
        } else if !model.isConnected {
            Section {
                Label(
                    model.availableModels.isEmpty
                        ? "This pod isn’t connected yet. Its models appear once it is."
                        : "This pod isn’t connected yet. Choose now and it switches as soon as it connects.",
                    systemImage: "clock"
                )
                .font(.footnote)
                .foregroundStyle(AppColors.secondaryLabel)
                .accessibilityIdentifier("modelPicker.deferredNotice")
            }
        } else if let error = model.error {
            Section {
                Label(error, systemImage: "exclamationmark.triangle")
                    .font(.footnote)
                    .foregroundStyle(AppColors.destructive)
                    .accessibilityLabel("Model catalog error: \(error)")
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

    // MARK: Thinking

    /// The thinking levels as one row of chips: few, short, and chosen together
    /// with a model, so they sit above the list rather than after it.
    @ViewBuilder
    private var thinkingSection: some View {
        let levels = model.availableThinkingLevels
        if !levels.isEmpty {
            Section("Thinking") {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(levels, id: \.self) { level in
                            thinkingChip(level)
                        }
                    }
                    .padding(.horizontal, 16)
                }
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
            }
            .accessibilityIdentifier("modelPicker.thinking")
        }
    }

    private func thinkingChip(_ level: String) -> some View {
        let isSelected = level == model.selectedThinkingLevel
        let isPending = level == model.pendingThinkingLevel
        return Button {
            _ = model.selectThinkingLevel(level)
        } label: {
            HStack(spacing: 6) {
                if isPending { ProgressView().controlSize(.mini) }
                Text(ThinkingLevelChoice.label(level))
                    .font(.subheadline.weight(isSelected ? .semibold : .regular))
            }
            .padding(.horizontal, 14)
            .frame(minHeight: 44)
            .foregroundStyle(isSelected ? AppColors.onAccent : AppColors.label)
            .background(isSelected ? AppColors.accent : AppColors.card, in: Capsule())
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .disabled(!rowsEnabled || isSelected)
        .accessibilityLabel("Thinking \(ThinkingLevelChoice.label(level))")
        .accessibilityValue(isSelected ? "Selected" : "")
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .accessibilityIdentifier("modelPicker.thinking.\(level)")
    }

    // MARK: Models

    private var emptySection: some View {
        Section {
            EmptyStateView(
                title: "No models yet",
                message: model.isConnected
                    ? "This pod did not report any models. Check its model providers in Settings."
                    : "This pod’s models appear once it connects.",
                systemImage: "cpu"
            )
            if model.isConnected {
                Button("Refresh models") { model.checkModelStatus() }
                    .frame(minHeight: 44)
                    .accessibilityIdentifier("modelPicker.refresh")
            }
        }
    }

    private func modelSection(
        _ title: String, _ models: [ModelChoice], idPrefix: String
    ) -> some View {
        Section(title) {
            ForEach(models) { choice in
                modelRow(choice)
                    .accessibilityIdentifier("modelPicker.\(idPrefix).\(choice.id)")
            }
        }
    }

    private func modelRow(_ choice: ModelChoice) -> some View {
        let isSelected = choice == model.selectedModel
        return Button {
            // The model already in use is a no-op, not a switch to announce.
            if isSelected || model.selectModel(choice) { done() }
        } label: {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(choice.name)
                        .fontWeight(isSelected ? .semibold : .regular)
                    Text("\(choice.provider) · \(choice.modelId)")
                        .font(.caption.monospaced())
                        .foregroundStyle(AppColors.secondaryLabel)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Spacer()
                if choice == model.pendingModel {
                    ProgressView().controlSize(.small)
                } else if choice == model.deferredModel {
                    Image(systemName: "clock").foregroundStyle(AppColors.accent)
                } else if isSelected {
                    Image(systemName: "checkmark").foregroundStyle(AppColors.accent)
                }
            }
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!rowsEnabled)
        .accessibilityLabel(
            "Model \(choice.name), provider \(choice.provider), ID \(choice.modelId). "
                + rowAction(choice, isSelected: isSelected)
        )
    }

    /// What tapping a model row would do, for VoiceOver.
    private func rowAction(_ choice: ModelChoice, isSelected: Bool) -> String {
        if choice == model.pendingModel { return "Switching to this model" }
        if isSelected { return "Currently selected" }
        return model.isConnected ? "Switch to this model" : "Use this model when the pod connects"
    }
}
