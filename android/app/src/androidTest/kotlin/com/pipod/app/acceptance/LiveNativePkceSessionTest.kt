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
 * Full-scope: composer, fresh assistant-role turn, Attach-image picker open/cancel.
 * Picker routing only — not a native attachment-flow claim.
 */
@RunWith(AndroidJUnit4::class)
class LiveNativePkceSessionTest {

    @Test
    fun composerAssistantPickerRouting() {
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
            if (backend == "static" && LiveUi.stopWaitingVisible(device, 8_000)) {
                fail("static must not show workstation wait")
            }
            if (!LiveUi.composerVisible(device, 90_000)) {
                fail("session composer never appeared")
            }
            LiveUi.allowlistedShot(device, "session.png")
            exerciseAttachImagePickerOpenCancel(device)
            sendPromptAndAssertFreshAssistant(device)
        }
    }

    private fun exerciseAttachImagePickerOpenCancel(device: UiDevice) {
        LiveUi.clickDesc(device, "Attach image")
        val picker = device.wait(Until.findObject(By.textContains("Photo")), 8_000)
            ?: device.wait(Until.findObject(By.textContains("Gallery")), 1_000)
            ?: device.wait(Until.findObject(By.textContains("Files")), 1_000)
            ?: device.wait(Until.findObject(By.textContains("Allow")), 1_000)
            ?: device.wait(Until.findObject(By.pkg("com.google.android.providers.media.module")), 1_000)
        if (picker == null) {
            fail("Attach image did not open the system picker")
        }
        device.pressBack()
        if (!LiveUi.composerVisible(device, 15_000)) {
            fail("composer lost after closing attach picker")
        }
    }

    private fun sendPromptAndAssertFreshAssistant(device: UiDevice) {
        val token = LiveGate.promptToken()
        val field = device.wait(Until.findObject(By.clazz("android.widget.EditText")), 15_000)
            ?: fail("composer field missing")
        field.click()
        field.text = "Reply with exactly $token and no other words."
        LiveUi.clickDesc(device, "Send message")
        val userTurn = device.wait(Until.findObject(By.descContains("You").descContains(token)), 30_000)
        if (userTurn == null) {
            fail("submitted user turn with $token never appeared")
        }
        val assistant = device.wait(
            Until.findObject(By.descContains("pi").descContains(token)),
            120_000,
        )
        if (assistant == null) {
            fail("no fresh assistant-role reply containing $token")
        }
        val desc = assistant.contentDescription?.toString().orEmpty()
        if (desc.startsWith("You")) {
            fail("matched the user turn, not an assistant-role reply")
        }
    }
}
