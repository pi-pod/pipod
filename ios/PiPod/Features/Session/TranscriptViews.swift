import SwiftUI

/// A day header between clusters of a long conversation, so a week-old
/// transcript is scannable without a timestamp on every bubble.
struct DaySeparator: View {
    let title: String

    var body: some View {
        Text(title)
            .font(.caption.weight(.semibold))
            .foregroundStyle(AppColors.secondaryLabel)
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .background(AppColors.fill.opacity(0.6), in: Capsule())
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
            .accessibilityAddTraits(.isHeader)
            .accessibilityLabel(title)
    }
}

/// Lives at the end of the transcript, next to the last turn — where a chat app
/// puts a typing indicator. A top-of-screen banner is too far from the
/// conversation it describes.
struct TypingIndicator: View {
    /// A pod extension can rename the working state through a remote-UI control
    /// frame; the app's own wording is the default.
    let label: String?

    private var text: String {
        let trimmed = label?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? "pi is working…" : trimmed
    }

    var body: some View {
        HStack(spacing: 8) {
            ProgressView().controlSize(.mini)
            Text(text)
                .font(.footnote)
                .foregroundStyle(AppColors.secondaryLabel)
        }
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(text)
        .accessibilityAddTraits(.updatesFrequently)
        .accessibilityIdentifier("session.typingIndicator")
    }
}

/// Compact jump control that also reports what arrived while the user was
/// reading further up: scrolling away from the bottom should not hide the fact
/// that the conversation moved on.
struct JumpToLatestButton: View {
    let newMessageCount: Int
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: "arrow.down")
                if newMessageCount > 0 {
                    Text("\(newMessageCount) new").font(.footnote.weight(.semibold))
                }
            }
            .padding(.horizontal, newMessageCount > 0 ? 14 : 0)
            .frame(minWidth: 44, minHeight: 44)
            .background(AppColors.card, in: Capsule())
            .overlay(Capsule().stroke(AppColors.separator))
            .shadow(color: .black.opacity(0.12), radius: 6, y: 2)
        }
        .buttonStyle(.plain)
        .foregroundStyle(AppColors.accent)
        .padding(.trailing, 16)
        .padding(.bottom, 10)
        .accessibilityLabel(
            newMessageCount > 0
                ? "\(newMessageCount) new messages. Scroll to latest"
                : "Scroll to latest messages"
        )
        .accessibilityIdentifier("session.jumpToLatest")
    }
}

/// Empty conversation: say what to do, and offer chips that only fill the
/// composer. Tapping a chip must never send — a suggestion that fires a model
/// turn spends money the user has not confirmed.
struct ConversationEmptyState: View {
    let onChoose: (String) -> Void

    static let suggestions = [
        "What’s in this workspace?",
        "Summarize recent changes",
        "Help me fix a bug",
    ]

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "bubble.left.and.bubble.right")
                .font(.system(size: 40))
                .foregroundStyle(AppColors.secondaryLabel)
            Text("Start a conversation").font(.headline)
            Text("Tell pi what you want to do in this pod.")
                .font(.callout)
                .foregroundStyle(AppColors.secondaryLabel)
                .multilineTextAlignment(.center)
            VStack(spacing: 8) {
                ForEach(Self.suggestions, id: \.self) { suggestion in
                    Button(suggestion) { onChoose(suggestion) }
                        .buttonStyle(.bordered)
                        .tint(AppColors.accent)
                        .frame(minHeight: 44)
                        .accessibilityLabel(suggestion)
                        .accessibilityHint(
                            "Fills the message field. It is not sent until you tap Send."
                        )
                }
            }
            .padding(.top, 8)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 24)
        .accessibilityIdentifier("session.emptyState")
    }
}

// MARK: - Message rows

