package com.pipod.app.features.settings

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.pipod.app.core.api.model.AuthUser
import com.pipod.app.core.api.model.BillingSummary
import com.pipod.app.core.api.model.ConnectableProvider
import com.pipod.app.core.api.model.PlanChangeAccount
import com.pipod.app.core.api.model.PlanChangeConfirmResult
import com.pipod.app.core.api.model.PlanChangeErrors
import com.pipod.app.core.api.model.PlanChangeQuote
import com.pipod.app.core.api.model.PlanKey
import com.pipod.app.core.api.model.CredentialStatus
import com.pipod.app.core.api.model.ModelCredentialsResponse
import com.pipod.app.core.api.model.Organization
import com.pipod.app.core.api.model.SecretMeta
import com.pipod.app.core.config.RuntimeConfig
import com.pipod.app.core.format.FriendlyError
import com.pipod.app.core.format.SecretName
import com.pipod.app.core.push.NotificationAuthorization
import com.pipod.app.core.push.NotificationSettingsService
import com.pipod.app.core.push.UnavailableNotificationSettings
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * Who is signed in, and the two things only the session can do about it.
 *
 * Ported from `SettingsAccount` in
 * `pi-pod-flutter/lib/features/settings/settings_view.dart`. Everything is a
 * constructor parameter with a default, so a test builds one in three lines.
 */
data class SettingsAccount(
    val user: AuthUser? = null,
    val organization: Organization? = null,
    /** Whether the server would accept a write to the organization defaults. */
    val canManageOrganization: Boolean = false,
    /** Where an administrator manages the organization, when they may open it. */
    val adminConsoleUrl: String? = null,
    /**
     * True when the session rides on a baked development token: signing out
     * would sign straight back in, so the screen explains instead of bouncing
     * to the browser.
     */
    val signOutUnavailable: Boolean = false,
    /**
     * The SaaS account summary from `/v1/me`. Null on the self-hosted static
     * backend, which does not send it — the account card then shows no
     * billing row at all.
     */
    val billing: BillingSummary? = null,
    val setOrganizationAlias: suspend (String) -> Unit = {},
    val signOut: suspend () -> Unit = {},
    val openExternalUrl: UrlOpener = NoUrlOpener,
    val billingAccount: suspend () -> Pair<Boolean, Boolean> = { false to false },
    val createCheckoutSession: suspend (trial: Boolean) -> String = { error("checkout unavailable") },
    val createPortalSession: suspend () -> String = { error("portal unavailable") },
    /**
     * The plan-change account view, or null when the backend has no
     * `/v1/billing` at all (the static edition) — the surface then omits
     * itself rather than erroring.
     */
    val planChangeAccount: suspend () -> PlanChangeAccount? = { null },
    /** A priced quote for [plan]; 404 propagates so the surface can omit itself. */
    val previewPlanChange: suspend (PlanKey) -> PlanChangeQuote = { error("plan-change unavailable") },
    /** Confirms the reviewed quote id. Only the id is ever sent. */
    val confirmPlanChange: suspend (String) -> PlanChangeConfirmResult = { error("plan-change unavailable") },
    /**
     * Re-reads the authoritative account (`/v1/me`) after a confirm or a
     * plan-change error, so pending/cancel truth comes from the server.
     */
    val refreshAccount: suspend () -> Unit = {},
)

/** A provider sign-in the reader has started but not finished. */
data class PendingCredentialLogin(val provider: ConnectableProvider, val authType: String)

