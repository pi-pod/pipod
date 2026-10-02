import Foundation

/// Somewhere in the app a `pipod://` URL or a notification payload asked for: a
/// pod session (optionally resumed at `fromSeq`), or a job that never spawned a
/// pod.
public struct DeepLinkDestination: Hashable, Sendable {
    public let podId: String?
    public let orgId: String?
    public let sessionId: String?
    public let fromSeq: Int?
    public let jobId: String?

    public init(
        podId: String? = nil,
        orgId: String? = nil,
        sessionId: String? = nil,
        fromSeq: Int? = nil,
        jobId: String? = nil
    ) {
        self.podId = podId
        self.orgId = orgId
        self.sessionId = sessionId
        self.fromSeq = fromSeq
        self.jobId = jobId
    }

    public var isEmpty: Bool {
        (podId ?? "").isEmpty && jobId == nil
    }

    /// `pipod://pod/<id>`, `pipod://job/<id>`, plus
    /// the triple-slash spelling and in-app http(s) paths.
    public static func from(url: URL) -> DeepLinkDestination? {
        let scheme = url.scheme?.lowercased() ?? ""
        if scheme == "http" || scheme == "https" || scheme.isEmpty {
            return fromAppPath(url)
        }
        guard scheme == Config.callbackScheme else { return nil }
        if isAuthCallback(url) { return nil }

        let parts = url.pathComponents.filter { $0 != "/" && !$0.isEmpty }
        let kind: String
        let id: String
        if let host = url.host, !host.isEmpty, let first = parts.first {
            kind = host
            id = first
        } else if parts.count >= 2 {
            kind = parts[0]
            id = parts[1]
        } else {
            return nil
        }

        let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func parameter(_ names: String...) -> String? {
            for name in names {
                if let value = query.first(where: { $0.name == name })?.value, !value.isEmpty {
                    return value
                }
            }
            return nil
        }

        guard isRoutableId(id) else { return nil }

        switch kind {
        case "pod":
            return DeepLinkDestination(
                podId: id,
                sessionId: routable(parameter("sessionId", "session_id")),
                fromSeq: parameter("fromSeq", "from_seq").flatMap(Int.init)
            )
        case "job":
            return DeepLinkDestination(jobId: id)
        default:
            return nil
        }
    }

    /// The id when it can name something, and nil when it cannot — an optional
    /// part of a destination is dropped rather than taking the whole link down.
    static func routable(_ id: String?) -> String? {
        guard let id, isRoutableId(id) else { return nil }
        return id
    }

    /// Whether an id out of a URL or a push payload can name a resource at all.
    ///
    /// `URL.pathComponents` decodes percent-escapes, so `pipod://pod/a%2Fb`
    /// arrives as the single component `a/b` — an id with a path separator
    /// inside it. Every request built from it is escaped before it is sent, so
    /// this is not a path-traversal hole; it is an id that cannot exist, and
    /// carrying it forward only costs a screen that loads nothing. The same goes
    /// for whitespace and control characters. Ids are otherwise opaque: no
    /// format is assumed beyond what a URL can carry.
    static func isRoutableId(_ id: String) -> Bool {
        guard !id.isEmpty, id.count <= 256 else { return false }
        return !id.unicodeScalars.contains { scalar in
            scalar == "/" || scalar == "?" || scalar == "#" || scalar == "\\"
                || CharacterSet.whitespacesAndNewlines.contains(scalar)
                || CharacterSet.controlCharacters.contains(scalar)
        }
    }

    /// Web-style in-app paths, so a link copied out of the web build still opens.
    public static func fromAppPath(_ url: URL) -> DeepLinkDestination? {
        let parts = url.pathComponents.filter { $0 != "/" && !$0.isEmpty }
        let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func parameter(_ name: String) -> String? {
            query.first { $0.name == name }?.value
        }
        if parts.count >= 3, parts[0] == "pods", parts[2] == "session",
           isRoutableId(parts[1]) {
            return DeepLinkDestination(
                podId: parts[1],
                sessionId: routable(parameter("sessionId")),
                fromSeq: parameter("fromSeq").flatMap(Int.init)
            )
        }
        if parts.count >= 2, parts[0] == "jobs", isRoutableId(parts[1]) {
            return DeepLinkDestination(jobId: parts[1])
        }
        return nil
    }

    /// APNs / local-notification payload (spec §11 keys).
    public static func from(payload: [String: Any]) -> DeepLinkDestination? {
        func string(_ key: String) -> String? {
            guard let value = payload[key] as? String, !value.isEmpty else { return nil }
            return value
        }
        // A push payload is no more trusted than a URL: the ids in it address
        // the same screens and the same requests.
        let podId = routable(string("pod_id"))
        let jobId = routable(string("job_id"))
        if podId == nil, jobId == nil { return nil }

        let seq: Int?
        switch payload["seq"] {
        case let value as Int: seq = value
        case let value as NSNumber: seq = value.intValue
        case let value as String: seq = Int(value)
        default: seq = nil
        }

        return DeepLinkDestination(
            podId: podId,
            orgId: string("org_id"),
            sessionId: routable(string("session_id")),
            fromSeq: seq,
            jobId: jobId
        )
    }

    /// Whether a URL is the OIDC redirect rather than an in-app destination: exactly the
    /// registered redirect's scheme, host and path, since anything can open a pipod:// URL.
    public static func isAuthCallback(_ url: URL, redirectURI: String = Config.oidcRedirectURI) -> Bool {
        guard let registered = URL(string: redirectURI) else { return false }
        return url.scheme?.lowercased() == registered.scheme?.lowercased()
            && url.host?.lowercased() == registered.host?.lowercased()
            && url.path == registered.path
    }
}
