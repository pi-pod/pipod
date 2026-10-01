import SwiftUI

/// Payload-driven response UI for pi's extension UI protocol.
///
/// Deliberately independent of the approvals inbox so a live session transcript
/// composes the same safe controls: one implementation means one set of rules
/// about what may be approved and what the answer keys are.
public struct InteractionResponseControls: View {
    private let interaction: PendingInteraction
    /// Veto a dismissal while an unsent freeform draft exists, confirming before
    /// it is dropped. Only for the dedicated detail screen: several inline cards
    /// are on screen at once inside a session, and every mounted guard would
    /// answer the same back gesture.
    private let guardUnsentDraft: Bool
    private let onResolve: (JSONValue) async throws -> Void

    private let presentation: InteractionPresentation

    @State private var response = ""
    @State private var selectedOption = ""
    @State private var isResolving = false
    @State private var errorMessage: String?
    @State private var confirmingDiscard = false
    @State private var loadedDraft = false

    @Environment(\.dismiss) private var dismiss

    public init(
        interaction: PendingInteraction,
        guardUnsentDraft: Bool = false,
        onResolve: @escaping (JSONValue) async throws -> Void
    ) {
        self.interaction = interaction
        self.guardUnsentDraft = guardUnsentDraft
        self.onResolve = onResolve
        self.presentation = InteractionPresentation(interaction)
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            controls
            if isResolving {
                HStack(spacing: 8) {
                    ProgressView()
                    Text("Sending response…")
                        .font(.footnote)
                        .foregroundStyle(AppColors.secondaryLabel)
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Sending approval response")
            }
            if let errorMessage {
                Text(errorMessage)
                    .font(.footnote)
                    .foregroundStyle(AppColors.destructive)
                    .accessibilityLabel("Approval response error: \(errorMessage)")
            }
        }
        .disabled(isResolving)
        .task {
            guard !loadedDraft else { return }
            loadedDraft = true
            let saved = InteractionDraftStore.read(
                id: interaction.id, payload: interaction.payload
            )
            response = saved.isEmpty ? presentation.prefill : saved
        }
        .onChange(of: response) { _, newValue in
            guard case .input = presentation.responseStyle else { return }
            InteractionDraftStore.write(draftKey, newValue, prefill: presentation.prefill)
        }
        .interactiveDismissDisabled(guardUnsentDraft && hasResponseDraft && !isResolving)
        .confirmationDialog(
            "Discard response?",
            isPresented: $confirmingDiscard,
            titleVisibility: .visible
        ) {
            Button("Discard", role: .destructive) {
                response = presentation.prefill
                InteractionDraftStore.clear(draftKey)
                dismiss()
            }
            Button("Keep editing", role: .cancel) {}
        } message: {
            Text("The response you typed has not been sent.")
        }
        .toolbar {
            if guardUnsentDraft, hasResponseDraft, !isResolving {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { confirmingDiscard = true }
                        .accessibilityLabel("Discard the response you typed")
                }
            }
        }
    }

    // MARK: - Controls

    @ViewBuilder
    private var controls: some View {
        switch presentation.responseStyle {
        case .confirmation(let key):
            confirmationControls(key: key)
        case .input(let multiline):
            inputControls(multiline: multiline)
        case .selection(let options):
            selectionControls(options: options)
        case .unsupported:
            unsupportedNotice
        }
    }

    private func confirmationControls(key: String) -> some View {
        // "Approve/Deny" for a tool approval, "Confirm/Decline" for an extension
        // confirm: the verb has to match what the pod actually asked.
        let affirmative = key == "confirmed" ? "Confirm" : "Approve"
        let negative = key == "confirmed" ? "Decline" : "Deny"
        return HStack(spacing: 8) {
            Button(affirmative) { resolve(confirmation(key, true)) }
                .brandProminent()
                .accessibilityLabel(actionLabel(affirmative))
                .accessibilityIdentifier("interaction.confirm")
            Button(negative, role: .destructive) { resolve(confirmation(key, false)) }
                .buttonStyle(.bordered)
                .tint(AppColors.destructive)
                .accessibilityLabel(actionLabel(negative))
                .accessibilityIdentifier("interaction.decline")
        }
        .controlSize(.large)
    }

    /// A tool approval answers under `approved` rather than `confirmed`, so it
    /// cannot use the `InteractionResponse.confirmed` shorthand — but it still
    /// needs the frame type pi looks for.
    private func confirmation(_ key: String, _ value: Bool) -> JSONValue {
        key == "confirmed"
            ? InteractionResponse.confirmed(value)
            : InteractionResponse.normalized(.object([key: .bool(value)]))
    }

    @ViewBuilder
    private func inputControls(multiline: Bool) -> some View {
        // Decision text is full of hostnames, flags and commands; autocorrect
        // turns those into different instructions.
        Group {
            if multiline {
                TextField(
                    presentation.placeholder ?? "Response",
                    text: $response,
                    axis: .vertical
                )
                .lineLimit(4...12)
            } else {
                TextField(presentation.placeholder ?? "Response", text: $response)
                    .onSubmit {
                        guard !response.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        else { return }
                        resolve(InteractionResponse.value(.string(response)))
                    }
            }
        }
        .textFieldStyle(.roundedBorder)
        .autocorrectionDisabled()
        .textInputAutocapitalization(.never)
        .accessibilityLabel(actionLabel("Response for"))
        .accessibilityIdentifier("interaction.responseField")

        HStack(spacing: 8) {
            Button("Submit") { resolve(InteractionResponse.value(.string(response))) }
                .brandProminent()
                .disabled(response.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityLabel(actionLabel("Submit response for"))
                .accessibilityIdentifier("interaction.submit")
            Button("Cancel request", role: .destructive) {
                resolve(InteractionResponse.cancelled)
            }
            .buttonStyle(.bordered)
            .tint(AppColors.destructive)
            .accessibilityLabel(actionLabel("Cancel request for"))
        }
        .controlSize(.large)
    }

    @ViewBuilder
    private func selectionControls(options: [String]) -> some View {
        // No pre-selection: Submit stays disabled until the user picks for real,
        // so a default can never be sent as if it were a decision.
        //
        // A `Picker(.menu)` puts its whole hit area in the value chip, which
        // lands around 20pt tall inside a form row — too small to hit, and an
        // approval is exactly where a missed tap costs the most (pi keeps
        // blocking until its timeout). A `Menu` over a full-width row gives the
        // same behaviour with a real target.
        Menu {
            ForEach(options, id: \.self) { option in
                Button(option) { selectedOption = option }
            }
        } label: {
            HStack {
                Text(selectedOption.isEmpty ? "Choose…" : selectedOption)
                Spacer()
                Image(systemName: "chevron.up.chevron.down").font(.footnote)
            }
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .contentShape(Rectangle())
        }
        .accessibilityLabel(actionLabel("Response for"))
        .accessibilityValue(selectedOption.isEmpty ? "Choose…" : selectedOption)
        .accessibilityIdentifier("interaction.optionPicker")

        HStack(spacing: 8) {
            Button("Submit") { resolve(InteractionResponse.value(.string(selectedOption))) }
                .brandProminent()
                .disabled(selectedOption.isEmpty)
                .accessibilityLabel(actionLabel("Submit choice for"))
                .accessibilityIdentifier("interaction.submit")
            Button("Cancel request", role: .destructive) {
                resolve(InteractionResponse.cancelled)
            }
            .buttonStyle(.bordered)
            .tint(AppColors.destructive)
            .accessibilityLabel(actionLabel("Cancel selection request for"))
        }
        .controlSize(.large)
    }

    /// A request this build cannot phrase controls for still has one answer that
    /// is always correct. The server routes unknown methods to pi's extension UI,
    /// which takes `{cancelled: true}` from any of them — so backing out is
    /// offered rather than leaving pi blocked until its 120-second timeout.
    private var unsupportedNotice: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(
                """
                This app can’t answer this request type. Review the details and use a \
                client that supports it, or cancel the request so pi stops waiting.
                """,
                systemImage: "exclamationmark.triangle"
            )
            .font(.footnote)
            .foregroundStyle(StatusTone.caution.color)

            Button("Cancel request", role: .destructive) {
                resolve(InteractionResponse.cancelled)
            }
            .buttonStyle(.bordered)
            .tint(AppColors.destructive)
            .controlSize(.large)
            .accessibilityLabel(actionLabel("Cancel request for"))
            .accessibilityIdentifier("interaction.cancelUnsupported")
        }
        .accessibilityIdentifier("interaction.unsupported")
    }

    // MARK: - Behaviour

    private var draftKey: String {
        InteractionDraftStore.canonicalKey(id: interaction.id, payload: interaction.payload)
    }

    /// A freeform answer the user typed beyond any prefill. Losing it to an
    /// accidental back gesture forces retyping the decision.
    private var hasResponseDraft: Bool {
        guard case .input = presentation.responseStyle else { return false }
        return response != presentation.prefill
    }

    private func actionLabel(_ verb: String) -> String {
        let title = presentation.title.trimmingCharacters(in: .whitespacesAndNewlines)
        return title.isEmpty ? verb : "\(verb) \(title)"
    }

    private func resolve(_ answer: JSONValue) {
        // A send already in flight wins: a second tap, or a semantics action
        // slipping past the disabled state, must not fire a duplicate resolve.
        guard !isResolving else { return }
        isResolving = true
        errorMessage = nil
        Task {
            do {
                try await onResolve(answer)
                // The answer went out, so the draft served its purpose. Both id
                // domains are cleared: an entry stored before uuid adoption
                // would otherwise refill the next card.
                InteractionDraftStore.clear(draftKey)
                InteractionDraftStore.clear(interaction.id)
            } catch {
                errorMessage = "Could not send your response: "
                    + FriendlyError.message(error, serverHost: Config.serverURL.absoluteString)
            }
            isResolving = false
        }
    }
}