/** Everything the settings screen draws. */
data class SettingsState(
    val user: AuthUser? = null,
    val organization: Organization? = null,
    /**
     * The SaaS account summary. Same object as the pods-screen row, same
     * omission rule: null (or nothing renderable) draws nothing.
     */
    val billing: BillingSummary? = null,
    val canManageOrganization: Boolean = false,
    val adminConsoleUrl: String? = null,
    val signOutUnavailable: Boolean = false,
    val canSubscribe: Boolean = false,
    val canManageBilling: Boolean = false,
    val billingActionStatus: SettingsStatus? = null,
    /**
     * The plan-change gate and pending/cancel truth. Null hides the whole
     * surface: the static backend has no `/v1/billing`, and a 404 flag-off
     * answers the same way.
     */
    val planChangeAccount: PlanChangeAccount? = null,
    /** True while the plan picker sheet is up. */
    val planChangePickerOpen: Boolean = false,
    /** The plan being quoted, while a preview is in flight. */
    val planChangeTarget: PlanKey? = null,
    /**
     * The quote under review, or the quote a confirm retry re-sends.
     * Cleared whenever a new preview — and a new consent — is required.
     */
    val planChangeQuote: PlanChangeQuote? = null,
    /**
     * The quote id the reader explicitly consented to by confirming the
     * review. A confirm only ever sends this id; a stale quote clears it so
     * nothing re-sends at a price nobody reviewed.
     */
    val planChangeConsentedQuoteId: String? = null,
    /** True while a preview or a confirm is in flight. */
    val planChangeWorking: Boolean = false,
    val secrets: List<SecretMeta> = emptyList(),
    val unsupportedSecretCount: Int = 0,
    val modelCredentials: ModelCredentialsResponse? = null,
    /** Providers with a test or a delete in flight. */
    val credentialActions: Set<String> = emptySet(),
    /**
     * Per-section load failures. The sections load concurrently and fail
     * independently, so one outage must not hide or clear another's error.
     */
    val sectionErrors: Map<String, String> = emptyMap(),
    val isLoading: Boolean = false,
    /**
     * True once the screen has finished a load. Emptiness is not the same thing:
     * an organization with no secrets at all would otherwise look like a screen
     * that has never loaded, so its pull-to-refresh showed the first-load
     * treatment for ever and never the indicator the gesture is meant to give.
     */
    val hasLoadedOnce: Boolean = false,
    val isSavingSecret: Boolean = false,
    val isSecretFormExpanded: Boolean = false,
    val secretName: String = "",
    val secretValue: String = "",
    val isSwitchingOrganization: Boolean = false,
    val isOrganizationFormExpanded: Boolean = false,
    val organizationAlias: String = "",
    val notificationAuthorization: NotificationAuthorization = NotificationAuthorization.Unknown,
    val notificationRegistrationError: String? = null,
    val credentialStatus: SettingsStatus? = null,
    val secretStatus: SettingsStatus? = null,
    val organizationStatus: SettingsStatus? = null,
    val adminConsoleStatus: SettingsStatus? = null,
    val pendingLogin: PendingCredentialLogin? = null,
    /** Providers offered by the connect sheet, when it is up. */
    val providerChoices: List<ConnectableProvider>? = null,
    /** The provider whose sign-in method is being chosen, when it has two. */
    val authTypeChoice: ConnectableProvider? = null,
) {
    /**
     * A card floating over content that has already rendered reads as a modal
     * block, so the first load says so in the background instead.
     */
    val showsInitialProgress: Boolean get() = isLoading && !hasLoadedOnce

    val notificationPermissionText: String
        get() = when (notificationAuthorization) {
            NotificationAuthorization.NotDetermined -> "Not requested"
            NotificationAuthorization.Denied -> "Off"
            NotificationAuthorization.Authorized -> "Enabled"
            NotificationAuthorization.Provisional -> "Provisional"
            NotificationAuthorization.Ephemeral -> "Temporary"
            NotificationAuthorization.Unknown -> "Unknown — pull to refresh"
        }

    val requestedOrganizationAlias: String get() = organizationAlias.trim()

    val currentOrganizationAlias: String? get() = organization?.alias?.trim()

    val canSwitchOrganization: Boolean
        get() = requestedOrganizationAlias.isNotEmpty() &&
            requestedOrganizationAlias != currentOrganizationAlias &&
            !isSwitchingOrganization

    /** True once the alias field names the organization already signed in to. */
    val organizationAlreadyCurrent: Boolean
        get() = !isSwitchingOrganization &&
            requestedOrganizationAlias.isNotEmpty() &&
            requestedOrganizationAlias == currentOrganizationAlias

    fun provider(providerId: String): ConnectableProvider? =
        modelCredentials?.providers?.firstOrNull { it.id == providerId }

    fun isWorkingOn(providerId: String): Boolean = providerId in credentialActions

    fun sectionError(section: String): String? = sectionErrors[section]
}

/**
 * The settings screen's state machine, ported from `SettingsView` in
 * `pi-pod-flutter/lib/features/settings/settings_view.dart`.
 *
 * Decisions that cannot be undone by looking away stay with the screen, which
 * owns the dialog host; this class exposes what happens *after* the answer.
 */
