package com.pipod.app.features.settings

import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.pipod.app.core.api.model.ConnectableProvider
import com.pipod.app.core.api.model.CredentialStatus
import com.pipod.app.core.api.model.PlanKey
import com.pipod.app.core.api.model.SecretMeta
import com.pipod.app.core.api.model.SettingsProposal
import com.pipod.app.core.config.RuntimeConfig
import com.pipod.app.core.format.Format
import com.pipod.app.core.push.NotificationAuthorization
import com.pipod.app.features.common.AdaptiveRefreshButton
import com.pipod.app.features.common.SecretEntryFields
import com.pipod.app.features.common.billingAlertColor
import com.pipod.app.features.common.UnsupportedListItemCard
import com.pipod.app.ui.AppActivityIndicator
import com.pipod.app.ui.AppActionSheet
import com.pipod.app.ui.AppButton
import com.pipod.app.ui.AppButtonContent
import com.pipod.app.ui.AppButtonDefaults
import com.pipod.app.ui.AppButtonKind
import com.pipod.app.ui.AppDialogHost
import com.pipod.app.ui.AppDialogHostState
import com.pipod.app.ui.AppIconButton
import com.pipod.app.ui.AppIcons
import com.pipod.app.ui.AppListScaffold
import com.pipod.app.ui.AppListTile
import com.pipod.app.ui.AppProgressBar
import com.pipod.app.ui.AppSeparator
import com.pipod.app.ui.AppSheetAction
import com.pipod.app.ui.AppTextField
import com.pipod.app.ui.rememberAppDialogHostState
import com.pipod.app.ui.rememberAppToastHostState
import com.pipod.app.ui.theme.MonospaceTextStyle
import com.pipod.app.ui.theme.appColors
import kotlinx.coroutines.launch

/**
 * Everything the settings screen can be asked to do.
 *
 * Grouped rather than spread across two dozen parameters: the screen has one of
 * almost every kind of control on it, and a positional argument list that long
 * is a place for a mistake nobody would notice.
 *
 * The three destructive callbacks — [onDeleteSecret], [onRemoveCredential] and
 * [onSignOut] — are invoked only after the reader has confirmed.
 */
@Immutable
class SettingsActions(
    val onRefresh: () -> Unit = {},
    val onRetrySection: (String) -> Unit = {},
    val onOpenProposal: (SettingsProposal) -> Unit = {},
    val onToggleOrganizationForm: () -> Unit = {},
    val onOrganizationAliasChange: (String) -> Unit = {},
    val onSwitchOrganization: () -> Unit = {},
    val onOpenAdminConsole: () -> Unit = {},
    val onStartTrial: () -> Unit = {},
    val onSubscribe: () -> Unit = {},
    val onManageBilling: () -> Unit = {},
    val onOpenPlanChangePicker: () -> Unit = {},
    val onDismissPlanChange: () -> Unit = {},
    val onPlanChangePreview: (PlanKey) -> Unit = {},
    val onDismissPlanChangeReview: () -> Unit = {},
    val onConfirmPlanChange: () -> Unit = {},
    val onRetryPlanChangeConfirm: () -> Unit = {},
    val onResumePlanChangeConfirm: () -> Unit = {},
    val onSignOut: () -> Unit = {},
    val onConnectProvider: () -> Unit = {},
    val onProviderChosen: (ConnectableProvider) -> Unit = {},
    val onProviderChoicesDismissed: () -> Unit = {},
    val onAuthTypeChosen: (ConnectableProvider, String) -> Unit = { _, _ -> },
    val onAuthTypeDismissed: () -> Unit = {},
    val onReconnect: (ConnectableProvider) -> Unit = {},
    val onTestCredential: (CredentialStatus) -> Unit = {},
    val onRemoveCredential: (CredentialStatus) -> Unit = {},
    val onShowSecretForm: () -> Unit = {},
    val onCancelSecretForm: () -> Unit = {},
    val onSecretNameChange: (String) -> Unit = {},
    val onSecretValueChange: (String) -> Unit = {},
    val onSaveSecret: () -> Unit = {},
    val onDeleteSecret: (SecretMeta) -> Unit = {},
    val onOpenEnvironments: () -> Unit = {},
    val onRequestNotifications: () -> Unit = {},
    val onOpenNotificationSettings: () -> Unit = {},
)

/**
 * The settings screen, wired to its view model.
 *
 * Port of `SettingsView` in
 * `pi-pod-flutter/lib/features/settings/settings_view.dart`.
 *
 * [repository] is taken alongside the view model because two of this screen's
 * parts own their own state: the config bundle editors, which load on demand,
 * and the proposal detail, which is a screen in its own right shown in place of
 * this one.
 */
