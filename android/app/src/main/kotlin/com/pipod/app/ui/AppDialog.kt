package com.pipod.app.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.BasicAlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.pipod.app.ui.theme.appColors
import kotlin.coroutines.resume
import kotlinx.coroutines.CancellableContinuation
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Asks for a decision that cannot be undone by simply looking away.
 *
 * Ported from `showAppConfirm` in `pi-pod-flutter/lib/ui/app_dialog.dart`.
 * Dismissing counts as no, so a cancelled dialog and an explicit Cancel are
 * the same answer and a caller never has to handle a third case.
 *
 * @param confirmSemanticsLabel the confirm action's accessible name, which
 *   rides on the button itself rather than on a wrapper: a wrapper would
 *   expose the action twice and merge the Cancel name into it.
 * @param cancelSemanticsLabel Cancel's name must stay clear of the confirm
 *   name — "Cancel Delete pod permanently" reads as one merged instruction —
 *   so it is scoped ("Cancel deleting X") rather than built from the other.
 */
@Composable
fun AppConfirmDialog(
    title: String,
    confirmLabel: String,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
    message: String = "",
    cancelLabel: String = "Cancel",
    destructive: Boolean = false,
    confirmSemanticsLabel: String? = null,
    cancelSemanticsLabel: String? = null,
) {
    assert(!(cancelSemanticsLabel ?: cancelLabel).contains(confirmSemanticsLabel ?: confirmLabel)) {
        "Cancel semantics must not embed the confirm semantics: " +
            "'${cancelSemanticsLabel ?: cancelLabel}' contains " +
            "'${confirmSemanticsLabel ?: confirmLabel}'."
    }
    // An empty message means the title is the whole question; a blank body
    // paragraph under it would read as a missing sentence.
    val body: (@Composable () -> Unit)? = if (message.isEmpty()) null else { { Text(message) } }
    AlertDialog(
        onDismissRequest = onDismiss,
        modifier = modifier.testTag("app-confirm-dialog"),
        title = { Text(title) },
        text = body,
        confirmButton = {
            AppButton(
                text = confirmLabel,
                onClick = onConfirm,
                kind = AppButtonKind.Plain,
                destructive = destructive,
                semanticsLabel = confirmSemanticsLabel,
            )
        },
        dismissButton = {
            AppButton(
                text = cancelLabel,
                onClick = onDismiss,
                kind = AppButtonKind.Plain,
                semanticsLabel = cancelSemanticsLabel,
            )
        },
    )
}

/**
 * States something the reader cannot act on, such as a failure that already
 * happened. One dismissal, no choice to make.
 */
@Composable
fun AppNoticeDialog(
    title: String,
    message: String,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
    dismissLabel: String = "OK",
    dismissSemanticsLabel: String? = null,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        modifier = modifier.testTag("app-notice-dialog"),
        title = { Text(title) },
        text = { Text(message) },
        confirmButton = {
            AppButton(
                text = dismissLabel,
                onClick = onDismiss,
                kind = AppButtonKind.Plain,
                semanticsLabel = dismissSemanticsLabel,
            )
        },
    )
}

/**
 * Presents a panel of choices the reader works through and then applies.
 *
 * A phone gets the bottom sheet; once there is room for one, or when the
 * caller says the content reads better centred, it becomes a dialog instead.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AppSheet(
    onDismissRequest: () -> Unit,
    modifier: Modifier = Modifier,
    maxWidth: Dp = 520.dp,
    preferDialog: Boolean = false,
    content: @Composable ColumnScope.() -> Unit,
) {
    if (preferDialog || !isCompactWidth()) {
        BasicAlertDialog(onDismissRequest = onDismissRequest) {
            Surface(
                modifier = modifier
                    .widthIn(max = maxWidth)
                    .testTag("app-sheet"),
                shape = MaterialTheme.shapes.extraLarge,
                color = appColors.groupedBackground,
            ) {
                Column(Modifier.padding(vertical = 8.dp), content = content)
            }
        }
        return
    }
    ModalBottomSheet(
        onDismissRequest = onDismissRequest,
        modifier = modifier.testTag("app-sheet"),
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = appColors.groupedBackground,
    ) {
        Column(Modifier.fillMaxWidth(), content = content)
    }
}

/** One choice from a short menu of actions. */
data class AppSheetAction<T>(
    val value: T,
    val label: String,
    val icon: ImageVector? = null,
    val destructive: Boolean = false,
)

/**
 * A short menu of actions hung off a control.
 *
 * [onSelected] is called with null when the menu is dismissed, so a menu that
 * can only be left by dragging it away is never a trap when one of its choices
 * is destructive.
 */
