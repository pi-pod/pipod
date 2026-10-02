package com.pipod.app.features.settings

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.pipod.app.core.api.model.ConnectableProvider
import com.pipod.app.core.api.model.CredentialStatus
import com.pipod.app.core.config.RuntimeConfig
import com.pipod.app.core.credentials.LoginEvent
import com.pipod.app.core.credentials.LoginPrompt
import com.pipod.app.ui.AppActivityIndicator
import com.pipod.app.ui.AppButton
import com.pipod.app.ui.AppButtonKind
import com.pipod.app.ui.AppOption
import com.pipod.app.ui.AppOptionPicker
import com.pipod.app.ui.AppSelectableText
import com.pipod.app.ui.AppSheet
import com.pipod.app.ui.AppTextField
import com.pipod.app.ui.theme.MonospaceTextStyle
import com.pipod.app.ui.theme.appColors

/**
 * The provider sign-in, presented over whatever raised it.
 *
 * Port of `showCredentialLogin` in
 * `pi-pod-flutter/lib/features/settings/credential_login_view.dart`. The sheet
 * prefers the centred presentation: a sign-in that hands back a URL and a code
 * to copy reads better in a panel than in something dragged up from the bottom.
 */
@Composable
fun CredentialLoginSheet(
    provider: ConnectableProvider,
    authType: String,
    socketFactory: LoginSocketFactory,
    onDismiss: () -> Unit,
    onConnected: (CredentialStatus) -> Unit,
    modifier: Modifier = Modifier,
    podId: String? = null,
    openUrl: UrlOpener = NoUrlOpener,
    serverHost: String? = RuntimeConfig.serverUrl,
) {
    val viewModel = rememberCredentialLoginViewModel(
        provider = provider,
        authType = authType,
        socketFactory = socketFactory,
        podId = podId,
        openUrl = openUrl,
        serverHost = serverHost,
    )
    val state by viewModel.state.collectAsStateWithLifecycle()

    LaunchedEffect(viewModel) {
        viewModel.events.collect { event ->
            when (event) {
                is CredentialLoginEvent.Connected -> onConnected(event.status)
                CredentialLoginEvent.Dismissed -> onDismiss()
            }
        }
    }

    AppSheet(
        onDismissRequest = onDismiss,
        modifier = modifier,
        maxWidth = 620.dp,
        preferDialog = true,
    ) {
        CredentialLoginView(
            provider = provider,
            authType = authType,
            state = state,
            onSubmit = viewModel::respond,
            onOpenUrl = viewModel::open,
            onCancel = viewModel::cancel,
        )
    }
}

/**
 * One holder per provider sign-in, living exactly as long as the sheet.
 *
 * A second attempt at the same provider is a second socket, so the holder is
 * remembered rather than kept in the activity's view-model store — and leaving
 * the sheet closes the socket instead of leaving it open behind a dismissed
 * panel.
 */
@Composable
fun rememberCredentialLoginViewModel(
    provider: ConnectableProvider,
    authType: String,
    socketFactory: LoginSocketFactory,
    podId: String? = null,
    openUrl: UrlOpener = NoUrlOpener,
    serverHost: String? = RuntimeConfig.serverUrl,
): CredentialLoginViewModel {
    val scope = rememberCoroutineScope()
    val model = remember(provider.id, authType, podId) {
        CredentialLoginViewModel(
            provider = provider,
            authType = authType,
            socketFactory = socketFactory,
            podId = podId,
            openUrl = openUrl,
            serverHost = serverHost,
            scope = scope,
        )
    }
    DisposableEffect(model) { onDispose { model.close() } }
    return model
}

/** The sign-in panel as a pure function of [state]. */
@Composable
fun ColumnScope.CredentialLoginView(
    provider: ConnectableProvider,
    authType: String,
    state: CredentialLoginState,
    onSubmit: (String) -> Unit,
    onOpenUrl: (String) -> Unit,
    onCancel: () -> Unit,
) {
    Column(
        Modifier
            .fillMaxWidth()
            .heightIn(max = 720.dp)
            .padding(start = 20.dp, top = 16.dp, end = 20.dp, bottom = 20.dp)
            .testTag(CredentialLoginTestTags.SHEET),
    ) {
        Text(
            text = "Connect ${provider.name}",
            style = MaterialTheme.typography.titleMedium,
        )
        Spacer(Modifier.height(6.dp))
        Text(
            text = if (authType == "api_key") {
                "Enter the provider API key. It will be stored in encrypted account custody."
            } else {
                "Complete the provider sign-in to use it in every pod you launch."
            },
        )
        Spacer(Modifier.height(12.dp))
        Column(
            Modifier
                .weight(1f, fill = false)
                .verticalScroll(rememberScrollState()),
        ) {
            if (state.connecting) {
                Row(
                    modifier = Modifier.semantics(mergeDescendants = true) {
                        contentDescription = "Connecting to ${provider.name}"
                        liveRegion = LiveRegionMode.Polite
                    },
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    AppActivityIndicator(size = 18.dp)
                    Spacer(Modifier.width(8.dp))
                    Text("Starting sign-in…")
                }
            }
            state.events.forEach { event ->
                LoginEventView(
                    event = event,
                    providerName = provider.name,
                    onOpen = onOpenUrl,
                )
                Spacer(Modifier.height(12.dp))
            }
            state.prompt?.let { prompt ->
                LoginPromptControl(prompt = prompt, onSubmit = onSubmit)
            }
            state.error?.let { error ->
                Spacer(Modifier.height(12.dp))
                Text(
                    text = error,
                    color = appColors.destructive,
                    modifier = Modifier
                        .testTag(CredentialLoginTestTags.ERROR)
                        .semantics(mergeDescendants = true) {
                            contentDescription = "Provider sign-in error: $error"
                            liveRegion = LiveRegionMode.Polite
                        },
                )
            }
        }
        Spacer(Modifier.height(12.dp))
        AppButton(
            text = "Cancel",
            onClick = onCancel,
            modifier = Modifier
                .fillMaxWidth()
                .testTag(CredentialLoginTestTags.CANCEL),
            kind = AppButtonKind.Tinted,
            destructive = true,
            semanticsLabel = "Cancel ${provider.name} sign-in",
        )
    }
}

