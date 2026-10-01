import SwiftUI

/// The signed-out screen. One action, and every failure reaches it as a sentence
/// rather than an OAuth error code.
public struct SignInView: View {
    public let notice: String?
    public let initialError: String?
    public let signIn: () async throws -> Void

    @State private var isSigningIn = false
    @State private var error: String?

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
