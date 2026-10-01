import Foundation

extension PendingInteraction {
    /// Builds an approval card the client raised itself.
    ///
    /// `PendingInteraction` is decoded from the REST inbox, so it ships only a
    /// `Decodable` initializer. The session reducer also *creates* cards — from
    /// live `interaction` frames, from a replayed `extension_ui_request`, and
    /// from the gateway's attach snapshot — and those never pass through JSON.
    public init(
        id: String,
        sessionId: String,
        podId: String,
        podName: String,
        seq: Int,
        kind: String,
        payload: JSONValue,
        createdAt: String,
        resolvedAt: String? = nil,
        deliveredAt: String? = nil
    ) {
        self.id = id
        self.sessionId = sessionId
        self.podId = podId
        self.podName = podName
        self.seq = seq
        self.kind = kind
        self.payload = payload
        self.createdAt = createdAt
        self.resolvedAt = resolvedAt
        self.deliveredAt = deliveredAt
    }
}
