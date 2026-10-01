package com.pipod.app.core.push

import com.pipod.app.core.api.ApiClient
import com.pipod.app.core.format.FriendlyError

/** How the OS currently answers "may this app notify?". */
enum class NotificationAuthorization {
    NotDetermined,
    Denied,
    Authorized,
    Provisional,
    Ephemeral,
    Unknown,
}

/**
 * Platform boundary for notification permission.
 *
 * The settings screen talks to this rather than to a notification API directly,
 * so it can be driven from a test without a system service behind it.
 */
interface NotificationSettingsService {
    val registrationError: String?
    suspend fun refresh(): NotificationAuthorization
    suspend fun requestAndRegister(): NotificationAuthorization
    suspend fun openSystemSettings()
}

/**
 * Optional remote push token.
 *
 * Absent until a Firebase project is wired to this app. The controller still
 * polls pending approvals and raises a local banner, so a pending approval is
 * visible either way.
 */
interface PushTokenSource {
    suspend fun currentToken(): String?
    val tokenKind: String
    val platform: String
}

object NoPushTokenSource : PushTokenSource {
    override suspend fun currentToken(): String? = null
    override val tokenKind: String = "fcm"
    override val platform: String = "android"
}

/**
 * In-process push: the shell already polls pending interactions for its badge,
 * so a rise in that count is what raises an OS-local banner. Remote
 * registration is attempted whenever [tokenSource] can produce a token.
 *
 * Port of `pi-pod-flutter/lib/core/push/push_controller.dart`.
 */
class PushController(
    private val api: ApiClient,
    private val notifier: LocalNotifier,
    private val tokenSource: PushTokenSource = NoPushTokenSource,
    private val environment: String = "production",
    /** Asks the OS for permission. The activity owns the launcher that does it. */
    private val requestPermission: suspend () -> Boolean = { false },
    private val openSettings: suspend () -> Unit = {},
) : NotificationSettingsService {

    private var lastPending = 0
    private var lastByPod: Map<String, Int> = emptyMap()
    private var seenFirst = false
    private var authorization = NotificationAuthorization.NotDetermined

    override var registrationError: String? = null
        private set

    /** The pod whose session is on screen; its approvals need no banner. */
    var visiblePodId: String? = null

    /**
     * Called whenever the signed-in store learns a new pending-approval count.
     * The first observation is silent so a cold start does not replay history.
     *
     * [byPod] is where the pending approvals sit, when the observation carried
     * it. Null means the caller reported only a total and the split from the
     * last full poll stands.
     */
    suspend fun onPendingCount(count: Int, byPod: Map<String, Int>? = null) {
        val rose = seenFirst && count > lastPending
        // The OS is asked at the moment of the decision, not remembered from
        // whenever `refresh()` last ran. The cached answer started at
        // NotDetermined and only the settings screen ever moved it, so on a
        // device where permission was granted — at install, below API 33, or in
        // system settings — no banner ever fired unless the person had opened
        // Settings in this launch.
        if (rose && permitted() && !belongsToVisiblePod(byPod)) {
            notifier.show(
                title = "Approval needed",
                body = if (count == 1) "1 request is waiting" else "$count requests are waiting",
                payload = "pipod://interaction/inbox",
            )
        }
        seenFirst = true
        lastPending = count
        if (byPod != null) lastByPod = byPod
    }

    /**
     * Whether the rise is entirely the pod already on screen.
     *
     * Its approval is rendered inline in the conversation the person is looking
     * at; a banner over the top of it says nothing they cannot already see. A
     * rise that cannot be attributed — no breakdown, or a pod that is not the
     * visible one — is announced.
     */
    private fun belongsToVisiblePod(byPod: Map<String, Int>?): Boolean {
        val visible = visiblePodId ?: return false
        if (byPod == null) return false
        val risen = byPod.filter { (podId, pending) -> pending > (lastByPod[podId] ?: 0) }
        return risen.isNotEmpty() && risen.keys.all { it == visible }
    }

    private fun permitted(): Boolean {
        val allowed = notifier.isPermitted()
        authorization = when {
            allowed -> NotificationAuthorization.Authorized
            authorization == NotificationAuthorization.NotDetermined -> NotificationAuthorization.NotDetermined
            else -> NotificationAuthorization.Denied
        }
        return allowed
    }

    override suspend fun refresh(): NotificationAuthorization {
        // The OS is authoritative: permission can be revoked in system settings
        // while the app is backgrounded, and a cached "authorized" would then
        // silently drop every banner.
        if (notifier.isPermitted()) {
            authorization = NotificationAuthorization.Authorized
        } else if (authorization == NotificationAuthorization.Authorized) {
            authorization = NotificationAuthorization.Denied
        }
        return authorization
    }

    override suspend fun requestAndRegister(): NotificationAuthorization {
        registrationError = null
        val granted = requestPermission()
        authorization = if (granted) {
            NotificationAuthorization.Authorized
        } else {
            NotificationAuthorization.Denied
        }
        if (!granted) return authorization
        registerCurrentToken()
        return authorization
    }

    suspend fun registerCurrentToken() {
        val token = tokenSource.currentToken() ?: return
        try {
            api.registerDevice(
                token = token,
                tokenKind = tokenSource.tokenKind,
                platform = tokenSource.platform,
                environment = environment,
            )
            registrationError = null
        } catch (error: Throwable) {
            registrationError =
                "Notifications are enabled, but this device could not be registered: " +
                FriendlyError.message(error, api.baseUrl)
        }
    }

    override suspend fun openSystemSettings() = openSettings()
}

/** Used until a platform implementation is installed. */
object UnavailableNotificationSettings : NotificationSettingsService {
    override val registrationError: String? = null
    override suspend fun refresh(): NotificationAuthorization = NotificationAuthorization.Unknown
    override suspend fun requestAndRegister(): NotificationAuthorization = NotificationAuthorization.Unknown
    override suspend fun openSystemSettings() = Unit
}
