package com.pipod.app.core.format

import java.net.URI

/**
 * Which URLs found in text the app did not write may be handed to the platform.
 *
 * The transcript renders agent output, and agent output is steerable by any file
 * or page the agent read. Handing an arbitrary URI to `ACTION_VIEW` launches
 * whatever app claims the scheme — `market:`, `tel:`, a third party's custom
 * scheme, or `pipod://` back into this app — and a `file://` URI throws
 * `FileUriExposedException`, which is a `RuntimeException` neither Compose nor
 * `AndroidUriHandler` catches. So only the three schemes a link in prose can
 * honestly mean are allowed through, and everything else stays inert text.
 *
 * This is deliberately *not* [com.pipod.app.core.credentials.isSafeLoginUrl].
 * That predicate guards a credential exchange, where plain HTTP off the loopback
 * would leak a token; this one guards opening a page in a browser, where plain
 * HTTP to a developer's own host is ordinary. The two rules answer different
 * questions and are kept apart on purpose.
 */
object SafeExternalUrl {

    private val ALLOWED_SCHEMES = setOf("http", "https", "mailto")

    /** Whether [value] may become a tappable link. */
    fun isSafe(value: String): Boolean = displayHost(value) != null

    /**
     * What the confirmation names as the destination: the host for `http(s)`,
     * the address for `mailto:`. Null for anything [isSafe] refuses, so one
     * function answers both questions and they can never disagree.
     */
    fun displayHost(value: String): String? {
        val trimmed = value.trim()
        if (trimmed.isEmpty() || trimmed.length > MAX_LENGTH) return null
        // A control character or a space inside a URL is either a mangled parse
        // or a deliberate attempt to hide the tail of it.
        if (trimmed.any { it.isWhitespace() || it.code < 0x20 || it.code == 0x7f }) return null
        val uri = runCatching { URI(trimmed) }.getOrNull() ?: return null
        val scheme = uri.scheme?.lowercase() ?: return null
        if (scheme !in ALLOWED_SCHEMES) return null
        if (scheme == "mailto") {
            // `URI` keeps everything after `mailto:` as the opaque part; the
            // address is what precedes any `?subject=…` tail.
            val address = uri.schemeSpecificPart?.substringBefore('?')?.trim().orEmpty()
            if (address.isEmpty() || address.length > MAX_HOST_LENGTH) return null
            if (!address.contains('@')) return null
            return address
        }
        // `https://pipod.dev@evil.example/` reads as pipod.dev and opens
        // evil.example. Nothing legitimate in prose carries userinfo, so the
        // whole URL is refused rather than shown under a name that is a lie.
        if (uri.rawUserInfo != null) return null
        val host = uri.host?.trim().orEmpty()
        if (host.isEmpty() || host.length > MAX_HOST_LENGTH) return null
        return host
    }

    /** A URL long enough to fill a dialog is truncated before it is shown. */
    fun forDisplay(value: String, limit: Int = 160): String {
        val trimmed = value.trim()
        return if (trimmed.length <= limit) trimmed else trimmed.take(limit) + "…"
    }

    /** Longer than any real link in prose, and short enough to reject a payload. */
    private const val MAX_LENGTH = 2048

    private const val MAX_HOST_LENGTH = 255
}
