# Session core

`com.pipod.app.core.session` and `com.pipod.app.core.credentials` are the
headless half of the live agent session: the WebSocket transport, the transcript
reducer, the remote-UI protocol, and the app-wide signed-in state. Nothing here
imports Compose; a screen observes a `StateFlow` and calls methods.

It is a behavioural port of `pi-pod-flutter/lib/core/session/` and
`lib/core/credentials/`, with one deliberate protocol fix (see
[Dialogs](#dialogs)).

## Wiring

```kotlin
val store = SessionStore(
    api = ApiClientSessionStoreApi(apiClient),
    storage = SecureSessionTokenStorage(context),
    authenticator = /* the OIDC sign-in flow */,
    scope = applicationScope,
)
apiClient.onSessionExpired = store::handleUnauthorized
```

Every class that takes a `CoroutineScope` uses it for its own background work and
**does not cancel a scope you passed in**; a scope it created itself is cancelled
by `dispose()`. Always call `dispose()`.

## Transcript row model

```kotlin
enum class StreamItemStyle { USER, ASSISTANT, TOOL, STATUS }

enum class StreamItemDelivery {
    DELIVERED, SENDING, WAITING_FOR_CONNECTION, SAVED_ON_SERVER, FAILED,
}

data class StreamItem(
    val id: String,                 // "session:seq", or "local:-N" before the echo
    val style: StreamItemStyle,
    val title: String,              // "You" / "pi" / "bash completed"; empty for STATUS
    val text: String,
    val timestamp: java.time.Instant? = null,
    val isInProgress: Boolean = false,
    val isError: Boolean = false,
    val delivery: StreamItemDelivery = StreamItemDelivery.DELIVERED,
    val attachments: List<StreamImageAttachment> = emptyList(),
)

class StreamImageAttachment(
    val id: String = "",            // composer identity, empty for history rows
    val name: String,
    val mimeType: String,
    val bytes: ByteArray,
    val declaredBytes: Int? = null, // only on descriptor placeholders
) {
    val isPlaceholder: Boolean      // no pixels: the bytes never left the pod
    val sizeBytes: Int
}
```

Rows are immutable and replaced in the list, so a Compose `key(item.id)` list
sees a change; the Dart original mutated them in place. The server persists
`user_prompt` images as `{mimeType, bytes}` descriptors, never base64, so a
history row for someone else's turn is a size tile. A live echo adopts the
locally sent bubble instead, and the local bytes stay on the row.

Day grouping and message chrome are **not** ported here — they were
`core/format/transcript_presentation.dart` in Flutter and belong to whoever owns
`core/format`. This package only produces the flat, ordered list.

## `SessionStream`

The reducer. One instance per open pod session.

```kotlin
class SessionStream(
    val podId: String,
    fromSeq: Long?,
    sessionId: String? = null,
    api: SessionApi? = null,
    socketFactory: SessionTransportFactory? = null,
    now: () -> Instant = Instant::now,
    reconnectDelay: (attempt: Int) -> Duration = ::defaultReconnectDelay,  // 1,2,4,…,30s
    scope: CoroutineScope? = null,
)
```

### State

```kotlin
val state: StateFlow<SessionStreamState>
val snapshot: SessionStreamState          // state.value
val items: List<StreamItem>               // snapshot.items
val openDialogs: List<PiDialog>
val lastSeq: Long
val sessionId: String?
val remoteUi: RemoteUiStore
```

```kotlin
data class SessionStreamState(
    val items: List<StreamItem>,
    val openDialogs: List<PiDialog>,
    val availableModels: List<ModelChoice>,
    val availableThinkingLevels: List<String>,
    val isConnected: Boolean,
    val reconnecting: Boolean,
    val reconnectAttempt: Int,
    val isOffline: Boolean,
    val isRunning: Boolean,                // show the working indicator
    val isInterrupting: Boolean,           // Stop was tapped, not yet settled
    val scrollRevision: Int,               // bumped on every transcript mutation
    val scrollIsStreamingUpdate: Boolean,  // true = a delta, not a new row
    val currentModel: ModelChoice?,
    val currentThinkingLevel: String?,
    val hasModelSnapshot: Boolean,         // false = show a neutral placeholder
    val isModelSwitchInFlight: Boolean,
    val isThinkingSwitchInFlight: Boolean,
    val modelCatalogRevision: Int,
    val preparingPod: Pod?,                // non-null while the sandbox boots
    val podRecord: Pod?,
    val isLoadingHistory: Boolean,
    val sessionEnded: Boolean,
    val sessionEndedMessage: String,
    val historyLoadFailed: Boolean,
    val podUnavailable: Boolean,
    val asleep: String?,                   // "stopped" | "archived"
    val waking: Boolean,
    val error: String?,                    // already friendly; render verbatim
    val gatewayError: String?,             // the raw text behind `error`
    val workingMessage: String?,           // extension overrides, null = app default
    val workingVisible: Boolean,
    val workingIndicator: String?,
    val hiddenThinkingLabel: String?,
    val expandedToolDetails: Set<String>,
    val toolsExpandedByExtension: Boolean,
) {
    fun isToolExpanded(key: String): Boolean
}
```

`StateFlow` drops an equal value, so re-asserting the same state during a
streaming burst does not repaint. Watch `scrollRevision` to decide when to
scroll and `scrollIsStreamingUpdate` to decide whether to animate.

### Lifecycle

| Method | Notes |
|---|---|
| `suspend fun open(api: SessionApi)` | The whole entry path: pod snapshot → history → attach. Handles a preparing pod (polls every 2 s) and an asleep pod (history only). |
| `suspend fun openWithClient(client: ApiClient)` | `open(ApiClientSessionApi(client))`. |
| `suspend fun attach(api: SessionApi? = null)` | Mints a **fresh one-shot ticket** and connects. Never reuses a ticket. |
| `fun reattachIfNeeded()` / `fun onForeground()` | Reconnects only a live session that was interrupted. |
| `fun setOffline(offline: Boolean)` | Suppresses reconnect attempts while offline; reattaches on the way back. |
| `fun wake()` | Attaches a sleeping pod; sets `waking` so the boundary row reads "Pod woke up." |
| `fun detach()` | Stops reconnecting and drops the socket. Keeps the transcript. |
| `fun dispose()` | `detach()` + releases `remoteUi` and the notification collector. |

Reconnect backoff is 1, 2, 4, 8, 16, 30, 30 … seconds. A close code decides
whether to retry at all: `4404` pod gone, `4409` unavailable, `4420` asleep,
`4421` pi exited and `4400` bad request all stop; `4001`, `4500`, `1012` and a
bare drop reconnect.

A **session end** is the one path the close never drives: the gateway sends
`session_ended`, then `pod_state: detached`, then closes — and by then
`shouldReconnect` is already false, so `handleDisconnect` is skipped. So
`applySessionEnd` tears the transport down itself (`isConnected = false`, socket
released and disposed, in-flight sends failed) and settles every row that was
still painting. Anything else leaves the snapshot claiming a live connection
over a sleeping pod, which is what `wake()` and the composer both key off.
`endKind` mirrors the server's `sessionEndDisposition` reason for reason,
including `persist_failed` (retryable) and `host_stopped`/`host_archived`
(asleep) — it is the fallback for the `pod_state` frame, which carries no kind.

The gateway refusing the **attach** and the durable queue refusing a **send** are
two independent workstation waits with a slot each: neither cancels the other,
and only the attach-path one may touch `shouldReconnect`, `reconnectJob`,
`asleep` or `waking`. `snapshot.workstationWait` shows the attach wait when both
are running.

### Sending

```kotlin
fun send(text: String, attachments: List<ChatAttachment> = emptyList())
fun retrySend(id: String)
fun discardOutgoing(id: String)
fun interrupt()
```

`send` puts the bubble on screen first and then delivers, so a failure is
visible where the user typed it rather than silent. Delivery outcomes:

* connected → `SENDING`, then `DELIVERED` when the server echoes it back;
* preparing pod, text only → durably queued over REST → `SAVED_ON_SERVER`;
* anything else → `WAITING_FOR_CONNECTION`, flushed on the next `hello`.

An image turn is never downgraded to the durable text queue — that endpoint
persists text only — so it parks in memory instead. `retrySend` reuses the
attachments' ids, so two same-named images stay distinct.

A gateway `error` frame fails every `SENDING` bubble: the gateway answers a
refused turn with that frame and no `user_prompt`, and the echo is the only
thing that ever moves a bubble off `SENDING`. `ChatAttachmentLimits.
maxPromptTextChars` (64 KiB) mirrors the gateway's own bound so the composer can
refuse before that happens. On reconnect the replayed echo of a prompt that was
in flight **adopts** the local bubble rather than appending a second one:
`replayThroughSeq` is the cursor this client had already read, not the hello's
`latestSeq`.

### Models

```kotlin
fun refreshModels()
fun selectModel(model: ModelChoice): Boolean
fun selectThinkingLevel(level: String): Boolean
```

Both return false and set `error` when the pod is not connected. A successful
switch is **optimistic**: `currentModel` moves immediately, `isModelSwitchInFlight`
goes true, and the next catalog snapshot for that field is ignored. This is not
cosmetic — the live gateway takes roughly three seconds to reflect a `set`, so a
`get_models` sent right after the switch really does return the old row.

`hasModelSnapshot` is false until the first `models` frame. Until then show a
placeholder: `hello`'s `state.model` is a stale default and is deliberately never
adopted.

`ModelCatalog.models/providers/modelsIn/providersMatching` order and filter the
picker; the current model sorts first. `ModelChoice` equality is
provider + model id, never the display name.

### Dialogs

When an extension calls `ctx.ui.confirm`, `select`, `input` or `editor`, pi
waits until a client answers. The gateway sends the request as an ephemeral
`extension_ui_request`, live and again on every attach while it is still open,
and sends `dialog_closed` when some client answers it. `openDialogs` is that set,
oldest first: each hello clears it, and the re-sent requests rebuild it.

`PiDialog.from(payload)` reads a request into `title`, `message`, `details`
(pretty-printed sorted JSON), `placeholder`, `prefill` and a `style`:

```kotlin
sealed interface Style {
    data object Confirm
    data class Input(val multiline: Boolean)
    data class Select(val options: List<String>)
    data object Unsupported                     // offer details + cancel only
}
```

Answer with one of the dialog's own builders, so the frame carries
`type: "extension_ui_response"` and pi's request `id`. pi releases the turn only
on that frame; anything else is accepted by the gateway and ignored by pi.

```kotlin
stream.answer(dialog, dialog.confirmed(true))   // or dialog.value(text), dialog.cancelled
```

`answer` sends over the socket, removes the card and appends a receipt row such
as "You confirmed <title>." It returns false while disconnected; the card stays.

### Tool cards

```kotlin
fun setToolExpanded(key: String, expanded: Boolean)
fun isToolExpanded(key: String): Boolean
```

An extension can force every tool card open through a remote-UI control frame;
`snapshot.toolsExpandedByExtension` reflects that and `isToolExpanded` already
accounts for it.

`!command` bash output arrives as `bash_execution_update` keyed by an **RPC
request id**, not a `toolCallId`, so it opens a "Running bash" card of its own
(`bash:<id>`) and `bash_execution_end` settles it. The text is redacted and
truncated like every other visible string, and the accumulator holds the same
64 KiB tail the gateway does (`SessionStream.BASH_OUTPUT_MAX_CHARS`) so the
reattach snapshot is recognised as a prefix and supersedes instead of doubling.
It is cleared on `detach()` and on a session boundary.

Independent `!` bash outlives the agent turn: `agent_settled` and an
agent-idle hello snapshot (`isStreaming`/`pendingMessageCount`) never settle
its card, and later `bash_execution_update` / `bash_execution_end` frames for
the same `id` still apply. Only `bash_execution_end` completes the card (the
end frame carries only the `id`, so the accumulated updates are the text);
without an end frame the card stays "Running bash" rather than reading a
fabricated "bash completed" (`SessionStreamBashSettleTest`).

### Test seams

`ingestForTesting(message)`, `loadHistoryForTesting(pages)`,
`setPodRecordForTesting(pod)`, `markPromptSentForTesting()`,
`markWakingForTesting()`. Pass a `TestScope` as `scope`; never let the default
scope run in a test.

## `SessionSocket`

```kotlin
class SessionSocket(
    val podId: String,
    val fromSeq: Long?,
    val fromSessionId: String?,
    val serverUrl: String = RuntimeConfig.serverUrl,
    webSocketFactory: WebSocket.Factory = defaultWebSocketFactory(),
    val pingInterval: Duration = 25.seconds,
) : SessionTransport
```

Implements `SessionTransport`: `connect(ticket)`, `disconnect(notify)`,
`prompt(text, images)`, `interrupt()`, `requestModels()`,
`uiResponse(response)`,
`set(model, thinkingLevel)`, plus `onMessage` / `onDisconnect` callbacks and the
`isConnected` / `latestSeq` / `sessionId` observables.

Authentication rides the one-shot `ticket` query parameter, not a header, so the
same URL works from a browser. `connectionUrl(ticket)` returns the **http/https**
form — OkHttp upgrades it itself, unlike the Dart client which had to hand a
browser `wss`. Any fragment on the configured server URL is dropped.

The default `webSocketFactory` builds its own `OkHttpClient` with no read
timeout, because a session socket is long-lived and pings itself. Pass
`AppContainer.httpClient` instead to share the app's connection pool — it
already sets a 20 s ping interval — and a reconnect reuses a warm TLS
connection:

```kotlin
SessionStream(
    podId = podId,
    fromSeq = null,
    socketFactory = { pod, seq, session ->
        SessionSocket(pod, seq, session, webSocketFactory = container.httpClient)
    },
    scope = viewModelScope,
)
```

Decoded frames are `SessionServerMessage.Hello | Event | Ephemeral | DialogClosed
| ReplayGap | PodState | PodUpdated | Ended | Models | Pong | Error`. Malformed
and unknown frames are ignored rather than throwing, so a server that ships a new
frame kind costs nothing.

**Callbacks arrive on OkHttp's reader thread.** `SessionStream` serialises them
against user actions with its own lock; a different consumer must do the same.

## `RemoteUiStore` and the remote-UI protocol

`stream.remoteUi` holds the pod's extension-owned TUI surfaces.

```kotlin
val state: StateFlow<RemoteUiSnapshot>      // (surfaces, revision)
val surfaces: List<RemoteUiSurface>         // insertion order = the pod's open order
fun surface(id: String): RemoteUiSurface?
fun withRole(role: RemoteUiRole): List<RemoteUiSurface>
```

A `RemoteUiSurface` exposes `lines` (ANSI text to render), `role`
(`CUSTOM/WIDGET/HEADER/FOOTER/EDITOR`), `placement`, `isOverlay`,
`overlayOptions`, `focused`, `widgetKey`, `editorText`, `readOnly`,
`isAwaitingInput`, and the input path back to the pod: `resize(w, h)`,
`input(data)`, `setText(text)`, `close()`.

`RemoteUiKeys.encode(keyCode, character, control, alt, shift, meta)` turns an
Android key event into the bytes pi-tui would have read from stdin;
`RemoteUiKeys.fromKeyEvent(event)` is the `android.view.KeyEvent` adapter.

Two things the Compose layer has to know:

* `input`, `setText` and `resize` do **not** publish a new snapshot — faithful to
  the Dart, which never notified for locally driven changes. A composer that
  shows `editorText` must hold its own state and only read the surface when a
  pod frame arrives.
* `dispose()` clears the surfaces without emitting, so the last snapshot stays
  observable.

## `SessionStore`

App-wide signed-in state.

```kotlin
val state: StateFlow<SessionStoreState>

data class SessionStoreState(
    val user: AuthUser?,
    val organization: Organization?,
    val currentOrgId: String?,
    val permissions: List<String>,
    val adminConsoleUrl: String?,       // null when this account may not open it
    val isRestoringSession: Boolean,    // starts true; gate the shell on it
    val pendingDeepLink: Any?,
    val authNotice: String?,            // render verbatim
)
```

| Method | Notes |
|---|---|
| `suspend fun restore(showExpiryNotice: Boolean = true)` | Refresh-token rotation, or a web access token validated against `/me`. Re-entrant calls are dropped. |
| `suspend fun signIn(callback: String? = null)` | Needs a `SessionAuthenticator`. |
| `suspend fun applyAuthorization(response)` | Persist + `loadMe`. Idempotent per response, because the browser service calls it from inside the attempt that spent the code as well. |
| `suspend fun signInWithDevToken(token: String)` | Debug bypass; the token is stripped to the JWT alphabet. |
| `suspend fun signOut()` | Clears locally **first**, then tells the provider best-effort. |
| `suspend fun setOrganizationAlias(alias: String)` | Re-authorizes pinned to one org. |
| `suspend fun loadMe()` | |
| `fun setPendingDeepLink(destination)` | |
| `fun handleUnauthorized()` | Wire to `ApiClient.onSessionExpired`. |
| `fun dispose()` | |

A transient outage never destroys credentials: only `OidcSessionExpiredException`
clears them. `SessionKeys.ACCESS/REFRESH/ID_TOKEN` are the storage keys, shared
with whoever wires `ApiClient.onTokensUpdated`.

`SessionTokenStorage` is `suspend read/write/delete`;
`SecureSessionTokenStorage(context)` backs it with
`EncryptedSharedPreferences`. A keystore that refuses degrades to
"nothing stored" — `isPersistent` goes false — instead of failing the launch.

## `LoginSocket`

`core/credentials/LoginSocket` drives a model-provider account login over its own
WebSocket, ticketed through `ApiClient.modelCredentialLoginTicket`.

```kotlin
suspend fun connect()
fun respond(id: String, value: String): Boolean
fun cancel(): Boolean
fun disconnect(notify: Boolean = true)
var onMessage: ((LoginServerMessage) -> Unit)?
var onDisconnect: ((Throwable?) -> Unit)?
```

`LoginServerMessage` is `Prompt | Event | Done`; `LoginEvent` is
`Info | AuthUrl | DeviceCode | Progress`. A `done` frame means the close that
follows is expected, not a dropped connection. Every URL is vetted by
`isSafeLoginUrl` — HTTPS anywhere, plain HTTP only on loopback — before it
reaches presentation code, so an unsafe frame is dropped rather than offered.

## Attachments

`ChatAttachmentLimits` validates images before they are staged: signature
sniffing only (never the suffix), 8 MiB per image, 15 MiB and 5 images per turn,
with a named HEIC refusal. Replay budgets are wider (8 images, 24 MiB) because
the CLI can persist turns the composer would not accept.

`ChatAttachmentPicker` is an interface with no implementation here: on Android the
picker is a `Context`-bound concern (photo picker / SAF) the UI layer owns. Feed
bytes through `ChatAttachmentLimits.readBounded(stream, name, knownSize)` so a
mis-picked multi-gigabyte file is refused without being read into memory.
