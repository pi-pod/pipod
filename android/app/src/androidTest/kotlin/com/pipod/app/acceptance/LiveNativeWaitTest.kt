package com.pipod.app.acceptance

import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import com.pipod.app.MainActivity
import kotlin.test.fail
import org.junit.Test
import org.junit.runner.RunWith

/**
 * SaaS last leg: UI-caused wait on the re-armed owner workstation.
 * Retry must leave cancelled copy and show NEW Stop-waiting or a fresh
 * assistant-role reply. Always-rendered composer presence is not success.
 */
@RunWith(AndroidJUnit4::class)
class LiveNativeWaitTest {

    @Test
    fun waitCancelRetryLeavesCancelledState() {
        LiveUi.requireLive(needSessionFixture = true)
        if (LiveGate.backend() != "saas") {
            fail("wait leg is saas-only")
        }
        val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())

        ActivityScenario.launch(MainActivity::class.java).use {
            if (device.wait(Until.findObject(By.text("Sign in")), 8_000) != null &&
                device.findObject(By.text("Pods")) == null
            ) {
                fail("PKCE session lost; still on Sign in")
            }
            LiveUi.openPodSession(device, LiveGate.podId())
            if (!LiveUi.stopWaitingVisible(device, 60_000)) {
                fail("INCOMPLETE: UI did not observe Stop waiting on re-armed host")
            }
            LiveUi.allowlistedShot(device, "wait.png")
            LiveUi.clickDesc(device, "Stop waiting for the workstation")
            if (!LiveUi.cancelledWaitVisible(device, 20_000)) {
                fail("INCOMPLETE: cancel did not leave cancelled/retry UI")
            }
            if (LiveUi.stopWaitingVisible(device, 2_000)) {
                fail("Stop waiting still present after cancel")
            }
            val retry = device.wait(Until.findObject(By.text("Try again now")), 15_000)
                ?: device.wait(Until.findObject(By.desc("Try the workstation again now")), 2_000)
                ?: fail("INCOMPLETE: retry control missing after cancel")
            retry.click()
            val deadline = System.currentTimeMillis() + 25_000
            var leftCancelled = false
            var sawNewWait = false
            while (System.currentTimeMillis() < deadline) {
                val cancelled = device.findObject(By.textContains("Stopped waiting")) != null ||
                    device.findObject(By.text("Try again now")) != null
                val waiting = device.findObject(By.desc("Stop waiting for the workstation")) != null
                if (!cancelled) leftCancelled = true
                if (leftCancelled && waiting) {
                    sawNewWait = true
                    break
                }
                Thread.sleep(400)
            }
            if (sawNewWait) return@use
            if (!leftCancelled) {
                fail("INCOMPLETE: retry did not leave cancelled state")
            }
            if (!LiveUi.sendEnabled(device)) {
                fail("INCOMPLETE: retry produced neither new Stop-waiting nor a usable Send")
            }
            assertFreshAssistantAfterRetry(device)
        }
    }

    private fun assertFreshAssistantAfterRetry(device: UiDevice) {
        val token = "${LiveGate.promptToken()}-WAIT"
        val field = device.wait(Until.findObject(By.clazz("android.widget.EditText")), 15_000)
            ?: fail("composer field missing after retry")
        field.click()
        field.text = "Reply with exactly $token and no other words."
        LiveUi.clickDesc(device, "Send message")
        val assistant = device.wait(
            Until.findObject(By.descContains("pi").descContains(token)),
            120_000,
        )
        if (assistant == null) {
            fail("INCOMPLETE: retry session had no fresh assistant-role reply")
        }
    }
}