@Composable
fun SettingsScreen(
    viewModel: SettingsViewModel,
    repository: SettingsRepository,
    socketFactory: LoginSocketFactory,
    onOpenEnvironments: () -> Unit,
    modifier: Modifier = Modifier,
    openUrl: UrlOpener = NoUrlOpener,
    serverHost: String? = RuntimeConfig.serverUrl,
    dialogs: AppDialogHostState = rememberAppDialogHostState(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    // The editors are remembered before the proposal branch below, so reviewing
    // a proposal and coming back does not throw away unsaved bundle edits the
    // way dropping their slots would.
    val organizationBundle = state.organization?.let { organization ->
        rememberConfigBundleEditor(
            subject = "organization config bundle",
            description = "Config, setup script and bake script shared by every pod in the " +
                "organization.",
            // Keyed on the organization, so switching one does not leave the
            // previous organization's text — and its version — in the editor.
            layerId = organization.id,
            load = { repository.orgSettings(organization.id) },
            save = { config, initScript, bakeScript, version ->
                repository.saveOrgSettings(
                    orgId = organization.id,
                    config = config,
                    initScript = initScript,
                    bakeScript = bakeScript,
                    version = version,
                )
            },
            serverHost = serverHost,
        )
    }

    val userBundle = state.user?.let { user ->
        rememberConfigBundleEditor(
            subject = "user config bundle",
            description = "Your own config, setup script and bake script.",
            layerId = user.id,
            load = { repository.userSettings(user.id) },
            save = { config, initScript, bakeScript, version ->
                repository.saveUserSettings(
                    userId = user.id,
                    config = config,
                    initScript = initScript,
                    bakeScript = bakeScript,
                    version = version,
                )
            },
            serverHost = serverHost,
        )
    }

    val openProposal = state.openProposal
    if (openProposal != null) {
        val scope = rememberCoroutineScope()
        BackHandler { viewModel.closeProposal() }
        ProposalDetailScreen(
            viewModel = rememberProposalDetailViewModel(
                proposal = openProposal,
                repository = repository,
                serverHost = serverHost,
            ),
            onBack = viewModel::closeProposal,
            onSetSecret = viewModel::openSecretForm,
            onResolved = {
                viewModel.refreshProposals()
                // Applying a proposal rewrites one of these very layers. An
                // editor left open on the old contents would carry a version
                // the server has already moved past.
                scope.launch {
                    organizationBundle?.reloadIfClean()
                    userBundle?.reloadIfClean()
                }
            },
            modifier = modifier,
        )
        return
    }

    val proposalsContent: @Composable () -> Unit = {
        ProposalsSection(
            proposals = state.proposals,
            onOpenProposal = viewModel::openProposal,
        )
    }
    val organizationBundleContent: (@Composable () -> Unit)? = organizationBundle?.let { editor ->
        {
            ConfigBundleEditor(
                editor = editor,
                canEdit = state.canManageOrganization,
                readOnlyReason = "Only organization managers can save changes here.",
                dialogs = dialogs,
            )
        }
    }
    val userBundleContent: (@Composable () -> Unit)? = userBundle?.let { editor ->
        { ConfigBundleEditor(editor = editor, dialogs = dialogs) }
    }

    SettingsScreen(
        state = state,
        actions = SettingsActions(
            onRefresh = viewModel::loadAll,
            onRetrySection = { section ->
                when (section) {
                    SettingsViewModel.PROPOSALS -> viewModel.refreshProposals()
                    SettingsViewModel.PROVIDERS -> viewModel.refreshModelCredentials()
                    SettingsViewModel.SECRETS -> viewModel.refreshSecrets()
                    SettingsViewModel.NOTIFICATIONS -> viewModel.refreshNotificationAuthorization()
                }
            },
            onOpenProposal = viewModel::openProposal,
            onToggleOrganizationForm = viewModel::toggleOrganizationForm,
            onOrganizationAliasChange = viewModel::onOrganizationAliasChange,
            onSwitchOrganization = viewModel::switchOrganization,
            onOpenAdminConsole = viewModel::openAdminConsole,
            onStartTrial = { viewModel.startCheckout(paid = false) },
            onSubscribe = { viewModel.startCheckout(paid = true) },
            onManageBilling = viewModel::openPortal,
            onOpenPlanChangePicker = viewModel::openPlanChangePicker,
            onDismissPlanChange = viewModel::dismissPlanChange,
            onPlanChangePreview = viewModel::previewPlanChange,
            onDismissPlanChangeReview = viewModel::dismissPlanChangeReview,
            onConfirmPlanChange = viewModel::confirmPlanChange,
            onRetryPlanChangeConfirm = viewModel::retryPlanChangeConfirm,
            onResumePlanChangeConfirm = viewModel::resumePlanChangeConfirm,
            onSignOut = viewModel::signOut,
            onConnectProvider = viewModel::connectProvider,
            onProviderChosen = viewModel::login,
            onProviderChoicesDismissed = viewModel::dismissProviderChoices,
            onAuthTypeChosen = viewModel::loginWith,
            onAuthTypeDismissed = viewModel::dismissAuthTypeChoice,
            onReconnect = viewModel::login,
            onTestCredential = viewModel::testCredential,
            onRemoveCredential = viewModel::removeCredential,
            onShowSecretForm = viewModel::showSecretForm,
            onCancelSecretForm = viewModel::cancelSecretForm,
            onSecretNameChange = viewModel::onSecretNameChange,
            onSecretValueChange = viewModel::onSecretValueChange,
            onSaveSecret = viewModel::saveSecret,
            onDeleteSecret = viewModel::deleteSecret,
            onOpenEnvironments = onOpenEnvironments,
            onRequestNotifications = viewModel::requestNotifications,
            onOpenNotificationSettings = viewModel::openNotificationSettings,
        ),
        modifier = modifier,
        dialogs = dialogs,
        proposalsSection = proposalsContent,
        organizationBundle = organizationBundleContent,
        userBundle = userBundleContent,
    )

    state.pendingLogin?.let { pending ->
        CredentialLoginSheet(
            provider = pending.provider,
            authType = pending.authType,
            socketFactory = socketFactory,
            onDismiss = viewModel::dismissLogin,
            onConnected = viewModel::onCredentialConnected,
            openUrl = openUrl,
            serverHost = serverHost,
        )
    }
}

/** The settings screen as a pure function of [state]. */
@Composable
fun SettingsScreen(
    state: SettingsState,
    actions: SettingsActions,
    modifier: Modifier = Modifier,
    dialogs: AppDialogHostState = rememberAppDialogHostState(),
    toastHostState: SnackbarHostState = rememberAppToastHostState(),
    listState: LazyListState = rememberLazyListState(),
    proposalsSection: @Composable () -> Unit = {},
    organizationBundle: (@Composable () -> Unit)? = null,
    userBundle: (@Composable () -> Unit)? = null,
) {
    val scope = rememberCoroutineScope()
    val hasOrganizationBundle = organizationBundle != null
    val hasUserBundle = userBundle != null
    val keys = remember(state, hasOrganizationBundle, hasUserBundle) {
        settingsItemKeys(state, hasOrganizationBundle, hasUserBundle)
    }

    // A proposal that hands back a secret name fills a field most of a screen
    // below where the reader was standing. Filling it silently off screen is the
    // same as not filling it, so the row it lives in comes to the top.
    LaunchedEffect(state.secretFormFocusRequest) {
        if (state.secretFormFocusRequest == 0) return@LaunchedEffect
        val index = keys.indexOf(SettingsItemKeys.SECRETS)
        if (index >= 0) listState.animateScrollToItem(index)
    }

    val confirmDeleteSecret: (SecretMeta) -> Unit = { secret ->
        scope.launch {
            val confirmed = dialogs.confirm(
                title = "Delete ${secret.name}?",
                message = "The value is write-only and cannot be recovered after deletion.",
                confirmLabel = "Delete secret permanently",
                destructive = true,
                confirmSemanticsLabel = "Confirm permanently delete user secret ${secret.name}",
                // Cancel stays a lone node: its name never embeds the confirm name.
                cancelSemanticsLabel = "Cancel deleting secret ${secret.name}",
            )
            if (confirmed) actions.onDeleteSecret(secret)
        }
    }

    val confirmRemoveCredential: (CredentialStatus, String) -> Unit = { credential, name ->
        scope.launch {
            val confirmed = dialogs.confirm(
                title = "Delete the saved $name sign-in?",
                message = "Pods using it will need a reconnect.",
                confirmLabel = "Delete sign-in",
                destructive = true,
                confirmSemanticsLabel = "Confirm delete $name model provider sign-in",
                cancelSemanticsLabel = "Cancel deleting $name sign-in",
            )
            if (confirmed) actions.onRemoveCredential(credential)
        }
    }

    val confirmSignOut: () -> Unit = {
        scope.launch {
            // A development build carries a baked token that signs straight back
            // in: sending the reader to the browser logout and back explains
            // nothing. Say so instead of bouncing.
            if (state.signOutUnavailable) {
                dialogs.notice(
                    title = "Sign out is unavailable in this build",
                    message = "This development build signs in automatically with a baked " +
                        "token, so signing out would sign straight back in. Use a release " +
                        "build to switch accounts.",
                    dismissSemanticsLabel = "Dismiss sign out unavailable notice",
                )
                return@launch
            }
            val confirmed = dialogs.confirm(
                title = "Sign out of pi pod?",
                confirmLabel = "Sign out",
                destructive = true,
                confirmSemanticsLabel = "Confirm sign out of pi pod",
                cancelSemanticsLabel = "Cancel signing out",
            )
            if (confirmed) actions.onSignOut()
        }
    }

    AppListScaffold(
        title = "Settings",
        modifier = modifier.testTag(SettingsTestTags.SCREEN),
        grouped = true,
        // Phones get pull-to-refresh; the toolbar button stays for wide layouts
        // with room for it. A first load draws the background bar instead, so
        // the two indicators never run at once.
        isRefreshing = state.isLoading && !state.showsInitialProgress,
        onRefresh = actions.onRefresh,
        refreshSemanticsLabel = "Refresh settings",
        contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 120.dp),
        listState = listState,
        toastHostState = toastHostState,
        actions = {
            AdaptiveRefreshButton(label = "Refresh settings", onClick = actions.onRefresh)
        },
    ) {
        settingsRows(
            keys = keys,
            state = state,
            actions = actions,
            proposalsSection = proposalsSection,
            organizationBundle = organizationBundle,
            userBundle = userBundle,
            onConfirmDeleteSecret = confirmDeleteSecret,
            onConfirmRemoveCredential = confirmRemoveCredential,
            onConfirmSignOut = confirmSignOut,
        )
    }

    state.providerChoices?.let { providers ->
        AppActionSheet(
            actions = providers.map { AppSheetAction(value = it, label = it.name) },
            onSelected = { provider ->
                if (provider == null) actions.onProviderChoicesDismissed() else actions.onProviderChosen(provider)
            },
        )
    }

    state.authTypeChoice?.let { provider ->
        AppActionSheet(
            actions = listOf(
                AppSheetAction(
                    value = "oauth",
                    label = provider.oauthLoginLabel ?: "Sign in with ${provider.name}",
                ),
                AppSheetAction(value = "api_key", label = "Connect with API key"),
            ),
            onSelected = { authType ->
                if (authType == null) {
                    actions.onAuthTypeDismissed()
                } else {
                    actions.onAuthTypeChosen(provider, authType)
                }
            },
        )
    }

    PlanChangeDialogs(state = state, actions = actions)

    AppDialogHost(dialogs)
}

