package com.pipod.app.features.interactions

import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.pipod.app.core.api.model.DecodedList
import com.pipod.app.core.api.model.PendingInteraction
import com.pipod.app.core.api.model.ResolveOutcome
import com.pipod.app.ui.theme.PiPodTheme
import kotlin.test.assertEquals
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * A deep link names one approval: a still-pending id opens its row, while an
 * id that is no longer pending says so instead of dropping the reader onto an
 * empty list with no explanation.
 */
@RunWith(AndroidJUnit4::class)
class InteractionListScreenTest {

    @get:Rule
    val compose = createComposeRule()

    private val opened = mutableListOf<PendingInteraction>()
    private val handled = mutableListOf<String>()

    private fun render(repository: InteractionRepository, targetInteractionId: String?) {
        val viewModel = InteractionListViewModel(repository = repository, serverHost = null)
        compose.setContent {
            PiPodTheme {
                InteractionListScreen(
                    viewModel = viewModel,
                    onOpenInteraction = { opened += it },
                    targetInteractionId = targetInteractionId,
                    onTargetHandled = { handled += it },
                )
            }
        }
    }

    @Test
    fun aPendingTargetOpensItsRow() {
        render(FakeInteractionRepository(items = listOf(interaction("approval-1"))), "approval-1")

        compose.waitUntil(timeoutMillis = 5_000) { opened.isNotEmpty() }

        assertEquals(listOf("approval-1"), opened.map { it.id })
        assertEquals(listOf("approval-1"), handled)
    }

    @Test
    fun aResolvedTargetSaysItIsNoLongerPending() {
        render(FakeInteractionRepository(items = emptyList()), "approval-gone")

        compose.waitUntil(timeoutMillis = 5_000) {
            compose.onAllNodesWithText(
                "That approval is no longer pending. It may already have been resolved.",
            ).fetchSemanticsNodes().isNotEmpty()
        }
        assertEquals(emptyList(), opened.map { it.id })

        // Dismissing the notice is what marks the target handled.
        compose.onNodeWithContentDescription("Dismiss unavailable approval message").performClick()
        compose.waitUntil(timeoutMillis = 5_000) { handled.isNotEmpty() }

        assertEquals(listOf("approval-gone"), handled)
    }

    private fun interaction(id: String): PendingInteraction = PendingInteraction(
        id = id,
        sessionId = "session-1",
        podId = "pod-1",
        podName = "fixture-pod",
        seq = 1,
        kind = "approval",
        payload = buildJsonObject {
            put("title", JsonPrimitive("Deploy change"))
            put("message", JsonPrimitive("Run the release command."))
        },
        createdAt = "2026-08-18T04:38:03.822Z",
    )

    private class FakeInteractionRepository(
        var items: List<PendingInteraction> = emptyList(),
    ) : InteractionRepository {
        override suspend fun interactions(): DecodedList<PendingInteraction> =
            DecodedList(items = items, unparsedRows = emptyList())

        override suspend fun resolve(id: String, response: JsonObject): ResolveOutcome {
            items = items.filterNot { it.id == id }
            return ResolveOutcome(resolved = true)
        }
    }
}
