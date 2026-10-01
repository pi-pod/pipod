import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// The phone's window into a pi session.
///
/// Replay is compacted into a readable conversation while transport details stay
/// out of the way: the reducer in `SessionStream` owns reconnect, gaps and
/// ordering, and this screen only decides what a person sees.
public struct SessionView: View {
    let podId: String
    let initialPod: Pod?
    let fromSeq: Int?
    let sessionId: String?
    /// The exact route this screen was built for. Identity, not a pod id: see
    /// `shouldDetach`.
    let route: PodRoute

    @Environment(\.apiClient) private var api
    @Environment(AppRouter.self) private var router
    @Environment(PushController.self) private var push
    @Environment(SessionStreamRegistry.self) private var streams
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.scenePhase) private var scenePhase

    @State private var stream: SessionStream?
    @State private var draft = ""
    @State private var attachments: [ChatAttachment] = []
    @State private var pickerItems: [PhotosPickerItem] = []
    @State private var showFileImporter = false
    @State private var attachError: String?
    @State private var isPicking = false
    @State private var launchReport: LaunchReport?
    @State private var showsEditorReplayNotice = false
    @State private var shouldFocusFreshComposer = false
    @State private var followsLatest = true
    /// Whether the transcript's bottom sentinel is on screen. The drag gesture
    /// reads it so a rubber-band bounce at the end of the conversation is not
    /// mistaken for scrolling away from it.
    @State private var bottomIsVisible = true
    @State private var readThroughCount = 0
    @State private var loadedDraft = false
    /// Rows are derived from `stream.items`, and the reducer bumps a revision
    /// many times a second while a turn streams. Deriving them in `body` rebuilt
    /// the whole transcript on every bump, including the ones that changed no
    /// items at all.
    @State private var rowCache = TranscriptRowCache()
    @FocusState private var composerFocused: Bool

    public init(
        podId: String,
        initialPod: Pod? = nil,
        fromSeq: Int? = nil,
        sessionId: String? = nil,
        route: PodRoute? = nil
    ) {
        self.podId = podId
        self.initialPod = initialPod
        self.fromSeq = fromSeq
        self.sessionId = sessionId
        self.route = route
            ?? .session(
                podId: podId, pod: initialPod, fromSeq: fromSeq, sessionId: sessionId
            )
    }

    /// Whether a session screen that just left the stack should tear its socket
    /// down.
    ///
    /// Pushing the model picker or the pod details covers this screen without
    /// leaving it, and detaching there would drop a live conversation behind the
    /// user's back. But re-entering the same pod from a notification *replaces*
    /// the route with different associated values, destroying this view while a
    /// `.session` route for the same pod is still on the path — so matching on
    /// the pod id would see the replacement and leak this stream. Only the exact
    /// route this view was built for answers the question.
    static func shouldDetach(route: PodRoute, from path: [PodRoute]) -> Bool {
        !path.contains(route)
    }

    public var body: some View {
        Group {
            if let stream {
                content(stream)
            } else {
                LoadingView(label: "Opening conversation…")
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbarContent }
        .task { start() }
        .onAppear {
            // Returning from a pushed screen: heal the socket if it dropped.
            push.visiblePodId = podId
            stream?.reattachIfNeeded()
        }
        .onDisappear {
            // A notification for this pod is only redundant while it is on screen.
            if push.visiblePodId == podId { push.visiblePodId = nil }
            guard Self.shouldDetach(route: route, from: router.podsPath) else { return }
            if let stream {
                streams.forget(stream, for: podId)
                stream.detach()
            }
        }
        .onChange(of: scenePhase) { _, phase in
            // The socket is torn down in the background; coming back should not
            // cost a three-second stare at a dead screen.
            if phase == .active { stream?.reattachIfNeeded() }
        }
        .onChange(of: pickerItems) { _, items in
            guard !items.isEmpty else { return }
            Task { await stage(items) }
        }
        // The document browser presents from the screen root, not from the
        // composer button that asks for it: the bar rebuilds on every
        // transcript change, and the presentation must not share a view
        // whose identity churns underneath it. Same handlers the button
        // used to own; the button now only flips the binding.
        .fileImporter(
            isPresented: $showFileImporter,
            allowedContentTypes: [.image],
            allowsMultipleSelection: false
        ) { result in
            switch result {
            case .success(let urls):
                showFileImporter = false
                Task { await stageFiles(urls) }
            case .failure(let error):
                showFileImporter = false
                attachError = FriendlyError.message(error)
            }
        }
    }

    // MARK: - Screen

    @ViewBuilder
    private func content(_ stream: SessionStream) -> some View {
        GeometryReader { proxy in
            let rows = AnsiCellMetrics.rows(in: proxy.size.height, typeSize: typeSize)
            let header = stream.remoteUI.withRole(.header).last
            let footer = stream.remoteUI.withRole(.footer).last
            let editor = stream.remoteUI.withRole(.editor).last
            let overlays = stream.remoteUI.withRole(.custom)

            VStack(spacing: 0) {
                workstationBand(stream)

                if showsEditorReplayNotice {
                    HStack(alignment: .top, spacing: 8) {
                        Label(
                            "Recovered editor text may already have been submitted. Review it before sending.",
                            systemImage: "questionmark.circle"
                        )
                        .font(.footnote)
                        .foregroundStyle(AppColors.notice)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        Button("Dismiss") { showsEditorReplayNotice = false }
                            .font(.footnote.weight(.semibold))
                            .frame(minWidth: 44, minHeight: 44)
                    }
                    .padding(.horizontal, 12)
                    .background(AppColors.noticeFill)
                    .accessibilityIdentifier("session.editorReplayNotice")
                }

                if let launchReport, LaunchPodView.hasSomethingToSay(launchReport) {
                    SessionLaunchReportNotice(report: launchReport)
                }

                if let header {
                    RemoteUIBand(surface: header, viewportRows: rows, isHeader: true)
                }

                ZStack(alignment: .bottomTrailing) {
                    transcript(stream)
                    if !followsLatest {
                        JumpToLatestButton(
                            newMessageCount: max(0, stream.items.count - readThroughCount)
                        ) {
                            followsLatest = true
                        }
                    }
                    if !overlays.isEmpty {
                        RemoteUIOverlayLayer(surfaces: overlays, viewportRows: rows)
                    }
                }

                RemoteUIWidgetStack(
                    surfaces: widgets(stream, placement: .aboveEditor), viewportRows: rows
                )
                if let editor {
                    RemoteUIEditorPanel(surface: editor, viewportRows: rows)
                }
                ComposerBar(
                    stream: stream,
                    text: $draft,
                    placeholder: composerPlaceholder(stream),
                    onSend: { sendDraft(stream) },
                    onChooseModel: { router.openModelPicker(podId: podId) },
                    attachments: attachments,
                    onRemoveAttachment: { id in
                        attachments.removeAll { $0.id == id }
                        attachError = nil
                    },
                    pickerItems: $pickerItems,
                    showFileImporter: $showFileImporter,
                    attachError: attachError,
                    isPicking: isPicking,
                    isFocused: $composerFocused
                )
                .onAppear { focusFreshComposerIfNeeded() }
                RemoteUIWidgetStack(
                    surfaces: widgets(stream, placement: .belowEditor), viewportRows: rows
                )
                if let footer {
                    RemoteUIBand(surface: footer, viewportRows: rows, isHeader: false)
                }
            }
        }
        .background(AppColors.background)
        .onChange(of: draft) { _, value in
            guard loadedDraft else { return }
            SessionDraftStore.write(podId: podId, draft: value)
        }
        .onChange(of: stream.blockedPromptDrafts) { _, value in
            guard !value.isEmpty else { return }
            let recovered = value.joined(separator: "\n\n")
            draft = draft.isEmpty ? recovered : draft + "\n\n" + recovered
            _ = stream.takeBlockedPromptDrafts()
            composerFocused = true
        }
        .onChange(of: stream.editorSnapshotDrafts) { _, value in
            guard !value.isEmpty else { return }
            let recovered = value.joined(separator: "\n\n")
            draft = draft.isEmpty ? recovered : draft + "\n\n" + recovered
            _ = stream.takeEditorSnapshotDrafts()
            showsEditorReplayNotice = true
            composerFocused = true
        }
    }

    /// A workstation coming up replaces the connection banner rather than
    /// sitting beside it: a strip that says "Reconnecting…" under a wait that
    /// takes minutes would describe the wrong problem.
    @ViewBuilder
    private func workstationBand(_ stream: SessionStream) -> some View {
        if let wait = stream.workstationWait {
            WorkstationWaitCard(
                progress: wait.progress,
                onCheckNow: { wait.checkNow() },
                onCancel: { stream.cancelWorkstationWait() }
            )
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity)
            .background(AppColors.bar)
        } else if let notice = stream.workstationNotice {
            WorkstationNoticeTile(
                message: notice,
                retryTitle: stream.workstationCanKeepWaiting ? "Keep waiting" : nil,
                onRetry: stream.workstationCanKeepWaiting
                    ? { stream.retryWorkstationWait() } : nil
            )
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity)
            .background(AppColors.bar)
        } else {
            ConnectionBanner(stream: stream, onRetry: reopen)
        }
    }

    private func transcript(_ stream: SessionStream) -> some View {
        ScrollViewReader { scroller in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    leadingState(stream)
                    ForEach(rowCache.rows, id: \.id) { row in
                        transcriptRow(row, stream: stream)
                    }
                    ForEach(stream.pendingInteractions) { interaction in
                        approvalCard(interaction, stream: stream)
                    }
                    if stream.workingVisible
                        || TranscriptPresentation.showsTypingIndicator(
                            isRunning: stream.isRunning, lastItem: stream.items.last
                        ) {
                        TypingIndicator(label: stream.workingMessage ?? stream.workingIndicator)
                    }
                    // The sentinel that re-arms auto-follow. Reaching the bottom
                    // is how someone says "keep up with the conversation again";
                    // before this, only sending a message did.
                    Color.clear
                        .frame(height: 28)
                        .id(Self.bottomAnchor)
                        .onAppear {
                            bottomIsVisible = true
                            followsLatest = TranscriptScrollPolicy.shouldFollow(
                                wasFollowing: followsLatest, bottomIsVisible: true
                            )
                        }
                        // Not a disarm: content growing under a following
                        // transcript pushes the sentinel out for a frame, and
                        // the scroll that follows brings it straight back.
                        .onDisappear { bottomIsVisible = false }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
            }
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: stream.items, initial: true) { _, items in
                rowCache.update(items)
            }
            .onChange(of: stream.scrollRevision) { _, _ in
                guard followsLatest else { return }
                // Streaming deltas arrive many times a second; animating each
                // scroll makes the transcript judder.
                if stream.scrollIsStreamingUpdate {
                    scroller.scrollTo(Self.bottomAnchor, anchor: .bottom)
                } else {
                    withAnimation(.easeOut(duration: 0.22)) {
                        scroller.scrollTo(Self.bottomAnchor, anchor: .bottom)
                    }
                }
            }
            .onChange(of: followsLatest) { _, follows in
                guard follows else {
                    readThroughCount = stream.items.count
                    return
                }
                withAnimation(.easeOut(duration: 0.22)) {
                    scroller.scrollTo(Self.bottomAnchor, anchor: .bottom)
                }
            }
            .simultaneousGesture(
                // Dragging away from the bottom stops the transcript chasing new
                // rows; the jump button then reports what arrived meanwhile.
                // Geometry never turns following off — only a deliberate drag —
                // so a scroll the app performed itself cannot disarm it.
                DragGesture()
                    .onChanged { value in
                        followsLatest = TranscriptScrollPolicy.shouldFollow(
                            wasFollowing: followsLatest, draggedBy: value.translation.height
                        )
                    }
                    .onEnded { _ in
                        followsLatest = TranscriptScrollPolicy.shouldFollowAfterDrag(
                            wasFollowing: followsLatest, bottomIsVisible: bottomIsVisible
                        )
                    }
            )
        }
    }

    @ViewBuilder
    private func transcriptRow(_ row: TranscriptRow, stream: SessionStream) -> some View {
        switch row {
        case .day(_, let title):
            DaySeparator(title: title)
        case .tools(let items):
            ToolActivityCard(
                items: items,
                isExpanded: stream.isToolExpanded,
                setExpanded: stream.setToolExpanded
            )
        case .item(let item, let chrome):
            EventRow(
                item: item,
                chrome: chrome,
                thinkingLabel: stream.hiddenThinkingLabel,
                onRetry: { stream.retrySend(item.id) },
                onCheck: { stream.checkOutgoing(item.id) },
                onDiscard: { discardOutgoing(item, stream: stream) }
            )
        }
    }

    @ViewBuilder
    private func leadingState(_ stream: SessionStream) -> some View {
        if let preparing = stream.preparingPod {
            SandboxPreparationView(pod: preparing)
        } else if stream.historyLoadFailed, stream.items.isEmpty {
            RefreshErrorTile(
                message: "Conversation history couldn’t be loaded. Sending still works."
            ) {
                reopen()
            }
            .padding(.vertical, 16)
        } else if stream.isLoadingHistory {
            // An existing conversation must never flash "start a conversation"
            // while its history is still in flight.
            ProgressView()
                .frame(maxWidth: .infinity)
                .padding(.top, 40)
                .accessibilityLabel("Loading conversation")
        } else if stream.items.isEmpty, stream.pendingInteractions.isEmpty {
            ConversationEmptyState { suggestion in
                draft = suggestion
                composerFocused = true
            }
        }
    }

    private func approvalCard(
        _ interaction: PendingInteraction, stream: SessionStream
    ) -> some View {
        // A card the reducer calls stale may still be answerable — only a
        // resolution event truly retires a request — so the usual actions stay
        // and Dismiss is added.
        let stale = stream.isInteractionStale(interaction)
        return ApprovalCard(
            interaction: interaction,
            isStale: stale,
            onDismissStale: stale ? { _ = stream.removeInteraction(interaction.id) } : nil
        ) { response in
            let resolvableId = stream.resolvableId(for: interaction.id)
            // Register the intent first: the racing `interaction_resolved` event
            // usually beats this POST back, and it needs the answer to phrase a
            // specific receipt instead of a generic one.
            stream.beginLocalResolve(resolvableId, response: response)
            do {
                let outcome = try await api.resolveInteraction(
                    id: resolvableId, response: response
                )
                stream.markInteractionResolved(
                    resolvableId,
                    deliveryPending: outcome.isDeliveryPending,
                    response: response
                )
            } catch {
                stream.cancelLocalResolve(resolvableId)
                throw error
            }
        }
        .id(interaction.id)
    }

    private func widgets(
        _ stream: SessionStream, placement: RemoteUIPlacement
    ) -> [RemoteUISurface] {
        stream.remoteUI.withRole(.widget).filter { $0.placement == placement }
    }

    // MARK: - Toolbar

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .principal) {
            VStack(spacing: 0) {
                Text(title)
                    .font(.headline)
                    .lineLimit(1)
                if let subtitle {
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(AppColors.secondaryLabel)
                        .lineLimit(1)
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(subtitle.map { "\(title), \($0)" } ?? title)
        }
        ToolbarItem(placement: .topBarTrailing) {
            Button {
                router.openPod(podId, pod: stream?.podRecord ?? initialPod)
            } label: {
                Image(systemName: "info.circle")
            }
            .accessibilityLabel("Pod details")
            .accessibilityIdentifier("session.podDetails")
        }
    }

    private var title: String {
        stream?.podName ?? initialPod?.name ?? "Session"
    }

    /// The transport banner and preparation card already name their states.
    /// The title only adds information while an empty transcript has no typing row.
    private var subtitle: String? { stream.flatMap(Self.subtitle(for:)) }

    static func subtitle(for stream: SessionStream) -> String? {
        if stream.preparingPod != nil || stream.workstationWait != nil
            || stream.podUnavailable || stream.error != nil
            || (stream.isOffline && !stream.isConnected) || stream.waking
            || (stream.asleep != nil && !stream.isConnected) || !stream.isConnected {
            return nil
        }
        if stream.isRunning, stream.items.isEmpty, stream.pendingInteractions.isEmpty {
            return "pi is working"
        }
        return nil
    }

    private func composerPlaceholder(_ stream: SessionStream) -> String {
        Self.composerPlaceholder(for: stream)
    }

    static func composerPlaceholder(for stream: SessionStream) -> String {
        if stream.isConnected { return "Message pi…" }
        if stream.preparingPod != nil { return "Message pi (sends when ready)…" }
        // Never "wakes the pod" here: a workstation is not woken by a keystroke,
        // and offering that as the fix would be a promise this app cannot keep.
        if stream.workstationWait != nil {
            return "Message pi (sends when your workstation is up)…"
        }
        if stream.asleep != nil { return "Message pi (wakes the pod)…" }
        return stream.reconnecting
            ? "Message pi (sends on reconnect)…"
            : "Message pi (sends when connected)…"
    }

    // MARK: - Lifecycle

    private static let bottomAnchor = "session.bottom"

    private func start() {
        guard stream == nil else { return }
        launchReport = router.consumeLaunchReport(for: podId)
        shouldFocusFreshComposer = router.consumeComposerFocus(for: podId)
        let created = SessionStream(podId: podId, fromSeq: fromSeq, sessionId: sessionId)
        // Restored cards resolve through the gateway uuid from the pending
        // listing; without this the inline Submit posts the pi request id, which
        // the server rejects.
        created.pendingInteractionsFetcher = { [api] in
            try await api.interactions().items
        }
        if let initialPod { created.setPodRecordForTesting(initialPod) }
        stream = created
        // The model picker is a value route, so the tab shell builds it and needs
        // a way to find the stream this screen owns.
        streams.register(created, for: podId)
        push.visiblePodId = podId
        if !loadedDraft {
            loadedDraft = true
            let saved = SessionDraftStore.read(podId: podId)
            if !saved.isEmpty, draft.isEmpty { draft = saved }
        }
        // Not awaited here: this screen is replaced by the model picker or the
        // pod details on a push, which cancels its `.task` — and would cancel
        // the history and ticket fetches with it. The stream owns that work.
        created.startOpening(api)
    }

    /// Focus only the composer belonging to a just-created pod. The one-shot
    /// router flag is consumed before this screen replaces the launch route, so
    /// returning to the same conversation never steals a draft's focus.
    private func focusFreshComposerIfNeeded() {
        guard shouldFocusFreshComposer else { return }
        shouldFocusFreshComposer = false
        Task { @MainActor in
            await Task.yield()
            guard !Task.isCancelled else { return }
            composerFocused = true
        }
    }

    /// The connection banner's recovery action. `SessionStream.retry` owns
    /// which recovery that is, because only it knows whether the pod is
    /// asleep — and re-opening a sleeping pod recovers nothing.
    private func reopen() {
        stream?.retry(api)
    }

    private func sendDraft(_ stream: SessionStream) {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty || !attachments.isEmpty else { return }
        showsEditorReplayNotice = false
        // A selected model is not usable until the live catalog confirms it.
        // Refuse before clearing the draft so a pending switch cannot lose work.
        guard !stream.isModelSwitchInFlight, !stream.isThinkingSwitchInFlight else { return }
        // The composer already disables Send past the gateway's prompt cap; this
        // is the same refusal one layer down, so no path can hand the socket a
        // prompt the server will throw away with the turn already on screen.
        guard text.utf16.count <= ComposerLimits.maxPromptTextChars else { return }
        let staged = attachments
        draft = ""
        SessionDraftStore.write(podId: podId, draft: "")
        attachments = []
        attachError = nil
        followsLatest = true
        stream.send(text, attachments: staged)
    }

    /// Deleting an undelivered message moves its text back into the composer
    /// instead of dropping it, so a mis-tap never destroys a long draft.
    private func discardOutgoing(_ item: StreamItem, stream: SessionStream) {
        // A response-less remote mutation may still execute. Do not put its
        // text back into the composer where it looks safe to send again.
        if item.delivery != .unknown, !item.text.isEmpty {
            draft = draft.isEmpty ? item.text : draft + "\n\n" + item.text
            SessionDraftStore.write(podId: podId, draft: draft)
        }
        stream.discardOutgoing(item.id)
    }

    private func stage(_ items: [PhotosPickerItem]) async {
        isPicking = true
        attachError = nil
        let result = await ChatAttachmentLoader.load(items, existing: attachments)
        attachments.append(contentsOf: result.staged)
        attachError = result.dropped?.message
        pickerItems = []
        isPicking = false
    }

    /// The document-browser twin of `stage`: security-scoped file URLs become
    /// the same staged attachments through the same budgets and signature
    /// checks, so either attach affordance feeds the identical send path.
    private func stageFiles(_ urls: [URL]) async {
        isPicking = true
        attachError = nil
        let result = await ChatAttachmentLoader.loadFileURLs(urls, existing: attachments)
        attachments.append(contentsOf: result.staged)
        attachError = result.dropped?.message
        isPicking = false
    }
}