/** The keys the settings list uses, one per row it can draw. */
internal object SettingsItemKeys {
    const val LOADING = "loading"
    const val PROPOSALS_ERROR = "proposals-error"
    const val UNSUPPORTED_PROPOSAL = "unsupported-proposal"
    const val PROPOSALS = "proposals"
    const val PROPOSALS_GAP = "proposals-gap"
    const val ACCOUNT = "account"
    const val PROVIDERS = "providers"
    const val SECRETS = "secrets"
    const val ENVIRONMENTS = "environments"
    const val ORG_DEFAULTS = "org-defaults"
    const val USER_DEFAULTS = "user-defaults"
    const val NOTIFICATIONS = "notifications"
}

/**
 * The rows the settings list draws, in order.
 *
 * The single source of that order. Bringing the secret form into view needs the
 * index of the row it sits in, and a second list that had to be kept in step
 * with the renderer would drift the first time a section became conditional.
 */
internal fun settingsItemKeys(
    state: SettingsState,
    hasOrganizationBundle: Boolean,
    hasUserBundle: Boolean,
): List<String> = buildList {
    if (state.showsInitialProgress) add(SettingsItemKeys.LOADING)
    if (state.sectionError(SettingsViewModel.PROPOSALS) != null) {
        add(SettingsItemKeys.PROPOSALS_ERROR)
    }
    repeat(state.unsupportedProposalCount) { add("${SettingsItemKeys.UNSUPPORTED_PROPOSAL}-$it") }
    if (state.proposals.isNotEmpty()) add(SettingsItemKeys.PROPOSALS)
    if (state.proposals.isNotEmpty() || state.unsupportedProposalCount > 0) {
        add(SettingsItemKeys.PROPOSALS_GAP)
    }
    if (state.user != null) add(SettingsItemKeys.ACCOUNT)
    add(SettingsItemKeys.PROVIDERS)
    add(SettingsItemKeys.SECRETS)
    add(SettingsItemKeys.ENVIRONMENTS)
    if (state.organization != null && hasOrganizationBundle) add(SettingsItemKeys.ORG_DEFAULTS)
    if (state.user != null && hasUserBundle) add(SettingsItemKeys.USER_DEFAULTS)
    add(SettingsItemKeys.NOTIFICATIONS)
}

