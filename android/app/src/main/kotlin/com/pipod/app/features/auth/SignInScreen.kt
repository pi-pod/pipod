package com.pipod.app.features.auth

import androidx.compose.foundation.background
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.pipod.app.core.config.ServerDiscovery
import com.pipod.app.core.format.FriendlyError
import com.pipod.app.ui.AppActivityIndicator
import com.pipod.app.ui.AppButton
import com.pipod.app.ui.AppButtonKind
import com.pipod.app.ui.AppIcons
import com.pipod.app.ui.AppScaffold
import com.pipod.app.ui.AppTextField
import com.pipod.app.ui.theme.appColors
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/**
 * The signed-out screen.
 *
 * Port of `pi-pod-flutter/lib/features/auth/sign_in_view.dart`. Sign-in itself
 * happens in the system browser: this screen only starts it and reports why it
 * did not finish.
 */
@Composable
fun SignInScreen(
    onSignIn: suspend () -> Unit,
    modifier: Modifier = Modifier,
    notice: String? = null,
    initialError: String? = null,
    serverName: String = "",
    hasServerChoice: Boolean = false,
    onChooseServer: suspend (address: String) -> Unit = {},
    onUseCloud: () -> Unit = {},
    /** The chosen server as the field should show it; see [ServerDiscovery.address]. */
    serverAddress: String = "",
) {
    var choosingServer by remember { mutableStateOf(false) }
    // Deliberately not `rememberSaveable`: the only thing that clears this flag
    // is the `finally` of a coroutine in `rememberCoroutineScope`, which dies
    // with the composition — and instance state is saved *before* the
    // composition is disposed. Restored, the screen came back with a disabled
    // "Signing in…" button and nothing behind it, and force-stopping the app
    // was the only way out. A sign-in in flight cannot survive the composition,
    // so neither may the flag that claims one is.
    var isSigningIn by remember { mutableStateOf(false) }
    var error by remember(initialError) { mutableStateOf(initialError) }
    val scope = rememberCoroutineScope()

    if (choosingServer) {
        ServerDialog(
            initial = if (hasServerChoice) serverAddress else "",
            hasServerChoice = hasServerChoice,
            onChoose = onChooseServer,
            onUseCloud = {
                onUseCloud()
                choosingServer = false
            },
            onDismiss = { choosingServer = false },
        )
    }

    AppScaffold(modifier = modifier.testTag("sign-in-screen")) { padding ->
        Box(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState()),
            contentAlignment = Alignment.Center,
        ) {
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
                modifier = Modifier.padding(32.dp).widthIn(max = 440.dp),
            ) {
                Box(
                    Modifier
                        .size(96.dp)
                        .background(appColors.accent.copy(alpha = 0.12f), CircleShape)
                        // The mark is decoration; the heading below already names the app.
                        .clearAndSetSemantics { },
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        AppIcons.brand,
                        contentDescription = null,
                        tint = appColors.accent,
                        modifier = Modifier.size(48.dp),
                    )
                }
                Spacer(Modifier.height(20.dp))
                Text(
                    text = "pi pod",
                    style = MaterialTheme.typography.displaySmall,
                    fontWeight = FontWeight.Bold,
                )
                Spacer(Modifier.height(12.dp))
                Text(
                    text = "Run every pi session inside a fresh pod — from any device.",
                    textAlign = TextAlign.Center,
                    style = MaterialTheme.typography.bodyLarge,
                    color = appColors.secondaryLabel,
                )
                Spacer(Modifier.height(28.dp))
                AppButton(
                    onClick = {
                        if (isSigningIn) return@AppButton
                        isSigningIn = true
                        error = null
                        scope.launch {
                            try {
                                onSignIn()
                            } catch (cancelled: CancellationException) {
                                throw cancelled
                            } catch (failure: Throwable) {
                                error = FriendlyError.message(failure)
                            } finally {
                                isSigningIn = false
                            }
                        }
                    },
                    modifier = Modifier.fillMaxWidth().testTag("sign-in-button"),
                    kind = AppButtonKind.Filled,
                    enabled = !isSigningIn,
                    semanticsLabel = "Sign in",
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        if (isSigningIn) {
                            AppActivityIndicator(size = 18.dp)
                        } else {
                            Icon(AppIcons.person, contentDescription = null)
                        }
                        Spacer(Modifier.width(8.dp))
                        Text(if (isSigningIn) "Signing in…" else "Sign in")
                    }
                }
                if (serverName.isNotEmpty()) {
                    TextButton(
                        onClick = { choosingServer = true },
                        enabled = !isSigningIn,
                        modifier = Modifier
                            .testTag("sign-in-server")
                            .semantics { contentDescription = "Server: $serverName. Change server" },
                    ) {
                        Text(
                            text = "Server: $serverName · Change",
                            style = MaterialTheme.typography.bodySmall,
                            color = appColors.accent,
                        )
                    }
                }
                notice?.let {
                    Spacer(Modifier.height(18.dp))
                    Text(
                        text = it,
                        textAlign = TextAlign.Center,
                        color = appColors.secondaryLabel,
                        modifier = Modifier
                            .testTag("sign-in-notice")
                            .semantics { contentDescription = "Authentication notice: $it" },
                    )
                }
                error?.let {
                    Spacer(Modifier.height(18.dp))
                    Text(
                        text = it,
                        textAlign = TextAlign.Center,
                        color = appColors.destructive,
                        modifier = Modifier
                            .testTag("sign-in-error")
                            .semantics {
                                contentDescription = "Sign in error: $it"
                                liveRegion = LiveRegionMode.Polite
                            },
                    )
                }
            }
        }
    }
}

