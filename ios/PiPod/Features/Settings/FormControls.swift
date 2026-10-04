import SwiftUI

/// The result of the last action on a screen, kept next to the control that
/// caused it. Shared by every workspace editor so success and failure read the
/// same way wherever they happen.
public struct StatusMessage: Equatable, Sendable {
    public let text: String
    public let isError: Bool

    public init(_ text: String, isError: Bool) {
        self.text = text
        self.isError = isError
    }

    public static func success(_ text: String) -> StatusMessage {
        StatusMessage(text, isError: false)
    }

    public static func failure(_ text: String) -> StatusMessage {
        StatusMessage(text, isError: true)
    }
}

/// Inline confirmation or failure, announced when it appears.
public struct StatusBanner: View {
    public let status: StatusMessage

    public init(_ status: StatusMessage) { self.status = status }

    public var body: some View {
        let tone: StatusTone = status.isError ? .danger : .positive
        return HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(
                systemName: status.isError
                    ? "exclamationmark.triangle.fill" : "checkmark.circle.fill"
            )
            .foregroundStyle(tone.color)
            .accessibilityHidden(true)
            Text(status.text)
                .font(.footnote)
                .foregroundStyle(AppColors.label)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(10)
        .background(tone.fill, in: RoundedRectangle(cornerRadius: 10))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(status.isError ? "Error" : "Success"): \(status.text)")
    }
}

/// A load failure that belongs to one section. Settings fetches four things at
/// once; one outage must not hide or clear another section's error.
public struct SectionErrorView: View {
    public let message: String
    public let retryLabel: String
    public let retry: () async -> Void

    @State private var isRetrying = false

    public init(message: String, retryLabel: String, retry: @escaping () async -> Void) {
        self.message = message
        self.retryLabel = retryLabel
        self.retry = retry
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            StatusBanner(.failure(message))
            Button {
                Task {
                    isRetrying = true
                    await retry()
                    isRetrying = false
                }
            } label: {
                if isRetrying {
                    ProgressView().controlSize(.small)
                } else {
                    Text("Try again").font(.footnote.weight(.semibold))
                }
            }
            .buttonStyle(.plain)
            .foregroundStyle(AppColors.accent)
            .frame(minHeight: 44, alignment: .leading)
            .disabled(isRetrying)
            .accessibilityLabel(retryLabel)
        }
    }
}

/// A write-only secret value with an explicit show/hide control.
///
/// Long keys pasted blind are the top source of trailing-newline and truncation
/// mistakes, and the value can never be read back to check.
public struct SecretValueField: View {
    @Binding public var value: String
    public let accessibilityPrefix: String
    public var isEnabled: Bool

    @State private var reveals = false

    public init(value: Binding<String>, accessibilityPrefix: String, isEnabled: Bool = true) {
        self._value = value
        self.accessibilityPrefix = accessibilityPrefix
        self.isEnabled = isEnabled
    }

    public var body: some View {
        HStack(spacing: 4) {
            Group {
                if reveals {
                    TextField("Value", text: $value)
                        .font(.system(.body, design: .monospaced))
                } else {
                    SecureField("Value", text: $value)
                }
            }
            // Both branches carry these: an autocapitalisation or a smart-quote
            // substitution silently rewrites a pasted credential, and the failure
            // only surfaces much later as an unexplained 401 inside a pod.
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .keyboardType(.asciiCapable)
            .disabled(!isEnabled)
            .accessibilityLabel("\(accessibilityPrefix) value")
            .accessibilityIdentifier("\(accessibilityPrefix) value")

            Button {
                reveals.toggle()
            } label: {
                Image(systemName: reveals ? "eye.slash" : "eye")
                    .foregroundStyle(AppColors.secondaryLabel)
                    .frame(width: 44, height: 44)
            }
            .buttonStyle(.plain)
            .disabled(!isEnabled)
            .accessibilityLabel(
                "\(reveals ? "Hide" : "Show") secret value for \(accessibilityPrefix.lowercased())"
            )
        }
    }
}

/// Name, value, validation and Save for one write-only secret.
///
/// Both screens that accept one — your account and an environment — ask for
/// exactly this and have to enforce the same env-var naming rule, so they share
/// the control instead of each restating the rule.
public struct SecretEntryFields: View {
    @Binding public var name: String
    @Binding public var value: String
    public let accessibilityPrefix: String
    public let isSaving: Bool
    public let save: () -> Void

    private enum Field: Hashable { case name, value }
    @FocusState private var focused: Field?

    public init(
        name: Binding<String>,
        value: Binding<String>,
        accessibilityPrefix: String,
        isSaving: Bool,
        save: @escaping () -> Void
    ) {
        self._name = name
        self._value = value
        self.accessibilityPrefix = accessibilityPrefix
        self.isSaving = isSaving
        self.save = save
    }

    public var canSave: Bool {
        SecretName.isValid(name)
            && !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !isSaving
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            TextField("NAME", text: $name)
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
                .font(.system(.body, design: .monospaced))
                .focused($focused, equals: .name)
                .submitLabel(.next)
                .onSubmit { focused = .value }
                .disabled(isSaving)
                .accessibilityLabel("\(accessibilityPrefix) name")
                .accessibilityIdentifier("\(accessibilityPrefix) name")

            if let problem = SecretName.problem(name) {
                Text(problem)
                    .font(.caption)
                    .foregroundStyle(StatusTone.caution.color)
                    .accessibilityLabel("\(accessibilityPrefix) name problem: \(problem)")
            } else if let notice = SecretName.normalizationNotice(name) {
                Text(notice)
                    .font(.caption)
                    .foregroundStyle(AppColors.secondaryLabel)
                    .accessibilityLabel("\(accessibilityPrefix) name normalization: \(notice)")
            }

            SecretValueField(
                value: $value, accessibilityPrefix: accessibilityPrefix, isEnabled: !isSaving
            )
            .focused($focused, equals: .value)

            Button {
                focused = nil
                save()
            } label: {
                if isSaving {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("Saving secret…")
                    }
                    .frame(maxWidth: .infinity)
                } else {
                    Text("Save secret").frame(maxWidth: .infinity)
                }
            }
            .brandProminent()
            .disabled(!canSave)
            .accessibilityLabel("Save \(accessibilityPrefix.lowercased())")
            .accessibilityIdentifier("Save \(accessibilityPrefix.lowercased())")
        }
    }
}
