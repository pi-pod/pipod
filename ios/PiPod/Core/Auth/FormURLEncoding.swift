import Foundation

/// `application/x-www-form-urlencoded` bodies for the OIDC token endpoint.
///
/// `URLComponents.percentEncodedQuery` cannot be used for this. It leaves `+`
/// literal, because `+` is legal in a URL query — but a form decoder reads `+` as
/// a space. Authorization codes and refresh tokens are opaque base64-ish strings
/// that routinely contain `+`, so a token posted that way arrives at the provider
/// with spaces where its bytes used to be, and the grant is rejected as invalid
/// for no visible reason.
///
/// Everything outside RFC 3986's unreserved set is percent-encoded here, which
/// leaves nothing for a form decoder to reinterpret.
enum FormURLEncoding {
    /// RFC 3986 unreserved: ALPHA / DIGIT / "-" / "." / "_" / "~".
    private static let unreserved: CharacterSet = {
        var set = CharacterSet.alphanumerics
        set.insert(charactersIn: "-._~")
        return set
    }()

    static func encode(_ body: [String: String]) -> String {
        body.sorted { $0.key < $1.key }
            .map { "\(escape($0.key))=\(escape($0.value))" }
            .joined(separator: "&")
    }

    static func escape(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: unreserved) ?? value
    }
}
