import SwiftUI

/// The signed-out screen. One action, and every failure reaches it as a sentence
/// rather than an OAuth error code.
public struct SignInView: View {
    public let notice: String?
    public let initialError: String?
    public let signIn: () async throws -> Void

    @State private var isSigningIn = false
    @State private var error: String?
    @State private var serverName = ServerDiscovery.displayName(Config.serverURL)
    @State private var isChoosingServer = false

    public init(
        notice: String? = nil,
        initialError: String? = nil,
        signIn: @escaping () async throws -> Void
    ) {
        self.notice = notice
        self.initialError = initialError
        self.signIn = signIn
    }

    public var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                brandMark
                    .padding(.bottom, 20)

                Text("pi pod")
                    .font(.largeTitle.bold())

                Text("Run every pi session inside a fresh pod — from any device.")
                    .font(.body)
                    .foregroundStyle(AppColors.secondaryLabel)
                    .multilineTextAlignment(.center)
                    .padding(.top, 12)

                Button(action: start) {
                    HStack(spacing: 8) {
                        if isSigningIn {
                            ProgressView().controlSize(.small).tint(AppColors.onAccent)
                        } else {
                            Image(systemName: "person.crop.circle")
                        }
                        Text(isSigningIn ? "Signing in…" : "Sign in")
                    }
                    .frame(maxWidth: .infinity, minHeight: 28)
                }
                .brandProminent()
                .controlSize(.large)
                .disabled(isSigningIn)
                .padding(.top, 28)
                .accessibilityIdentifier("sign_in_button")
                .accessibilityLabel("Sign in")

                Button {
                    isChoosingServer = true
                } label: {
                    (Text("Server: ").foregroundStyle(AppColors.secondaryLabel)
                        + Text(serverName) + Text(" · Change").foregroundStyle(AppColors.accent))
                        .font(.footnote)
                }
                .buttonStyle(.plain)
                .disabled(isSigningIn)
                .padding(.top, 14)
                .accessibilityIdentifier("sign_in.server")
                .accessibilityLabel("Server: \(serverName). Change server")

                if let notice {
                    Text(notice)
                        .font(.subheadline)
                        .foregroundStyle(AppColors.secondaryLabel)
                        .multilineTextAlignment(.center)
                        .padding(.top, 18)
                        .accessibilityLabel("Authentication notice: \(notice)")
                }

                if let error {
                    Text(error)
                        .font(.subheadline)
                        .foregroundStyle(AppColors.destructive)
                        .multilineTextAlignment(.center)
                        .padding(.top, 18)
                        .accessibilityLabel("Sign in error: \(error)")
                        .accessibilityAddTraits(.isStaticText)
                }
            }
            .frame(maxWidth: 440)
            .frame(maxWidth: .infinity)
            .padding(32)
        }
        .scrollBounceBehavior(.basedOnSize)
        .background(AppColors.background)
        .sheet(isPresented: $isChoosingServer) {
            ServerPickerSheet { choice in
                Config.serverChoice = choice
                serverName = ServerDiscovery.displayName(Config.serverURL)
                error = nil
            }
        }
        .onAppear { error = initialError }
        .onChange(of: initialError) { _, newValue in error = newValue }
    }

    private var brandMark: some View {
        ZStack {
            Circle()
                .fill(AppColors.accent.opacity(0.12))
            Image(systemName: "shippingbox.fill")
                .font(.system(size: 44))
                .foregroundStyle(AppColors.accent)
        }
        .frame(width: 96, height: 96)
        .accessibilityHidden(true)
    }

    private func start() {
        guard !isSigningIn else { return }
        isSigningIn = true
        error = nil
        Task {
            do {
                try await signIn()
            } catch {
                self.error = FriendlyError.message(error)
            }
            isSigningIn = false
        }
    }
}

/// Where to sign in: pi pod cloud, or an organization's own self-hosted server, found from its
/// address alone.
private struct ServerPickerSheet: View {
    let onChoose: (Config.ServerChoice?) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var address = Config.serverChoice.map { ServerDiscovery.address($0.serverURL) } ?? ""
    @State private var isChecking = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("pipod.example.com", text: $address)
                        .keyboardType(.URL)
                        .textContentType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.continue)
                        .onSubmit(check)
                        .accessibilityIdentifier("server.address")
                        .accessibilityLabel("Server address")
                } header: {
                    Text("Your server")
                } footer: {
                    Text("If your organization runs pi pod itself, enter the address its CLI signs in to.")
                }
                if let error {
                    Text(error)
                        .font(.subheadline)
                        .foregroundStyle(AppColors.destructive)
                        .accessibilityIdentifier("server.error")
                }
                if Config.serverChoice != nil {
                    Section {
                        Button("Use pi pod cloud") {
                            onChoose(nil)
                            dismiss()
                        }
                        .accessibilityIdentifier("server.useCloud")
                    }
                }
            }
            .navigationTitle("Server")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isChecking {
                        ProgressView()
                    } else {
                        Button("Continue", action: check)
                            .disabled(address.trimmingCharacters(in: .whitespaces).isEmpty)
                            .accessibilityIdentifier("server.continue")
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func check() {
        guard !isChecking else { return }
        isChecking = true
        error = nil
        Task {
            do {
                onChoose(try await ServerDiscovery.resolve(address))
                dismiss()
            } catch {
                self.error = (error as? LocalizedError)?.errorDescription ?? FriendlyError.message(error)
            }
            isChecking = false
        }
    }
}