/// Launch context belongs beside the new conversation, not on a blocking
/// acknowledgement screen. Routine secret information is summarized by count;
/// policy changes and actionable warnings remain expandable without exposing
/// secret values.
struct SessionLaunchReportNotice: View {
    let report: LaunchReport

    @State private var isExpanded = false

    private var warnings: [String] {
        PodDetailView.userFacingWarnings(report.warnings)
    }

    static func title(for report: LaunchReport) -> String {
        var parts: [String] = []
        if !report.clamps.isEmpty {
            parts.append(
                report.clamps.count == 1 ? "1 policy change" : "\(report.clamps.count) policy changes"
            )
        }
        if !report.secretKeys.isEmpty {
            parts.append(
                report.secretKeys.count == 1 ? "1 saved secret" : "\(report.secretKeys.count) saved secrets"
            )
        }
        let warningCount = PodDetailView.userFacingWarnings(report.warnings).count
        if warningCount > 0 {
            parts.append(warningCount == 1 ? "1 warning" : "\(warningCount) warnings")
        }
        return "Launch notes · \(parts.joined(separator: " · "))"
    }

    static func icon(for report: LaunchReport) -> String {
        PodDetailView.userFacingWarnings(report.warnings).isEmpty
            ? "info.circle" : "exclamationmark.triangle"
    }

