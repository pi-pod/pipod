package com.pipod.app.features.settings

import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.pipod.app.core.api.model.PlanKey
import com.pipod.app.ui.AppActionSheet
import com.pipod.app.ui.AppActivityIndicator
import com.pipod.app.ui.AppButton
import com.pipod.app.ui.AppButtonKind
import com.pipod.app.ui.AppConfirmDialog
import com.pipod.app.ui.AppSheetAction
import com.pipod.app.ui.theme.appColors

/**
 * The plan-change surface inside the account card.
 *
 * Gated on `planChangeAccount?.canChangePlan`; the whole block — button,
 * pending truth and all — omits itself otherwise. The static backend has no
 * `/v1/billing` and a flag-off server 404s, both of which read as a null
 * account, so omission is the normal case, not an error.
 *
 * Pending/cancel truth rides the same account object: a scheduled change or a
 * scheduled cancellation is said here, in the server's own words, rather than
 * left for the next invoice to explain. When `canResumePlanChange` is true
 * (`openPlanChange.state==applying`), a resume control confirms that same quote
 * id instead of starting a new preview — including after process death.
 */
@Composable
fun PlanChangeAccountContent(state: SettingsState, actions: SettingsActions) {
    val account = state.planChangeAccount

    account?.pendingLine?.let { pending ->
        Spacer(Modifier.height(4.dp))
        Text(
            text = pending,
            style = MaterialTheme.typography.bodySmall,
            color = appColors.secondaryLabel,
            modifier = Modifier
                .fillMaxWidth()
                .testTag(PlanChangeTestTags.PENDING)
                .semantics {
                    contentDescription = "Pending plan change, $pending"
                    liveRegion = LiveRegionMode.Polite
                },
        )
    }
    account?.cancelLine?.let { cancel ->
        Spacer(Modifier.height(4.dp))
        Text(
            text = cancel,
            style = MaterialTheme.typography.bodySmall,
            color = appColors.secondaryLabel,
            modifier = Modifier
                .fillMaxWidth()
                .testTag(PlanChangeTestTags.CANCEL)
                .semantics {
                    contentDescription = "Subscription schedule, $cancel"
                    liveRegion = LiveRegionMode.Polite
                },
        )
    }

    // An applying open quote owns the flow even when the gate is closed:
    // resuming confirms its id, never a fresh preview.
    if (account?.canResume == true &&
        account.openPlanChange != null &&
        state.planChangeQuote == null &&
        !state.planChangeWorking
    ) {
        Spacer(Modifier.height(4.dp))
        AppButton(
            text = "Continue plan change",
            onClick = actions.onResumePlanChangeConfirm,
            modifier = Modifier.testTag(PlanChangeTestTags.RESUME),
            kind = AppButtonKind.Plain,
            semanticsLabel = "Continue the in-progress plan change",
        )
    }

    if (account?.canChangePlan != true) return

    Spacer(Modifier.height(4.dp))
    AppButton(
        onClick = actions.onOpenPlanChangePicker,
        modifier = Modifier
            .fillMaxWidth()
            .testTag(PlanChangeTestTags.CHANGE_PLAN),
        kind = AppButtonKind.Plain,
        enabled = !state.planChangeWorking,
        semanticsLabel = "Change plan",
    ) {
        if (state.planChangeWorking && state.planChangeQuote == null) {
            AppActivityIndicator(size = 18.dp)
        } else {
            Text("Change plan")
        }
    }

    // A transport failure keeps the consented quote for a same-id retry; the
    // retry is offered beside the error line it explains.
    if (state.planChangeConsentedQuoteId != null &&
        state.planChangeQuote != null &&
        !state.planChangeWorking
    ) {
        Spacer(Modifier.height(4.dp))
        AppButton(
            text = "Try again",
            onClick = actions.onRetryPlanChangeConfirm,
            modifier = Modifier.testTag(PlanChangeTestTags.RETRY_CONFIRM),
            kind = AppButtonKind.Plain,
            semanticsLabel = "Retry the plan change confirmation",
        )
    }
}

/**
 * The picker and the review, above the settings list.
 *
 * The picker offers the plans beside the current one; the review shows the
 * quote — due now, timing, and (for a scheduled change only) what follows —
 * and confirming it is the explicit per-quote consent. Only the reviewed
 * quote id is ever confirmed.
 */
@Composable
fun PlanChangeDialogs(state: SettingsState, actions: SettingsActions) {
    if (state.planChangePickerOpen) {
        val options = PlanKey.optionsBesides(state.planChangeAccount?.currentPlanKey)
        AppActionSheet(
            actions = options.map { plan ->
                AppSheetAction(value = plan, label = "Change to ${plan.displayName}")
            },
            onSelected = { plan ->
                if (plan == null) actions.onDismissPlanChange() else actions.onPlanChangePreview(plan)
            },
        )
    }

    state.planChangeQuote?.let { quote ->
        AppConfirmDialog(
            title = quote.reviewTitle,
            message = quote.reviewLines().joinToString("\n"),
            confirmLabel = quote.confirmLabel,
            onConfirm = actions.onConfirmPlanChange,
            onDismiss = actions.onDismissPlanChangeReview,
            confirmSemanticsLabel = "Confirm change to ${quote.targetPlan.displayName} at the quoted price",
            cancelSemanticsLabel = "Cancel the plan change review",
        )
    }
}

/** The handles a UI test finds the plan-change surface by — and asserts the absence of. */
object PlanChangeTestTags {
    const val CHANGE_PLAN = "settings-change-plan"
    const val PENDING = "settings-plan-pending"
    const val CANCEL = "settings-plan-cancel"
    const val RESUME = "settings-plan-resume"
    const val RETRY_CONFIRM = "settings-plan-retry"
}