private fun LazyListScope.settingsRows(
    keys: List<String>,
    state: SettingsState,
    actions: SettingsActions,
    proposalsSection: @Composable () -> Unit,
    organizationBundle: (@Composable () -> Unit)?,
    userBundle: (@Composable () -> Unit)?,
    onConfirmDeleteSecret: (SecretMeta) -> Unit,
    onConfirmRemoveCredential: (CredentialStatus, String) -> Unit,
    onConfirmSignOut: () -> Unit,
) {
    keys.forEach { key ->
        item(key = key) {
            when {
                key == SettingsItemKeys.LOADING -> AppProgressBar(
                    progress = null,
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(2.dp)
                        .semantics {
                            contentDescription = "Loading settings"
                            liveRegion = LiveRegionMode.Polite
                        },
                )

                key == SettingsItemKeys.PROPOSALS_ERROR -> {
                    SettingsSectionError(
                        message = state.sectionError(SettingsViewModel.PROPOSALS).orEmpty(),
                        retrySemanticsLabel = "Retry loading proposals",
                        onRetry = { actions.onRetrySection(SettingsViewModel.PROPOSALS) },
                    )
                    Spacer(Modifier.height(12.dp))
                }

                key.startsWith(SettingsItemKeys.UNSUPPORTED_PROPOSAL) ->
                    UnsupportedListItemCard(itemName = "approval")

                key == SettingsItemKeys.PROPOSALS -> proposalsSection()

                key == SettingsItemKeys.PROPOSALS_GAP -> Spacer(Modifier.height(12.dp))

                key == SettingsItemKeys.ACCOUNT -> {
                    AccountCard(
                        state = state,
                        actions = actions,
                        onConfirmSignOut = onConfirmSignOut,
                    )
                    Spacer(Modifier.height(12.dp))
                }

                key == SettingsItemKeys.PROVIDERS -> {
                    ModelProvidersCard(
                        state = state,
                        actions = actions,
                        onConfirmRemoveCredential = onConfirmRemoveCredential,
                    )
                    Spacer(Modifier.height(12.dp))
                }

                key == SettingsItemKeys.SECRETS -> {
                    UserSecretsCard(
                        state = state,
                        actions = actions,
                        onConfirmDeleteSecret = onConfirmDeleteSecret,
                    )
                    Spacer(Modifier.height(12.dp))
                }

                key == SettingsItemKeys.ENVIRONMENTS -> {
                    EnvironmentsCard(actions)
                    Spacer(Modifier.height(12.dp))
                }

                key == SettingsItemKeys.ORG_DEFAULTS -> {
                    OrganizationDefaultsCard(state = state, bundle = organizationBundle)
                    Spacer(Modifier.height(12.dp))
                }

                key == SettingsItemKeys.USER_DEFAULTS -> {
                    UserDefaultsCard(bundle = userBundle)
                    Spacer(Modifier.height(12.dp))
                }

                key == SettingsItemKeys.NOTIFICATIONS ->
                    NotificationsCard(state = state, actions = actions)
            }
        }
    }
}

