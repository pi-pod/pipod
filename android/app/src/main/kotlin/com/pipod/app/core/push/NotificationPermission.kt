package com.pipod.app.core.push

import android.Manifest
import android.app.NotificationManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

/** Whether the OS lets this app post notifications. Does not itself prompt. */
fun interface NotificationPermission {
    fun isGranted(): Boolean
}

class AndroidNotificationPermission(private val context: Context) : NotificationPermission {

    init {
        // Earlier versions posted "Approval needed" banners on this channel. Nothing
        // posts there any more, so it should not linger in the app's notification
        // settings. A notification manager that refuses is not worth failing over.
        runCatching {
            context.getSystemService(NotificationManager::class.java)
                ?.deleteNotificationChannel(RETIRED_APPROVALS_CHANNEL)
        }
    }

    override fun isGranted(): Boolean {
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return false
        // POST_NOTIFICATIONS is only enforced from API 33; below it the manifest
        // permission is granted at install time and the check above is the answer.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true
        return ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
    }

    private companion object {
        const val RETIRED_APPROVALS_CHANNEL = "pipod.approvals"
    }
}