    var body: some View {
        DisclosureGroup(isExpanded: $isExpanded) {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(report.clamps) { clamp in
                    Label(clampMessage(clamp), systemImage: "slider.horizontal.3")
                        .font(.footnote)
                        .foregroundStyle(AppColors.notice)
                }
                if !report.secretKeys.isEmpty {
                    Label(
                        report.secretKeys.count == 1
                            ? "1 saved secret was sent into this pod."
                            : "\(report.secretKeys.count) saved secrets were sent into this pod.",
                        systemImage: "key"
                    )
                    .font(.footnote)
                    .foregroundStyle(AppColors.secondaryLabel)
                }
                ForEach(warnings, id: \.self) { warning in
                    Label(warning, systemImage: "exclamationmark.triangle")
                        .font(.footnote)
                        .foregroundStyle(AppColors.warning)
                }
            }
            .padding(.top, 4)
        } label: {
            Label(Self.title(for: report), systemImage: Self.icon(for: report))
                .font(.footnote.weight(.medium))
                .foregroundStyle(warnings.isEmpty ? AppColors.accent : AppColors.warning)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(AppColors.noticeFill)
        .accessibilityIdentifier("session.launchReport")
    }

    private func clampMessage(_ clamp: PolicyClamp) -> String {
        let reason = clamp.reason.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !reason.isEmpty else { return "Organization policy changed this value" }
        return reason.prefix(1).uppercased() + reason.dropFirst()
    }
}