/// One transcript row. A conversation stays readable at roughly 60 characters a
/// line, so bubbles are capped rather than running the full width of a tablet.
struct EventRow: View {
    let item: StreamItem
    let chrome: MessageChrome
    /// Replaces the placeholder shown while a reply has no visible text yet, so
    /// an extension that hides thinking can name what is happening instead.
    let thinkingLabel: String?
    let onRetry: () -> Void
    let onCheck: () -> Void
    let onDiscard: () -> Void

    static let measure: CGFloat = 560

    private var timeLabel: String? {
        item.timestamp.map { Format.transcriptTime($0) }
    }

    var body: some View {
        Group {
            switch item.style {
            case .status, .tool:
                Text(item.text)
                    .font(.footnote)
                    .foregroundStyle(AppColors.secondaryLabel)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 2)
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel(item.text)
                    // What the app says it just did to the stream ("You
                    // stopped this turn.") is a localized sentence, and
                    // `.combine` collapses the row into one element that is
                    // not a static text — so neither the wording nor the
                    // XCTest type is a contract. A tool line is a different
                    // fact and carries a different identifier, so a tool
                    // mentioning a word can never pass for a status line.
                    .accessibilityIdentifier(
                        item.style == .status
                            ? "session.statusMessage" : "session.toolMessage"
                    )
            case .user:
                userBubble
            case .assistant:
                assistantBlock
            }
        }
        .padding(.top, chrome.isContinuation ? 0 : 8)
    }

    // MARK: User

    private var userBubble: some View {
        HStack {
            Spacer(minLength: 56)
            VStack(alignment: .trailing, spacing: 2) {
                VStack(alignment: .trailing, spacing: 4) {
                    if showsMeta { metaRow(sender: "You", alignment: .trailing) }
                    if !item.attachments.isEmpty { attachmentThumbs }
                    if !item.text.isEmpty {
                        Text(item.text)
                            .font(.body)
                            .foregroundStyle(item.isError ? AppColors.destructive : AppColors.onAccent)
                            .textSelection(.enabled)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 8)
                            .background(bubbleFill, in: userShape)
                    }
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel(accessibilityText(sender: "You"))
                // The delivery footer stays outside the bubble element so a
                // Retry the sighted user can tap is not merged away into a label.
                deliveryFooter
            }
            .frame(maxWidth: Self.measure, alignment: .trailing)
        }
        .contextMenu { copyButton }
    }

    /// Fill for an outgoing bubble. Internal so the contrast tests can pin it:
    /// a pending message stays opaque — fading the accent tanks text contrast,
    /// and the delivery footer below the bubble already reports sending state.
    static func bubbleFill(isError: Bool, delivery: StreamItemDelivery) -> Color {
        if isError { return AppColors.destructiveFill }
        return AppColors.accent
    }

    private var bubbleFill: Color {
        Self.bubbleFill(isError: item.isError, delivery: item.delivery)
    }

    /// Outgoing bubbles tuck the trailing corner so grouped follow-ups read as
    /// one stack instead of a pile of identical cards.
    private var userShape: UnevenRoundedRectangle {
        UnevenRoundedRectangle(
            topLeadingRadius: 18,
            bottomLeadingRadius: 18,
            bottomTrailingRadius: chrome.isContinuation ? 18 : 6,
            topTrailingRadius: chrome.isContinuation ? 6 : 18
        )
    }

    /// Thumbnails of the images that rode along with this turn. Read-only:
    /// removal happens in the composer before sending, never after. Descriptor
    /// placeholders — history rows whose bytes never left the pod — render as
    /// size tiles instead of attempting a decode.
    private var attachmentThumbs: some View {
        let count = item.attachments.count
        return HStack(spacing: 6) {
            ForEach(Array(item.attachments.enumerated()), id: \.offset) { index, attachment in
                if attachment.isPlaceholder {
                    placeholderThumb(attachment)
                } else {
                    // Drawn from a 144px copy decoded once off the main thread.
                    // A full-size decode here would run again on every revision
                    // of a streaming transcript.
                    AttachmentThumbnail(
                        key: Self.thumbnailKey(item: item.id, index: index, attachment: attachment),
                        bytes: attachment.bytes,
                        side: 72,
                        cornerRadius: 10
                    ) {
                        placeholderThumb(attachment)
                    }
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(
            count == 1
                ? "1 image attached, \(item.attachments[0].name)"
                : "\(count) images attached"
        )
        // Two different facts, so two different identifiers. Pictures whose
        // bytes are here and pictures the server only told us about render
        // into the same collapsed strip under the same label, and "the image
        // arrived" is not provable from a size tile standing in for one.
        .accessibilityIdentifier(
            item.attachments.contains(where: \.isPlaceholder)
                ? "session.messageAttachmentsPlaceholder"
                : "session.messageAttachments"
        )
    }

    /// Stable per image for the lifetime of the row. A live echo carries the
    /// composer's own attachment id; a history row carries none, so its position
    /// inside its item is the identity — both are stable, and neither hashes
    /// megabytes of pixels to find a cache entry.
    static func thumbnailKey(
        item: String, index: Int, attachment: StreamImageAttachment
    ) -> String {
        attachment.id.isEmpty ? "\(item)#\(index)" : attachment.id
    }

    /// A history image whose bytes never left the pod: an icon plus the size the
    /// server reported, so an older turn still reads as carrying pictures.
    private func placeholderThumb(_ attachment: StreamImageAttachment) -> some View {
        VStack(spacing: 2) {
            Image(systemName: "photo").font(.title3)
            Text(ChatAttachmentLimits.describeBytes(attachment.sizeBytes))
                .font(.caption2)
                .lineLimit(1)
        }
        .foregroundStyle(AppColors.secondaryLabel)
        .frame(width: 72, height: 72)
        .background(AppColors.fill.opacity(0.5), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(AppColors.separator))
    }

    /// Undelivered work is reported on the message it belongs to, with the
    /// recovery next to it — a banner elsewhere cannot say *which* message is
    /// stuck.
    @ViewBuilder
    private var deliveryFooter: some View {
        switch item.delivery {
        case .delivered:
            EmptyView()
        case .sending:
            deliveryLabel("Sending…", systemImage: "paperplane")
        case .waitingForConnection:
            deliveryLabel("Waiting for connection", systemImage: "clock")
        case .savedOnServer:
            HStack(spacing: 8) {
                deliveryLabel("Saved on server", systemImage: "checkmark.circle")
                Button("Check status", action: onCheck)
                    .font(.caption.weight(.semibold))
                    .frame(minWidth: 44, minHeight: 44)
                    .accessibilityLabel("Check this queued message's delivery status")
                    .accessibilityIdentifier("session.checkSend")
            }
            .buttonStyle(.plain)
            .foregroundStyle(AppColors.accent)
        case .unknown:
            HStack(spacing: 8) {
                Label("Delivery unconfirmed", systemImage: "questionmark.circle")
                    .font(.caption)
                    .foregroundStyle(AppColors.notice)
                Button("Check conversation", action: onCheck)
                    .font(.caption.weight(.bold))
                    .frame(minWidth: 44, minHeight: 44)
                    .accessibilityLabel("Check whether this message was delivered")
                    .accessibilityIdentifier("session.checkSend")
                Button("Remove local", role: .destructive, action: onDiscard)
                    .font(.caption)
                    .frame(minWidth: 44, minHeight: 44)
                    .accessibilityLabel("Remove this local message notice")
                    .accessibilityIdentifier("session.discardSend")
            }
            .buttonStyle(.plain)
            .foregroundStyle(AppColors.accent)
        case .failed:
            HStack(spacing: 8) {
                Label("Not delivered", systemImage: "exclamationmark.circle")
                    .font(.caption)
                    .foregroundStyle(AppColors.notice)
                Button("Retry", action: onRetry)
                    .font(.caption.weight(.bold))
                    .frame(minWidth: 44, minHeight: 44)
                    .accessibilityLabel("Send this message again")
                    .accessibilityIdentifier("session.retrySend")
                Button("Delete", role: .destructive, action: onDiscard)
                    .font(.caption)
                    .frame(minWidth: 44, minHeight: 44)
                    .accessibilityLabel("Delete this undelivered message")
                    .accessibilityIdentifier("session.discardSend")
            }
            .buttonStyle(.plain)
            .foregroundStyle(AppColors.accent)
        }
    }

    private func deliveryLabel(_ text: String, systemImage: String) -> some View {
        Label(text, systemImage: systemImage)
            .font(.caption)
            .foregroundStyle(AppColors.secondaryLabel)
    }

    // MARK: Assistant

    private var assistantBlock: some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                if showsMeta { metaRow(sender: "pi", alignment: .leading) }
                assistantContent
            }
            .frame(maxWidth: Self.measure, alignment: .leading)
            Spacer(minLength: 20)
        }
        .accessibilityElement(children: .contain)
        // Acceptance identifier so UI tests can correlate assistant-role
        // responses distinctly from the user's own echoed prompt text.
        .accessibilityIdentifier("session.assistantMessage")
        .contextMenu { copyButton }
    }

    @ViewBuilder
    private var assistantContent: some View {
        if item.isInProgress, item.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            let label = thinkingLabel?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            HStack(spacing: 6) {
                ProgressView().controlSize(.mini)
                Text(label.isEmpty ? "Thinking…" : label)
                    .font(.callout)
                    .foregroundStyle(AppColors.secondaryLabel)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel(accessibilityText(sender: "pi"))
        } else if item.isError {
            Text(item.text)
                .font(.callout)
                .foregroundStyle(AppColors.destructive)
                .textSelection(.enabled)
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(AppColors.destructiveFill, in: RoundedRectangle(cornerRadius: 12))
                .accessibilityLabel(accessibilityText(sender: "pi"))
        } else {
            MarkdownText(item.text)
                .accessibilityLabel(accessibilityText(sender: "pi"))
        }
    }

    // MARK: Shared chrome

    private var showsMeta: Bool {
        chrome.showsSender || (chrome.showsTimestamp && timeLabel != nil)
    }

    private func metaRow(sender: String, alignment: HorizontalAlignment) -> some View {
        HStack(spacing: 6) {
            if chrome.showsSender {
                Text(sender)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(AppColors.secondaryLabel)
            }
            if item.isError {
                Image(systemName: "exclamationmark.triangle")
                    .font(.caption2)
                    .foregroundStyle(AppColors.destructive)
            }
            if chrome.showsTimestamp, let timeLabel {
                Text(timeLabel)
                    .font(.caption)
                    .foregroundStyle(AppColors.secondaryLabel)
            }
        }
        .frame(maxWidth: .infinity, alignment: alignment == .leading ? .leading : .trailing)
        .accessibilityHidden(true)
    }

    private var copyButton: some View {
        Button {
            UIPasteboard.general.string = item.text
        } label: {
            Label("Copy message", systemImage: "doc.on.doc")
        }
    }

    /// Screen readers still need the speaker when the visual label is collapsed
    /// into a group — otherwise consecutive "You" bubbles become anonymous.
    private func accessibilityText(sender: String) -> String {
        var parts = [sender]
        if let timeLabel { parts.append(timeLabel) }
        if item.isError { parts.append("Error") }
        if !item.attachments.isEmpty {
            let count = item.attachments.count
            parts.append(count == 1 ? "1 image attached" : "\(count) images attached")
        }
        let body = item.text.trimmingCharacters(in: .whitespacesAndNewlines)
        parts.append(body.isEmpty && item.isInProgress ? "Thinking" : body)
        switch item.delivery {
        case .delivered: break
        case .sending: parts.append("Sending")
        case .waitingForConnection: parts.append("Waiting for connection")
        case .savedOnServer: parts.append("Saved on the server")
        case .unknown: parts.append("Delivery unconfirmed")
        case .failed: parts.append("Not delivered")
        }
        return parts.joined(separator: ", ")
    }
}

