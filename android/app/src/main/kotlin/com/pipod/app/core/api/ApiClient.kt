package com.pipod.app.core.api

import com.pipod.app.core.api.model.AgentSession
import com.pipod.app.core.api.model.ApiError
import com.pipod.app.core.api.model.BillingSummary
import com.pipod.app.core.api.model.ConversationEventsPage
import com.pipod.app.core.api.model.CredentialStatus
import com.pipod.app.core.api.model.CredentialTestResponse
import com.pipod.app.core.api.model.DecodedList
import com.pipod.app.core.api.model.EnvironmentEditorData
import com.pipod.app.core.api.model.Job
import com.pipod.app.core.api.model.JobRun
import com.pipod.app.core.api.model.LaunchResponse
import com.pipod.app.core.api.model.LoginTicket
import com.pipod.app.core.api.model.MeResponse
import com.pipod.app.core.api.model.ModelCredentialsResponse
import com.pipod.app.core.api.model.PlanChangeConfirmResult
import com.pipod.app.core.api.model.PlanChangeQuote
import com.pipod.app.core.api.model.PlanKey
import com.pipod.app.core.api.model.Pod
import com.pipod.app.core.api.model.PodTemplate
import com.pipod.app.core.api.model.PodsPage
import com.pipod.app.core.api.model.QueuedPromptReceipt
import com.pipod.app.core.api.model.RefreshResponse
import com.pipod.app.core.api.model.SecretMeta
import com.pipod.app.core.api.model.SessionEventRecord
import com.pipod.app.core.api.model.SessionEventsPage
import com.pipod.app.core.api.model.SettingsLayer
import com.pipod.app.core.api.model.UnparsedRow
import com.pipod.app.core.api.model.WorkstationStatus
import com.pipod.app.core.api.model.WsTicket
import com.pipod.app.core.api.model.decodeListRows
import com.pipod.app.core.auth.OidcSessionExpiredException
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * REST client for the pi pod `/v1` API.
 *
 * Port of `pi-pod-flutter/lib/core/api/api_client.dart`, method for method, so
 * the two clients speak to the server identically.
 */