@Composable
private fun EnvironmentsCard(actions: SettingsActions) {
    SettingsCard(
        modifier = Modifier.testTag(SettingsTestTags.ENVIRONMENTS_CARD),
        title = "Every pod you launch",
        footer = "An environment is what a pod starts from: a setup script, a bake script " +
            "and a network policy. Model providers you connect work in every pod.",
    ) {
        AppListTile(
            modifier = Modifier
                .semantics(mergeDescendants = true) { }
                .testTag(SettingsTestTags.ENVIRONMENTS_ROW),
            onClick = actions.onOpenEnvironments,
            showChevron = true,
            semanticsLabel = "Open environments settings",
            leading = { Icon(AppIcons.environment, contentDescription = null) },
            title = { Text("Environments") },
        )
    }
}

@Composable
private fun OrganizationDefaultsCard(state: SettingsState, bundle: (@Composable () -> Unit)?) {
    val organization = state.organization ?: return
    SettingsCard(
        modifier = Modifier.testTag(SettingsTestTags.ORG_DEFAULTS_CARD),
        title = "Organization defaults",
        footer = "Applied under every environment for everyone in your organization. " +
            "Agents can propose changes here from inside a pod.",
    ) {
        bundle?.invoke()
    }
}

@Composable
private fun UserDefaultsCard(bundle: (@Composable () -> Unit)?) {
    SettingsCard(
        modifier = Modifier.testTag(SettingsTestTags.USER_DEFAULTS_CARD),
        title = "Your defaults",
        footer = "Applied on top of the organization defaults in every pod you launch, " +
            "whichever environment it uses.",
    ) {
        bundle?.invoke()
    }
}