// MARK: - Tool activity

/// One run of tool calls, collapsed into a single line. A turn that reads six
/// files and runs three commands is nine full-width cards otherwise, and the
/// prose the user actually came for scrolls off the top.
struct ToolActivityCard: View {
    let items: [StreamItem]
    let isExpanded: (String) -> Bool
    let setExpanded: (String, Bool) -> Void

    private var groupID: String { "tool-group-\(items.first?.id ?? "")" }
    private var activeItem: StreamItem? { items.last { $0.isInProgress } }
    private var failureCount: Int { items.filter(\.isError).count }
    private var hasDetails: Bool { items.contains { !$0.text.isEmpty } }

    private var summary: String {
        if let activeItem { return activeItem.title }
        if items.count == 1 { return items[0].title }
        return "\(items.count) tool calls"
    }

    var body: some View {
        let expanded = isExpanded(groupID)
        VStack(alignment: .leading, spacing: 8) {
            Button {
                guard hasDetails else { return }
                setExpanded(groupID, !expanded)
            } label: {
                HStack(spacing: 8) {
                    statusIcon
                    Text(summary)
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(failureCount > 0 ? AppColors.destructive : AppColors.label)
                        .lineLimit(1)
                    if failureCount > 0, items.count > 1 {
                        Text("\(failureCount) failed")
                            .font(.caption)
                            .foregroundStyle(AppColors.destructive)
                    }
                    Spacer()
                    if hasDetails {
                        Image(systemName: expanded ? "chevron.up" : "chevron.down")
                            .font(.footnote)
                            .foregroundStyle(AppColors.secondaryLabel)
                    }
                }
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!hasDetails)
            .accessibilityLabel(
                failureCount > 0 ? "\(summary), \(failureCount) failed" : summary
            )
            .accessibilityHint(hasDetails ? "Shows what each tool did" : "")
            .accessibilityIdentifier("session.toolGroup")

            if expanded {
                if items.count == 1 {
                    detailText(items[0].text)
                } else {
                    ForEach(items) { item in
                        ToolDetailRow(
                            item: item,
                            isExpanded: isExpanded(item.id),
                            setExpanded: { setExpanded(item.id, $0) }
                        )
                    }
                }
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(AppColors.fill.opacity(0.45), in: RoundedRectangle(cornerRadius: 12))
        .padding(.top, 8)
    }

    @ViewBuilder
    private var statusIcon: some View {
        if activeItem != nil {
            ProgressView().controlSize(.mini)
        } else {
            Image(systemName: failureCount > 0 ? "xmark.circle" : "checkmark.circle")
                .font(.footnote)
                .foregroundStyle(
                    failureCount > 0 ? AppColors.destructive : AppColors.secondaryLabel
                )
        }
    }

    private func detailText(_ text: String) -> some View {
        ScrollView(.horizontal, showsIndicators: true) {
            Text(text)
                .font(.system(.footnote, design: .monospaced))
                .textSelection(.enabled)
                // Tool output is a grid; let it scroll rather than wrap.
                .fixedSize(horizontal: true, vertical: true)
        }
    }
}

private struct ToolDetailRow: View {
    let item: StreamItem
    let isExpanded: Bool
    let setExpanded: (Bool) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button {
                guard !item.text.isEmpty else { return }
                setExpanded(!isExpanded)
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: item.isError ? "xmark.circle" : "checkmark.circle")
                        .font(.caption)
                        .foregroundStyle(
                            item.isError ? AppColors.destructive : AppColors.secondaryLabel
                        )
                    Text(item.title)
                        .font(.footnote)
                        .foregroundStyle(item.isError ? AppColors.destructive : AppColors.label)
                        .lineLimit(1)
                    Spacer()
                    if !item.text.isEmpty {
                        Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                            .font(.caption)
                            .foregroundStyle(AppColors.secondaryLabel)
                    }
                }
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(item.text.isEmpty)
            .accessibilityLabel(item.title)

            if isExpanded, !item.text.isEmpty {
                // Indented under its own title, or the output reads as the card's.
                ScrollView(.horizontal, showsIndicators: true) {
                    Text(item.text)
                        .font(.system(.footnote, design: .monospaced))
                        .textSelection(.enabled)
                        .fixedSize(horizontal: true, vertical: true)
                }
                .padding(.leading, 22)
            }
        }
    }
}

