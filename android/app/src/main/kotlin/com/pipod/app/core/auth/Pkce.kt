package com.pipod.app.core.auth

import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

/**
 * RFC 7636 S256 pair.
 *
 * The verifier stays on this device; only the challenge is sent to Zitadel. A
 * caller that needs a deterministic test injects [random].
 */
data class PkcePair(val verifier: String, val challenge: String) {

    companion object {
        private const val UNRESERVED =
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"

        /**
         * 32 random bytes, base64url without padding — 43 characters, inside the
         * 43–128 window Zitadel and the OIDC spec both accept.
         */
        fun generate(random: SecureRandom = SecureRandom()): PkcePair {
            val bytes = ByteArray(32).also(random::nextBytes)
            val verifier = base64Url(bytes)
            return PkcePair(verifier = verifier, challenge = challengeFor(verifier))
        }

        /**
         * Same alphabet as the spec's unreserved set, used when a caller wants a
         * verifier that is not a base64 payload (rare; tests mainly).
         */
        fun randomVerifier(random: SecureRandom = SecureRandom(), length: Int = 64): String =
            buildString(length) {
                repeat(length) { append(UNRESERVED[random.nextInt(UNRESERVED.length)]) }
            }

        fun challengeFor(verifier: String): String =
            base64Url(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.UTF_8)))

        /** URL-safe base64 without padding, the only encoding the spec accepts. */
        internal fun base64Url(bytes: ByteArray): String =
            Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    }
}
