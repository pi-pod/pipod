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
 * Absent until a Firebase project is wired to this app.
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
 * Notification permission, and remote registration whenever [tokenSource] can
 * produce a token.
 *
 * Port of `pi-pod-flutter/lib/core/push/push_controller.dart`.
 */
class PushController(
    private val api: ApiClient,
    private val permission: NotificationPermission,
    private val tokenSource: PushTokenSource = NoPushTokenSource,
    private val environment: String = "production",
    /** Asks the OS for permission. The activity owns the launcher that does it. */
    private val requestPermission: suspend () -> Boolean = { false },
    private val openSettings: suspend () -> Unit = {},
) : NotificationSettingsService {

    private var authorization = NotificationAuthorization.NotDetermined

    override var registrationError: String? = null
        private set

    override suspend fun refresh(): NotificationAuthorization {
        // The OS is authoritative: permission can be revoked in system settings
        // while the app is backgrounded, and a cached "authorized" would then
        // be a lie on the settings screen.
        if (permission.isGranted()) {
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