// MARK: - Approval card

/// An approval request inline in the transcript. The response controls are
/// shared with the standalone approvals inbox, so there is one set of rules
/// about what may be approved.
struct ApprovalCard: View {
    let interaction: PendingInteraction
    let isStale: Bool
    let onDismissStale: (() -> Void)?
    let onResolve: (JSONValue) async throws -> Void

    @State private var showsDetails = false

    /// Shown when the turn settled without an answer. Its own element, so a
    /// screen reader announces that pi moved on.
    static let staleCaption =
        "pi moved on without this answer — you can still respond or dismiss."

    var body: some View {
        let presentation = InteractionPresentation(interaction)
        VStack(alignment: .leading, spacing: 10) {
            Label(presentation.title, systemImage: "person.badge.shield.checkmark")
                .font(.subheadline)
                .foregroundStyle(AppColors.notice)

            Text(presentation.message)
                .font(.callout)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)

            if isStale {
                Text(Self.staleCaption)
                    .font(.footnote)
                    .foregroundStyle(AppColors.secondaryLabel)
                    .accessibilityLabel(Self.staleCaption)
            }

            DisclosureGroup("Complete request details", isExpanded: $showsDetails) {
                ScrollView(.horizontal, showsIndicators: true) {
                    Text(presentation.details)
                        .font(.system(.footnote, design: .monospaced))
                        .textSelection(.enabled)
                        .fixedSize(horizontal: true, vertical: true)
                }
            }
            .font(.footnote)
            .accessibilityIdentifier("session.approvalDetails")

            InteractionResponseControls(
                interaction: interaction,
                // Several cards can be on screen at once, so the unsent-draft
                // guard stays off here: each mounted guard would answer the same
                // back gesture with its own dialog.
                guardUnsentDraft: false,
                onResolve: onResolve
            )

            if isStale, let onDismissStale {
                Button("Dismiss", action: onDismissStale)
                    .buttonStyle(.bordered)
                    .frame(minHeight: 44)
                    .accessibilityLabel(
                        presentation.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                            ? "Dismiss stale request"
                            : "Dismiss stale request for \(presentation.title)"
                    )
            }
        }
        .padding(14)
        .background(AppColors.noticeFill, in: RoundedRectangle(cornerRadius: 16))
        .padding(.vertical, 6)
        .accessibilityIdentifier("session.approvalCard")
    }
}