@Composable
private fun AccountCard(
    state: SettingsState,
    actions: SettingsActions,
    onConfirmSignOut: () -> Unit,
) {
    val user = state.user ?: return
    val turn by animateFloatAsState(
        if (state.isOrganizationFormExpanded) 180f else 0f,
        label = "organization-chevron",
    )

    SettingsCard(modifier = Modifier.testTag(SettingsTestTags.ACCOUNT_CARD), title = "Account") {
        SettingsLabeledValue(label = "Signed in as", value = user.email ?: user.displayName ?: user.id)
        state.organization?.let { organization ->
            SettingsLabeledValue(
                label = "Organization",
                value = organization.name ?: organization.alias ?: organization.id,
            )
        }
        // The SaaS account summary, in the same words as the pods-screen row.
        // Absent on the self-hosted backend, where nothing renders and no
        // space is taken.
        val billingSegments = state.billing?.segments().orEmpty()
        if (billingSegments.isNotEmpty()) {
            SettingsLabeledValue(
                label = "Billing",
                value = billingSegments.joinToString(" · "),
            )
        }
        // Why launches are about to be refused, said here rather than left for
        // the 402 to explain after the fact.
        state.billing?.alert?.let { alert ->
            Text(
                text = alert.message,
                style = MaterialTheme.typography.bodySmall,
                color = billingAlertColor(alert),
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 4.dp)
                    .testTag(SettingsTestTags.BILLING_ALERT)
                    .semantics {
                        contentDescription = "Account warning, ${alert.message}"
                        liveRegion = LiveRegionMode.Polite
                    },
            )
        }
        Spacer(Modifier.height(8.dp))
        AppButton(
            onClick = actions.onToggleOrganizationForm,
            modifier = Modifier
                .fillMaxWidth()
                .testTag(SettingsTestTags.ORGANIZATION_TOGGLE)
                .semantics {
                    stateDescription =
                        if (state.isOrganizationFormExpanded) "Expanded" else "Collapsed"
                },
            kind = AppButtonKind.Plain,
            // The name never flips with the state: the state is announced
            // separately, and a control that renames itself is a different
            // control to anything driving the screen by name.
            semanticsLabel = "Switch organization",
        ) {
            Icon(
                imageVector = AppIcons.expand,
                contentDescription = null,
                modifier = Modifier.rotate(turn),
            )
            Spacer(Modifier.width(8.dp))
            Text(
                text = if (state.isOrganizationFormExpanded) {
                    "Hide organization switch"
                } else {
                    "Switch organization"
                },
                modifier = Modifier.weight(1f),
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }

        if (state.isOrganizationFormExpanded) {
            Spacer(Modifier.height(4.dp))
            Text(
                "Switching organizations starts a new browser authorization for the exact alias.",
            )
            // The floating field label sits half above the border; without this
            // gap it collides with the helper text.
            Spacer(Modifier.height(12.dp))
            AppTextField(
                value = state.organizationAlias,
                onValueChange = actions.onOrganizationAliasChange,
                modifier = Modifier.testTag(SettingsTestTags.ORGANIZATION_ALIAS),
                label = "Organization alias",
                semanticsLabel = "Organization alias",
                keyboardOptions = KeyboardOptions(
                    capitalization = KeyboardCapitalization.None,
                    autoCorrectEnabled = false,
                    keyboardType = KeyboardType.Uri,
                    imeAction = ImeAction.Done,
                ),
                keyboardActions = KeyboardActions(onDone = { actions.onSwitchOrganization() }),
            )
            Spacer(Modifier.height(8.dp))
            AppButton(
                onClick = actions.onSwitchOrganization,
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag(SettingsTestTags.ORGANIZATION_SWITCH),
                enabled = state.canSwitchOrganization,
                semanticsLabel = "Reauthorize organization",
            ) {
                if (state.isSwitchingOrganization) {
                    AppActivityIndicator(size = 18.dp)
                } else {
                    Text("Switch organization")
                }
            }
            // A disabled Switch reads as broken. Name the reason when the alias
            // already matches.
            if (state.organizationAlreadyCurrent) {
                Spacer(Modifier.height(4.dp))
                SettingsFootnote("Already signed in to this organization.")
            }
        }

        state.organizationStatus?.let { status ->
            Spacer(Modifier.height(8.dp))
            SettingsStatusLabel(status)
        }

        if (state.canSubscribe) {
            Spacer(Modifier.height(4.dp))
            AppButton(
                text = "Start trial",
                onClick = actions.onStartTrial,
                modifier = Modifier.testTag("settings-start-trial"),
                kind = AppButtonKind.Plain,
                semanticsLabel = "Start trial",
            )
            Spacer(Modifier.height(4.dp))
            AppButton(
                text = "Subscribe",
                onClick = actions.onSubscribe,
                modifier = Modifier.testTag("settings-subscribe"),
                kind = AppButtonKind.Plain,
                semanticsLabel = "Subscribe",
            )
        }
        if (state.canManageBilling) {
            Spacer(Modifier.height(4.dp))
            AppButton(
                text = "Manage billing",
                onClick = actions.onManageBilling,
                modifier = Modifier.testTag("settings-manage-billing"),
                kind = AppButtonKind.Plain,
                semanticsLabel = "Manage billing",
            )
        }
        // The plan-change surface, gated on `canChangePlan`; it omits itself
        // on the static backend and on a flag-off 404.
        PlanChangeAccountContent(state = state, actions = actions)
        state.billingActionStatus?.let { status ->
            Spacer(Modifier.height(8.dp))
            SettingsStatusLabel(status)
        }

        if (state.adminConsoleUrl != null) {
            Spacer(Modifier.height(4.dp))
            AppButton(
                onClick = actions.onOpenAdminConsole,
                modifier = Modifier.testTag(SettingsTestTags.ADMIN_CONSOLE),
                kind = AppButtonKind.Plain,
                semanticsLabel = "Open admin console",
            ) {
                AppButtonContent(icon = AppIcons.openExternal, label = "Admin console")
            }
            state.adminConsoleStatus?.let { status ->
                Spacer(Modifier.height(8.dp))
                SettingsStatusLabel(status)
            }
        }

        Spacer(Modifier.height(4.dp))
        AppButton(
            text = "Sign out",
            onClick = onConfirmSignOut,
            modifier = Modifier.testTag(SettingsTestTags.SIGN_OUT),
            kind = AppButtonKind.Plain,
            destructive = true,
            semanticsLabel = "Sign out of pi pod",
        )
    }
}