/**
 * Where to sign in: pi pod cloud, or an organization's own self-hosted server, found from its
 * address alone.
 */
@Composable
private fun ServerDialog(
    initial: String,
    hasServerChoice: Boolean,
    onChoose: suspend (String) -> Unit,
    onUseCloud: () -> Unit,
    onDismiss: () -> Unit,
) {
    var address by remember { mutableStateOf(initial) }
    var checking by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    fun check() {
        if (checking || address.isBlank()) return
        checking = true
        error = null
        scope.launch {
            try {
                onChoose(address)
                onDismiss()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Throwable) {
                error = (failure as? ServerDiscovery.Failure)?.message ?: FriendlyError.message(failure)
            } finally {
                checking = false
            }
        }
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        modifier = Modifier.testTag("server-dialog"),
        title = { Text("Server") },
        text = {
            Column {
                Text(
                    "If your organization runs pi pod itself, enter the address its CLI signs in to.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = appColors.secondaryLabel,
                )
                Spacer(Modifier.height(12.dp))
                AppTextField(
                    value = address,
                    onValueChange = { address = it },
                    placeholder = "pipod.example.com",
                    enabled = !checking,
                    keyboardOptions = KeyboardOptions(
                        keyboardType = KeyboardType.Uri,
                        autoCorrectEnabled = false,
                        imeAction = ImeAction.Go,
                    ),
                    keyboardActions = KeyboardActions(onGo = { check() }),
                    modifier = Modifier.fillMaxWidth().testTag("server-address"),
                )
                error?.let {
                    Spacer(Modifier.height(10.dp))
                    Text(
                        it,
                        color = appColors.destructive,
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier
                            .testTag("server-error")
                            .semantics { liveRegion = LiveRegionMode.Polite },
                    )
                }
                if (hasServerChoice) {
                    TextButton(onClick = onUseCloud, modifier = Modifier.testTag("server-use-cloud")) {
                        Text("Use pi pod cloud")
                    }
                }
            }
        },
        confirmButton = {
            TextButton(
                onClick = { check() },
                enabled = !checking && address.isNotBlank(),
                modifier = Modifier.testTag("server-continue"),
            ) { Text(if (checking) "Checking…" else "Continue") }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("Cancel") }
        },
    )
}