// MARK: - Sandbox preparation

/// The staged progress of a sandbox that is still being built. A bare spinner
/// leaves the user guessing whether a slow bake script is progress or a hang.
struct SandboxPreparationView: View {
    let pod: Pod

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Preparing your sandbox").font(.subheadline)
            Text(
                """
                You can send a message now. It is saved on the server and starts \
                automatically when setup finishes.
                """
            )
            .font(.callout)
            .foregroundStyle(AppColors.secondaryLabel)

            ForEach(Self.stages(pod), id: \.label) { stage in
                HStack(alignment: .top, spacing: 10) {
                    stageIcon(stage.status).frame(width: 20)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(stage.label).font(.callout)
                        Text(stage.detail)
                            .font(.footnote)
                            .foregroundStyle(AppColors.secondaryLabel)
                    }
                    Spacer()
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel("\(stage.label), \(stage.detail)")
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(AppColors.fill.opacity(0.4), in: RoundedRectangle(cornerRadius: 12))
    }

    @ViewBuilder
    private func stageIcon(_ status: String) -> some View {
        if ["running", "preparing", "installing"].contains(status) {
            ProgressView().controlSize(.mini)
        } else if ["ok", "ready", "skipped", "degraded"].contains(status) {
            Image(systemName: status == "degraded" ? "exclamationmark.circle" : "checkmark.circle")
                .foregroundStyle(status == "degraded" ? AppColors.warning : AppColors.success)
        } else if status.hasPrefix("failed") {
            Image(systemName: "xmark.circle").foregroundStyle(AppColors.destructive)
        } else {
            Image(systemName: "circle").foregroundStyle(AppColors.separator)
        }
    }

