import Foundation
import Security

/// An ID token that must not be accepted.
public struct InvalidIDTokenError: Error, Hashable, Sendable {
    public let message: String

    public init(_ message: String) { self.message = message }
}

/// A compact JWS, split but not yet trusted.
struct DecodedJWS {
    let header: [String: JSONValue]
    let claims: [String: JSONValue]
    /// The `header.payload` bytes the signature covers.
    let signingInput: Data
    let signature: Data

    init(compactSerialization token: String) throws {
        let parts = token.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3 else {
            throw InvalidIDTokenError("token is not a compact JWS")
        }
        guard let headerData = Data(base64URLEncoded: String(parts[0])),
              let claimsData = Data(base64URLEncoded: String(parts[1])),
              let signature = Data(base64URLEncoded: String(parts[2]))
        else {
            throw InvalidIDTokenError("token segments are not base64url")
        }
        guard let header = (try? JSONCoding.value(from: headerData))?.objectValue,
              let claims = (try? JSONCoding.value(from: claimsData))?.objectValue
        else {
            throw InvalidIDTokenError("token segments are not JSON objects")
        }
        self.header = header
        self.claims = claims
        self.signature = signature
        self.signingInput = Data("\(parts[0]).\(parts[1])".utf8)
    }

    var algorithm: String? { header["alg"]?.stringValue }
    var keyID: String? { header["kid"]?.stringValue }
}

/// One RSA signing key from a JWKS document.
struct JSONWebKey {
    let keyID: String?
    let key: SecKey

    /// Builds a `SecKey` from the JWK's modulus and exponent.
    ///
    /// `SecKeyCreateWithData` wants a PKCS#1 `RSAPublicKey`, which is the DER
    /// SEQUENCE of two INTEGERs — so the JWK's two base64url numbers are encoded
    /// by hand rather than pulling in a JOSE dependency for it.
    init?(json: [String: JSONValue]) {
        guard json["kty"]?.stringValue == "RSA" else { return nil }
        if let alg = json["alg"]?.stringValue, alg != "RS256" { return nil }
        if let use = json["use"]?.stringValue, use != "sig" { return nil }
        if let operations = json["key_ops"]?.arrayValue,
           !operations.compactMap(\.stringValue).contains("verify") {
            return nil
        }
        guard let modulusText = json["n"]?.stringValue,
              let exponentText = json["e"]?.stringValue,
              let modulus = Data(base64URLEncoded: modulusText),
              let exponent = Data(base64URLEncoded: exponentText)
        else { return nil }

        let der = DER.sequence([DER.integer(modulus), DER.integer(exponent)])
        let attributes: [CFString: Any] = [
            kSecAttrKeyType: kSecAttrKeyTypeRSA,
            kSecAttrKeyClass: kSecAttrKeyClassPublic,
        ]
        guard let key = SecKeyCreateWithData(der as CFData, attributes as CFDictionary, nil) else {
            return nil
        }
        self.keyID = json["kid"]?.stringValue
        self.key = key
    }

    func verifies(_ jws: DecodedJWS) -> Bool {
        SecKeyVerifySignature(
            key,
            .rsaSignatureMessagePKCS1v15SHA256,
            jws.signingInput as CFData,
            jws.signature as CFData,
            nil
        )
    }
}

/// Minimal DER writer for the two-integer RSA public key above.
enum DER {
    static func integer(_ magnitude: Data) -> Data {
        var bytes = Array(magnitude)
        // Strip leading zeros, then re-add one when the high bit is set: DER
        // INTEGERs are signed, and an unpadded 2048-bit modulus reads negative.
        while bytes.first == 0x00 { bytes.removeFirst() }
        if let first = bytes.first, first & 0x80 != 0 { bytes.insert(0x00, at: 0) }
        return tagged(0x02, Data(bytes))
    }

    static func sequence(_ elements: [Data]) -> Data {
        tagged(0x30, elements.reduce(Data(), +))
    }

    private static func tagged(_ tag: UInt8, _ content: Data) -> Data {
        var out = Data([tag])
        let count = content.count
        if count < 0x80 {
            out.append(UInt8(count))
        } else {
            var length = count
            var lengthBytes: [UInt8] = []
            while length > 0 {
                lengthBytes.insert(UInt8(length & 0xFF), at: 0)
                length >>= 8
            }
            out.append(UInt8(0x80 | lengthBytes.count))
            out.append(contentsOf: lengthBytes)
        }
        out.append(content)
        return out
    }
}