/// The one place transport trouble is explained, with its recovery attached.
struct ConnectionBanner: View {
    let stream: SessionStream
    let onRetry: () -> Void

    var body: some View {
        if let banner = banner {
            HStack(spacing: 8) {
                if banner.spinner {
                    ProgressView().controlSize(.mini)
                } else if let icon = banner.icon {
                    Image(systemName: icon).font(.footnote)
                }
                Text(banner.text)
                    .font(.footnote)
                    .foregroundStyle(banner.destructive ? AppColors.destructive : AppColors.secondaryLabel)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if let action = banner.action {
                    Button(action.title, action: action.run)
                        .font(.footnote.weight(.semibold))
                        .buttonStyle(.plain)
                        .foregroundStyle(AppColors.accent)
                        .frame(minWidth: 44, minHeight: 44)
                        .accessibilityIdentifier("session.bannerAction")
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 6)
            .frame(maxWidth: .infinity)
            .background(banner.background)
            .accessibilityElement(children: .contain)
            .accessibilityLabel(banner.text)
            .accessibilityIdentifier("session.banner")
        }
    }

    private struct Banner {
        var text: String
        var icon: String?
        var spinner = false
        var destructive = false
        var background: Color = .clear
        var action: (title: String, run: () -> Void)?
    }

    static func bannerText(for stream: SessionStream) -> String? {
        ConnectionBanner(stream: stream, onRetry: {}).banner?.text
    }

    static func actionTitle(for stream: SessionStream) -> String? {
        ConnectionBanner(stream: stream, onRetry: {}).banner?.action?.title
    }

    private var banner: Banner? {
        if stream.podUnavailable {
            return Banner(
                text: "This pod is unavailable. Check its status on the pod screen, then retry.",
                icon: "exclamationmark.circle",
                background: AppColors.fill.opacity(0.5),
                action: ("Retry", onRetry)
            )
        }
        // `stream.error` is already the code-aware sentence: the reducer knows
        // the gateway's error code, which the raw text does not carry, so
        // re-presenting `gatewayError` here would throw that mapping away and
        // put a bare server fragment on screen.
        if let message = stream.error {
            return Banner(
                text: message,
                icon: "exclamationmark.triangle",
                destructive: true,
                background: AppColors.destructiveFill,
                action: ("Retry", onRetry)
            )
        }
        if stream.preparingPod != nil { return nil }
        if stream.isOffline, !stream.isConnected {
            return Banner(
                text: "Offline — reconnecting when the network returns",
                icon: "wifi.slash",
                action: ("Retry", onRetry)
            )
        }
        if stream.waking {
            return Banner(
                text: stream.asleep == "archived"
                    ? """
                        Waking pod from cold storage — seconds-to-minutes depending on \
                        workspace size…
                        """
                    : "Waking pod…",
                spinner: true
            )
        }
        if stream.asleep != nil, !stream.isConnected {
            return Banner(
                text: "Pod is asleep — sending a message wakes it.",
                icon: "moon.zzz",
                background: AppColors.fill.opacity(0.5),
                action: ("Wake", { stream.wake() })
            )
        }
        if !stream.isConnected {
            let text: String
            if !stream.reconnecting {
                text = "Connecting…"
            } else if stream.reconnectAttempt > 1 {
                text = "Reconnecting… (attempt \(stream.reconnectAttempt))"
            } else {
                text = "Reconnecting…"
            }
            return Banner(
                text: text,
                spinner: true,
                action: stream.reconnecting ? ("Retry now", onRetry) : nil
            )
        }
        return nil
    }
}
