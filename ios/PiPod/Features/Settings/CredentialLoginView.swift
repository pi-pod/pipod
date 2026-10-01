import SwiftUI

/// Generic UI for the frozen provider-login prompt/event protocol.
///
/// The server drives: it asks questions, reports progress and hands back a
/// credential. Nothing here knows what any particular provider's sign-in looks
/// like, which is what lets a new provider ship without a client release.
struct CredentialLoginView: View {
    let provider: ConnectableProvider
    let authType: String
    var podId: String?
    let finished: (CredentialStatus?) -> Void

    @Environment(\.apiClient) private var api
    @Environment(\.openURL) private var openURL

    @State private var socket: LoginSocket?
    @State private var events: [LoginEvent] = []
    @State private var prompt: LoginPrompt?
    @State private var answer = ""
    @State private var selection = ""
    @State private var errorMessage: String?
    @State private var isConnecting = true
    @State private var isFinished = false
    @State private var isCancelled = false

    init(
        provider: ConnectableProvider,
        authType: String,
        podId: String? = nil,
        finished: @escaping (CredentialStatus?) -> Void
    ) {
        self.provider = provider
        self.authType = authType
        self.podId = podId
        self.finished = finished
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text(
                        authType == "api_key"
                            ? """
                            Enter the provider API key. It will be stored in encrypted \
                            account custody.
                            """
                            : """
                            Complete the provider sign-in to use it in every pod you launch.
                            """
                    )
                    .font(.footnote)
                    .foregroundStyle(AppColors.secondaryLabel)
                }

                if isConnecting {
                    Section {
                        HStack(spacing: 8) {
                            ProgressView().controlSize(.small)
                            Text("Starting sign-in…")
                        }
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel("Connecting to \(provider.name)")
                    }
                }

                if !events.isEmpty {
                    Section {
                        ForEach(Array(events.enumerated()), id: \.offset) { _, event in
                            eventView(event)
                        }
                    }
                }

                if let prompt {
                    Section {
                        promptControl(prompt)
                    }
                }