    struct PreparationStage {
        let label: String
        let detail: String
        let status: String
    }

    static func stages(_ pod: Pod) -> [PreparationStage] {
        var result: [PreparationStage] = []
        let phase = pod.preparationPhase
        let config = pod.resolvedConfig

        let imageStatus = config.imagePreparation?.status
            ?? (phase == "preparing-image" ? "preparing" : "ready")
        result.append(
            PreparationStage(
                label: "Runtime image",
                detail: imageStatus == "preparing"
                    ? "Building the required image" : stageDetail(imageStatus),
                status: imageStatus
            )
        )

        let sandboxStatus: String
        if phase == "preparing-image" {
            sandboxStatus = "pending"
        } else if phase == "provisioning-sandbox" {
            sandboxStatus = "running"
        } else if phase == "waiting-for-capacity" {
            // The server promotes the launch phase while a bounded capacity wait
            // is live. It is not provisioning yet and it is certainly not ready:
            // falling through to "ok" told the reader the sandbox was up while
            // the request was still queued behind other people's.
            sandboxStatus = "waiting"
        } else {
            sandboxStatus = "ok"
        }
        result.append(
            PreparationStage(
                label: "Sandbox",
                detail: sandboxStatus == "running"
                    ? "Creating and starting the sandbox"
                    : (sandboxStatus == "waiting"
                        ? "Waiting for room on a machine" : stageDetail(sandboxStatus)),
                status: sandboxStatus
            )
        )

        if let settings = config.piSettings, settings.packageCount > 0 {
            result.append(
                PreparationStage(
                    label: "Pi providers",
                    detail: settings.status == "installing"
                        ? "Installing Claude Agent SDK and Meta OAuth support"
                        : stageDetail(settings.status),
                    status: settings.status
                )
            )
        }

        if let bake = config.bake {
            result.append(
                PreparationStage(
                    label: "Bake script",
                    detail: bake.status == "running"
                        ? "Running the environment bake script"
                        : "\(stageDetail(bake.status)) · \(bake.mode)",
                    status: bake.status
                )
            )
        }

        for step in config.initSteps ?? [] {
            result.append(
                PreparationStage(
                    label: "\(initLabel(step.scope)) setup",
                    detail: step.status == "running"
                        ? "Running the init script" : stageDetail(step.status),
                    status: step.status
                )
            )
        }
        return result
    }

    static func stageDetail(_ status: String) -> String {
        switch status {
        case "ok", "ready": return "Ready"
        case "skipped": return "Not needed"
        case "waiting": return "Waiting for capacity"
        case "pending": return "Waiting"
        case "degraded": return "Finished with a warning"
        case "failed": return "Failed"
        default: return capitalized(status.replacingOccurrences(of: "_", with: " "))
        }
    }

    static func initLabel(_ scope: String) -> String {
        switch scope {
        case "org": return "Organization"
        case "template": return "Environment"
        case "project": return "Project"
        default: return capitalized(scope)
        }
    }

    private static func capitalized(_ value: String) -> String {
        guard let first = value.first else { return value }
        return first.uppercased() + value.dropFirst()
    }
}
