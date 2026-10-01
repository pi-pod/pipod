import SwiftUI

/// One approval, in full: what is being asked, the complete request, and the
/// controls to answer it.
public struct InteractionDetailView: View {
    private let interaction: PendingInteraction

    @Environment(AppRouter.self) private var router
    @Environment(\.apiClient) private var api

    @State private var showsDetails = false

    public init(interaction: PendingInteraction) {
        self.interaction = interaction
    }

    public var body: some View {
        let presentation = InteractionPresentation(interaction)
        Form {
            Section("Request") {
                DetailRow("Pod", value: interaction.podName)
                Text(presentation.title)
                    .font(.headline)
                Text(presentation.message)
                    .font(.callout)
                    .textSelection(.enabled)
                Button {
                    // An approval is answered in context: the pod's conversation
                    // is where the request came from. The router drops this
                    // screen on the way, so the session is not stacked on top of
                    // a request nobody is asking about any more.
                    router.openSessionFromApproval(podId: interaction.podId)
                } label: {
                    Label("Open pod", systemImage: "arrow.up.forward.app")
                }
                .accessibilityLabel("Open pod \(interaction.podName) for this approval")
                .accessibilityIdentifier("approval.openPod")
            }

            Section {
                DisclosureGroup("Complete request details", isExpanded: $showsDetails) {
                    Text(presentation.details)
                        .font(.system(.footnote, design: .monospaced))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .accessibilityIdentifier("approval.details")
            }

            Section("Your response") {
                InteractionResponseControls(
                    interaction: interaction,
                    // A dedicated answer screen: a typed response must confirm
                    // before a back gesture drops it.
                    guardUnsentDraft: true
                ) { response in
                    _ = try await api.resolveInteraction(id: interaction.id, response: response)
                    // The inbox and every open session listen for this; the list
                    // drops the row and the transcript writes its receipt.
                    SessionNotifications.postResolved(id: interaction.id, response: response)
                    router.closeApprovalDetail()
                }
            }
        }
        .navigationTitle("Approval")
        .navigationBarTitleDisplayMode(.inline)
    }
}
