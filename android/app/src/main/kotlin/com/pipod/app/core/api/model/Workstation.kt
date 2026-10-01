package com.pipod.app.core.api.model

import java.time.Instant
import java.time.OffsetDateTime
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull

/**
 * The personal workstation ("box") a pod runs on, and the 503 the server
 * answers with while it is not ready.
 *
 * A workstation is a whole VM per user, not a fleet slot: production spans from
 * intent to authenticated readiness are minutes, not seconds. Nothing here may
 * be turned into a fleet-capacity wait, an archived pod, or a suggestion to
 * launch a duplicate — see `FriendlyError.workstationMessage`.
 *
 * Everything below mirrors the server's own validator
 * (`pi-pod-server` `src/server/safe-errors.ts` `boxHostDemandDetail`) field for
 * field. A present-but-malformed field fails the whole parse, exactly as it
 * does there: a half-trusted detail is more dangerous than no detail, because
 * the client would then poll a path or print a number the server never sent.
 */

/** `sandbox_hosts.box_state`. */
enum class WorkstationState(val wire: String) {
    Provisioning("provisioning"),
    Starting("starting"),
    Running("running"),
    Stopping("stopping"),
    Stopped("stopped"),
    Error("error"),
    Unknown("unknown"),
    Deleting("deleting"),
    Deleted("deleted"),
    ;

    companion object {
        fun fromWire(value: String?): WorkstationState? = entries.firstOrNull { it.wire == value }
    }
}

/** Mirrors the `box_operations.kind` CHECK constraint, legacy `publish` included. */
enum class WorkstationOperationKind(val wire: String) {
    Create("create"),
    Resume("resume"),
    Stop("stop"),
    Delete("delete"),
    Publish("publish"),
    Activate("activate"),
    Ttl("ttl"),
    ;

    companion object {
        fun fromWire(value: String?): WorkstationOperationKind? =
            entries.firstOrNull { it.wire == value }
    }
}

/** Mirrors the `box_operations.state` CHECK constraint. */
enum class WorkstationOperationState(val wire: String) {
    Pending("pending"),
    Running("running"),
    Uncertain("uncertain"),
    Succeeded("succeeded"),
    Failed("failed"),
    Cancelled("cancelled"),
    ;

    companion object {
        fun fromWire(value: String?): WorkstationOperationState? =
            entries.firstOrNull { it.wire == value }
    }
}

/**
 * The seven fields `GET /v1/workstations/:hostId` projects for the operation
 * currently in flight. All seven are always written by the server, so a partial
 * object is a shape this client does not recognise rather than a newer one.
 */
data class WorkstationOperation(
    val id: String,
    val kind: WorkstationOperationKind,
    val state: WorkstationOperationState,
    /**
     * A bounded controller slug (`vendor`, `command:install`, `poll:activate`,
     * …). Render it as a lowercase technical detail — never as a promise.
     */
    val phase: String,
    val deadlineAt: Instant,
    val retryAt: Instant?,
    val errorCode: String?,
) {
    companion object {
        /** Null for absent, malformed, or JSON null — the caller decides which it wanted. */
        fun parse(value: JsonElement?): WorkstationOperation? {
            val record = value as? JsonObject ?: return null
            val id = record.text("id")?.takeIf { OPERATION_ID.matches(it) } ?: return null
            val kind = WorkstationOperationKind.fromWire(record.text("kind")) ?: return null
            val state = WorkstationOperationState.fromWire(record.text("state")) ?: return null
            val phase = record.text("phase")?.takeIf { PHASE.matches(it) } ?: return null
            val deadlineAt = instant(record["deadlineAt"]) ?: return null
            // `null` is the server's answer for "no retry scheduled"; a present
            // value that does not parse is a shape we do not recognise.
            val retryAt = when (val raw = record["retryAt"]) {
                null, JsonNull -> null
                else -> instant(raw) ?: return null
            }
            val errorCode = when (val raw = record["errorCode"]) {
                null, JsonNull -> null
                else -> (raw as? JsonPrimitive)?.takeIf { it.isString }?.content
                    ?.takeIf { ERROR_CODE.matches(it) } ?: return null
            }
            return WorkstationOperation(
                id = id,
                kind = kind,
                state = state,
                phase = phase,
                deadlineAt = deadlineAt,
                retryAt = retryAt,
                errorCode = errorCode,
            )
        }

        private val OPERATION_ID = Regex(
            "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
        )
        private val PHASE = Regex("^[A-Za-z0-9._:-]{1,64}$")
        private val ERROR_CODE = Regex("^[A-Za-z0-9._-]{1,64}$")
    }
}

