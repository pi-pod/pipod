package com.pipod.app.acceptance

import android.content.Intent
import android.net.Uri
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.io.File
import kotlin.test.assertTrue
import kotlin.test.fail

internal object LiveUi {
    val ALLOWED_SHOTS = setOf("pods.png", "settings.png", "wait.png", "session.png")

    fun requireLive(needSessionFixture: Boolean) {
        if (!LiveGate.enabled()) {
            fail("LIVE required: pipodLive=1 (missing login is a failure, not a skip)")
        }
        val backend = LiveGate.backend()
        if (backend != "static" && backend != "saas") {
            fail("pipodBackend must be static or saas")
        }
        val scope = LiveGate.scope()
        if (scope != "auth" && scope != "full") {
            fail("pipodScope must be auth or full")
        }
        if (needSessionFixture) {
            if (scope != "full") {
                fail("session fixtures are full-scope only")
            }
            if (LiveGate.podId().isEmpty()) {
                fail("pipodPodId required")
            }
        }
    }

    fun openPodSession(device: UiDevice, podId: String) {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val view = Intent(Intent.ACTION_VIEW, Uri.parse("pipod://pod/$podId")).apply {
            setPackage(context.packageName)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(view)
        device.waitForIdle()
    }

    /** Active wait: Stop-waiting control, not the cancelled title. */
    fun stopWaitingVisible(device: UiDevice, timeoutMs: Long): Boolean =
        device.wait(Until.findObject(By.desc("Stop waiting for the workstation")), timeoutMs) != null ||
            device.wait(Until.findObject(By.text("Stop waiting")), 1_000) != null

    fun cancelledWaitVisible(device: UiDevice, timeoutMs: Long): Boolean =
        device.wait(Until.findObject(By.textContains("Stopped waiting")), timeoutMs) != null ||
            device.wait(Until.findObject(By.text("Try again now")), 1_000) != null

    fun composerVisible(device: UiDevice, timeoutMs: Long): Boolean =
        device.wait(Until.findObject(By.desc("Send message")), timeoutMs) != null ||
            device.wait(Until.findObject(By.desc("Attach image")), 2_000) != null ||
            device.wait(Until.findObject(By.textContains("Message pi")), 2_000) != null

    fun sendEnabled(device: UiDevice): Boolean {
        val send = device.findObject(By.desc("Send message")) ?: return false
        return send.isEnabled
    }

    fun allowlistedShot(device: UiDevice, name: String) {
        val ctx = InstrumentationRegistry.getInstrumentation().targetContext
        val dir = File(ctx.getExternalFilesDir(null), "acceptance-shots").apply { mkdirs() }
        assertTrue(ALLOWED_SHOTS.contains(name), "shot not allowlisted")
        device.takeScreenshot(File(dir, name))
    }

    fun clickText(device: UiDevice, text: String, timeoutMs: Long = 15_000) {
        val obj = device.wait(Until.findObject(By.text(text)), timeoutMs)
            ?: fail("missing UI text: $text")
        obj.click()
    }

    fun clickDesc(device: UiDevice, desc: String, timeoutMs: Long = 15_000) {
        val obj = device.wait(Until.findObject(By.desc(desc)), timeoutMs)
            ?: fail("missing UI desc: $desc")
        obj.click()
    }

    fun completeChromeFirstRun(device: UiDevice) {
        val deadline = System.currentTimeMillis() + 45_000
        while (System.currentTimeMillis() < deadline) {
            listOf("Use without an account", "SKIP", "Skip", "Accept & continue", "No thanks")
                .mapNotNull { device.findObject(By.text(it)) }
                .firstOrNull()
                ?.click()
            if (device.findObject(By.text("Login Name")) != null) return
            if (device.findObject(By.clazz("android.widget.EditText")) != null) return
            Thread.sleep(500)
        }
    }

    fun typeLogin(device: UiDevice, login: String) {
        val field = device.wait(Until.findObject(By.clazz("android.widget.EditText")), 30_000)
            ?: fail("login field missing")
        field.click()
        field.text = login
        (device.findObject(By.text("Next")) ?: fail("Next missing after login")).click()
    }

    fun typePassword(device: UiDevice, password: String) {
        val field = device.wait(Until.findObject(By.clazz("android.widget.EditText")), 30_000)
            ?: fail("password field missing")
        field.click()
        field.text = password
        (device.findObject(By.text("Next")) ?: fail("Next missing after password")).click()
        device.findObject(By.text("Next"))?.click()
    }
}