@Composable
fun <T> AppActionSheet(
    actions: List<AppSheetAction<T>>,
    onSelected: (T?) -> Unit,
    modifier: Modifier = Modifier,
) {
    AppSheet(onDismissRequest = { onSelected(null) }, modifier = modifier, maxWidth = 360.dp) {
        AppListSection(modifier = Modifier.padding(AppListPadding)) {
            items(actions) { action ->
                AppListTile(
                    title = {
                        Text(
                            text = action.label,
                            color = if (action.destructive) appColors.destructive else Color.Unspecified,
                        )
                    },
                    leading = action.icon?.let {
                        {
                            Icon(
                                imageVector = it,
                                contentDescription = null,
                                tint = if (action.destructive) appColors.destructive else appColors.label,
                            )
                        }
                    },
                    onClick = { onSelected(action.value) },
                )
            }
        }
    }
}

/**
 * The dialogs a screen can raise, held the way `SnackbarHostState` is held.
 *
 * The Flutter app awaits `showAppConfirm(...)` inline, which reads far better
 * than threading a `showDeleteDialog` boolean through a view model for every
 * destructive action. Keeping that shape in Compose means one small state
 * holder that suspends until [AppDialogHost] — which must be composed
 * somewhere above the caller — reports the answer.
 */
@Stable
class AppDialogHostState {

    internal sealed interface Request {
        data class Confirm(
            val title: String,
            val message: String,
            val confirmLabel: String,
            val cancelLabel: String,
            val destructive: Boolean,
            val confirmSemanticsLabel: String?,
            val cancelSemanticsLabel: String?,
            val continuation: CancellableContinuation<Boolean>,
        ) : Request

        data class Notice(
            val title: String,
            val message: String,
            val dismissLabel: String,
            val dismissSemanticsLabel: String?,
            val continuation: CancellableContinuation<Unit>,
        ) : Request
    }

    internal var current: Request? by mutableStateOf(null)
        private set

    // One dialog at a time: two racing confirmations would replace each other
    // on screen and leave the first caller suspended forever.
    private val mutex = Mutex()

    /** Suspends until the reader answers. Dismissal answers false. */
    suspend fun confirm(
        title: String,
        confirmLabel: String,
        message: String = "",
        cancelLabel: String = "Cancel",
        destructive: Boolean = false,
        confirmSemanticsLabel: String? = null,
        cancelSemanticsLabel: String? = null,
    ): Boolean = mutex.withLock {
        suspendCancellableCoroutine { continuation ->
            current = Request.Confirm(
                title = title,
                message = message,
                confirmLabel = confirmLabel,
                cancelLabel = cancelLabel,
                destructive = destructive,
                confirmSemanticsLabel = confirmSemanticsLabel,
                cancelSemanticsLabel = cancelSemanticsLabel,
                continuation = continuation,
            )
            continuation.invokeOnCancellation { current = null }
        }
    }

    /** Suspends until the notice is dismissed. */
    suspend fun notice(
        title: String,
        message: String,
        dismissLabel: String = "OK",
        dismissSemanticsLabel: String? = null,
    ): Unit = mutex.withLock {
        suspendCancellableCoroutine { continuation ->
            current = Request.Notice(
                title = title,
                message = message,
                dismissLabel = dismissLabel,
                dismissSemanticsLabel = dismissSemanticsLabel,
                continuation = continuation,
            )
            continuation.invokeOnCancellation { current = null }
        }
    }

    internal fun answerConfirm(request: Request.Confirm, answer: Boolean) {
        current = null
        if (request.continuation.isActive) request.continuation.resume(answer)
    }

    internal fun answerNotice(request: Request.Notice) {
        current = null
        if (request.continuation.isActive) request.continuation.resume(Unit)
    }
}

/** Remembers an [AppDialogHostState] for the enclosing screen. */
@Composable
fun rememberAppDialogHostState(): AppDialogHostState = remember { AppDialogHostState() }

/**
 * The screen's dialog host, for content too deep to be handed one.
 *
 * Null by default, and deliberately so: a composable that finds no host must
 * raise its own rather than silently skip the question it meant to ask. Provide
 * it beside the [AppDialogHost] that renders it — a host nobody renders suspends
 * its caller forever.
 */
val LocalAppDialogHost = compositionLocalOf<AppDialogHostState?> { null }

/**
 * Renders whatever [state] is currently asking for. Place it once per screen,
 * beside the content it belongs to.
 */
@Composable
fun AppDialogHost(state: AppDialogHostState) {
    when (val request = state.current) {
        null -> Unit
        is AppDialogHostState.Request.Confirm -> AppConfirmDialog(
            title = request.title,
            message = request.message,
            confirmLabel = request.confirmLabel,
            cancelLabel = request.cancelLabel,
            destructive = request.destructive,
            confirmSemanticsLabel = request.confirmSemanticsLabel,
            cancelSemanticsLabel = request.cancelSemanticsLabel,
            onConfirm = { state.answerConfirm(request, true) },
            onDismiss = { state.answerConfirm(request, false) },
        )

        is AppDialogHostState.Request.Notice -> AppNoticeDialog(
            title = request.title,
            message = request.message,
            dismissLabel = request.dismissLabel,
            dismissSemanticsLabel = request.dismissSemanticsLabel,
            onDismiss = { state.answerNotice(request) },
        )
    }
}
