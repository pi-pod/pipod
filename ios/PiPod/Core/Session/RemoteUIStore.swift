import Foundation
import Observation

/// Sends a `ui_response` client message. Returns false when the socket is down;
/// the gateway replays the still-outstanding input request on reattach, so a
/// dropped send costs one round trip rather than the surface.
public typealias RemoteUIResponder = (JSONValue) -> Bool

/// One pod-side extension surface as the app knows it: the newest rendered
/// lines, the metadata accumulated across frames, and the input request the pod
/// is currently waiting on.
///
/// Behaviour mirrors `RemoteSurface` in pi-pod's `client/runtime/remote-ui.ts`,
/// which is the contract of record: revision monotonicity, resize-before-input
/// flush ordering, batched key events, and newest-wins `setText`.
@MainActor
@Observable
public final class RemoteUISurface: Identifiable {
    public let id: String

    /// Metadata merged across every frame this surface has received.
    public private(set) var frame: RemoteUISurfaceFrame
    public private(set) var lines: [String] = []
    public private(set) var editorText = ""
    public private(set) var revision = -1

    /// Set when another attached client claimed this surface first. It keeps
    /// rendering; only input is refused.
    public private(set) var readOnly = false

    @ObservationIgnored private weak var store: RemoteUIStore?
    @ObservationIgnored private var json: [String: JSONValue]
    @ObservationIgnored private var pendingRequestID: String?
    @ObservationIgnored private var sequence = 0
    @ObservationIgnored private var lastEditorSubmitID = 0
    @ObservationIgnored private var width = 0
    @ObservationIgnored private var height = 0
    @ObservationIgnored private var queuedWidth = 0
    @ObservationIgnored private var queuedHeight = 0
    @ObservationIgnored private var queued: [QueuedInput] = []

    init?(id: String, store: RemoteUIStore, json: JSONValue) {
        guard let object = json.objectValue,
              case .surface(let frame)? = RemoteUIFrame.from(json: json)
        else { return nil }
        self.id = id
        self.store = store
        self.json = object
        self.frame = frame
    }

    public var role: RemoteUIRole { frame.role }
    public var isOverlay: Bool { frame.overlay }
    public var overlayOptions: RemoteUIOverlayOptions? { frame.overlayOptions }
    public var widgetKey: String? { frame.widgetKey }
    public var placement: RemoteUIPlacement { frame.placement ?? .aboveEditor }

    /// A non-capturing overlay does not take focus unless the pod says so.
    public var focused: Bool { frame.focused ?? !(overlayOptions?.nonCapturing ?? false) }

    /// True while the pod is waiting for this client to answer.
    public var isAwaitingInput: Bool { pendingRequestID != nil }

    // MARK: - Incoming frames

    func apply(
        json incoming: JSONValue,
        frame: RemoteUISurfaceFrame,
        requestID: String?,
        gatewayReplay: Bool
    ) {
        if frame.revision >= revision, let object = incoming.objectValue {
            revision = frame.revision
            lines = frame.lines ?? []
            json.merge(object) { _, new in new }
            if case .surface(let merged)? = RemoteUIFrame.from(json: .object(json)) {
                self.frame = merged
            }
            applyEditorFrame(
                text: frame.editorText, submit: frame.editorSubmit,
                submitID: frame.editorSubmitID, gatewayReplay: gatewayReplay
            )
        }
        if let requestID {
            pendingRequestID = requestID
            flush()
        }
    }