class ApiClient(
    baseUrl: String,
    httpClient: OkHttpClient? = null,
    accessToken: String? = null,
    refreshToken: String? = null,
    idToken: String? = null,
    refreshTokens: TokenRefresher,
    /**
     * Notified whenever a refresh produced a new token set worth persisting.
     *
     * Suspending, and awaited before the retried request goes out: the rotated
     * refresh token has to be durable before anything can act on the new access
     * token, or a restore running alongside reads the spent one from storage.
     */
    var onTokensUpdated: (suspend (accessToken: String, refreshToken: String, idToken: String?) -> Unit)? = null,
) {

    /** The base URL with any trailing slashes removed, as the server expects. */
    val baseUrl: String = baseUrl.trimEnd('/')

    private val base: HttpUrl = this.baseUrl.toHttpUrl()

    @Volatile
    var accessToken: String? = accessToken

    @Volatile
    var refreshToken: String? = refreshToken

    @Volatile
    var idToken: String? = idToken

    /** Called when the provider says the refresh chain is finished. */
    var onSessionExpired: (() -> Unit)? = null

    private val client: OkHttpClient = (httpClient ?: defaultHttpClient())
        .newBuilder()
        .addInterceptor(
            AuthInterceptor(
                accessToken = { this.accessToken },
                refreshToken = { this.refreshToken },
                updateTokens = ::updateTokens,
                refresh = refreshTokens,
            ),
        )
        .build()

    private val refresher = refreshTokens

    private suspend fun updateTokens(newAccessToken: String, newRefreshToken: String, newIdToken: String?) {
        accessToken = newAccessToken
        refreshToken = newRefreshToken
        if (!newIdToken.isNullOrEmpty()) idToken = newIdToken
        onTokensUpdated?.invoke(newAccessToken, newRefreshToken, idToken)
    }

    suspend fun refresh(refreshToken: String): RefreshResponse = refresher.refresh(refreshToken)

    // --- identity -----------------------------------------------------------

    suspend fun me(): MeResponse = ApiJson.decodeFromJsonElement(
        MeResponse.serializer(),
        request("GET", "me").jsonObject,
    )

    /**
     * `GET /v1/billing/account` — the account body as sent.
     *
     * A 404 is the self-hosted edition answering: the whole `/v1/billing` group
     * is registered only under the boat backend, so its absence is the contract
     * rather than an error, and an empty object is what "no account surface"
     * looks like to every caller.
     *
     * [billingSummary] parses the same body for the summary line; both read
     * this one response shape so they cannot drift apart.
     */
    suspend fun billingAccount(): JsonObject =
        try {
            request("GET", "billing/account").jsonObject
        } catch (error: ApiError) {
            if (error.transportStatus == 404) JsonObject(emptyMap()) else throw error
        }

    suspend fun createCheckoutSession(plan: String, trial: Boolean): String {
        val body = buildJsonObject {
            put("plan", plan)
            put("trial", trial)
        }
        val url = request("POST", "billing/checkout-session", body = body)
            .jsonObject["url"]?.jsonPrimitive?.content.orEmpty()
        require(url.startsWith("https://")) { "checkout did not return a usable URL" }
        return url
    }

    suspend fun createPortalSession(): String {
        val url = request("POST", "billing/portal-session", body = JsonObject(emptyMap()))
            .jsonObject["url"]?.jsonPrimitive?.content.orEmpty()
        require(url.startsWith("https://")) { "portal did not return a usable URL" }
        return url
    }

    /**
     * `POST /v1/billing/plan-change/preview` — a quote the reader reviews
     * before anything is charged.
     *
     * [plan] is the only thing sent: the server prices the change from the
     * subscription it owns. A 404 (flag off, or nothing owned) propagates so
     * the caller can omit the surface; an unreadable quote body is a fault,
     * never an empty review.
     */
    suspend fun previewPlanChange(plan: PlanKey): PlanChangeQuote {
        val body = buildJsonObject { put("plan", plan.wire) }
        val json = request("POST", "billing/plan-change/preview", body = body).jsonObject
        return PlanChangeQuote.parse(json)
            ?: throw ApiError(error = "Unexpected plan-change quote response", detail = json)
    }

    /**
     * `POST /v1/billing/plan-change/confirm` — confirms the reviewed quote.
     *
     * Only the reviewed [quoteId] is sent, and a retry after a transport
     * failure re-sends that same id even if its TTL passed: a stale or
     * expired quote needs a new preview and a new consent, never a silent
     * re-send at a new price. The body answers `{ applied, ...quote, account }`:
     * success is `applied === true` AND the returned account showing the target
     * (or the refreshed account as fallback) — a missing `applied` never grants.
     * The current API defines no hosted payment URL, so none is read here.
     */
    suspend fun confirmPlanChange(quoteId: String): PlanChangeConfirmResult {
        val body = buildJsonObject { put("quoteId", quoteId) }
        val json = request("POST", "billing/plan-change/confirm", body = body).jsonObject
        return PlanChangeConfirmResult.parse(json)
            ?: throw ApiError(error = "Unexpected plan-change confirm response", detail = json)
    }

    // --- personal workstation -----------------------------------------------

    /**
     * `GET /v1/workstations/:hostId` — the durable state of the caller's own
     * workstation. It answers immediately and never blocks on the vendor.
     *
     * [hostId] must have come from a validated host-demand detail; anything that
     * does not match the route's own rule is refused here rather than sent. A
     * 404 — including a server that predates the route — reads as "nothing to
     * report" so a wait keeps retrying the original request instead of failing.
     *
     * This is deliberately read-only. `POST /v1/workstation` and the
     * resume/stop/destroy routes are never called to "help" a wait: demand has
     * already committed the durable operation, and a second intent is at best a
     * no-op.
     */
    suspend fun workstation(hostId: String): WorkstationStatus? {
        if (!WORKSTATION_HOST_ID.matches(hostId)) return null
        return try {
            WorkstationStatus.parse(request("GET", "workstations/$hostId"))
        } catch (error: ApiError) {
            if (error.transportStatus == 404) return null
            throw error
        }
    }

    // --- environments (templates) -------------------------------------------

    /**
     * Every environment the organization can see.
     *
     * The route defaults to 100 rows and offers a `before` cursor on
     * `created_at`; sending neither meant an organization past its hundredth
     * environment simply stopped seeing the rest, with no "load more" anywhere
     * to ask for them.
     */
    suspend fun templates(): DecodedList<PodTemplate> = pageThrough(
        path = "templates",
        key = "templates",
        resourceName = "environment",
        query = emptyMap(),
        cursorOf = { row -> row.text("createdAt") },
        idOf = { it.id },
        decode = { ApiJson.decodeFromJsonElement(PodTemplate.serializer(), it) },
    )

    suspend fun template(id: String): PodTemplate = ApiJson.decodeFromJsonElement(
        PodTemplate.serializer(),
        request("GET", "templates/$id").jsonObject,
    )

    suspend fun templateEditorData(id: String): EnvironmentEditorData = ApiJson.decodeFromJsonElement(
        EnvironmentEditorData.serializer(),
        request("GET", "templates/$id").jsonObject,
    )

    suspend fun createTemplate(
        name: String,
        description: String? = null,
        initScript: String? = null,
        bakeScript: String? = null,
        config: JsonObject? = null,
        agentInstructions: String? = null,
    ): PodTemplate {
        val body = buildJsonObject {
            put("name", name)
            description?.let { put("description", it) }
            initScript?.let { put("initScript", it) }
            bakeScript?.let { put("bakeScript", it) }
            config?.let { put("config", it) }
            agentInstructions?.let { put("agentInstructions", it) }
        }
        return ApiJson.decodeFromJsonElement(
            PodTemplate.serializer(),
            request("POST", "templates", body = body).jsonObject,
        )
    }

    /**
     * Writes an environment.
     *
     * [expectedVersion] is the version the editor read. The server compares it
     * under the row lock and answers 409 when someone else has written since,
     * instead of letting the later save silently discard the earlier one. It is
     * optional so a server that predates the check still accepts the write.
     *
     * [bakeScript] is null when the editor never loaded one. The route
     * `COALESCE`s every absent field, so omitting the key leaves the stored
     * script alone — sending `""` would erase it, which is exactly what an
     * editor that opened before the fetch landed would do. [agentInstructions]
     * is null for the same reason when the server never reported any.
     */
    suspend fun updateTemplate(
        id: String,
        name: String,
        description: String,
        initScript: String,
        bakeScript: String?,
        config: JsonObject,
        agentInstructions: String? = null,
        expectedVersion: Int? = null,
    ): PodTemplate {
        val body = buildJsonObject {
            put("name", name)
            put("description", description)
            put("initScript", initScript)
            bakeScript?.let { put("bakeScript", it) }
            agentInstructions?.let { put("agentInstructions", it) }
            put("config", config)
            expectedVersion?.let { put("expectedVersion", it) }
        }
        return ApiJson.decodeFromJsonElement(
            PodTemplate.serializer(),
            request("PATCH", "templates/$id", body = body).jsonObject,
        )
    }

    suspend fun activateTemplate(id: String) {
        request("POST", "templates/$id/activate", body = EMPTY_BODY)
    }

    suspend fun deleteTemplate(id: String) {
        request("DELETE", "templates/$id")
    }

    // --- pods ---------------------------------------------------------------

    /**
     * Every pod the organization can see.
     *
     * The route pages at `limit` (200 maximum) and hands back no cursor of its
     * own, so an organization past that simply lost the rest of its pods. The
     * cursor is the last row's `last_activity_at ?? created_at` (camelCase on
     * the wire), which is what the route orders by, followed until a page
     * comes back short.
     */
    suspend fun pods(state: String? = null, mine: Boolean = false): DecodedList<Pod> =
        podsPage(state = state, mine = mine).pods

    /**
     * The pod list plus the optional account summary the envelope may carry.
     *
     * The SaaS backend sends `workstation` on `GET /v1/me` today and may put
     * the same object here later; the self-hosted static backend sends it in
     * neither place. Both shapes are read by the same parser so the two can
     * never drift, and absence is silent. Billing is read from the first page;
     * rows de-duplicate by id.
     */
    suspend fun podsPage(state: String? = null, mine: Boolean = false): PodsPage {
        val query = buildMap {
            state?.let { put("state", it) }
            if (mine) put("mine", "true")
        }
        // Billing rides the same envelope as the rows; capture it from the
        // first page so the walk below never fetches twice.
        var billing: BillingSummary? = null
        var billingRead = false
        val pods = pageThrough(
            path = "pods",
            key = "pods",
            resourceName = "pod",
            query = query,
            cursorOf = { row -> row.text("lastActivityAt") ?: row.text("createdAt") },
            idOf = { it.id },
            decode = { ApiJson.decodeFromJsonElement(Pod.serializer(), it) },
            onEnvelope = {
                if (!billingRead) {
                    billing = BillingSummary.parse(it)
                    billingRead = true
                }
            },
        )
        return PodsPage(pods = pods, billing = billing)
    }

    suspend fun pod(id: String): Pod =
        ApiJson.decodeFromJsonElement(Pod.serializer(), request("GET", "pods/$id").jsonObject)

    /**
     * Launches a pod on the single sandbox backend. There is no provider
     * choice: the server places every pod on the sandbox host.
     */
    /**
     * The body carries the environment and nothing else. `piSettings` is a retired launch
     * input: the server applies none of it and warns about it in the launch report.
     */
    suspend fun launch(templateId: String? = null): LaunchResponse {
        val body = buildJsonObject {
            templateId?.let { put("templateId", it) }
        }
        return ApiJson.decodeFromJsonElement(
            LaunchResponse.serializer(),
            request("POST", "pods", body = body).jsonObject,
        )
    }

    /** [model] ("provider/id") asks the pod to switch to it before the prompt, when its pi offers it. */
    suspend fun queuePrompt(podId: String, text: String, model: String? = null): QueuedPromptReceipt =
        ApiJson.decodeFromJsonElement(
            QueuedPromptReceipt.serializer(),
            request(
                "POST",
                "pods/$podId/prompts",
                body = buildJsonObject {
                    put("text", text)
                    if (model != null) put("model", model)
                },
            ).jsonObject,
        )

    /**
     * `archive`, `restore` or `stop`; anything else is a programming error,
     * not a request.
     *
     * `stop` and `archive` are different operations and neither implies the
     * other: stop releases the machine now and keeps the pod listed and its
     * disk intact, archive hides the row and lets the reaper move the disk to
     * cold storage later.
     */
    suspend fun podCommand(id: String, command: String): Pod {
        if (command != "archive" && command != "restore" && command != "stop") {
            throw ApiError(error = "Unsupported pod lifecycle action")
        }
        val result = request("POST", "pods/$id/$command", body = EMPTY_BODY).jsonObject
        return pod(result.getValue("id").jsonPrimitive.content)
    }

    /**
     * Deletes a pod.
     *
     * Without [cascade] the server refuses to orphan live children and answers
     * 409 naming them, which the caller turns into a question. The flag is only
     * ever sent when the reader has answered it.
     */
    suspend fun deletePod(id: String, cascade: Boolean = false) {
        request(
            "DELETE",
            "pods/$id",
            query = if (cascade) mapOf("cascade" to "true") else emptyMap(),
        )
    }

    /**
     * Cooperatively cancel a bounded capacity wait (capacity contract §1).
     *
     * Returns true when a wait was cancelled, false when there was nothing left
     * to cancel — the pod never queued (contract 404, including older servers
     * where the route itself 404s), or the row is no longer waiting.
     *
     * The server answers the second case on its `if (!finished)` branch with the
     * wait view plus `cancelRequested: true` and **no** `cancelled` key: the
     * wait was already admitted, already expired, or a double tap cancelled it
     * first. That is a normal answer, not a fault, and reporting it as "Could
     * not cancel the capacity wait" blamed the server for agreeing. Only a body
     * carrying neither key is genuinely unreadable.
     */
    suspend fun cancelCapacityWait(id: String): Boolean {
        val body = try {
            request("DELETE", "pods/$id/capacity-wait").jsonObject
        } catch (error: ApiError) {
            // Only the transport's real 404 reads as "nothing queued": any other
            // status, even one whose prose mentions not-found, is a failure.
            if (error.transportStatus == 404) return false
            throw error
        }
        (body["cancelled"] as? JsonPrimitive)?.booleanOrNull?.let { return it }
        val cancelRequested = (body["cancelRequested"] as? JsonPrimitive)?.booleanOrNull
        val state = (body["state"] as? JsonPrimitive)?.takeIf { it.isString }?.content
        if (cancelRequested == true || (state != null && state != "waiting")) return false
        throw ApiError(error = "Unexpected capacity-wait cancel response", detail = body)
    }

    suspend fun wsTicket(podId: String): WsTicket = ApiJson.decodeFromJsonElement(
        WsTicket.serializer(),
        request("POST", "pods/$podId/ws-ticket", body = EMPTY_BODY).jsonObject,
    )

    // --- sessions and transcripts -------------------------------------------

    /**
     * Every gateway session this pod has had, newest first. Paged on
     * `started_at` the way the other list routes are: a long-lived pod
     * reconnects far more than a hundred times.
     */
    suspend fun sessions(podId: String): List<AgentSession> = pageThrough(
        path = "pods/$podId/sessions",
        key = "sessions",
        resourceName = "session",
        query = emptyMap(),
        // This route returns the database column names unchanged.
        cursorOf = { row -> row.text("started_at") },
        idOf = { it.id },
        decode = { ApiJson.decodeFromJsonElement(AgentSession.serializer(), it) },
    ).items

    suspend fun sessionEvents(
        sessionId: String,
        afterSeq: Long,
        limit: Int = 200,
    ): List<SessionEventRecord> = ApiJson.decodeFromJsonElement(
        SessionEventsPage.serializer(),
        request(
            "GET",
            "sessions/$sessionId/events",
            query = mapOf("after_seq" to "$afterSeq", "limit" to "$limit"),
        ).jsonObject,
    ).events

    suspend fun conversationEvents(
        podId: String,
        before: String? = null,
        limit: Int = 200,
    ): ConversationEventsPage = ApiJson.decodeFromJsonElement(
        ConversationEventsPage.serializer(),
        request(
            "GET",
            "pods/$podId/conversation/events",
            query = buildMap {
                put("limit", "$limit")
                before?.let { put("before", it) }
            },
        ).jsonObject,
    )

    // --- jobs ---------------------------------------------------------------

    /**
     * Every job the caller can see, org-scoped ones included.
     *
     * This route is the only one with a real keyset cursor: it orders by
     * `(created_at, id)` and takes `beforeId` alongside `before`, so a run of
     * jobs created in one transaction — which share `created_at` to the
     * microsecond — pages correctly instead of stalling on the tie.
     */
    suspend fun jobs(): DecodedList<Job> = pageThrough(
        path = "jobs",
        key = "jobs",
        resourceName = "job",
        query = emptyMap(),
        cursorOf = { row -> row.text("createdAt") },
        tieBreakerOf = { row -> row.text("id") },
        idOf = { it.id },
        decode = { ApiJson.decodeFromJsonElement(Job.serializer(), it) },
    )

    suspend fun job(id: String): Job =
        ApiJson.decodeFromJsonElement(Job.serializer(), request("GET", "jobs/$id").jsonObject)

    /**
     * A job's run history.
     *
     * The route has no cursor of its own — only `limit`, defaulting to 50 and
     * capped at 200 — so the most this client can do is ask for the whole
     * window rather than a third of it.
     */
    suspend fun jobRuns(id: String): DecodedList<JobRun> = decodeListRows(
        json = request("GET", "jobs/$id/runs", query = mapOf("limit" to "$LIST_PAGE_SIZE")).jsonObject,
        key = "runs",
        resourceName = "job run",
        decode = { ApiJson.decodeFromJsonElement(JobRun.serializer(), it) },
    )

    suspend fun jobCommand(id: String, command: String): Job {
        if (command !in setOf("activate", "pause", "resume", "run")) {
            throw ApiError(error = "Unsupported job action")
        }
        request("POST", "jobs/$id/$command", body = EMPTY_BODY)
        return job(id)
    }

    suspend fun deleteJob(id: String) {
        request("DELETE", "jobs/$id")
    }

    // --- settings layers ----------------------------------------------------

    suspend fun orgSettings(orgId: String): SettingsLayer = ApiJson.decodeFromJsonElement(
        SettingsLayer.serializer(),
        request("GET", "orgs/$orgId/settings").jsonObject,
    )

    /**
     * Writes the organization config bundle. [version] is the version read; the
     * server rejects the write when it no longer matches.
     */
    suspend fun putOrgSettings(
        orgId: String,
        config: JsonObject,
        initScript: String,
        bakeScript: String,
        version: Int,
    ): Int = putSettingsLayer("orgs/$orgId/settings", config, initScript, bakeScript, version)

    suspend fun userSettings(userId: String): SettingsLayer = ApiJson.decodeFromJsonElement(
        SettingsLayer.serializer(),
        request("GET", "users/$userId/settings").jsonObject,
    )

    /** Writes the user config bundle with the same concurrency rule as [putOrgSettings]. */
    suspend fun putUserSettings(
        userId: String,
        config: JsonObject,
        initScript: String,
        bakeScript: String,
        version: Int,
    ): Int = putSettingsLayer("users/$userId/settings", config, initScript, bakeScript, version)

    private suspend fun putSettingsLayer(
        path: String,
        config: JsonObject,
        initScript: String,
        bakeScript: String,
        version: Int,
    ): Int {
        val body = buildJsonObject {
            put("config", config)
            put("initScript", initScript)
            put("bakeScript", bakeScript)
            put("version", version)
        }
        return request("PUT", path, body = body).jsonObject.getValue("version").jsonPrimitive.int
    }

    // --- secrets ------------------------------------------------------------

    suspend fun secrets(scope: String, scopeId: String): DecodedList<SecretMeta> = decodeListRows(
        json = request("GET", "secrets/$scope/$scopeId").jsonObject,
        key = "secrets",
        resourceName = "secret",
        decode = { ApiJson.decodeFromJsonElement(SecretMeta.serializer(), it) },
    )

    suspend fun putSecret(scope: String, scopeId: String, name: String, value: String) {
        request(
            "PUT",
            "secrets/$scope/$scopeId/$name",
            body = buildJsonObject { put("value", value) },
        )
    }

    suspend fun deleteSecret(scope: String, scopeId: String, name: String) {
        request("DELETE", "secrets/$scope/$scopeId/$name")
    }

    // --- model credentials --------------------------------------------------

    suspend fun modelCredentials(): ModelCredentialsResponse = ApiJson.decodeFromJsonElement(
        ModelCredentialsResponse.serializer(),
        request("GET", "model-credentials").jsonObject,
    )

    suspend fun modelCredentialLoginTicket(
        providerId: String,
        authType: String,
        podId: String? = null,
    ): LoginTicket {
        val body = buildJsonObject {
            put("authType", authType)
            podId?.let { put("podId", it) }
        }
        return ApiJson.decodeFromJsonElement(
            LoginTicket.serializer(),
            request("POST", "model-credentials/$providerId/login-ticket", body = body).jsonObject,
        )
    }

    suspend fun testModelCredential(providerId: String): CredentialStatus = ApiJson.decodeFromJsonElement(
        CredentialTestResponse.serializer(),
        request("POST", "model-credentials/$providerId/test", body = EMPTY_BODY).jsonObject,
    ).status

    suspend fun deleteModelCredential(providerId: String) {
        request("DELETE", "model-credentials/$providerId")
    }

    // --- push registration --------------------------------------------------

    /**
     * Registers this install for pushes. `apnsToken` and `token` carry the same
     * value: the field was named for the first platform to ship and the server
     * still reads it, so both are sent for every platform.
     */
    suspend fun registerDevice(token: String, tokenKind: String = "fcm", platform: String = "android", environment: String) {
        if (token.isEmpty()) throw IllegalStateException("registerDevice requires a token")
        val body = buildJsonObject {
            put("apnsToken", token)
            put("token", token)
            put("tokenKind", tokenKind)
            put("platform", platform)
            put("environment", environment)
        }
        request("POST", "devices", body = body)
    }

    suspend fun unregisterDevice(token: String) {
        request("DELETE", "devices/$token")
    }

    // --- pagination ---------------------------------------------------------

    /**
     * Reads a `before`-cursor list route to the end.
     *
     * Both list routes that can genuinely exceed one page order newest-first and
     * take `before` as an exclusive timestamp cursor. Stopping conditions, in
     * order: a short page (fewer rows than asked for), a page that added nothing
     * new, a page that produced no cursor or the same cursor again, and the page
     * cap. The middle two are what keep a server whose timestamps are coarser
     * than its ordering from turning this into an endless read.
     *
     * De-duplication is by row id and spans the whole read: `before` is
     * exclusive on the *timestamp*, so rows sharing the cursor's timestamp come
     * back on both sides of it.
     *
     * That exclusivity is also a hazard. Postgres `now()` is transaction time,
     * so rows written together — a cascade over a pod's co-located children,
     * a batch of jobs — share their ordering column to the microsecond. If such
     * a group straddles a page boundary, asking for `before = <the last row's
     * timestamp>` drops the rest of the group entirely. Two answers, in order of
     * preference: [tieBreakerOf], for the one route that offers a real keyset
     * cursor (`/jobs`, which pages on `(created_at, id)`); otherwise step the
     * cursor back to the newest timestamp *before* the boundary group and let
     * the `seen` set discard what comes back twice.
     */
    private suspend fun <T> pageThrough(
        path: String,
        key: String,
        resourceName: String,
        query: Map<String, String>,
        cursorOf: (JsonObject) -> String?,
        idOf: (T) -> String,
        decode: (JsonObject) -> T,
        tieBreakerOf: ((JsonObject) -> String?)? = null,
        onEnvelope: (JsonObject) -> Unit = {},
    ): DecodedList<T> {
        val items = mutableListOf<T>()
        val unparsed = mutableListOf<UnparsedRow>()
        val seen = mutableSetOf<String>()
        var before: String? = null
        var beforeId: String? = null

        for (page in 0 until MAX_LIST_PAGES) {
            val json = request(
                "GET",
                path,
                query = buildMap {
                    putAll(query)
                    put("limit", "$LIST_PAGE_SIZE")
                    before?.let { put("before", it) }
                    beforeId?.let { put("beforeId", it) }
                },
            ).jsonObject
            onEnvelope(json)
            val decoded = decodeListRows(json, key, resourceName, decode)
            val raw = json[key] as? JsonArray ?: JsonArray(emptyList())
            val rows = raw.filterIsInstance<JsonObject>()

            var added = 0
            for (item in decoded.items) {
                if (!seen.add(idOf(item))) continue
                items += item
                added += 1
            }
            for (row in decoded.unparsedRows) {
                if (row.id != null && !seen.add(row.id)) continue
                unparsed += row
                added += 1
            }

            if (raw.size < LIST_PAGE_SIZE) break
            if (added == 0) break
            val last = rows.lastOrNull() ?: break
            val boundary = cursorOf(last) ?: break
            val nextId = tieBreakerOf?.invoke(last)
            val nextBefore = if (nextId != null) boundary else backOffBoundary(rows, boundary, cursorOf)
            // Neither the cursor nor its tie-breaker moved: a whole page sharing
            // one timestamp with no keyset to separate it cannot be walked past,
            // and asking again would only fetch it forever.
            if (nextBefore == before && nextId == beforeId) break
            before = nextBefore
            beforeId = nextId
        }
        return DecodedList(items = items, unparsedRows = unparsed)
    }

    /**
     * The newest cursor value strictly older than [boundary], so the next page
     * re-reads the whole group sharing the boundary timestamp instead of
     * skipping whatever part of it did not fit. Falls back to [boundary] when
     * the entire page shares one value — nothing else is available to ask for.
     */
    private fun backOffBoundary(
        rows: List<JsonObject>,
        boundary: String,
        cursorOf: (JsonObject) -> String?,
    ): String {
        for (index in rows.indices.reversed()) {
            val cursor = cursorOf(rows[index]) ?: continue
            if (cursor != boundary) return cursor
        }
        return boundary
    }

    private fun JsonObject.text(key: String): String? =
        (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { it.isNotEmpty() }

    // --- transport ----------------------------------------------------------

    private suspend fun request(
        method: String,
        path: String,
        query: Map<String, String> = emptyMap(),
        body: JsonElement? = null,
        authorized: Boolean = true,
    ): JsonElement = withContext(Dispatchers.IO) {
        val url = base.newBuilder()
            .addPathSegment("v1")
            .apply { path.split('/').forEach { addPathSegment(it) } }
            .apply { query.forEach { (key, value) -> addQueryParameter(key, value) } }
            .build()

        val requestBody = body?.let { ApiJson.encodeToString(JsonElement.serializer(), it).toRequestBody(JSON_MEDIA) }
        val builder = Request.Builder()
            .url(url)
            .header("Accept", "application/json")
            .method(method, requestBody ?: emptyBodyFor(method))
        if (!authorized) builder.header(AuthInterceptor.UNAUTHORIZED_HEADER, "1")

        try {
            client.newCall(builder.build()).execute().use { response ->
                val text = response.body.string()
                if (!response.isSuccessful) throw errorFor(response.code, text)
                if (text.isBlank()) return@use JsonNull
                ApiJson.parseToJsonElement(text)
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Throwable) {
            throw mapError(error)
        }
    }

    private fun errorFor(status: Int, text: String): Throwable {
        if (status == 401) return OidcSessionExpiredException()
        val parsed = runCatching { ApiJson.parseToJsonElement(text) }.getOrNull()
        if (parsed is JsonObject && (parsed["error"] as? JsonPrimitive)?.isString == true) {
            return ApiError.fromJson(parsed).copyWith(httpStatus = status)
        }
        return ApiError(
            error = "HTTP $status",
            detail = JsonPrimitive(text),
            httpStatus = status,
        )
    }

    private fun mapError(error: Throwable): Throwable {
        val unwrapped = when {
            error is ApiIoException -> error.original
            error is IOException && error.cause is ApiError -> error.cause!!
            else -> error
        }
        if (unwrapped is OidcSessionExpiredException) onSessionExpired?.invoke()
        return unwrapped
    }

    private fun emptyBodyFor(method: String) =
        if (method == "POST" || method == "PUT" || method == "PATCH") {
            ByteArray(0).toRequestBody(null)
        } else {
            null
        }

    companion object {
        /** The server's maximum for both paged list routes. */
        internal const val LIST_PAGE_SIZE = 200

        /**
         * 20 000 rows. Far past any real organization, and a bound that keeps a
         * server behaving unexpectedly from costing an unbounded number of
         * requests before a list screen gives up.
         */
        internal const val MAX_LIST_PAGES = 100
        /** The same host-id shape the workstation routes accept as a path parameter. */
        private val WORKSTATION_HOST_ID = Regex("^boat-[A-Za-z0-9._-]{1,180}$")

        private val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()

        /** `{}` — the body routes that take no arguments still expect. */
        private val EMPTY_BODY: JsonElement = buildJsonObject { }

        /** Unused today; kept so an empty JSON array literal has one spelling. */
        internal val EMPTY_ARRAY: JsonElement = buildJsonArray { }

        fun defaultHttpClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .build()
    }

    // --- billing -------------------------------------------------------------

    /**
     * The account summary, parsed from [billingAccount].
     *
     * The body carries the same flat block `/v1/me` sends under `workstation`,
     * plus fields this client does not render, so it goes through the one
     * [BillingSummary.fromObject] parser rather than a second one that could
     * drift from it. `accountView()` spreads the evaluated billing at the top
     * level, so there is no `workstation` wrapper here. An absent account
     * surface (the empty object a 404 becomes) is null, not an empty summary.
     */
    suspend fun billingSummary(): BillingSummary? =
        BillingSummary.fromObject(billingAccount().takeIf { it.isNotEmpty() })
}
