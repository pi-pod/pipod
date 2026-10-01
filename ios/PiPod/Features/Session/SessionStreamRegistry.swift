import Observation

/// The live session streams, by pod.
///
/// The model picker is a value route, so the screen that builds it is the tab
/// shell rather than the session view that owns the stream. This is the one
/// place those two meet: a session registers its stream while it is on screen
/// and drops it when it detaches, and nothing else reaches in.
@MainActor
@Observable
public final class SessionStreamRegistry {
    @ObservationIgnored private var streams: [String: SessionStream] = [:]

    public init() {}

    public func register(_ stream: SessionStream, for podId: String) {
        streams[podId] = stream
    }

    /// Drops the registration only when it is still this stream's. Re-entering
    /// the same pod builds the replacement before the view it replaced
    /// disappears, and the losing order would otherwise unregister the live one.
    public func forget(_ stream: SessionStream, for podId: String) {
        if streams[podId] === stream { streams.removeValue(forKey: podId) }
    }

    public func stream(for podId: String) -> SessionStream? { streams[podId] }
}