    private func applyEditorFrame(
        text: String?, submit: String?, submitID: Int?, gatewayReplay: Bool
    ) {
        if let text, text != editorText {
            editorText = text
            store?.onEditorTextChanged?(self)
        }
        // A repeat of the same submit id is the same submission replayed; it
        // must not send the turn twice.
        guard let submit, let submitID, submitID > lastEditorSubmitID else { return }
        // The gateway marks cached attach frames explicitly. If this submission
        // was already accepted before a warm reattach, suppress it. A cold
        // replay has no such evidence, so recover it for review, never auto-send.
        if gatewayReplay {
            lastEditorSubmitID = submitID
            if (store?.acceptedEditorSubmitID(for: id) ?? 0) < submitID,
               store?.onEditorSnapshotSubmit?(self, submit) == true {
                store?.recordAcceptedEditorSubmit(submitID, for: id)
            }
            return
        }
        if submitID <= (store?.acceptedEditorSubmitID(for: id) ?? 0) {
            lastEditorSubmitID = submitID
            return
        }
        // Only advance the id once the stream has accepted the text into either
        // a turn or a recoverable draft. A rejected callback can be replayed by
        // the next surface repaint without silently dropping the editor text.
        if store?.onEditorSubmit?(self, submit) == true {
            lastEditorSubmitID = submitID
            store?.recordAcceptedEditorSubmit(submitID, for: id)
        }
    }

    func markReadOnly() {
        readOnly = true
        queued.removeAll()
        queuedWidth = 0
        queuedHeight = 0
    }

    // MARK: - Outgoing input

    /// Reports the host's measured cell grid. A pending resize always flushes
    /// before queued input so the pod renders the next frame at the real width.
    public func resize(width newWidth: Int, height newHeight: Int) {
        guard newWidth > 0, newHeight > 0 else { return }
        guard newWidth != width || newHeight != height else { return }
        width = newWidth
        height = newHeight
        guard !readOnly else { return }
        guard pendingRequestID != nil else {
            queuedWidth = newWidth
            queuedHeight = newHeight
            return
        }
        send(.resize, width: newWidth, height: newHeight)
    }

    /// Raw terminal data, exactly as pi-tui would have read it from stdin.
    public func input(_ data: String) {
        guard !readOnly else { return }
        var chunks: [String] = []
        if data.isEmpty {
            chunks.append("")
        } else {
            var remainder = Substring(data)
            while !remainder.isEmpty {
                let chunk = remainder.prefix(RemoteUILimits.maxLineLength)
                chunks.append(String(chunk))
                remainder = remainder.dropFirst(chunk.count)
            }
        }
        guard pendingRequestID != nil else {
            for chunk in chunks { enqueue(QueuedInput(kind: .input, data: chunk)) }
            return
        }
        send(.input, width: sendWidth, height: sendHeight, data: chunks.removeFirst())
        for chunk in chunks { enqueue(QueuedInput(kind: .input, data: chunk)) }
    }

    /// Absolute replacement of an editor-role surface's text.
    public func setText(_ text: String) {
        guard !readOnly else { return }
        editorText = text
        guard pendingRequestID != nil else {
            // Only the newest unsent replacement matters; raw key events keep order.
            queued.removeAll { $0.kind == .setText }
            enqueue(QueuedInput(kind: .setText, data: text))
            return
        }
        send(.setText, width: sendWidth, height: sendHeight, data: text)
    }

    /// The user dismissed the surface locally; the pod tears its component down.
    public func close() {
        let awaiting = pendingRequestID != nil
        if !readOnly, awaiting {
            send(.close, width: sendWidth, height: sendHeight)
        }
        store?.forget(id, awaitingClose: !awaiting)
    }

    private func enqueue(_ input: QueuedInput) {
        // A bounded FIFO survives normal typing across a round trip without
        // growing without limit if the surface stops answering entirely.
        if queued.count >= 1024 { queued.removeFirst() }
        queued.append(input)
    }

    private func flush() {
        guard pendingRequestID != nil, !readOnly else { return }
        if queuedWidth > 0 {
            let width = queuedWidth
            let height = queuedHeight
            queuedWidth = 0
            queuedHeight = 0
            send(.resize, width: width, height: height)
            return
        }
        guard !queued.isEmpty else { return }
        let first = queued.removeFirst()
        guard first.kind == .input else {
            send(first.kind, width: sendWidth, height: sendHeight, data: first.data)
            return
        }
        var events = [first.data]
        while events.count < RemoteUILimits.maxInputEvents,
              queued.first?.kind == .input {
            events.append(queued.removeFirst().data)
        }
        send(.input, width: sendWidth, height: sendHeight, events: events)
    }

    private var sendWidth: Int { width > 0 ? width : 80 }
    private var sendHeight: Int { height > 0 ? height : 24 }

