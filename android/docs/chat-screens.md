# Chat screens

The conversation surface: `com.pipod.app.features.session`. Ported from
`pi-pod-flutter/lib/features/session/`.

Everything here renders `com.pipod.app.core.session` — see
[`session-core.md`](session-core.md) — through the widget vocabulary in
[`design-system.md`](design-system.md). Nothing in this layer parses a payload,
formats a timestamp or decides what a dialog means; it draws what those two
already decided.

Two conventions hold across every screen below.

1. **Each screen composable comes in two forms**: one that takes the live
   `ViewModel` (or `SessionStream`) and one that is a pure function of a
   hand-made state object. The second is what a Compose UI test drives, so
   every state — preparing, asleep, mid-interrupt, history failed — can be put
   on screen without a server.
2. **Accessibility names are the API.** The manual acceptance pass drives this
   app through the accessibility tree, so every label below is exact, including
   `’`, `—` and `…`. Test tags are for the containers a driver has to find
   rather than name.

One ordering rule follows from how Compose collapses a layout node's semantics:
**`Modifier.testTag(...)` must be declared *before* `Modifier.clearAndSetSemantics { }`**
on the same node. The collapse resets the accumulated configuration when it
reaches a clearing modifier, so a tag declared after one is silently discarded
and the driver cannot find the node at all. Every cleared node in these two
packages is written tag-first.

---

## `SessionRoute`

`features/session/SessionRoute.kt`. Resolves the pod a deep link names before
the transcript opens: a push notification carries only an id, and the header
needs a real pod to title itself with.

```kotlin
@Composable
fun SessionRoute(
    podId: String,
    client: ApiClient,
    drafts: SessionDraftStore,
    modifier: Modifier = Modifier,
    initialPod: Pod? = null,
    fromSeq: Long? = null,
    sessionId: String? = null,
    onOpenPodDetails: (Pod) -> Unit = {},
    onOpenModelPicker: (SessionStream) -> Unit = {},
    onBack: () -> Unit = {},
)
```

It builds the `SessionViewModel` through `SessionViewModel.create(...)` and
renders one of three things: a spinner, a load failure, or `SessionScreen`.

| | |
| --- | --- |
| Semantics | `Loading conversation` |
| Failure copy | `FriendlyError.message(error, RuntimeConfig.serverUrl)`, verbatim |
| Buttons | `Retry`, `Back to pod` |
| Test tags | `session-route-loading`, `session-route-failure`, `session-route-retry`, `session-route-back` |

---

## `SessionScreen`

`features/session/SessionScreen.kt`.

```kotlin
@Composable
fun SessionScreen(
    viewModel: SessionViewModel,
    modifier: Modifier = Modifier,
    onOpenPodDetails: (Pod) -> Unit = {},
    onOpenModelPicker: (SessionStream) -> Unit = {},
    onNavigateBack: (() -> Unit)? = null,
)

@Composable
fun SessionScreen(
    state: SessionState,
    actions: SessionScreenActions,
    modifier: Modifier = Modifier,
    listState: LazyListState = rememberLazyListState(),
)
```

`SessionScreenActions` is one bundle rather than fifteen parameters, so a test
that only cares about Send does not have to name the other fourteen:

```kotlin
data class SessionScreenActions(
    val onDraftChange: (String) -> Unit = {},
    val onSend: () -> Unit = {},
    val onInterrupt: () -> Unit = {},
    val onAttach: () -> Unit = {},
    val onRemoveAttachment: (String) -> Unit = {},
    val onRetrySend: (String) -> Unit = {},
    val onDiscardOutgoing: (StreamItem) -> Unit = {},
    val onRetryConnection: () -> Unit = {},
    val onWake: () -> Unit = {},
    val isToolExpanded: (String) -> Boolean = { false },
    val onToolExpandedChanged: (String, Boolean) -> Unit = { _, _ -> },
    val onAnswerDialog: (PiDialog, JsonObject) -> Boolean = { _, _ -> false },
    val onOpenPodDetails: (Pod) -> Unit = {},
    val onOpenModelPicker: () -> Unit = {},
    val onNavigateBack: (() -> Unit)? = null,
)
```

