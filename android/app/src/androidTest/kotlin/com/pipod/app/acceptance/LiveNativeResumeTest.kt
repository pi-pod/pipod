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

/** Native resume after companion non-waking asleep fence. */
@RunWith(AndroidJUnit4::class)
class LiveNativeResumeTest {

    @Test
    fun openSessionAfterProvenStop() {
        LiveUi.requireLive(needSessionFixture = true)
        val backend = LiveGate.backend()
        val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())

        ActivityScenario.launch(MainActivity::class.java).use {
            if (device.wait(Until.findObject(By.text("Sign in")), 8_000) != null &&
                device.findObject(By.text("Pods")) == null
            ) {
                fail("PKCE session lost; still on Sign in")
            }
            LiveUi.openPodSession(device, LiveGate.podId())
            if (backend == "static") {
                if (LiveUi.stopWaitingVisible(device, 8_000)) {
                    fail("static reconnect must not show workstation wait")
                }
                if (!LiveUi.composerVisible(device, 90_000)) {
                    fail("INCOMPLETE: static reconnect did not restore composer")
                }
            } else if (!LiveUi.composerVisible(device, 90_000) && !LiveUi.stopWaitingVisible(device, 5_000)) {
                fail("INCOMPLETE: saas resume had no composer or wait transition")
            }
        }
    }
}