    private func send(
        _ kind: RemoteUIInputKind,
        width: Int,
        height: Int,
        data: String? = nil,
        events: [String]? = nil
    ) {
        guard let requestID = pendingRequestID else { return }
        pendingRequestID = nil
        sequence += 1
        store?.respond(
            from: self,
            requestID: requestID,
            input: RemoteUIInput(
                kind: kind,
                surfaceID: id,
                sequence: sequence,
                width: min(max(width, 1), RemoteUILimits.maxDimension),
                height: min(max(height, 1), RemoteUILimits.maxDimension),
                data: data,
                events: events
            )
        )
    }

    struct QueuedInput {
        let kind: RemoteUIInputKind
        let data: String
    }
}

/// Holds every live remote extension UI surface for one session and owns the
/// input path back to the pod. Frames are whole-surface repaints, so the store
/// keeps only the newest one per surface.
@MainActor
@Observable
public final class RemoteUIStore {
    @ObservationIgnored public var responder: RemoteUIResponder?
    @ObservationIgnored public var onControl: ((RemoteUIControlFrame) -> Void)?
    @ObservationIgnored public var onEditorSubmit: ((RemoteUISurface, String) -> Bool)?
    @ObservationIgnored public var onEditorSnapshotSubmit: ((RemoteUISurface, String) -> Bool)?
    @ObservationIgnored public var onEditorTextChanged: ((RemoteUISurface) -> Void)?

    /// Insertion-ordered, which is the order the pod opened them in.
    public private(set) var surfaces: [RemoteUISurface] = []

    /// Surfaces dismissed locally while the pod was not waiting on us. The close
    /// goes out on the next input request instead of leaving the pod's component
    /// blocked forever.
    @ObservationIgnored private var dismissed: [String] = []
    /// Survives a warm socket reattach so the gateway's cached frame cannot
    /// replay a submission already accepted by this client.
    @ObservationIgnored private var acceptedEditorSubmitIDs: [String: Int] = [:]
    @ObservationIgnored private var activeContextRevision = 0
    @ObservationIgnored private var lastRespondedSurfaceID: String?

    public init(responder: RemoteUIResponder? = nil) {
        self.responder = responder
    }

    public var isEmpty: Bool { surfaces.isEmpty }

    public func surface(_ id: String) -> RemoteUISurface? {
        surfaces.first { $0.id == id }
    }

    public func withRole(_ role: RemoteUIRole) -> [RemoteUISurface] {
        surfaces.filter { $0.role == role }
    }

    /// Consumes an `extension_ui_request` ephemeral payload. Returns false when
    /// it is not remote-UI traffic, leaving it to the ordinary approval path.
    @discardableResult
    public func applyExtensionRequest(_ payload: JSONValue) -> Bool {
        guard let encoded = RemoteUICodec.encodedFrame(in: payload) else { return false }
        let requestID = payload["method"]?.stringValue == "input"
            ? payload["id"]?.stringValue : nil
        guard let json = RemoteUICodec.decodedFrameJSON(encoded),
              let frame = RemoteUIFrame.from(json: json)
        else {
            // The prefix says this is remote-UI traffic whatever the body turned
            // out to be, so it must not fall through to the approval path and
            // render as a card of raw base64. The waiting component is told the
            // request was cancelled instead — the reference client's answer.
            if let requestID { respondCancelled(requestID: requestID) }
            return true
        }

        if let contextRevision = frame.contextRevision {
            if contextRevision < activeContextRevision {
                // A frame from a pod context that has already been replaced.
                // Answering with close lets the abandoned component finish.
                if let requestID {
                    let surfaceID: String
                    if case .surface(let surface) = frame { surfaceID = surface.surfaceID }
                    else { surfaceID = "stale" }
                    respondClose(requestID: requestID, surfaceID: surfaceID)
                }
                return true
            }
            if contextRevision > activeContextRevision {
                clear()
                activeContextRevision = contextRevision
            }
        }

        let gatewayReplay = payload["gatewayReplay"]?.boolValue == true
        switch frame {
        case .control(let control):
            onControl?(control)
        case .surface(let surface):
            apply(json: json, frame: surface, requestID: requestID, gatewayReplay: gatewayReplay)
        }
        return true
    }

