package com.pipod.app.core.push

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.pipod.app.R

/**
 * OS-local banner.
 *
 * There is no Firebase project wired to this app yet, so this is the only
 * channel that can surface an approval while the app is backgrounded. A missing
 * permission or a notification manager that refuses the post must not take the
 * app down — an approval banner is an assist, not a correctness requirement.
 */
interface LocalNotifier {
    /** True when notifications may be posted. Does not itself prompt. */
    fun isPermitted(): Boolean

    suspend fun show(title: String, body: String, payload: String? = null)
}

/** For tests, previews, and any build that must not touch the system service. */
object NoopLocalNotifier : LocalNotifier {
    override fun isPermitted(): Boolean = false
    override suspend fun show(title: String, body: String, payload: String?) = Unit
}

class AndroidLocalNotifier(private val context: Context) : LocalNotifier {

    init {
        // At construction, not at the first post. A channel created inside
        // `show` races the notify that needs it, and on a device that has never
        // had one the first banner of a launch could be dropped by the platform
        // for naming a channel that did not exist yet.
        ensureChannel()
    }

    override fun isPermitted(): Boolean {
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return false
        // POST_NOTIFICATIONS is only enforced from API 33; below it the manifest
        // permission is granted at install time and the check above is the answer.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true
        return ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
    }

    override suspend fun show(title: String, body: String, payload: String?) {
        if (!isPermitted()) return
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_launcher_monochrome)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .apply { payload?.let { setContentIntent(openIntent(it)) } }
            .build()
        runCatching {
            // One id, deliberately. Keying on the text meant "1 request is
            // waiting" and "2 requests are waiting" were different
            // notifications, so a run of approvals stacked the shade with
            // successive counts of the same thing. The newest count replaces the
            // last one instead.
            NotificationManagerCompat.from(context).notify(APPROVALS_NOTIFICATION_ID, notification)
        }
        // A SecurityException here means the permission was revoked between the
        // check and the post, which is a race, not a bug worth crashing on.
    }

    /**
     * Taps land on the deep link the payload names, so an approval banner opens
     * the approval rather than the last screen the app happened to be on.
     */
    private fun openIntent(payload: String): PendingIntent {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(payload)).apply {
            `package` = context.packageName
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        }
        return PendingIntent.getActivity(
            context,
            payload.hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun ensureChannel() {
        runCatching {
            val manager = context.getSystemService(NotificationManager::class.java) ?: return
            if (manager.getNotificationChannel(CHANNEL_ID) != null) return
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "Approvals", NotificationManager.IMPORTANCE_HIGH).apply {
                    description = "An agent is waiting for your answer."
                },
            )
        }
        // A notification manager that refuses is not worth failing construction
        // over: the app graph is built from it, and banners are an assist.
    }

    companion object {
        const val CHANNEL_ID = "pipod.approvals"

        /** The single approval banner; a later count supersedes the last. */
        const val APPROVALS_NOTIFICATION_ID = 0x9D0D
    }
}