class SettingsViewModel(
    private val repository: SettingsRepository,
    private val credentials: CredentialsRepository,
    account: SettingsAccount = SettingsAccount(),
    private val notifications: NotificationSettingsService = UnavailableNotificationSettings,
    private val serverHost: String? = RuntimeConfig.serverUrl,
) : ViewModel() {

    private val _state = MutableStateFlow(SettingsState())
    val state: StateFlow<SettingsState> = _state.asStateFlow()

    var account: SettingsAccount = account
        private set

    private var aliasSeeded = false

    init {
        setAccount(account)
        loadAll()
    }

    /**
     * Adopts a newly loaded identity. The alias field is seeded once and then
     * left alone: re-seeding would throw away what somebody is typing every
     * time the session refreshes.
     */
    fun setAccount(account: SettingsAccount) {
        this.account = account
        _state.update {
            it.copy(
                user = account.user,
                organization = account.organization,
                billing = account.billing,
                canManageOrganization = account.canManageOrganization,
                adminConsoleUrl = account.adminConsoleUrl,
                signOutUnavailable = account.signOutUnavailable,
                organizationAlias = if (aliasSeeded) {
                    it.organizationAlias
                } else {
                    account.organization?.alias.orEmpty()
                },
            )
        }
        if (account.organization != null) aliasSeeded = true
    }

    // --- loading ------------------------------------------------------------

    fun loadAll() {
        viewModelScope.launch {
            if (account.user == null) return@launch
            _state.update { it.copy(isLoading = true, sectionErrors = emptyMap()) }
            coroutineScope {
                listOf(
                    async { refreshSecretsNow() },
                    async { refreshModelCredentialsNow() },
                    async { refreshNotificationAuthorizationNow() },
                    async { refreshBillingFlagsNow() },
                ).awaitAll()
            }
            _state.update { it.copy(isLoading = false, hasLoadedOnce = true) }
        }
    }

    fun refreshSecrets() {
        viewModelScope.launch { refreshSecretsNow() }
    }

    fun refreshModelCredentials() {
        viewModelScope.launch { refreshModelCredentialsNow() }
    }

    fun refreshNotificationAuthorization() {
        viewModelScope.launch { refreshNotificationAuthorizationNow() }
    }

    private suspend fun refreshBillingFlagsNow() {
        try {
            val (canSubscribe, canManageBilling) = account.billingAccount()
            val planChange = account.planChangeAccount()
            _state.update {
                it.copy(
                    canSubscribe = canSubscribe,
                    canManageBilling = canManageBilling,
                    planChangeAccount = planChange,
                )
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Throwable) {
            _state.update {
                it.copy(
                    canSubscribe = false,
                    canManageBilling = false,
                    planChangeAccount = null,
                )
            }
        }
    }

    // --- plan change --------------------------------------------------------
    //
    // Gate: `planChangeAccount?.canChangePlan`, and the whole surface omits
    // itself on 404 (flag off, nothing owned) or on the static backend, which
    // has no `/v1/billing`. Preview builds the review; only the reviewed
    // quote id is ever confirmed, after the reader confirms the review, so
    // consent is always per quote. A stale or expired quote needs a new
    // preview and a new consent — never a silent re-send at a new price —
    // while a transport failure (5xx/timeout, quote unknown) retries the same
    // consented id even if its TTL/`expiresAt` passed: the quote stays
    // `applying` server-side and the id makes the retry idempotent. A 402
    // (`card_declined`/`authentication_required`) fails the quote outright —
    // no pending invoice, no hosted payment intent, no Pro — and is never
    // replayed: the card is fixed in the portal and a new preview follows.
    // The current API defines no hosted payment URL, so none is read here.
    // A 200 is `{ applied, ...quote, account }`: the grant is `applied === true`
    // AND the account showing the target — `applied:true` leaving the old plan,
    // or the target plan without `applied:true`, is `plan_change_not_applied`,
    // never success. A missing `applied` never grants. When `canResumePlanChange` is true
    // (`openPlanChange.state==applying`), the client resumes by confirming that
    // same quote id instead of minting a fresh preview — including after
    // process death, where `openPlanChange` is re-read on load. While a quote
    // is applying, a preview is refused with 409 `plan_change_in_flight`
    // `{ quoteId, state }`: the in-flight id is confirmed, never replaced.
    // A 409 never raises the spend cap implicitly. A 409
    // `plan_change_effect_unknown` (`{ quoteId, retryable }`) keeps the
    // consented quote and its id for a same-id retry, exactly like a 5xx —
    // unknown, never stale, never a 402. The account is re-read
    // authoritatively after every confirm and every plan-change error, so
    // pending/cancel truth comes from the server.

    /** Opens the plan picker. Only called when the gate is showing. */
    fun openPlanChangePicker() = _state.update {
        it.copy(planChangePickerOpen = true, planChangeTarget = null)
    }

    /** Closes the picker and drops any unconsented quote with it. */
    fun dismissPlanChange() = _state.update {
        it.copy(
            planChangePickerOpen = false,
            planChangeTarget = null,
            // An unreviewed or unconfirmed quote is not consent: dropping it
            // means a later change always starts from a fresh preview.
            planChangeQuote = if (it.planChangeConsentedQuoteId == null) null else it.planChangeQuote,
        )
    }

    /** Closes the review without confirming. Consent was never given. */
    fun dismissPlanChangeReview() = _state.update {
        it.copy(planChangeQuote = null, planChangeConsentedQuoteId = null)
    }

    /** Previews [plan]: the review the reader consents to before anything is charged. */
    fun previewPlanChange(plan: PlanKey) {
        if (_state.value.planChangeWorking) return
        if (_state.value.planChangeAccount?.canResume == true) {
            // An applying quote owns the flow: confirming its id is the only
            // way forward, never a fresh preview at a fresh price.
            _state.update {
                it.copy(
                    billingActionStatus = SettingsStatus(
                        text = PlanChangeErrors.IN_FLIGHT_COPY,
                        isError = true,
                    ),
                )
            }
            return
        }
        viewModelScope.launch {
            _state.update {
                it.copy(
                    planChangePickerOpen = false,
                    planChangeTarget = plan,
                    planChangeQuote = null,
                    planChangeConsentedQuoteId = null,
                    planChangeWorking = true,
                    billingActionStatus = SettingsStatus(
                        text = "Getting a quote for ${plan.displayName}…",
                        isError = false,
                    ),
                )
            }
            try {
                val quote = account.previewPlanChange(plan)
                _state.update {
                    it.copy(
                        planChangeQuote = quote,
                        planChangeWorking = false,
                        // The review itself is the news; the status line retires.
                        billingActionStatus = null,
                    )
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                val api = error as? com.pipod.app.core.api.model.ApiError
                // A 409 `plan_change_in_flight` while applying: truth is
                // re-read so the resume control points at the in-flight id.
                val truth = if (api != null && PlanChangeErrors.isInFlight(api)) {
                    refreshPlanChangeTruth()
                } else {
                    null
                }
                _state.update { current ->
                    if (api != null && PlanChangeErrors.isNotFound(api)) {
                        // Flag off or nothing owned: omit the surface, not an error.
                        current.copy(
                            planChangeTarget = null,
                            planChangeWorking = false,
                            planChangeAccount = null,
                            billingActionStatus = null,
                        )
                    } else {
                        current.copy(
                            planChangeTarget = null,
                            planChangeWorking = false,
                            planChangeAccount = truth ?: current.planChangeAccount,
                            billingActionStatus = SettingsStatus(
                                text = planChangeMessage(error),
                                isError = true,
                            ),
                        )
                    }
                }
            }
        }
    }

    /**
     * Confirms the quote under review. The reader confirming the review is
     * the explicit consent, and only that quote id is ever sent.
     */
    fun confirmPlanChange() {
        val quote = _state.value.planChangeQuote ?: return
        if (_state.value.planChangeWorking) return
        viewModelScope.launch {
            _state.update {
                it.copy(
                    planChangeConsentedQuoteId = quote.quoteId,
                    planChangeWorking = true,
                    billingActionStatus = null,
                )
            }
            confirmPlanChangeNow(quote.quoteId, quote.targetPlan)
        }
    }

    /**
     * Retries the consented quote after a transport failure. Same quote id:
     * nothing was re-priced, so no new consent is needed.
     */
    fun retryPlanChangeConfirm() {
        if (_state.value.planChangeWorking) return
        val quoteId = _state.value.planChangeConsentedQuoteId ?: return
        val target = _state.value.planChangeQuote?.targetPlan
            ?.takeIf { _state.value.planChangeQuote?.quoteId == quoteId }
            ?: return
        viewModelScope.launch {
            _state.update { it.copy(planChangeWorking = true, billingActionStatus = null) }
            confirmPlanChangeNow(quoteId, target)
        }
    }

    /**
     * Resumes the authoritative open quote: confirms `openPlanChange`'s id
     * when `canResumePlanChange` is true (`openPlanChange.state==applying`),
     * instead of minting a fresh preview.
     *
     * This is the restart path — `openPlanChange` is re-read on load, so a
     * confirm lost to process death resumes here with the same id — and the
     * path when `canChangePlan` is false because a quote is applying.
     */
    fun resumePlanChangeConfirm() {
        if (_state.value.planChangeWorking) return
        val account = _state.value.planChangeAccount ?: return
        val open = account.openPlanChange ?: return
        if (!account.canResume) return
        viewModelScope.launch {
            _state.update {
                it.copy(
                    planChangeConsentedQuoteId = open.quoteId,
                    planChangeWorking = true,
                    billingActionStatus = null,
                )
            }
            confirmPlanChangeNow(open.quoteId, open.targetPlan)
        }
    }

    private suspend fun confirmPlanChangeNow(quoteId: String, target: PlanKey?) {
        try {
            val result = account.confirmPlanChange(quoteId)
            val account = refreshPlanChangeTruth()
            // The confirm echoes the quote, so a resume without a parsed
            // target still assesses against the target the server confirmed.
            // The grant is `applied === true` AND the account corroborating it
            // (confirm's account, falling back to the refreshed truth): either
            // signal alone — `applied:true` leaving the old plan, or the target
            // plan without `applied:true` — is `plan_change_not_applied`.
            val effectiveTarget = target ?: result.quote?.targetPlan
            val applied = result.applied &&
                (effectiveTarget?.let { (result.account ?: account)?.isApplied(it) } == true)
            _state.update {
                it.copy(
                    planChangeWorking = false,
                    planChangeQuote = null,
                    planChangeConsentedQuoteId = null,
                    billingActionStatus = SettingsStatus(
                        text = if (applied) {
                            if (effectiveTarget == PlanKey.Standard) {
                                "Plan change scheduled. It takes effect at the end of the current period."
                            } else {
                                "Plan change confirmed. Your account shows the new plan."
                            }
                        } else {
                            // 200 yet still on the old plan: not applied, no Pro.
                            PlanChangeErrors.NOT_APPLIED_COPY
                        },
                        isError = !applied,
                    ),
                )
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Throwable) {
            onPlanChangeConfirmError(error)
        }
    }

    private suspend fun onPlanChangeConfirmError(error: Throwable) {
        val api = error as? com.pipod.app.core.api.model.ApiError
        // Pending/cancel truth is authoritative: re-read even on failure.
        val truth = refreshPlanChangeTruth()
        _state.update { current ->
            when {
                api != null && PlanChangeErrors.isNotFound(api) ->
                    current.copy(
                        planChangeWorking = false,
                        planChangeQuote = null,
                        planChangeConsentedQuoteId = null,
                        planChangeAccount = null,
                    )
                api != null && PlanChangeErrors.isStale(api) ->
                    // A new preview and a new consent are required: the price
                    // may have changed, so the old quote — and its consent —
                    // are dropped rather than re-sent.
                    current.copy(
                        planChangeWorking = false,
                        planChangeQuote = null,
                        planChangeConsentedQuoteId = null,
                        planChangeAccount = truth ?: current.planChangeAccount,
                        billingActionStatus = SettingsStatus(
                            text = PlanChangeErrors.message(api)
                                ?: planChangeMessage(error),
                            isError = true,
                        ),
                    )
                api != null && PlanChangeErrors.isPaymentRequired(api) ->
                    // 402 (`card_declined`/`authentication_required`) fails
                    // the quote: no pending invoice, no hosted payment
                    // intent, no Pro — the current API defines no hosted
                    // payment URL. The review closes and the failed id is
                    // dropped so it can never be replayed: the card is fixed
                    // in the portal and a new preview follows.
                    current.copy(
                        planChangeWorking = false,
                        planChangeQuote = null,
                        planChangeConsentedQuoteId = null,
                        planChangeAccount = truth ?: current.planChangeAccount,
                        billingActionStatus = SettingsStatus(
                            text = PlanChangeErrors.message(api)
                                ?: planChangeMessage(error),
                            isError = true,
                        ),
                    )
                api != null && PlanChangeErrors.isCapBelowBase(api) ->
                    // No implicit cap raise: say so and leave the cap alone.
                    // A new preview follows raising the cap, so the refused
                    // quote — and its consent — are dropped with it.
                    current.copy(
                        planChangeWorking = false,
                        planChangeQuote = null,
                        planChangeConsentedQuoteId = null,
                        planChangeAccount = truth ?: current.planChangeAccount,
                        billingActionStatus = SettingsStatus(
                            text = PlanChangeErrors.message(api)
                                ?: planChangeMessage(error),
                            isError = true,
                        ),
                    )
                api != null && PlanChangeErrors.isEffectUnknown(api) ->
                    // 409 `plan_change_effect_unknown`: the confirm may or may
                    // not have applied — unknown, never stale, never a 402
                    // (`detail.retryable` notwithstanding). The consented quote
                    // and its id are kept for a same-id retry exactly like a
                    // 5xx: the id makes the retry idempotent and the refreshed
                    // account stays the truth. Never a grant by itself, never a
                    // fresh preview (which could double-apply).
                    current.copy(
                        planChangeWorking = false,
                        planChangeAccount = truth ?: current.planChangeAccount,
                        billingActionStatus = SettingsStatus(
                            text = PlanChangeErrors.message(api)
                                ?: planChangeMessage(error),
                            isError = true,
                        ),
                    )
                api != null && PlanChangeErrors.codeOf(api) != null ->
                    current.copy(
                        planChangeWorking = false,
                        planChangeAccount = truth ?: current.planChangeAccount,
                        billingActionStatus = SettingsStatus(
                            text = PlanChangeErrors.message(api)
                                ?: planChangeMessage(error),
                            isError = true,
                        ),
                    )
                isConfirmRetryable(error) ->
                    // Same consented quote id is kept for the retry; the
                    // review stays up so the retry re-sends exactly what was
                    // consented to, even if its TTL/`expiresAt` passed — the
                    // quote stays `applying` server-side, so expiry never
                    // invalidates an applying retry. A 5xx is ambiguous — it
                    // may have applied before failing — but the id makes the
                    // retry idempotent and the refreshed account stays the
                    // truth either way. Never a grant by itself.
                    current.copy(
                        planChangeWorking = false,
                        planChangeAccount = truth ?: current.planChangeAccount,
                        billingActionStatus = SettingsStatus(
                            text = "The confirmation couldn't be sent. " +
                                "Try again — it retries the same quote.",
                            isError = true,
                        ),
                    )
                else ->
                    current.copy(
                        planChangeWorking = false,
                        planChangeQuote = null,
                        planChangeConsentedQuoteId = null,
                        planChangeAccount = truth ?: current.planChangeAccount,
                        billingActionStatus = SettingsStatus(
                            text = planChangeMessage(error),
                            isError = true,
                        ),
                    )
            }
        }
    }

    /**
     * Re-reads the authoritative account after a confirm or a plan-change
     * error. `/v1/me` is the source of truth (a 402 leaves it un-granted);
     * the flags follow. Never throws: truth refresh must not mask the result
     * it follows.
     */
    private suspend fun refreshPlanChangeTruth(): PlanChangeAccount? {
        return try {
            runCatching { account.refreshAccount() }.getOrNull()
            val (canSubscribe, canManageBilling) = account.billingAccount()
            val planChange = account.planChangeAccount()
            _state.update {
                it.copy(
                    canSubscribe = canSubscribe,
                    canManageBilling = canManageBilling,
                    planChangeAccount = planChange,
                )
            }
            planChange
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Throwable) {
            null
        }
    }

    private fun planChangeMessage(error: Throwable): String {
        (error as? com.pipod.app.core.api.model.ApiError)?.let { api ->
            PlanChangeErrors.message(api)?.let { return it }
        }
        return FriendlyError.message(error, serverHost)
    }

    private fun isConfirmRetryable(error: Throwable): Boolean {
        val api = error as? com.pipod.app.core.api.model.ApiError ?: return true
        val status = api.transportStatus ?: return true
        return status >= 500
    }

    fun startCheckout(paid: Boolean) {
        viewModelScope.launch {
            _state.update { it.copy(billingActionStatus = null) }
            try {
                val url = account.createCheckoutSession(!paid)
                if (!url.startsWith("https://")) {
                    _state.update {
                        it.copy(
                            billingActionStatus = SettingsStatus(
                                text = "Checkout did not return a usable URL.",
                                isError = true,
                            ),
                        )
                    }
                    return@launch
                }
                account.openExternalUrl.open(url)
                _state.update {
                    it.copy(
                        billingActionStatus = SettingsStatus(
                            text = "Return pages do not grant a plan; the server is the source of truth.",
                            isError = false,
                        ),
                    )
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                _state.update {
                    it.copy(
                        billingActionStatus = SettingsStatus(
                            text = FriendlyError.message(error, serverHost),
                            isError = true,
                        ),
                    )
                }
            }
        }
    }

    fun openPortal() {
        viewModelScope.launch {
            _state.update { it.copy(billingActionStatus = null) }
            try {
                val url = account.createPortalSession()
                if (!url.startsWith("https://")) {
                    _state.update {
                        it.copy(
                            billingActionStatus = SettingsStatus(
                                text = "Portal did not return a usable URL.",
                                isError = true,
                            ),
                        )
                    }
                    return@launch
                }
                account.openExternalUrl.open(url)
                _state.update {
                    it.copy(
                        billingActionStatus = SettingsStatus(
                            text = "Return pages do not grant a plan; the server is the source of truth.",
                            isError = false,
                        ),
                    )
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                _state.update {
                    it.copy(
                        billingActionStatus = SettingsStatus(
                            text = FriendlyError.message(error, serverHost),
                            isError = true,
                        ),
                    )
                }
            }
        }
    }

    private suspend fun refreshSecretsNow() {
        val userId = account.user?.id ?: return
        try {
            val values = repository.secrets(userId)
            _state.update {
                it.copy(secrets = values.items, unsupportedSecretCount = values.unparsedRows.size)
            }
            clearSectionError(SECRETS)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Throwable) {
            setSectionError(SECRETS, error)
        }
    }

    private suspend fun refreshModelCredentialsNow() {
        try {
            _state.update { it.copy(modelCredentials = credentials.modelCredentials()) }
            clearSectionError(PROVIDERS)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Throwable) {
            setSectionError(PROVIDERS, error)
        }
    }

    private suspend fun refreshNotificationAuthorizationNow() {
        try {
            val authorization = notifications.refresh()
            _state.update {
                it.copy(
                    notificationAuthorization = authorization,
                    notificationRegistrationError = notifications.registrationError,
                )
            }
            clearSectionError(NOTIFICATIONS)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Throwable) {
            setSectionError(NOTIFICATIONS, error)
        }
    }

    private fun setSectionError(section: String, error: Throwable) {
        val message = "Some settings could not be loaded: " +
            FriendlyError.message(error, serverHost)
        _state.update { it.copy(sectionErrors = it.sectionErrors + (section to message)) }
    }

    private fun clearSectionError(section: String) {
        _state.update { it.copy(sectionErrors = it.sectionErrors - section) }
    }

    // --- secrets ------------------------------------------------------------

    fun onSecretNameChange(value: String) = _state.update { it.copy(secretName = value) }

    fun onSecretValueChange(value: String) = _state.update { it.copy(secretValue = value) }

    fun showSecretForm() = _state.update {
        it.copy(
            secretName = "",
            secretValue = "",
            isSecretFormExpanded = true,
            secretStatus = null,
        )
    }

    fun cancelSecretForm() = _state.update {
        it.copy(secretName = "", secretValue = "", isSecretFormExpanded = false)
    }

    fun saveSecret() {
        viewModelScope.launch {
            val userId = account.user?.id ?: return@launch
            val current = _state.value
            val name = SecretName.normalized(current.secretName)
            val value = current.secretValue.trim()
            if (name.isEmpty() || value.isEmpty()) return@launch

            _state.update { it.copy(isSavingSecret = true, secretStatus = null) }
            try {
                repository.putSecret(userId = userId, name = name, value = value)
                _state.update {
                    it.copy(
                        secretName = "",
                        secretValue = "",
                        isSecretFormExpanded = false,
                        secretStatus = SettingsStatus(
                            text = "Secret saved. Its value can never be read back.",
                            isError = false,
                        ),
                    )
                }
                refreshSecretsNow()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                _state.update {
                    it.copy(
                        secretStatus = SettingsStatus(
                            text = FriendlyError.message(error, serverHost),
                            isError = true,
                        ),
                    )
                }
            } finally {
                _state.update { it.copy(isSavingSecret = false) }
            }
        }
    }

    /** Called after the reader has confirmed; the value cannot be recovered. */
    fun deleteSecret(secret: SecretMeta) {
        viewModelScope.launch {
            val userId = account.user?.id ?: return@launch
            _state.update { it.copy(secretStatus = null) }
            try {
                repository.deleteSecret(userId = userId, name = secret.name)
                _state.update { current ->
                    current.copy(
                        secrets = current.secrets.filterNot { it.id == secret.id },
                        secretStatus = SettingsStatus("${secret.name} deleted.", isError = false),
                    )
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                _state.update {
                    it.copy(
                        secretStatus = SettingsStatus(
                            text = "Could not delete ${secret.name}: " +
                                FriendlyError.message(error, serverHost),
                            isError = true,
                        ),
                    )
                }
            }
        }
    }

    // --- model credentials --------------------------------------------------

    /** Offers the providers this account could still connect. */
    fun connectProvider() {
        val response = _state.value.modelCredentials ?: return
        val stored = response.credentials.map { it.providerId }.toSet()
        val providers = response.providers.filter { it.brokerSupported && it.id !in stored }
        if (providers.isEmpty()) {
            _state.update {
                it.copy(
                    credentialStatus = SettingsStatus(
                        text = "Every supported model provider is already connected.",
                        isError = false,
                    ),
                )
            }
            return
        }
        _state.update { it.copy(providerChoices = providers) }
    }

    fun dismissProviderChoices() = _state.update { it.copy(providerChoices = null) }

    fun dismissAuthTypeChoice() = _state.update { it.copy(authTypeChoice = null) }

    /**
     * Starts a sign-in, asking which method first when the provider supports
     * both. A provider that supports neither has nothing to start.
     */
    fun login(provider: ConnectableProvider) {
        _state.update { it.copy(providerChoices = null, authTypeChoice = null) }
        val authType = when {
            provider.hasOauth && provider.apiKey -> {
                _state.update { it.copy(authTypeChoice = provider) }
                return
            }

            provider.hasOauth -> "oauth"
            provider.apiKey -> "api_key"
            else -> return
        }
        _state.update { it.copy(pendingLogin = PendingCredentialLogin(provider, authType)) }
    }

    fun loginWith(provider: ConnectableProvider, authType: String) = _state.update {
        it.copy(
            authTypeChoice = null,
            providerChoices = null,
            pendingLogin = PendingCredentialLogin(provider, authType),
        )
    }

    fun dismissLogin() = _state.update { it.copy(pendingLogin = null) }

    /**
     * A sign-in finished. The status the socket handed back is not written into
     * the list directly: a full re-read is one round trip and keeps every
     * provider's health from the same moment, rather than one fresh row beside
     * stale ones.
     */
    fun onCredentialConnected(@Suppress("UNUSED_PARAMETER") status: CredentialStatus) {
        val provider = _state.value.pendingLogin?.provider ?: return
        _state.update { it.copy(pendingLogin = null) }
        viewModelScope.launch {
            refreshModelCredentialsNow()
            _state.update {
                it.copy(
                    credentialStatus = SettingsStatus(
                        text = "${provider.name} connected.",
                        isError = false,
                    ),
                )
            }
        }
    }

    fun testCredential(credential: CredentialStatus) {
        viewModelScope.launch {
            val providerId = credential.providerId
            val name = _state.value.provider(providerId)?.name ?: providerId
            _state.update {
                it.copy(credentialActions = it.credentialActions + providerId, credentialStatus = null)
            }
            try {
                val status = credentials.test(providerId)
                _state.update { current ->
                    val response = current.modelCredentials ?: return@update current
                    current.copy(
                        modelCredentials = ModelCredentialsResponse(
                            credentials = response.credentials.map {
                                if (it.providerId == providerId) status else it
                            },
                            providers = response.providers,
                        ),
                        credentialStatus = SettingsStatus(
                            text = "$name sign-in is ${credentialStateLabel(status).lowercase()}.",
                            isError = status.state != "ready",
                        ),
                    )
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                _state.update {
                    it.copy(
                        credentialStatus = SettingsStatus(
                            text = FriendlyError.message(error, serverHost),
                            isError = true,
                        ),
                    )
                }
            } finally {
                _state.update { it.copy(credentialActions = it.credentialActions - providerId) }
            }
        }
    }

    /** Called after the reader has confirmed. Pods using it will need a reconnect. */
    fun removeCredential(credential: CredentialStatus) {
        viewModelScope.launch {
            val providerId = credential.providerId
            val name = _state.value.provider(providerId)?.name ?: providerId
            _state.update {
                it.copy(credentialActions = it.credentialActions + providerId, credentialStatus = null)
            }
            try {
                credentials.remove(providerId)
                refreshModelCredentialsNow()
                _state.update {
                    it.copy(
                        credentialStatus = SettingsStatus(
                            text = "$name sign-in deleted.",
                            isError = false,
                        ),
                    )
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                _state.update {
                    it.copy(
                        credentialStatus = SettingsStatus(
                            text = FriendlyError.message(error, serverHost),
                            isError = true,
                        ),
                    )
                }
            } finally {
                _state.update { it.copy(credentialActions = it.credentialActions - providerId) }
            }
        }
    }

    // --- organization -------------------------------------------------------

    fun onOrganizationAliasChange(value: String) {
        aliasSeeded = true
        _state.update { it.copy(organizationAlias = value) }
    }

    fun toggleOrganizationForm() = _state.update {
        it.copy(isOrganizationFormExpanded = !it.isOrganizationFormExpanded)
    }

    fun switchOrganization() {
        viewModelScope.launch {
            val current = _state.value
            if (!current.canSwitchOrganization) return@launch
            _state.update { it.copy(isSwitchingOrganization = true, organizationStatus = null) }
            try {
                account.setOrganizationAlias(current.requestedOrganizationAlias)
                _state.update {
                    it.copy(
                        organizationStatus = SettingsStatus(
                            text = "Organization authorization updated.",
                            isError = false,
                        ),
                    )
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                _state.update {
                    it.copy(
                        organizationStatus = SettingsStatus(
                            text = FriendlyError.message(error, serverHost),
                            isError = true,
                        ),
                    )
                }
            } finally {
                _state.update { it.copy(isSwitchingOrganization = false) }
            }
        }
    }

    fun openAdminConsole() {
        viewModelScope.launch {
            val url = _state.value.adminConsoleUrl?.takeIf { it.isNotEmpty() } ?: return@launch
            _state.update { it.copy(adminConsoleStatus = null) }
            if (account.openExternalUrl.open(url)) return@launch
            _state.update {
                it.copy(
                    adminConsoleStatus = SettingsStatus(
                        text = "Could not open the admin console. Visit $url in a browser.",
                        isError = true,
                    ),
                )
            }
        }
    }

    /**
     * Called after the reader has confirmed. There is no parting toast: the
     * sign-in screen appearing is the confirmation, and painting one first
     * risks writing on a tree the auth gate is about to replace.
     */
    fun signOut() {
        viewModelScope.launch { account.signOut() }
    }

    // --- notifications ------------------------------------------------------

    fun requestNotifications() {
        viewModelScope.launch {
            val status = notifications.requestAndRegister()
            _state.update {
                it.copy(
                    notificationAuthorization = status,
                    notificationRegistrationError = notifications.registrationError,
                )
            }
        }
    }

    fun openNotificationSettings() {
        viewModelScope.launch { notifications.openSystemSettings() }
    }

    companion object {
        const val NOTIFICATIONS = "notifications"
        const val PROVIDERS = "providers"
        const val SECRETS = "secrets"

        /** The server's credential states, in the words the reader sees. */
        fun credentialStateLabel(status: CredentialStatus): String = when (status.state) {
            "ready" -> "Ready"
            "reconnect_required" -> "Reconnect required"
            "temporarily_unavailable" -> "Temporarily unavailable"
            else -> status.state
        }
    }
}