    private func apply(
        json: JSONValue, frame: RemoteUISurfaceFrame, requestID: String?, gatewayReplay: Bool
    ) {
        if frame.kind == .close {
            dismissed.removeAll { $0 == frame.surfaceID }
            surfaces.removeAll { $0.id == frame.surfaceID }
            return
        }
        if dismissed.contains(frame.surfaceID) {
            // A repaint must not resurrect a surface the user dismissed; the
            // pending close rides out on this request instead.
            if let requestID {
                dismissed.removeAll { $0 == frame.surfaceID }
                respondClose(requestID: requestID, surfaceID: frame.surfaceID)
            }
            return
        }
        var target = surface(frame.surfaceID)
        if target == nil {
            // At the cap the reference client refuses the newcomer rather than
            // evicting a live surface: the evicted one's component would keep
            // painting into a surface that no longer exists, and the person
            // would watch the extension UI they were using disappear.
            if surfaces.count >= RemoteUILimits.maxSurfaces {
                if let requestID {
                    respondClose(requestID: requestID, surfaceID: frame.surfaceID)
                }
                return
            }
            guard let created = RemoteUISurface(id: frame.surfaceID, store: self, json: json)
            else { return }
            surfaces.append(created)
            target = created
        }
        target?.apply(
            json: json, frame: frame, requestID: requestID, gatewayReplay: gatewayReplay
        )
    }

    /// The gateway rejected our input because another attached client owns this
    /// surface. It stays visible and read-only until it closes or we reattach.
    public func markOwnedElsewhere() {
        guard let id = lastRespondedSurfaceID, let surface = surface(id), !surface.readOnly
        else { return }
        surface.markReadOnly()
    }

    /// A fresh attach: the gateway replays the newest frame and the outstanding
    /// input request for every live surface, so the old set is discarded first.
    public func resetForAttach(preservingEditorSubmissions: Bool = true) {
        dismissed.removeAll()
        surfaces.removeAll()
        lastRespondedSurfaceID = nil
        if !preservingEditorSubmissions {
            activeContextRevision = 0
            acceptedEditorSubmitIDs.removeAll()
        }
    }

    public func clear() {
        dismissed.removeAll()
        acceptedEditorSubmitIDs.removeAll()
        activeContextRevision = 0
        surfaces.removeAll()
        lastRespondedSurfaceID = nil
    }

    func acceptedEditorSubmitID(for surfaceID: String) -> Int {
        acceptedEditorSubmitIDs[surfaceID] ?? 0
    }

    func recordAcceptedEditorSubmit(_ submitID: Int, for surfaceID: String) {
        acceptedEditorSubmitIDs[surfaceID] = max(
            acceptedEditorSubmitIDs[surfaceID] ?? 0, submitID
        )
    }

    func forget(_ surfaceID: String, awaitingClose: Bool) {
        if awaitingClose {
            if dismissed.count >= RemoteUILimits.maxSurfaces { dismissed.removeFirst() }
            if !dismissed.contains(surfaceID) { dismissed.append(surfaceID) }
        }
        surfaces.removeAll { $0.id == surfaceID }
    }

    func respond(from surface: RemoteUISurface, requestID: String, input: RemoteUIInput) {
        lastRespondedSurfaceID = surface.id
        _ = responder?(RemoteUICodec.responsePayload(requestID: requestID, input: input))
    }

    /// The reference client's answer to a remote-UI request it cannot read.
    private func respondCancelled(requestID: String) {
        _ = responder?(
            .object([
                "type": .string("extension_ui_response"),
                "id": .string(requestID),
                "cancelled": .bool(true),
            ])
        )
    }

    private func respondClose(requestID: String, surfaceID: String) {
        _ = responder?(
            RemoteUICodec.responsePayload(
                requestID: requestID,
                input: RemoteUIInput(
                    kind: .close, surfaceID: surfaceID, sequence: 1, width: 80, height: 24
                )
            )
        )
    }
}
