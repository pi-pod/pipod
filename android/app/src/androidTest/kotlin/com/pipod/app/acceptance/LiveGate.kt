package com.pipod.app.acceptance

import androidx.test.platform.app.InstrumentationRegistry

/**
 * Live-backend instrumentation is opt-in. Fixture-backed integration checks
 * elsewhere must not be treated as this gate.
 *
 * Extra keys are identifiers only — never LOGIN/PASSWORD/token.
 */
object LiveGate {
    fun enabled(): Boolean =
        InstrumentationRegistry.getArguments().getString("pipodLive") == "1"

    fun backend(): String =
        InstrumentationRegistry.getArguments().getString("pipodBackend").orEmpty()

    fun scope(): String =
        InstrumentationRegistry.getArguments().getString("pipodScope").orEmpty().ifEmpty { "full" }

    fun podId(): String =
        InstrumentationRegistry.getArguments().getString("pipodPodId").orEmpty()

    fun nonce(): String =
        InstrumentationRegistry.getArguments().getString("pipodNonce").orEmpty()

    fun promptToken(): String {
        val n = nonce()
        require(n.isNotEmpty()) { "pipodNonce required for a fresh assistant turn" }
        return "PONGCI-$n"
    }
}