/**
 * The one question the provider is waiting on.
 *
 * Keyed by prompt id, so answering one question and being asked another starts
 * the control empty instead of offering the previous answer back.
 */
@Composable
private fun LoginPromptControl(prompt: LoginPrompt, onSubmit: (String) -> Unit) {
    var text by remember(prompt.id) { mutableStateOf("") }
    var selected by remember(prompt.id) { mutableStateOf(prompt.options.firstOrNull()?.id ?: "") }
    val isSelect = prompt.type == "select"
    val canSubmit = if (isSelect) selected.isNotEmpty() else text.isNotEmpty()
    val value = if (isSelect) selected else text

    Column(Modifier.fillMaxWidth()) {
        Text(prompt.message)
        Spacer(Modifier.height(8.dp))
        if (isSelect) {
            AppOptionPicker(
                label = "Choose an option",
                value = selected,
                options = prompt.options.map { option ->
                    AppOption(
                        value = option.id,
                        label = option.description?.let { "${option.label} — $it" } ?: option.label,
                    )
                },
                onValueChange = { selected = it },
                modifier = Modifier
                    .testTag(CredentialLoginTestTags.PROMPT)
                    .semantics { contentDescription = "Sign-in choice for ${prompt.id}" },
            )
        } else {
            AppTextField(
                value = text,
                onValueChange = { text = it },
                modifier = Modifier.testTag(CredentialLoginTestTags.PROMPT),
                obscureText = prompt.type == "secret",
                placeholder = prompt.placeholder,
                semanticsLabel = prompt.message,
                keyboardOptions = KeyboardOptions(
                    capitalization = KeyboardCapitalization.None,
                    autoCorrectEnabled = false,
                    imeAction = ImeAction.Done,
                ),
                keyboardActions = KeyboardActions(
                    onDone = { if (text.isNotEmpty()) onSubmit(text) },
                ),
            )
        }
        Spacer(Modifier.height(10.dp))
        AppButton(
            text = "Continue",
            onClick = { onSubmit(value) },
            modifier = Modifier
                .fillMaxWidth()
                .testTag(CredentialLoginTestTags.SUBMIT),
            enabled = canSubmit,
            semanticsLabel = "Submit sign-in response for ${prompt.id}",
        )
    }
}

/** One thing the provider said while the sign-in ran. */
@Composable
private fun LoginEventView(event: LoginEvent, providerName: String, onOpen: (String) -> Unit) {
    when (event) {
        is LoginEvent.Info -> Column(Modifier.fillMaxWidth()) {
            Text(event.message)
            event.links.forEach { link ->
                Spacer(Modifier.height(6.dp))
                Text(text = link.url, style = MonospaceTextStyle)
                AppButton(
                    text = link.label,
                    onClick = { onOpen(link.url) },
                    kind = AppButtonKind.Plain,
                    semanticsLabel = "Open ${link.label} for $providerName",
                )
            }
        }

        is LoginEvent.AuthUrl -> Column(Modifier.fillMaxWidth()) {
            Text(event.instructions)
            Spacer(Modifier.height(6.dp))
            AppSelectableText(text = event.url, style = MonospaceTextStyle)
            Spacer(Modifier.height(6.dp))
            AppButton(
                text = "Open",
                onClick = { onOpen(event.url) },
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag(CredentialLoginTestTags.OPEN),
                semanticsLabel = "Open $providerName sign-in page",
            )
        }

        is LoginEvent.DeviceCode -> Column(Modifier.fillMaxWidth()) {
            Text("Enter this code on the provider sign-in page:")
            Spacer(Modifier.height(6.dp))
            AppSelectableText(text = event.userCode, style = MonospaceTextStyle)
            Spacer(Modifier.height(6.dp))
            AppSelectableText(text = event.verificationUri, style = MonospaceTextStyle)
            Spacer(Modifier.height(6.dp))
            AppButton(
                text = "Open",
                onClick = { onOpen(event.verificationUri) },
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag(CredentialLoginTestTags.OPEN),
                semanticsLabel = "Open $providerName device sign-in page",
            )
        }

        is LoginEvent.Progress -> Row(
            modifier = Modifier
                .fillMaxWidth()
                .semantics(mergeDescendants = true) {
                    contentDescription = event.message
                    liveRegion = LiveRegionMode.Polite
                },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            AppActivityIndicator(size = 18.dp)
            Spacer(Modifier.width(8.dp))
            Text(text = event.message, modifier = Modifier.weight(1f))
        }
    }
}

/** The handles a UI test finds the sign-in sheet's parts by. */
object CredentialLoginTestTags {
    const val SHEET = "credential-login"
    const val PROMPT = "credential-login-prompt"
    const val SUBMIT = "credential-login-submit"
    const val CANCEL = "credential-login-cancel"
    const val OPEN = "credential-login-open"
    const val ERROR = "credential-login-error"
}