                if let errorMessage {
                    Section {
                        StatusBanner(.failure(errorMessage))
                            .accessibilityLabel("Provider sign-in error: \(errorMessage)")
                    }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Connect \(provider.name)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", role: .cancel) { cancel() }
                        .accessibilityLabel("Cancel \(provider.name) sign-in")
                        .accessibilityIdentifier("Cancel provider sign-in")
                }
            }
        }
        // A swipe-down that drops the socket without telling the server leaves
        // the provider's device flow polling until it expires.
        .interactiveDismissDisabled(!isFinished)
        .task { await connect() }
        .onDisappear { socket?.disconnect(notify: false) }
    }

    // MARK: - Events

    @ViewBuilder
    private func eventView(_ event: LoginEvent) -> some View {
        switch event {
        case .info(let message, let links):
            VStack(alignment: .leading, spacing: 8) {
                Text(message)
                ForEach(Array(links.enumerated()), id: \.offset) { _, link in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(link.url)
                            .font(.system(.footnote, design: .monospaced))
                            .textSelection(.enabled)
                        Button(link.displayLabel) { open(link.url) }
                            .frame(minHeight: 44)
                            .accessibilityLabel("Open \(link.displayLabel) for \(provider.name)")
                    }
                }
            }
        case .authURL(let url, let instructions):
            VStack(alignment: .leading, spacing: 8) {
                // Providers may send a sign-in link with no instructions at all.
                if let instructions { Text(instructions) }
                Text(url)
                    .font(.system(.footnote, design: .monospaced))
                    .textSelection(.enabled)
                Button("Open") { open(url) }
                    .brandProminent()
                    .accessibilityLabel("Open \(provider.name) sign-in page")
                    .accessibilityIdentifier("Open sign-in page")
            }
        case .deviceCode(let userCode, let verificationURI, _, _):
            VStack(alignment: .leading, spacing: 8) {
                Text("Enter this code on the provider sign-in page:")
                Text(userCode)
                    .font(.system(.title2, design: .monospaced).weight(.semibold))
                    .textSelection(.enabled)
                    .accessibilityLabel("Device code \(userCode)")
                Button("Copy code") { UIPasteboard.general.string = userCode }
                    .frame(minHeight: 44)
                    .accessibilityLabel("Copy \(provider.name) device code")
                Text(verificationURI)
                    .font(.system(.footnote, design: .monospaced))
                    .textSelection(.enabled)
                Button("Open") { open(verificationURI) }
                    .brandProminent()
                    .accessibilityLabel("Open \(provider.name) device sign-in page")
            }
        case .progress(let message):
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text(message)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(message)
        }
    }

    // MARK: - Prompts

    @ViewBuilder
    private func promptControl(_ prompt: LoginPrompt) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(prompt.message)

            if prompt.isSelect {
                Picker("Choose an option", selection: $selection) {
                    ForEach(prompt.options) { option in
                        Text(option.displayLabel).tag(option.id)
                    }
                }
                .accessibilityLabel("Sign-in choice for \(prompt.id)")
                .accessibilityIdentifier("Sign-in choice")
            } else if prompt.isSecret {
                SecureField(prompt.placeholder ?? "Value", text: $answer)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .accessibilityLabel("Sign-in response for \(prompt.id)")
                    .accessibilityIdentifier("Sign-in response")
            } else {
                TextField(prompt.placeholder ?? "Value", text: $answer)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .font(.system(.body, design: .monospaced))
                    .accessibilityLabel("Sign-in response for \(prompt.id)")
                    .accessibilityIdentifier("Sign-in response")
            }

            Button("Continue") { respond(prompt) }
                .brandProminent()
                .disabled(submitValue(prompt).isEmpty)
                .accessibilityLabel("Submit sign-in response for \(prompt.id)")
                .accessibilityIdentifier("Submit sign-in response")
        }
    }

    private func submitValue(_ prompt: LoginPrompt) -> String {
        prompt.isSelect ? selection : answer
    }

    private func respond(_ prompt: LoginPrompt) {
        let value = submitValue(prompt)
        guard !value.isEmpty, let socket else { return }
        if socket.respond(id: prompt.id, value: value) {
            self.prompt = nil
            answer = ""
            selection = ""
            errorMessage = nil
        } else {
            errorMessage = "Could not send the sign-in response. Try connecting again."
        }
    }

    // MARK: - Socket

    private func connect() async {
        guard socket == nil else { return }
        let socket = LoginSocket(
            api: api, providerId: provider.id, authType: authType, podId: podId
        )
        socket.onMessage = handle
        socket.onDisconnect = handleDisconnect
        self.socket = socket
        await socket.connect()
        if socket.isConnected { isConnecting = false }
    }

    private func handle(_ message: LoginServerMessage) {
        guard !isFinished else { return }
        isConnecting = false
        switch message {
        case .prompt(let prompt):
            self.prompt = prompt
            selection = prompt.options.first?.id ?? ""
            answer = ""
            errorMessage = nil
        case .event(let event):
            // Consecutive progress lines are one status, not a log.
            if event.isProgress, events.last?.isProgress == true {
                events[events.count - 1] = event
            } else {
                events.append(event)
            }
        case .done(let done):
            if done.ok, let status = done.status {
                isFinished = true
                finished(status)
                return
            }
            guard let failure = done.failure else { return }
            prompt = nil
            errorMessage = FriendlyError.message(
                apiError(for: failure), serverHost: Config.serverURL.absoluteString
            )
        }
    }

    /// The four codes `FriendlyError` already has written copy for keep their
    /// structure so that copy is reached; anything else travels as its sentence.
    private func apiError(for failure: LoginFailure) -> APIError {
        let known: Set<String> = [
            "credential_reconnect_required",
            "credential_temporarily_unavailable",
            "credential_provider_unsupported",
            "client_upgrade_required",
        ]
        guard known.contains(failure.code) else { return APIError(error: failure.message) }
        return APIError(
            error: failure.code,
            detail: .object([
                "code": .string(failure.code),
                "message": .string(failure.message),
                "provider": .string(provider.name),
            ])
        )
    }

    private func handleDisconnect(_ error: Error?) {
        guard !isFinished, !isCancelled else { return }
        isConnecting = false
        prompt = nil
        errorMessage = FriendlyError.message(
            error ?? APIError(error: "The sign-in connection closed before it finished."),
            serverHost: Config.serverURL.absoluteString
        )
    }

    private func cancel() {
        isCancelled = true
        socket?.cancel()
        finished(nil)
    }

    private func open(_ value: String) {
        // The decoder already dropped unsafe URLs; re-checking at the tap is the
        // cheap half of defence in depth.
        guard LoginProtocol.isSafeLoginURL(value), let url = URL(string: value) else { return }
        openURL(url) { accepted in
            guard !accepted else { return }
            errorMessage = "Could not open that sign-in page. Copy the URL instead."
        }
    }
}