### Layout, top to bottom

connection banner → remote-UI header band → transcript (with the jump control
and the overlay layer stacked over it) → remote-UI widgets placed
`ABOVE_EDITOR` → remote-UI editor panel → composer → widgets placed
`BELOW_EDITOR` → remote-UI footer band.

The transcript is a `LazyColumn` keyed by `TranscriptRow.id`, `dialog-<id>`,
`typing` and `transcript-tail`, so a streaming token updates one row instead of
rebuilding the list. It stays viewport-wide and gets the reading-column limit as
padding (`PaddingValues.centeredIn(viewportWidth)`), so a fling over the gutter
still scrolls.

### Follow-to-bottom

`followsLatest` starts true. Dragging away from the bottom turns it off and
records how many rows the reader had already seen; returning to the bottom
re-arms it. A scroll happens only when the reducer's `scrollRevision` changes,
and it animates only when `scrollIsStreamingUpdate` is false — streaming deltas
arrive many times a second and animating each one makes the transcript judder.
Dragging the transcript also dismisses the soft keyboard.

### Top bar

| Element | Name |
| --- | --- |
| Title | `SessionState.titleSemanticsLabel` — `"<pod name>"`, or `"<pod name>, <status>"` |
| Info action | `Pod details` (tag `session-pod-details`) |
| Model action | `ModelPickerButton(ModelPickerState.from(state.stream))`, tag `model-picker-button` |
| Back | `Back` (the design system's `AppBackButton`), tag `app-back-button` |

### `SessionState` — the derived wording

```kotlin
data class SessionState(
    val pod: Pod,
    val stream: SessionStreamState = SessionStreamState(),
    val remoteUi: RemoteUiSnapshot = RemoteUiSnapshot(),
    val draft: String = "",
    val attachments: List<ChatAttachment> = emptyList(),
    val attachError: String? = null,
    val isPickingImages: Boolean = false,
)
```

`livePod` prefers the stream's own record. `composer` projects a
[`ComposerState`](#composerbar).

`composerPlaceholder`, in order: `Message pi…` when connected,
`Message pi (sends when ready)…` while the sandbox prepares,
`Message pi (wakes the pod)…` when asleep, `Message pi (sends on reconnect)…`
otherwise.

`statusSubtitle` is null in the happy case — a persistent "Connected" next to
the pod name is noise. Otherwise, in order: `Preparing sandbox`, `Unavailable`,
`Couldn’t connect`, `Offline`, `Waking from storage…` / `Waking…`, `Asleep`,
`Reconnecting…` / `Connecting…`, and `pi is working` only while the transcript
and the open dialogs are both still empty.

### Connection banner

One live-region node per state, with the recovery beside the explanation.

| State | Text | Action |
| --- | --- | --- |
| preparing | `Sandbox is initializing — messages are saved until it is ready.` | — |
| unavailable | `This pod is unavailable. Check its status on the pod screen, then retry.` | `Retry` |
| error | `state.error`, or `FriendlyError.message(gatewayError)` when the raw text is known | `Retry` |
| offline | `Offline — reconnecting when the network returns` | `Retry` |
| waking | `Waking pod from cold storage — seconds-to-minutes depending on workspace size…` / `Waking pod…` | — |
| asleep | `Pod is asleep — sending a message wakes it.` | `Wake` |
| connecting | `Connecting…` / `Reconnecting…` / `Reconnecting… (attempt N)` | `Retry now` while reconnecting |

Tags: `connection-banner`, `connection-banner-action`.

### Transcript header states

| State | What it shows |
| --- | --- |
| preparing pod | [`SandboxPreparationView`](#sandboxpreparationview) |
| history failed and nothing to show | notice `Conversation history couldn’t be loaded` / `Retry to load the earlier messages. Sending still works.` / `Retry`, tag `transcript-notice` |
| history loading | spinner named `Loading conversation`, tag `transcript-loading` |
| nothing at all | [`ConversationEmptyState`](#transcript-rows) |

Tags: `session-screen`, `session-transcript`.

---

## `SessionViewModel`

`features/session/SessionViewModel.kt`.

```kotlin
class SessionViewModel(
    val stream: SessionStream,
    private val drafts: SessionDraftStore,
    initialPod: Pod,
    private val api: SessionApi? = null,
    private val ownsStream: Boolean = true,
) : ViewModel() {
    val state: StateFlow<SessionState>

    fun onDraftChange(text: String)
    fun send()
    fun interrupt()
    fun retrySend(id: String)
    fun discardOutgoing(item: StreamItem)
    fun setPickingImages(picking: Boolean)
    fun onImagesPicked(picked: List<ChatAttachment>)
    fun onAttachFailed(message: String)
    fun removeAttachment(id: String)
    fun retryConnection()
    fun wake()
    fun onForeground()
    fun setOffline(offline: Boolean)
    fun setToolExpanded(key: String, expanded: Boolean)
    fun answer(dialog: PiDialog, response: JsonObject): Boolean

    companion object {
        fun create(client: ApiClient, drafts: SessionDraftStore, pod: Pod,
                   fromSeq: Long? = null, sessionId: String? = null): SessionViewModel
    }
}
```

`discardOutgoing` moves the message's text **back into the composer** instead of
dropping it, so a mis-tap never destroys a long draft.

### Answering a dialog

When an extension calls `ctx.ui.confirm`, `select`, `input` or `editor`, pi
waits for an answer. The stream keeps those as `openDialogs` (see
[`session-core.md`](session-core.md#dialogs)) and the transcript ends with one
`DialogCard` per dialog. `answer` sends the `extension_ui_response` over the
socket and returns false while disconnected, which the card shows as
`Not connected. pi is still waiting; answer again once the conversation reconnects.`

Answer shapes, built by `PiDialog`: confirm `{"confirmed": …}`, select, input and
editor `{"value": …}`, cancel `{"cancelled": true}`, each with the frame `type`
and pi's request `id`.

---

## `ComposerBar`

`features/session/ComposerBar.kt`.

```kotlin
data class ComposerState(
    val text: String = "",
    val placeholder: String = "Message pi…",
    val attachments: List<ChatAttachment> = emptyList(),
    val attachError: String? = null,
    val isRunning: Boolean = false,
    val isInterrupting: Boolean = false,
    val isConnected: Boolean = false,
    val canAttach: Boolean = true,
) { val canSend: Boolean }

@Composable
fun ComposerBar(
    state: ComposerState,
    onValueChange: (String) -> Unit,
    onSend: () -> Unit,
    onInterrupt: () -> Unit,
    modifier: Modifier = Modifier,
    onAttach: () -> Unit = {},
    onRemoveAttachment: (String) -> Unit = {},
    focusRequester: FocusRequester? = null,
)
```

Send stays available while pi is working so a follow-up can queue. Stop only
becomes actionable for the turn that can be interrupted, but keeps its place in
the bar so the field never resizes under a thumb already moving toward Send.

`PromptLimits.maxPromptTextChars` (64 KiB) mirrors the gateway's
`MAX_PROMPT_TEXT_CHARS`. Past 90% of it the bar shows a count-remaining caption
(`composer-length`); past it, `SessionViewModel.send` refuses, leaves the draft
untouched and puts `PromptLimits.tooLong(length)` in the composer's error line —
sending it would only produce a bubble the gateway rejects on arrival, with a
Retry that fails the same way forever.
Autocorrect and suggestions are off: prompts to a coding agent are full of
commands and flags, and autocorrect turns "sudo" into "Audi".

| Element | Name | Tag |
| --- | --- | --- |
| bar | — | `session-composer` |
| field | its placeholder (the design system names a `Pill` field on its own node) | `composer-field` |
| attach | `Attach image` | `composer-attach` |
| interrupt | `Interrupt current turn` | `composer-interrupt` |
| interrupt, mid-stop | `Stopping the current turn` (still a node, reported disabled) | `composer-interrupt` |
| send | `Send message` | `composer-send` |
| strip | `1 image attached, <name>` / `N images attached, <name>, <name>` | `composer-attachments` |
| thumbnail | `Attached image, <name>` | `composer-attachment-<id>` |
| remove | `Remove image, <name>` | `composer-remove-attachment-<id>` |
| error | `Image attachment error, <message>` (live region) | `composer-attach-error` |

`attachmentStripLabel(attachments)` is the internal helper that builds the
strip's name, so a test can assert the exact string without a composition.

---

## Transcript rows

`features/session/TranscriptWidgets.kt`. Every one is a pure function of its
arguments — expansion lives on the session stream, drafts live in the composer.

Tapping a suggestion chip fills the composer **and focuses it** — the screen
holds a `FocusRequester` and hands it to `ComposerBar`. A chip that silently
fills a field the reader cannot see, with no keyboard, reads as having done
nothing. It never sends: a suggestion that fires a model turn spends money the
reader has not confirmed.

```kotlin
val TranscriptMeasure: Dp = 560.dp
val ConversationSuggestions: List<String>   // "What's in this workspace?",
                                            // "Summarize recent changes", "Help me fix a bug"

@Composable fun DaySeparator(title: String, modifier: Modifier = Modifier)
@Composable fun TypingIndicator(label: String? = null, modifier: Modifier = Modifier)
@Composable fun JumpToLatestButton(newMessageCount: Int, onClick: () -> Unit, modifier: Modifier = Modifier)
@Composable fun ConversationEmptyState(onChooseSuggestion: (String) -> Unit, modifier: Modifier = Modifier)

@Composable
fun EventRow(
    item: StreamItem,
    modifier: Modifier = Modifier,
    chrome: MessageChrome = MessageChrome.STANDALONE,
    thinkingLabel: String? = null,
    onRetry: () -> Unit = {},
    onDiscard: () -> Unit = {},
)

@Composable
fun ToolActivityCard(
    items: List<StreamItem>,
    isExpanded: (String) -> Boolean,
    onExpandedChanged: (String, Boolean) -> Unit,
    modifier: Modifier = Modifier,
)

// features/session/DialogCard.kt
@Composable
fun DialogCard(
    dialog: PiDialog,
    onAnswer: (JsonObject) -> Boolean,
    modifier: Modifier = Modifier,
)
```

Internal, so the wording can be tested without a composition:
`transcriptAccessibilityText(item, sender, timeLabel)`,
`toolActivitySummary(items)`, `toolActivityLabel(items)`,
`toolActivityGroupId(items)`.

### Names

| Row | Name |
| --- | --- |
| day header | the title itself, announced as a heading |
| status / tool line | `item.text` |
| user bubble | `transcriptAccessibilityText(item, "You", timeLabel)` |
| assistant block | `transcriptAccessibilityText(item, "pi", timeLabel)` |
| — that is | `"<sender>, <time>, Error, N images attached, <body or Thinking>, <delivery>"`, comma-joined, omitting what does not apply |
| — delivery suffixes | `Sending`, `Waiting for connection`, `Saved on the server`, `Not delivered` |
| bubble custom action | `Copy message` (long-press does the same and toasts `Copied`) |
| attachment strip | `1 image attached, <name>` / `N images attached` |
| placeholder tile | `<name>, <size>, sent earlier` |
| retry | `Send this message again` |
| delete | `Delete this undelivered message` |
| tool card | `toolActivityLabel(items)` — the summary, plus `, N failed` — with the hint `Shows what each tool did` and an Expanded/Collapsed state |
| tool detail row | `item.title` |
| typing indicator | the extension's label, or `pi is working…` |
| jump control | `N new messages. Scroll to latest`, or `Scroll to latest messages` |
| suggestion chip | the suggestion text |
| dialog card details | `Complete request details`, with an Expanded/Collapsed state |
| dialog buttons | `Confirm <title>` / `Decline <title>`, `Submit response for <title>` / `Submit choice for <title>`, `Cancel question <title>`; the field is `Response for <title>` |

Visible delivery footers, which are not names: `Sending…`,
`Waiting for connection`, `Saved — sends when the pod is ready`,
`Not delivered`.

### Tags

`transcript-day-separator`, `transcript-typing-indicator`, `jump-to-latest`,
`transcript-empty-state`, `transcript-suggestion-<index>`,
`transcript-row-<item id>`, `transcript-row-retry`, `transcript-row-discard`,
`transcript-tools-<first item id>`, `transcript-tool-detail-<item id>`,
`dialog-card-<pi request id>`, `dialog-card-details`, `dialog-confirm`,
`dialog-decline`, `dialog-input`, `dialog-options`, `dialog-submit`,
`dialog-cancel`.

---

## `MarkdownText`

`features/session/MarkdownText.kt`. Renders pi's markdown replies with no
external dependency: `core/format/MarkdownBlock` already parsed the block
structure, and `MarkdownInlineToken` here is a bounded reimplementation of only
the inline syntax pi actually emits.

```kotlin
@Composable fun MarkdownText(text: String, modifier: Modifier = Modifier)
@Composable fun MarkdownInline(content: String, modifier: Modifier = Modifier, style: TextStyle? = null)

data class MarkdownInlineToken(
    val text: String,
    val bold: Boolean = false,
    val italic: Boolean = false,
    val code: Boolean = false,
    val link: String? = null,
) { companion object { fun parse(input: String): List<MarkdownInlineToken> } }
```

Code spans win over emphasis, `` `` `` and `****` render verbatim rather than as
empty marks, `_` emphasis is refused intraword so `some_function_name` survives,
and anything unrecognised is shown as typed rather than eaten.

Links are `LinkAnnotation.Url` runs, which Compose gives the link role and tap
target for free — this replaces the Dart's `WidgetSpan` + `GestureDetector` +
`Semantics(link: true)` workaround.

**Only a URL `core/format/SafeExternalUrl` accepts becomes one.** Transcript
markdown is model output, so the scheme is a security boundary: `http`, `https`
and `mailto` (no userinfo, no whitespace, no control characters) are tappable and
everything else — `file:`, `intent:`, `market:`, `tel:`, `pipod:` — renders as
the original `[label](url)` text, unstyled and inert. A tap raises the screen's
`LocalAppDialogHost` (or the renderer's own) naming the destination host —
`Open example.com?` — because the label is arbitrary text and there is no hover
on a phone; only an accepted confirmation reaches `LocalUriHandler.openUri`, and
that call is wrapped.

| Element | Name | Tag |
| --- | --- | --- |
| root | — | `markdown-text` |
| code / table panel | — | `markdown-code-panel` |
| copy button | `Copy code` (toasts `Copied`) | `markdown-copy` |

---

## `SandboxPreparationView`

`features/session/SandboxPreparationView.kt`. A spinner alone leaves the user
guessing whether a slow bake script is progress or a hang, so every stage is
named and carries its own status.

```kotlin
@Composable fun SandboxPreparationView(pod: Pod, modifier: Modifier = Modifier)

data class PreparationStage(val label: String, val detail: String, val status: String)

object SandboxPreparation {
    fun stages(pod: Pod): List<PreparationStage>
    fun stageDetail(status: String): String
    fun initLabel(scope: String): String
    const val WAITING_FOR_CAPACITY = "waiting-for-capacity"
}
```

Headline `Preparing your sandbox`; body `You can send a message now. It is
saved on the server and starts automatically when setup finishes.`
Each stage row is one node named `"<label>, <detail>"`. Stage labels:
`Runtime image`, `Sandbox`, `Pi providers`, `Bake script`,
`<Organization|Environment|Project|…> setup`. Details: `Ready`, `Not needed`,
`Waiting`, `Finished with a warning`, `Failed`, plus the in-flight phrasings
`Building the required image`, `Creating and starting the sandbox`,
`Installing Claude Agent SDK and Meta OAuth support`,
`Running the environment bake script`, `Running the init script`.

A pod the server reports as `waiting-for-capacity` has no sandbox at all: the
Sandbox stage runs rather than reading `Ready`, and its detail is
`Waiting for capacity`, with `· ~Ns left` appended when the pod carries a live
capacity wait with a deadline — the same reading the pod status line quotes.

Tags: `sandbox-preparation`, `sandbox-stage-<index>`.

---

## Drafts and attachments

`features/session/SessionDraftStore.kt`,
`features/session/AndroidAttachmentPicker.kt`.

```kotlin
interface SessionDraftStore {
    fun read(podId: String): String
    fun write(podId: String, draft: String)
    companion object { fun keyFor(podId: String): String; const val PREFERENCES_NAME: String }
}
class SharedPreferencesSessionDraftStore(context: Context) : SessionDraftStore
class InMemorySessionDraftStore(initial: Map<String, String> = emptyMap()) : SessionDraftStore

```

An empty draft removes its entry rather than storing `""`. A preferences
backend that refuses degrades to "nothing stored": drafts are a convenience and
a session is still usable without them.

```kotlin
class AndroidAttachmentPicker(private val contentResolver: ContentResolver) {
    fun stage(uris: List<Uri>, existing: List<ChatAttachment>): List<ChatAttachment>
}

@Composable
fun rememberAttachmentPicker(
    existing: () -> List<ChatAttachment>,
    onPicked: (List<ChatAttachment>) -> Unit,
    onError: (String) -> Unit,
    onPickingChanged: (Boolean) -> Unit = {},
): () -> Unit
```

Over the system photo picker (`PickMultipleVisualMedia`). Every limit and every
refusal message comes from `ChatAttachmentLimits`: the stat size is checked
before a byte is read, so a mis-picked multi-gigabyte file is refused rather
than loaded. An attachment's id is its URI, so a retry reuses it and two
same-named images stay distinct.

---

## Remote UI

See the [`RemoteUiStore`](session-core.md#remoteuistore-and-the-remote-ui-protocol)
section for the protocol. `features/session/RemoteUiSurfaceView.kt` and
`features/session/RemoteUiLayers.kt` render it.

```kotlin
@Composable
fun RemoteUiSurfaceView(
    surface: RemoteUiSurface,
    viewportRows: Int,
    revision: Long,
    modifier: Modifier = Modifier,
    interactive: Boolean = false,
    autofocus: Boolean = false,
    maxHeight: Dp? = null,
)

@Composable fun RemoteUiBand(surface: RemoteUiSurface, viewportRows: Int, isHeader: Boolean, revision: Long, modifier: Modifier = Modifier)
@Composable fun RemoteUiWidgetStack(surfaces: List<RemoteUiSurface>, viewportRows: Int, revision: Long, modifier: Modifier = Modifier)
@Composable fun RemoteUiEditorPanel(surface: RemoteUiSurface, viewportRows: Int, revision: Long, modifier: Modifier = Modifier)
@Composable fun RemoteUiOverlayLayer(surfaces: List<RemoteUiSurface>, viewportRows: Int, revision: Long, modifier: Modifier = Modifier)
@Composable fun RemoteUiKeyBar(onKey: (String) -> Unit, onToggleControl: () -> Unit, controlArmed: Boolean = false, modifier: Modifier = Modifier)

@Immutable
data class RemoteUiOverlayGeometry(
    val width: Dp, val maxHeight: Dp, val alignment: Alignment,
    val offset: DpOffset, val margin: PaddingValues,
) {
    companion object {
        fun resolve(
            viewportWidth: Dp, viewportHeight: Dp, metrics: AnsiCellMetrics,
            options: RemoteUiOverlayOptions?, lineCount: Int, widestLine: Int,
        ): RemoteUiOverlayGeometry
    }
}

internal fun remoteUiSemanticsLabel(surface: RemoteUiSurface): String
```

### Why `revision` is a parameter

Surfaces are mutated in place, and `input` / `setText` / `resize` deliberately
publish no snapshot, so Compose would skip a repaint the pod actually asked for.
The caller passes `RemoteUiStore.state.value.revision`, which makes the
composable non-skippable exactly when the pod repainted. It is a parameter
rather than a `key(revision) { }` wrapper because the wrapper would destroy the
editor's focus and scroll position on every pod-side tick — and the pod ticks
continuously (a live REMOTEUI turn on the dev backend repaints every open
surface roughly once a second).

### Names and tags

| Element | Name | Tag |
| --- | --- | --- |
| any surface | `remoteUiSemanticsLabel(surface)` — `Extension header` / `Extension footer` / `Extension panel` / `Extension editor` / `Extension surface`, then `". "` and the ANSI-stripped text | `remote-ui-surface-<id>` |
| header / footer band | — | `remote-ui-header`, `remote-ui-footer` |
| widget stack | — | `remote-ui-widgets`, `remote-ui-widget-<id>` |
| editor | its placeholder, `Extension input…` | `remote-ui-editor`, `remote-ui-editor-field` |
| overlay panel | unnamed traversal group | `remote-ui-overlay-<id>` |
| overlay close | `Dismiss extension surface` | `remote-ui-overlay-close-<id>` |
| key bar | — | `remote-ui-key-bar` |
| keys | `Send Esc`, `Send Tab`, `Send ←`, `Send ↓`, `Send ↑`, `Send →`, `Send ⏎` | `remote-ui-key-Esc` … `remote-ui-key-⏎` |
| Ctrl chip | `Control armed for the next key` / `Arm control for the next key`, reported selected | `remote-ui-key-Ctrl` |
| soft-keyboard capture | silenced | `remote-ui-capture` |

Visible strings with no name of their own: `Controlled by another client` (the
read-only banner) and `Extension` (the overlay caption).

On a phone the pod's `focused: true` is recorded but never turns into a
`requestFocus()`: auto-focusing would hand primary focus to the hidden capture
field, so tapping the surface would *dismiss* an open keyboard instead of
raising one. Tap-to-focus replaces it, which is what the Dart does on every
touch target too.

---

## Known gaps

- **The extension editor does not move the caret to the end** when a pod frame
  replaces its text. `AppTextField` hoists a `String`, not a `TextFieldValue`,
  so there is no selection to set; fixing it needs a selection seam on the
  design-system field.
- **An overlay's `anchor: "left"/"right"` resolves as Start/End**, so under RTL
  it lands on the opposite side from the pod's intent. `BiasAbsoluteAlignment`
  would be the literal port.
- **`enableSuggestions: false` has no Compose analogue.** Fields use
  `autoCorrectEnabled = false` + `KeyboardCapitalization.None`;
  `TYPE_TEXT_FLAG_NO_SUGGESTIONS` is not reachable through `KeyboardOptions`.
- **Desktop-only affordances are gone rather than always-false**: send-on-Return,
  the always-visible scrollbar thumb, and the trackpad scroll passthrough over a
  code block.

---

## Verified against the dev backend

The isolated dev gateway (`dev/main-fake.mts`) with its **scripted, deterministic
fake agent** — not a real model and not a real sandbox — was driven directly at
the REST/WS boundary these screens sit on:

- A dialog answered with the answer object plus
  `"type": "extension_ui_response"` released the agent's blocked turn within
  about half a second for a CONFIRM and for a SELECT answered with
  `{"value": …}`. Without that key the same turn hangs until the agent's own
  120-second ask timeout. (Measured when answers still went through the
  retired REST resolve; the socket path forwards the same frame.)
- A TOOL turn produces `tool_execution_start` / `tool_execution_end` events —
  what the reducer folds into the `TOOL` rows `ToolActivityCard` groups.
- A REMOTEUI turn opens all five surface roles at once (header, footer, two
  widgets, an editor and a custom overlay) plus the control frames
  `setWorkingVisible`, `setWorkingMessage`, `setToolsExpanded` and
  `setHiddenThinkingLabel`, and then **repaints every open surface about once a
  second with an incrementing revision** — which is why the remote-UI
  composables take `revision` explicitly rather than being wrapped in `key`.

Not verified here: anything that needs a device. The on-device acceptance pass
owns the rendering, the gestures and the instrumented tests.
