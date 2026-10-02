import SwiftUI

/// A question pi is waiting on, at the end of the conversation it belongs to.
struct DialogCard: View {
    let dialog: PiDialog
    /// Sends the answer; false when the conversation is not connected.
    let onAnswer: (JSONValue) -> Bool

    @State private var response: String
    @State private var selectedOption = ""
    @State private var showsDetails = false
    @State private var errorMessage: String?

    init(dialog: PiDialog, onAnswer: @escaping (JSONValue) -> Bool) {
        self.dialog = dialog
        self.onAnswer = onAnswer
        _response = State(initialValue: dialog.prefill)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(dialog.title, systemImage: "questionmark.bubble")
                .font(.subheadline)
                .foregroundStyle(AppColors.notice)

            Text(dialog.message)
                .font(.callout)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)

            DisclosureGroup("Complete request details", isExpanded: $showsDetails) {
                ScrollView(.horizontal, showsIndicators: true) {
                    Text(dialog.details)
                        .font(.system(.footnote, design: .monospaced))
                        .textSelection(.enabled)
                        .fixedSize(horizontal: true, vertical: true)
                }
            }
            .font(.footnote)
            .accessibilityIdentifier("session.dialogDetails")

            controls

            if let errorMessage {
                Text(errorMessage)
                    .font(.footnote)
                    .foregroundStyle(AppColors.destructive)
            }
        }
        .padding(14)
        .background(AppColors.noticeFill, in: RoundedRectangle(cornerRadius: 16))
        .padding(.vertical, 6)
        .accessibilityIdentifier("session.dialogCard")
    }

    @ViewBuilder
    private var controls: some View {
        switch dialog.style {
        case .confirm:
            HStack(spacing: 8) {
                Button("Confirm") { send(dialog.confirmed(true)) }
                    .brandProminent()
                    .accessibilityLabel(label("Confirm"))
                    .accessibilityIdentifier("dialog.confirm")
                Button("Decline", role: .destructive) { send(dialog.confirmed(false)) }
                    .buttonStyle(.bordered)
                    .tint(AppColors.destructive)
                    .accessibilityLabel(label("Decline"))
                    .accessibilityIdentifier("dialog.decline")
            }
            .controlSize(.large)

        case .input(let multiline):
            // Answers are full of hostnames, flags and commands; autocorrect
            // turns those into different instructions.
            Group {
                if multiline {
                    TextField(dialog.placeholder ?? "Response", text: $response, axis: .vertical)
                        .lineLimit(4...12)
                } else {
                    TextField(dialog.placeholder ?? "Response", text: $response)
                        .onSubmit { if !trimmed(response).isEmpty { send(dialog.value(response)) } }
                }
            }
            .textFieldStyle(.roundedBorder)
            .autocorrectionDisabled()
            .textInputAutocapitalization(.never)
            .accessibilityLabel(label("Response for"))
            .accessibilityIdentifier("dialog.responseField")
            answerButtons(submitDisabled: trimmed(response).isEmpty) { dialog.value(response) }

        case .select(let options):
            // No pre-selection: Submit stays disabled until a real pick, so a
            // default is never sent as if it were a decision. A `Menu` over a
            // full-width row, because a `Picker(.menu)` chip is too small to hit.
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
            .accessibilityLabel(label("Response for"))
            .accessibilityValue(selectedOption.isEmpty ? "Choose…" : selectedOption)
            .accessibilityIdentifier("dialog.optionPicker")
            answerButtons(submitDisabled: selectedOption.isEmpty) { dialog.value(selectedOption) }

        case .unsupported:
            // Every dialog takes `{cancelled: true}`, so backing out is always
            // possible rather than leaving pi waiting until its timeout.
            Label(
                "This app can’t answer this kind of question. Cancel it so pi stops waiting, "
                    + "or answer it from the terminal.",
                systemImage: "exclamationmark.triangle"
            )
            .font(.footnote)
            .foregroundStyle(StatusTone.caution.color)
            Button("Cancel question", role: .destructive) { send(dialog.cancelled) }
                .buttonStyle(.bordered)
                .tint(AppColors.destructive)
                .controlSize(.large)
                .accessibilityIdentifier("dialog.cancel")
        }
    }

    private func answerButtons(
        submitDisabled: Bool, answer: @escaping () -> JSONValue
    ) -> some View {
        HStack(spacing: 8) {
            Button("Submit") { send(answer()) }
                .brandProminent()
                .disabled(submitDisabled)
                .accessibilityLabel(label("Submit response for"))
                .accessibilityIdentifier("dialog.submit")
            Button("Cancel question", role: .destructive) { send(dialog.cancelled) }
                .buttonStyle(.bordered)
                .tint(AppColors.destructive)
                .accessibilityLabel(label("Cancel question"))
        }
        .controlSize(.large)
    }

    private func send(_ answer: JSONValue) {
        errorMessage = onAnswer(answer)
            ? nil
            : "Not connected. pi is still waiting; answer again once the conversation reconnects."
    }

    private func trimmed(_ text: String) -> String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func label(_ verb: String) -> String {
        let title = trimmed(dialog.title)
        return title.isEmpty ? verb : "\(verb) \(title)"
    }
}