@Composable
private fun ModelProvidersCard(
    state: SettingsState,
    actions: SettingsActions,
    onConfirmRemoveCredential: (CredentialStatus, String) -> Unit,
) {
    val sectionError = state.sectionError(SettingsViewModel.PROVIDERS)

    SettingsCard(
        modifier = Modifier.testTag(SettingsTestTags.PROVIDERS_CARD),
        title = "Model providers",
    ) {
        if (sectionError != null) {
            SettingsSectionError(
                message = sectionError,
                retrySemanticsLabel = "Retry loading model providers",
                onRetry = { actions.onRetrySection(SettingsViewModel.PROVIDERS) },
            )
            Spacer(Modifier.height(8.dp))
        }

        val response = state.modelCredentials
        when {
            response == null && sectionError == null -> Row(
                modifier = Modifier.semantics(mergeDescendants = true) {
                    contentDescription = "Loading model providers"
                    liveRegion = LiveRegionMode.Polite
                },
                verticalAlignment = Alignment.CenterVertically,
            ) {
                AppActivityIndicator(size = 18.dp)
                Spacer(Modifier.width(8.dp))
                Text(text = "Loading model providers…", modifier = Modifier.weight(1f))
            }

            response == null || response.credentials.isEmpty() -> Text(
                "Connect a model provider so every pod you launch boots signed in. Do not run " +
                    "/login inside a pod for these providers.",
            )

            else -> response.credentials.forEach { credential ->
                CredentialRow(
                    credential = credential,
                    provider = state.provider(credential.providerId),
                    isWorking = state.isWorkingOn(credential.providerId),
                    onReconnect = actions.onReconnect,
                    onTest = { actions.onTestCredential(credential) },
                    onRemove = { name -> onConfirmRemoveCredential(credential, name) },
                )
            }
        }

        Spacer(Modifier.height(8.dp))
        AppButton(
            onClick = actions.onConnectProvider,
            modifier = Modifier.testTag(SettingsTestTags.CONNECT_PROVIDER),
            kind = AppButtonKind.Tinted,
            enabled = state.modelCredentials != null,
            semanticsLabel = "Connect model provider",
        ) {
            AppButtonContent(icon = AppIcons.add, label = "Connect")
        }

        state.credentialStatus?.let { status ->
            Spacer(Modifier.height(8.dp))
            SettingsStatusLabel(status)
        }
    }
}

