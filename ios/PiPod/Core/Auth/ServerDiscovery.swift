import Foundation

/// Finds how to sign in to a pi pod server from its address alone. Every server publishes its
/// identity provider, and the client id the phone apps use there, at `GET /v1/auth/config`.
public enum ServerDiscovery {
    public struct Failure: LocalizedError, Equatable {
        public let errorDescription: String?
        init(_ message: String) { errorDescription = message }
    }

    /// The choice to remember for `address`, or nil when it is the built-in server, which
    /// needs nothing discovered.
    public static func resolve(
        _ address: String, transport: HTTPTransport = URLSessionTransport()
    ) async throws -> Config.ServerChoice? {
        let url = try serverURL(address)
        if url.absoluteString == Config.builtInServerURL.absoluteString { return nil }
        let name = displayName(url)
        var request = URLRequest(url: url.appendingPathComponent("v1/auth/config"))
        request.timeoutInterval = 15
        let data: Data
        let response: HTTPURLResponse
        do {
            (data, response) = try await transport.send(request)
        } catch {
            throw Failure("Couldn’t reach \(name). Check the address and your connection.")
        }
        guard response.statusCode == 200,
              let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let issuer = body["issuer"] as? String, !issuer.isEmpty
        else {
            throw Failure(
                "\(name) didn’t answer like a pi pod server. Check the address — it is the one "
                    + "you pass to pipod login --server."
            )
        }
        // A server that runs its own identity provider must name the app's client there; only
        // the built-in provider's client id is known in advance.
        let published = (body["mobileClientId"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        guard let clientID = published
            ?? (issuer == Config.builtInOidcIssuer ? Config.builtInOidcClientID : nil)
        else {
            throw Failure(
                "\(name) doesn’t offer sign-in to the phone apps yet. Its operator can turn it "
                    + "on by running selfhost/upgrade."
            )
        }
        return Config.ServerChoice(serverURL: url, issuer: issuer, clientID: clientID)
    }

    /// `pipod.example.com` → `https://pipod.example.com`. Plain HTTP is accepted only for this
    /// device's own loopback, where a development server runs: anywhere else it would send
    /// sign-in tokens in the clear.
    static func serverURL(_ address: String) throws -> URL {
        var text = address.trimmingCharacters(in: .whitespacesAndNewlines)
        while text.hasSuffix("/") { text.removeLast() }
        guard !text.isEmpty else {
            throw Failure("Enter your server’s address, like pipod.example.com.")
        }
        if !text.contains("://") { text = "https://" + text }
        guard let url = URL(string: text), let host = url.host, !host.isEmpty,
              url.user == nil, url.query == nil, url.fragment == nil
        else {
            throw Failure("“\(address)” isn’t a server address. Enter one like pipod.example.com.")
        }
        switch url.scheme?.lowercased() {
        case "https":
            return url
        case "http" where ["127.0.0.1", "localhost", "::1"].contains(host):
            return url
        default:
            throw Failure("The app signs in only over HTTPS. Use the server’s https:// address.")
        }
    }

    /// The address to show in the field for a chosen server: what `serverURL` turns back into
    /// the same URL, so the scheme stays only where it is not the default HTTPS.
    public static func address(_ url: URL) -> String {
        let text = url.absoluteString
        return text.hasPrefix("https://") ? String(text.dropFirst("https://".count)) : text
    }

    /// How the sign-in screen names a server: "pi pod cloud" for the hosted one, else its host.
    public static func displayName(_ url: URL) -> String {
        if url.absoluteString == Config.productionServerURL.absoluteString { return "pi pod cloud" }
        guard let host = url.host else { return url.absoluteString }
        return url.port.map { "\(host):\($0)" } ?? host
    }
}
