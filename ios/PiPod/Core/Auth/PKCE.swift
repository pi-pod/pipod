import CryptoKit
import Foundation

/// RFC 7636 S256 pair. The verifier stays on this device; only the challenge is
/// sent to Zitadel.
public struct PKCEPair: Hashable, Sendable {
    public let verifier: String
    public let challenge: String

    public init(verifier: String, challenge: String) {
        self.verifier = verifier
        self.challenge = challenge
    }

    /// 32 random bytes, base64url without padding — 43 characters, inside the
    /// 43–128 window Zitadel and the OIDC spec both accept.
    public static func generate() -> PKCEPair {
        let verifier = Random.urlSafeString(byteCount: 32)
        return PKCEPair(verifier: verifier, challenge: challenge(for: verifier))
    }

    public static func challenge(for verifier: String) -> String {
        let digest = SHA256.hash(data: Data(verifier.utf8))
        return Data(digest).base64URLEncodedString()
    }
}

public enum Random {
    /// Cryptographically random bytes as unpadded base64url.
    public static func urlSafeString(byteCount: Int) -> String {
        var bytes = [UInt8](repeating: 0, count: byteCount)
        let status = SecRandomCopyBytes(kSecRandomDefault, byteCount, &bytes)
        if status != errSecSuccess {
            // SecRandom is the only entropy source worth trusting for a PKCE
            // verifier: falling back to a PRNG would silently weaken the proof.
            fatalError("SecRandomCopyBytes failed with status \(status)")
        }
        return Data(bytes).base64URLEncodedString()
    }
}

extension Data {
    public func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    public init?(base64URLEncoded string: String) {
        var text = string
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let remainder = text.count % 4
        if remainder > 0 { text += String(repeating: "=", count: 4 - remainder) }
        guard let data = Data(base64Encoded: text) else { return nil }
        self = data
    }
}