/** The body of `GET /v1/workstations/:hostId` — the durable truth. */
data class WorkstationStatus(
    val hostId: String,
    val state: WorkstationState?,
    val operation: WorkstationOperation?,
) {
    companion object {
        /** Null when the body is not a status this build can read. */
        fun parse(value: JsonElement?): WorkstationStatus? {
            val record = value as? JsonObject ?: return null
            val hostId = record.text("hostId")?.takeIf { WorkstationDemand.HOST_ID.matches(it) }
                ?: return null
            val state = when (val raw = record["state"]) {
                null, JsonNull -> null
                else -> WorkstationState.fromWire((raw as? JsonPrimitive)?.content) ?: return null
            }
            return WorkstationStatus(
                hostId = hostId,
                state = state,
                operation = WorkstationOperation.parse(record["operation"]),
            )
        }
    }
}

/**
 * The six reasons the server's host-demand allowlist admits, plus the
 * `host_archived` the gateway recognises on the WebSocket close path.
 *
 * `retryable` on the wire is authoritative over this table; the flag here is
 * only what the reason means when the server agrees with itself.
 */
enum class WorkstationDemandReason(val wire: String, val retryableByDefault: Boolean) {
    HostStarting("host_starting", true),
    HostStopped("host_stopped", true),
    HostRequiresReconciliation("host_requires_reconciliation", true),
    BoxStartsDisabled("box_starts_disabled", true),
    HostArchived("host_archived", true),
    HostDeleted("host_deleted", false),
    HostRetired("host_retired", false),
    ;

    companion object {
        fun fromWire(value: String?): WorkstationDemandReason? =
            entries.firstOrNull { it.wire == value }
    }
}

/**
 * A validated host-demand refusal: the caller's own workstation is not ready.
 *
 * [statusPath] is **recomputed** from [hostId] and compared with what the server
 * sent; a server-supplied path is never dialled. [reason] survives even when it
 * is not in [WorkstationDemandReason] so a newer server keeps working — but
 * then [retryable] is the only thing trusted, and the copy falls back to the
 * server's own sentence.
 */