/** One stored provider credential, its health and what can be done about it. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun CredentialRow(
    credential: CredentialStatus,
    provider: ConnectableProvider?,
    isWorking: Boolean,
    onReconnect: (ConnectableProvider) -> Unit,
    onTest: () -> Unit,
    onRemove: (String) -> Unit,
) {
    val name = provider?.name ?: credential.providerId
    val expiry = credential.expiresAt?.let { Format.absolute(it) }
    val lastRefresh = credential.lastRefreshAt?.let { Format.absolute(it) }

    Column(
        Modifier
            .fillMaxWidth()
            .padding(bottom = 12.dp)
            .testTag(SettingsTestTags.credentialRow(credential.providerId)),
    ) {
        Text(text = name, style = MaterialTheme.typography.titleSmall)
        SettingsLabeledValue(
            label = if (credential.type == "api_key") "API key" else "OAuth",
            value = SettingsViewModel.credentialStateLabel(credential),
        )
        expiry?.let { SettingsLabeledValue(label = "Expires", value = it) }
        lastRefresh?.let { SettingsLabeledValue(label = "Last refreshed", value = it) }
        Spacer(Modifier.height(4.dp))
        // Wraps rather than a Row: at a large font scale the three labels are
        // wider than the card, and a Row clipped the last one — Delete, the
        // only way to remove a credential — off the right-hand edge.
        FlowRow(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            AppButton(
                text = "Reconnect",
                onClick = { provider?.let(onReconnect) },
                kind = AppButtonKind.Plain,
                enabled = !isWorking && provider != null,
                semanticsLabel = "Reconnect $name model provider",
            )
            AppButton(
                text = "Test",
                onClick = onTest,
                kind = AppButtonKind.Plain,
                enabled = !isWorking,
                semanticsLabel = "Test $name model provider",
            )
            AppButton(
                onClick = { onRemove(name) },
                kind = AppButtonKind.Plain,
                enabled = !isWorking,
                destructive = true,
                semanticsLabel = "Delete $name model provider sign-in",
            ) {
                if (isWorking) AppActivityIndicator(size = 18.dp) else Text("Delete")
            }
        }
    }
}

@Composable
private fun UserSecretsCard(
    state: SettingsState,
    actions: SettingsActions,
    onConfirmDeleteSecret: (SecretMeta) -> Unit,
) {
    SettingsCard(
        modifier = Modifier.testTag(SettingsTestTags.SECRETS_CARD),
        title = "User secrets (write-only)",
    ) {
        Text(
            "Injected into every pod you launch — API keys for model providers and any other " +
                "service belong here. Values can be replaced or deleted, but never read back.",
        )
        Spacer(Modifier.height(4.dp))
        Text("To replace a value, save again with the same name.")

        state.sectionError(SettingsViewModel.SECRETS)?.let { error ->
            Spacer(Modifier.height(8.dp))
            SettingsSectionError(
                message = error,
                retrySemanticsLabel = "Retry loading secrets",
                onRetry = { actions.onRetrySection(SettingsViewModel.SECRETS) },
            )
        }

        Spacer(Modifier.height(12.dp))
        for (index in 0 until state.unsupportedSecretCount) {
            UnsupportedListItemCard(itemName = "secret")
        }
        state.secrets.forEach { secret ->
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag(SettingsTestTags.secretRow(secret.name)),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(text = secret.name, style = MonospaceTextStyle, modifier = Modifier.weight(1f))
                AppIconButton(
                    icon = AppIcons.delete,
                    onClick = { onConfirmDeleteSecret(secret) },
                    semanticsLabel = "Delete user secret ${secret.name}",
                    destructive = true,
                )
            }
        }
        if (state.secrets.isNotEmpty()) AppSeparator()

        if (state.isSecretFormExpanded) {
            SecretEntryFields(
                name = state.secretName,
                onNameChange = actions.onSecretNameChange,
                value = state.secretValue,
                onValueChange = actions.onSecretValueChange,
                semanticsPrefix = "User secret",
                isSaving = state.isSavingSecret,
                onSave = actions.onSaveSecret,
            )
            Spacer(Modifier.height(4.dp))
            AppButton(
                text = "Cancel",
                onClick = actions.onCancelSecretForm,
                modifier = Modifier.testTag(SettingsTestTags.CANCEL_SECRET),
                kind = AppButtonKind.Plain,
                enabled = !state.isSavingSecret,
                // A text-link Cancel still needs the standard touch target.
                minSize = DpSize(AppButtonDefaults.MinTouchTarget, AppButtonDefaults.MinTouchTarget),
                semanticsLabel = "Cancel adding secret",
            )
        } else {
            AppButton(
                onClick = actions.onShowSecretForm,
                modifier = Modifier.testTag(SettingsTestTags.ADD_SECRET),
                kind = AppButtonKind.Tinted,
                semanticsLabel = "Add secret",
            ) {
                AppButtonContent(icon = AppIcons.add, label = "Add secret")
            }
        }

        state.secretStatus?.let { status ->
            Spacer(Modifier.height(8.dp))
            SettingsStatusLabel(status)
        }
    }
}

@Composable
private fun NotificationsCard(state: SettingsState, actions: SettingsActions) {
    SettingsCard(
        modifier = Modifier.testTag(SettingsTestTags.NOTIFICATIONS_CARD),
        title = "Notifications",
    ) {
        Text(
            "Get an alert when pi needs approval or finishes a turn. Notifications are optional " +
                "and can be changed anytime.",
        )
        Spacer(Modifier.height(8.dp))
        SettingsLabeledValue(label = "Permission", value = state.notificationPermissionText)

        when (state.notificationAuthorization) {
            NotificationAuthorization.NotDetermined -> {
                Spacer(Modifier.height(8.dp))
                AppButton(
                    text = "Enable notifications",
                    onClick = actions.onRequestNotifications,
                    modifier = Modifier.testTag(SettingsTestTags.ENABLE_NOTIFICATIONS),
                    kind = AppButtonKind.Plain,
                    semanticsLabel = "Enable notifications",
                )
            }

            NotificationAuthorization.Denied -> {
                Spacer(Modifier.height(8.dp))
                AppButton(
                    text = "Open notification settings",
                    onClick = actions.onOpenNotificationSettings,
                    modifier = Modifier.testTag(SettingsTestTags.OPEN_NOTIFICATION_SETTINGS),
                    kind = AppButtonKind.Plain,
                    semanticsLabel = "Open notification settings",
                )
            }

            else -> Unit
        }

        state.sectionError(SettingsViewModel.NOTIFICATIONS)?.let { error ->
            Spacer(Modifier.height(8.dp))
            SettingsSectionError(
                message = error,
                retrySemanticsLabel = "Retry loading notification state",
                onRetry = { actions.onRetrySection(SettingsViewModel.NOTIFICATIONS) },
            )
        }

        state.notificationRegistrationError?.let { error ->
            Spacer(Modifier.height(8.dp))
            SettingsStatusLabel(SettingsStatus(text = error, isError = true))
        }
    }
}

/** The handles a UI test finds this screen's parts by. */
object SettingsTestTags {
    const val SCREEN = "settings-screen"
    const val ACCOUNT_CARD = "settings-account"
    const val BILLING_ALERT = "settings-billing-alert"
    const val PROVIDERS_CARD = "settings-providers"
    const val SECRETS_CARD = "settings-secrets"
    const val ENVIRONMENTS_CARD = "settings-environments"
    const val ENVIRONMENTS_ROW = "settings-environments-row"
    const val ORG_DEFAULTS_CARD = "settings-org-defaults"
    const val USER_DEFAULTS_CARD = "settings-user-defaults"
    const val NOTIFICATIONS_CARD = "settings-notifications"
    const val ORGANIZATION_TOGGLE = "settings-organization-toggle"
    const val ORGANIZATION_ALIAS = "settings-organization-alias"
    const val ORGANIZATION_SWITCH = "settings-organization-switch"
    const val ADMIN_CONSOLE = "settings-admin-console"
    const val SIGN_OUT = "settings-sign-out"
    const val CONNECT_PROVIDER = "settings-connect-provider"
    const val ADD_SECRET = "settings-add-secret"
    const val CANCEL_SECRET = "settings-cancel-secret"
    const val ENABLE_NOTIFICATIONS = "settings-enable-notifications"
    const val OPEN_NOTIFICATION_SETTINGS = "settings-open-notification-settings"

    fun credentialRow(providerId: String) = "settings-credential-$providerId"

    fun secretRow(name: String) = "settings-secret-$name"
}
