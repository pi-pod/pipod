package com.pipod.app.acceptance

import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Until
import com.pipod.app.MainActivity
import java.io.File
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlin.test.fail
import org.junit.Test
import org.junit.runner.RunWith

/** Native PKCE only. Auth-scope live; also the first full-scope leg. No pod fixtures. */
@RunWith(AndroidJUnit4::class)
class LiveNativePkceAuthTest {

    @Test
    fun nativePkceAndBilling() {
        LiveUi.requireLive(needSessionFixture = false)
        val backend = LiveGate.backend()
        val creds = readCreds()
        val device = androidx.test.uiautomator.UiDevice.getInstance(
            InstrumentationRegistry.getInstrumentation(),
        )

        ActivityScenario.launch(MainActivity::class.java).use {
            assertTrue(device.wait(Until.findObject(By.text("Sign in")), 30_000) != null, "Sign in missing")
            device.findObject(By.text("Sign in")).click()
            LiveUi.completeChromeFirstRun(device)
            LiveUi.typeLogin(device, creds.login)
            LiveUi.typePassword(device, creds.password)
            assertTrue(
                device.wait(Until.findObject(By.text("Pods")), 120_000) != null,
                "PKCE failed: Pods never appeared",
            )
            if (device.findObject(By.text("Sign in")) != null &&
                device.findObject(By.text("Settings")) == null
            ) {
                fail("PKCE failed: still on Sign in")
            }
            LiveUi.allowlistedShot(device, "pods.png")
            device.findObject(By.text("Settings")).click()
            assertTrue(device.wait(Until.findObject(By.text("Account")), 15_000) != null, "Account missing")
            val billing = device.findObject(By.textContains("Billing"))
            when (backend) {
                "static" -> assertTrue(billing == null, "static UI must hide billing")
                "saas" -> assertNotNull(billing, "saas UI must show billing")
            }
            LiveUi.allowlistedShot(device, "settings.png")
        }
    }

    private data class Creds(val login: String, val password: String)

    private fun readCreds(): Creds {
        val ctx = InstrumentationRegistry.getInstrumentation().targetContext
        val file = File(ctx.getExternalFilesDir(null), CREDS_FILE)
        if (!file.isFile) {
            fail("PKCE creds file missing (runner must adb-push $CREDS_FILE)")
        }
        val map = mutableMapOf<String, String>()
        file.bufferedReader().use { reader ->
            reader.lineSequence().forEach { line ->
                val i = line.indexOf('=')
                if (i > 0) map[line.substring(0, i)] = line.substring(i + 1)
            }
        }
        file.delete()
        val login = map["LOGIN"].orEmpty()
        val password = map["PASSWORD"].orEmpty()
        if (login.isEmpty() || password.isEmpty()) {
            fail("PKCE creds file missing LOGIN or PASSWORD")
        }
        return Creds(login, password)
    }

    companion object {
        const val CREDS_FILE = "pipod-acceptance.env"
    }
}
