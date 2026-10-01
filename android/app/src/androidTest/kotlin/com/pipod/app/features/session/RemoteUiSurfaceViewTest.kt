package com.pipod.app.features.session

import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.pipod.app.core.session.REMOTE_UI_INPUT_PREFIX
import com.pipod.app.core.session.REMOTE_UI_MAX_ENCODED_BYTES
import com.pipod.app.core.session.REMOTE_UI_NOTIFICATION_PREFIX
import com.pipod.app.core.session.RemoteUiInput
import com.pipod.app.core.session.RemoteUiInputKind
import com.pipod.app.core.session.RemoteUiStore
import com.pipod.app.core.session.decodeWireJson
import com.pipod.app.core.session.encodeRemoteUiPayload
import com.pipod.app.core.session.remoteUiInputFromJson
import com.pipod.app.ui.theme.PiPodTheme
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.test.assertEquals
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * A pod extension surface has to reach the screen as native styled text and send
 * terminal input back, without the app knowing which extension produced it.
 *
 * Ported from the surface cases of
 * `pi-pod-flutter/test/features/session/remote_ui_view_test.dart`. The store is
 * driven with real wire frames rather than a hand-built surface, because
 * `RemoteUiSurface` has no public constructor — a surface only exists because
 * the pod sent one.
 */
@RunWith(AndroidJUnit4::class)
class RemoteUiSurfaceViewTest {

    @get:Rule
    val compose = createComposeRule()

    @Test
    fun aSurfaceIsOneNodeNamedForItsRole() {
        val store = RemoteUiStore()
        store.applyExtensionRequest(
            notify(surfaceFrame(lines = listOf("\u001b[1mPick a branch\u001b[0m", "  main"))),
        )
        compose.setContent { SurfaceHost(store) }

        compose.onNodeWithTag(RemoteUiTestTags.surface("s1")).assertExists()
        // The escape sequences never reach the reader; the role does.
        compose
            .onNodeWithContentDescription("Extension surface. Pick a branch\n  main")
            .assertExists()
    }

    @Test
    fun aSurfaceOwnedByAnotherClientSaysSoAndStopsSending() {
        val recorder = Recorder()
        val store = RemoteUiStore(responder = recorder::call)
        store.applyExtensionRequest(inputRequest(surfaceFrame(kind = "open", revision = 0), "req-1"))
        compose.setContent { SurfaceHost(store) }
        // The measured cell grid is what the pod is told about first, and that
        // send is what names the surface the gateway then refuses.
        compose.waitUntil(timeoutMillis = 5_000) { recorder.responses.isNotEmpty() }
        val before = recorder.responses.size

        compose.runOnIdle { store.markOwnedElsewhere() }

        compose.onNodeWithText("Controlled by another client").assertIsDisplayed()
        // No way in and no way to raise a keyboard for a surface we do not own.
        compose.onNodeWithTag(RemoteUiTestTags.KEY_BAR).assertDoesNotExist()
        compose.onNodeWithTag(RemoteUiTestTags.CAPTURE).assertDoesNotExist()
        assertEquals(before, recorder.responses.size)
    }

    @Test
    fun aKeyBarChipSendsItsEscapeSequence() {
        val recorder = Recorder()
        val store = RemoteUiStore(responder = recorder::call)
        store.applyExtensionRequest(inputRequest(surfaceFrame(kind = "open", revision = 0), "req-1"))
        compose.setContent { SurfaceHost(store) }
        compose.waitUntil(timeoutMillis = 5_000) { recorder.responses.isNotEmpty() }

        // Input only goes out while the pod is waiting on us, so a second input
        // request is what the tap answers.
        compose.runOnIdle {
            store.applyExtensionRequest(inputRequest(surfaceFrame(revision = 1), "req-2"))
        }
        compose.onNodeWithTag(RemoteUiTestTags.key("↓")).performClick()
        compose.waitUntil(timeoutMillis = 5_000) { recorder.responses.size == 2 }

        val sent = sentInput(recorder.responses.last())
        assertEquals(RemoteUiInputKind.INPUT, sent.kind)
        assertEquals("\u001b[B", sent.data)
    }
}

/** Renders whichever surface the store currently holds, as the session view does. */
@Composable
private fun SurfaceHost(store: RemoteUiStore) {
    val snapshot by store.state.collectAsState()
    PiPodTheme {
        val surface = snapshot.surfaces.firstOrNull()
        if (surface != null) {
            RemoteUiSurfaceView(
                surface = surface,
                viewportRows = 24,
                revision = snapshot.revision,
                interactive = true,
            )
        }
    }
}

private fun surfaceFrame(
    id: String = "s1",
    kind: String = "frame",
    revision: Int = 1,
    role: String = "custom",
    lines: List<String> = listOf("hello"),
): JsonObject = buildJsonObject {
    put("v", 1)
    put("kind", kind)
    put("surfaceId", id)
    put("revision", revision)
    put("role", role)
    put("lines", JsonArray(lines.map { line -> JsonPrimitive(line) }))
}

private fun notify(frame: JsonObject): JsonObject = buildJsonObject {
    put("type", "extension_ui_request")
    put("id", "notify")
    put("method", "notify")
    put("message", REMOTE_UI_NOTIFICATION_PREFIX + encodeRemoteUiPayload(frame))
}

private fun inputRequest(frame: JsonObject, requestId: String): JsonObject = buildJsonObject {
    put("type", "extension_ui_request")
    put("id", requestId)
    put("method", "input")
    put("title", REMOTE_UI_INPUT_PREFIX + encodeRemoteUiPayload(frame))
}

/** Decodes what the store handed the socket. */
private fun sentInput(response: JsonObject): RemoteUiInput {
    val value = response["value"]!!.jsonPrimitive.content
    val json = decodeWireJson(
        value.substring(REMOTE_UI_INPUT_PREFIX.length),
        REMOTE_UI_MAX_ENCODED_BYTES,
    ) as JsonObject
    return remoteUiInputFromJson(json)!!
}

/**
 * Responses land on the main thread and are read from the test thread, so the
 * list has to be one both can see.
 */
private class Recorder {
    val responses = CopyOnWriteArrayList<JsonObject>()

    fun call(response: JsonObject): Boolean {
        responses.add(response)
        return true
    }
}
