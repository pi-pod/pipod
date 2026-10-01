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

/** Native Stop sandbox with required confirmation. Does not reopen; companion fence follows. */
@RunWith(AndroidJUnit4::class)
class LiveNativeStopTest {

    @Test
    fun confirmStopSandboxAndLeaveStopped() {
        LiveUi.requireLive(needSessionFixture = true)
        val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())

        ActivityScenario.launch(MainActivity::class.java).use {
            if (device.wait(Until.findObject(By.text("Sign in")), 8_000) != null &&
                device.findObject(By.text("Pods")) == null
            ) {
                fail("PKCE session lost; still on Sign in")
            }
            LiveUi.openPodSession(device, LiveGate.podId())
            if (!LiveUi.composerVisible(device, 60_000) && !LiveUi.stopWaitingVisible(device, 5_000)) {
                fail("session pod did not open")
            }
            LiveUi.clickDesc(device, "Pod details")
            LiveUi.clickDesc(device, "Pod actions")
            LiveUi.clickText(device, "Stop sandbox", 20_000)
            val dialog = device.wait(Until.findObject(By.textContains("Stop this pod")), 8_000)
            if (dialog == null) {
                fail("stop confirmation dialog missing")
            }
            val confirm = device.wait(Until.findObject(By.descContains("Stop sandbox")), 8_000)
                ?: fail("stop confirmation control missing")
            confirm.click()
            val gone = device.wait(Until.gone(By.textContains("Stop this pod")), 20_000)
            if (gone != true) {
                fail("stop confirmation did not complete")
            }
        }
    }
}