data class WorkstationDemand(
    val reason: String,
    val knownReason: WorkstationDemandReason?,
    val retryable: Boolean,
    val hostId: String? = null,
    val statusPath: String? = null,
    val state: WorkstationState? = null,
    val retryAfterMs: Int? = null,
    val operation: WorkstationOperation? = null,
    /**
     * The server's own `error` sentence, kept only as the fallback copy for a
     * reason this build does not know. It is static per reason on the server.
     */
    val serverMessage: String? = null,
) {

    /** How long to wait before the next poll, clamped to the contract's window. */
    val pollIntervalMs: Long
        get() = (retryAfterMs?.toLong() ?: DEFAULT_POLL_MS)
            .coerceIn(MIN_POLL_MS, MAX_POLL_MS)

    /** The wait budget this demand asks for, or null when it named no deadline. */
    fun budgetMsFrom(now: Long): Long? {
        val deadline = operation?.deadlineAt?.toEpochMilli() ?: return null
        return (deadline - now).coerceIn(MIN_BUDGET_MS, MAX_BUDGET_MS)
    }

    /** Folds a fresh status poll in without inventing anything the poll did not carry. */
    fun withStatus(status: WorkstationStatus): WorkstationDemand {
        if (hostId != null && status.hostId != hostId) return this
        return copy(state = status.state ?: state, operation = status.operation ?: operation)
    }

    companion object {
        /** The same host-id shape the workstation routes accept as a path parameter. */
        internal val HOST_ID = Regex("^box-[A-Za-z0-9._-]{1,180}$")

        /**
         * A reason slug, not prose. Bounds an unknown reason so a server can add
         * one without this build either crashing or rendering free text.
         */
        private val REASON = Regex("^[a-z][a-z0-9_]{0,63}$")

        /**
         * `BOX_HOST_DEMAND_REASONS` from `pi-pod-server`
         * `src/server/safe-errors.ts`, byte for byte.
         *
         * The server validates the reason against exactly this set before a
         * host-demand detail is allowed across the HTTP boundary, so requiring
         * membership here loses nothing a real server can send — and it is what
         * keeps `{kind:"admission", resource:"transitions", unit:"count",
         * reason:"transition_capacity"}`, the *fleet* refusal thrown by the box
         * backend, out of a personal-workstation wait. That envelope is
         * indistinguishable from a host demand on shape alone, and
         * `FriendlyError` consults [workstationMessage] before its capacity
         * table, so a fleet 503 would have rendered as "your workstation is
         * starting" and then polled a workstation for up to thirty minutes.
         */
        val REST_DEMAND_REASONS = setOf(
            "host_starting",
            "host_stopped",
            "host_deleted",
            "host_retired",
            "host_requires_reconciliation",
            "box_starts_disabled",
        )

        /**
         * The close-frame codes the gateway maps onto 4420 for a host wait
         * (`wsCloseForError` in `src/server/gateway/routes.ts`). Deliberately
         * not [REST_DEMAND_REASONS]: the WS list is its own, shorter one, and
         * it is the only place `host_archived` appears.
         */
        val CLOSE_FRAME_REASONS = setOf("host_starting", "host_stopped", "host_archived")

        /**
         * Billing refusals share the typed-detail mechanism but are never waits:
         * no polling, no workstation wait, no retry loop. [REST_DEMAND_REASONS]
         * already excludes them by construction — this names them so the
         * exclusion is testable and so `FriendlyError`, which maps them, has one
         * list to agree with. These are the five real `StartBlockedReason`
         * values from `entitlements.ts`.
         */
        val BILLING_REASONS = setOf(
            "subscription_required",
            "trial_expired",
            "trial_hours_exhausted",
            "payment_past_due",
            "spend_cap_reached",
        )

        const val MIN_POLL_MS = 5_000L
        const val MAX_POLL_MS = 60_000L
        const val DEFAULT_POLL_MS = 10_000L

        /** The server's own operation deadline is the shape of the client budget. */
        const val MIN_BUDGET_MS = 60_000L
        const val MAX_BUDGET_MS = 1_800_000L
        const val DEFAULT_BUDGET_MS = 1_200_000L

        private const val MAX_RETRY_AFTER_MS = 300_000

        /**
         * The failure the REST layer raised, when it is a host-demand 503.
         *
         * A status other than 503 is not this shape whatever its body says, so a
         * forged 200 or a 500 with a copied detail cannot start a wait.
         */
        fun fromThrowable(error: Throwable?): WorkstationDemand? {
            // A demand that arrived over the WebSocket has no HTTP response to
            // re-read, so it travels as a throw of its own.
            if (error is WorkstationNotReadyException) return error.demand
            val apiError = error as? ApiError ?: return null
            val status = apiError.transportStatus
            if (status != null && status != 503) return null
            return fromDetail(apiError.detail, serverMessage = apiError.error)
        }

        /**
         * The strict parse: the `admission` / `transitions` / `count` envelope is
         * what distinguishes this shape from every other typed detail, so it is
         * required here.
         */
        fun fromDetail(detail: JsonElement?, serverMessage: String? = null): WorkstationDemand? {
            val record = detail as? JsonObject ?: return null
            if (record.text("kind") != "admission") return null
            if (record.text("resource") != "transitions") return null
            if (record.text("unit") != "count") return null
            val reason = record.text("reason")?.takeIf { REASON.matches(it) } ?: return null
            if (reason !in REST_DEMAND_REASONS) return null
            val retryable = (record["retryable"] as? JsonPrimitive)?.booleanOrNull ?: return null
            return build(record, reason, retryable, serverMessage)
        }

        /**
         * The WebSocket close path. `4420` is also the "pod asleep" code, so the
         * *reason* is what identifies a workstation wait; the envelope is not
         * required because the gateway's own host-wait throws do not all carry
         * it. Every field that is present is still validated the same way.
         */
        fun fromCloseFrame(
            errCode: String?,
            detail: JsonElement? = null,
            serverMessage: String? = null,
        ): WorkstationDemand? {
            if (errCode == null || errCode !in CLOSE_FRAME_REASONS) return null
            val record = detail as? JsonObject
            val known = WorkstationDemandReason.fromWire(errCode)
            val retryable = record?.let { (it["retryable"] as? JsonPrimitive)?.booleanOrNull }
                ?: known?.retryableByDefault
                ?: true
            if (record == null) {
                return WorkstationDemand(
                    reason = errCode,
                    knownReason = known,
                    retryable = retryable,
                    serverMessage = serverMessage,
                )
            }
            // A detail that fails validation is dropped whole rather than read in
            // part: the close code already told us what this is.
            return build(record, errCode, retryable, serverMessage)
                ?: WorkstationDemand(
                    reason = errCode,
                    knownReason = known,
                    retryable = retryable,
                    serverMessage = serverMessage,
                )
        }

        private fun build(
            record: JsonObject,
            reason: String,
            retryable: Boolean,
            serverMessage: String?,
        ): WorkstationDemand? {
            var hostId: String? = null
            var statusPath: String? = null
            if (record.containsKey("hostId") && record["hostId"] != JsonNull) {
                val id = record.text("hostId")?.takeIf { HOST_ID.matches(it) } ?: return null
                // Recomputed from the validated id, then compared. `HOST_ID`
                // admits only unreserved characters, so percent-encoding is the
                // identity here and the comparison is exact.
                val path = "/v1/workstations/$id"
                val sent = record.text("statusHref")
                if (sent != null && sent != path) return null
                hostId = id
                statusPath = path
            } else if (record.containsKey("statusHref") && record["statusHref"] != JsonNull) {
                // An href without the id that generates it is a forged shape.
                return null
            }

            var state: WorkstationState? = null
            if (record.containsKey("state") && record["state"] != JsonNull) {
                state = WorkstationState.fromWire(record.text("state")) ?: return null
            }

            var retryAfterMs: Int? = null
            if (record.containsKey("retryAfterMs") && record["retryAfterMs"] != JsonNull) {
                val raw = (record["retryAfterMs"] as? JsonPrimitive)
                    ?.takeIf { !it.isString }?.doubleOrNull ?: return null
                if (!raw.isFinite()) return null
                val rounded = Math.round(raw)
                if (rounded < 0 || rounded > MAX_RETRY_AFTER_MS) return null
                retryAfterMs = rounded.toInt()
            }

            var operation: WorkstationOperation? = null
            if (record.containsKey("operation") && record["operation"] != JsonNull) {
                operation = WorkstationOperation.parse(record["operation"]) ?: return null
            }

            return WorkstationDemand(
                reason = reason,
                knownReason = WorkstationDemandReason.fromWire(reason),
                retryable = retryable,
                hostId = hostId,
                statusPath = statusPath,
                state = state,
                retryAfterMs = retryAfterMs,
                operation = operation,
                serverMessage = serverMessage?.trim()?.takeIf { it.isNotEmpty() },
            )
        }
    }
}

/**
 * A validated host-demand refusal raised somewhere other than a REST body — the
 * gateway's 4420 close, in practice — so the one shared wait can classify it the
 * same way it classifies a 503.
 */
class WorkstationNotReadyException(val demand: WorkstationDemand) :
    Exception("workstation not ready: ${demand.reason}")

/** The string at [key] when it really is a JSON string. */
private fun JsonObject.text(key: String): String? =
    (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

/**
 * A bounded ISO-8601 instant. The server re-renders every timestamp it emits
 * from a parsed instant, so anything longer or looser than that is not ours.
 */
private fun instant(value: JsonElement?): Instant? {
    val text = (value as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
    if (text.length > 40 || !ISO_INSTANT.matches(text)) return null
    val normalized = text.replace(' ', 'T')
    return runCatching { Instant.parse(normalized) }.getOrNull()
        ?: runCatching { OffsetDateTime.parse(normalized).toInstant() }.getOrNull()
}

private val ISO_INSTANT =
    Regex("^\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,6})?(Z|[+-]\\d{2}:?\\d{2})?$")
