# Pod and environment screens

The pod list, pod detail, launch flow, model picker and the environments
(templates) screens, ported from `pi-pod-flutter/lib/features/pods/` and
`pi-pod-flutter/lib/features/templates/`.

Two packages:

- `com.pipod.app.features.pods` — the pod list, the pod detail, the launch
  flow, and the model & thinking picker.
- `com.pipod.app.features.templates` — the environments list, the environment
  detail and the environment editor.

Three rules that hold across both:

1. **Every screen has a stateless twin.** The `viewModel` overload wires the
   real thing; the `state` overload is a pure function of an immutable state
   object, so a UI test renders any variant — loading, empty, failed, filtered
   to nothing, mid-action — with no server.
2. **Dependencies are constructor parameters.** There is no DI framework: a
   screen takes a `PodRepository` / `TemplateRepository` and a `serverHost`,
   and a test substitutes a fake.
3. **Errors reach the reader through `FriendlyError.message(error, host)`.**
   No screen prints an exception.

---

## Pods

| Composable | Signature |
| --- | --- |
| `PodListScreen` | `(viewModel: PodListViewModel, onOpenPod: (Pod) -> Unit, onOpenApprovals: () -> Unit, onLaunchNewPod: () -> Unit, modifier = Modifier, pendingApprovalsCount: Int = 0)` |
| `PodListScreen` | `(state: PodListState, onRefresh, onSearchChange: (String) -> Unit, onApplyFilter: (PodFilter) -> Unit, onClearFilters, onShowAllStatuses, onOpenPod: (Pod) -> Unit, onOpenApprovals, onLaunchNewPod, modifier = Modifier, pendingApprovalsCount: Int = 0, isRefreshing: Boolean = false)` |
| `PodDetailScreen` | `(viewModel: PodDetailViewModel, onBack, onOpenSession, onEditAndRetry: (templateId: String?) -> Unit, onOpenHostPod: (hostPodId: String) -> Unit, onBackToPods, modifier = Modifier, showsOpenSession: Boolean = false)` |
| `PodDetailScreen` | `(state: PodDetailState, onBack, onRefresh, onRunCommand: (String) -> Unit, onCancelWait, onDelete, onOpenSession, onEditAndRetry, onOpenHostPod: (String) -> Unit, onBackToPods, modifier = Modifier, showsOpenSession = false, dialogs = rememberAppDialogHostState(), toastHostState = rememberAppToastHostState())` |
| `LaunchPodScreen` | `(viewModel: LaunchPodViewModel, onLaunched: (Pod) -> Unit, onCancel, modifier = Modifier)` |
| `LaunchPodScreen` | `(state: LaunchPodState, onSelectTemplate: (String?) -> Unit, onLaunch, onRetryLoadTemplates, onCancel, modifier = Modifier)` |
| `ModelPickerButton` | `(state: ModelPickerState, onClick, modifier = Modifier)` |
| `ModelPickerScreen` | `(stream: SessionStream, onDone, modifier = Modifier)` |
| `ModelPickerScreen` | `(state: ModelPickerState, onSelectModel: (ModelChoice) -> Boolean, onSelectThinkingLevel: (String) -> Boolean, onDone, modifier = Modifier, toastHostState = rememberAppToastHostState())` |
| `ProviderPickerScreen` | `(providers: List<String>, models: List<ModelChoice>, selection: String, onSelected: (String) -> Unit, onBack, modifier = Modifier)` |
| `PodStateIcon` | `(presentation: PodPresentation, modifier = Modifier, size: Dp? = null)` |

State and view models:

| Type | Notes |
| --- | --- |
| `PodRepository` / `ApiPodRepository(api)` | `pods`, `templates`, `pod`, `template`, `launch`, `command`, `delete`, `cancelCapacityWait`, `podsPage`, `workstation(hostId)`, `billingAccount()`. |
| `PodListViewModel(repository, currentUserId = null, serverHost = RuntimeConfig.serverUrl)` | `state`, `refresh()`, `refreshPods()`, `refreshBilling()`, `pollIfInitializing()`, `setCurrentUserId()`, `setAccountBilling()`, `setSearch()`, `applyFilter()`, `clearFilters()`, `showAllStatuses()`, `cancelWorkstationWait()`, `retryAfterWorkstationWait()`. |
| `PodListState` | Derived, not stored: `visibleGroups`, `visiblePods`, `showsLocation`, `hiddenByStatus`, `hiddenBreakdown`, `projects`, `environments`, `showsOwnerFilter`, `showsOwnerMetadata`, `showsEmptyState`, `showsInitialSpinner`, `showsNoMatches`, `hasInitializingPod`. |
| `PodDetailViewModel(repository, podId, initialPod = null, serverHost)` | `state`, `events`, `load()`, `refresh()`, `pollIfInitializing()`, `runCommand("archive"\|"restore"\|"stop")`, `cancelCapacityWait()`, `delete()`, `cancelWorkstationWait()`, `retryAfterWorkstationWait()`; `actionLabel(command)` and `isNotFound(error)` on the companion. One read at a time through `RefreshJob`. |
| `PodDetailEvent` | `Toast(message)`, `Deleted`. |
| `LaunchPodViewModel(repository, initialTemplateId = null, isRetry = false, serverHost)` | `state`, `events`, `loadTemplates()`, `selectTemplate(id?)`, `launch()`. |
| `LaunchPodEvent` | `Launched(pod)`. |
| `ModelPickerState` | `from(SessionStreamState)`; `providers`, `allModels`, `modelsIn`, `modelRowEnabled`, `thinkingRowEnabled`, `emptyModelsMessage`, `reconcileProvider`. |
| `ThinkingLevelChoice.label(level)` | `off/minimal/low/medium/high/xhigh`, else capitalised. |

## Environments

| Composable | Signature |
| --- | --- |
| `TemplateListScreen` | `(viewModel: TemplateListViewModel, onOpenTemplate: (PodTemplate) -> Unit, onNewTemplate, modifier = Modifier, dialogs = rememberAppDialogHostState())` |
| `TemplateListScreen` | `(state: TemplateListState, onRefresh, onOpenTemplate: (PodTemplate) -> Unit, onNewTemplate, onDelete: (PodTemplate) -> Unit, modifier = Modifier, dialogs = …)` |
| `TemplateDetailScreen` | `(viewModel: TemplateDetailViewModel, onBack, onEdit: (PodTemplate, EnvironmentEditorData) -> Unit, modifier = Modifier, onChanged: () -> Unit = {}, dialogs = …)` |
| `TemplateDetailScreen` | `(state: TemplateDetailState, onBack, onRefresh, onEdit, onActivate, onDelete, onSecretNameChange: (String) -> Unit, onSecretValueChange: (String) -> Unit, onSaveSecret, onDeleteSecret: (SecretMeta) -> Unit, onDiscardSecretDraft, modifier = Modifier, dialogs = …)` |
| `TemplateEditorScreen` | `(viewModel: TemplateEditorViewModel, onDismiss, onSaved: (PodTemplate, EnvironmentEditorData) -> Unit, modifier = Modifier, dialogs = …)` |
| `TemplateEditorScreen` | `(state: TemplateEditorState, onNameChange, onDescriptionChange, onScriptChange, onBakeScriptChange, onAllowedHostsChange, onEgressModeChange: (String) -> Unit, onIncludeBuiltinsChange: (Boolean) -> Unit, onSave, onDismiss, modifier = Modifier, dialogs = …)` |

| Type | Notes |
| --- | --- |
| `TemplateRepository` / `ApiTemplateRepository(api)` | Every secret call is scoped `"template"`. |
| `TemplateListViewModel(repository, serverHost)` | `state`, `events`, `refresh()`, `delete(template)`. |
| `TemplateDetailViewModel(repository, template, serverHost)` | `state`, `events`, `refresh()`, `setSecretName/Value`, `clearSecretDraft()`, `saveSecret()`, `deleteSecret(secret)`, `activate()`, `deleteTemplate()`, `onSaved(...)`, `editorDataForEditing()`. |
| `TemplateEditorViewModel(repository, template = null, editorData = null, serverHost)` | `state`, `events`, one setter per field, `save()`; `parseHosts(raw)` on the companion. |
| `EgressSettings` (internal) | `from(config)` / `write(config, settings)` — rewrites only `mode`, `builtins` and `allow`, leaving every other server key untouched. |

---

## Semantics labels

Every string below is the exact accessible name. **Do not paraphrase them**:
the acceptance pass finds controls by these.

### Pod list

The list is one lazy item per pod group (`pod-group-<root id>`, or
`pod-pair-<root id>` on a window past 1050.dp), not one item holding the whole
account: an organization can have thousands of pods, and inside a single item
none of them are recycled. The grouping, the hidden-status breakdown and the
location/owner decisions are computed once per (pods, filter, reader) rather
than once per read.

Above the rows, in order: the personal-workstation card when a refresh found the
reader's own machine not ready, the account row, then the approvals row. The
workstation card offers Cancel while it is waiting and Try again once it is over
— never both, because a running wait is already re-issuing the request. While it
is up, neither the first-load spinner nor the "No pods yet" column is drawn.

| Label | Control |
| --- | --- |
| `Refresh pods` | Top-bar refresh (wide windows only) **and** the list's named custom accessibility action. |
| `Filter pods` | Filter glyph while the filter is at rest. Disabled when there are no pods. |
| `Filter pods, showing <summary>` | Filter glyph once a filter is on. `<summary>` is `PodFilter.summary`. |
| `New pod` | The floating action on a phone, and the top-bar add glyph on a wide window. Only one of the two is ever on screen. |
| `New pod from empty state` | The first-run action. It is named for where it is because the floating action is on screen at the same time and also answers to `New pod` — the same split the environments list already makes. |
| `Loading pods` | The first-load spinner (live region). |
| `Try loading pods again` | Empty-state action after a load failure. |
| `Retry refreshing pods` | `RefreshErrorTile` retry above stale rows. |
| `Search pods and projects` | The search field. See "Naming a form field" below. |
| `Clear pod search` | The field's trailing clear glyph. |
| `Clear pod filters` | The "Showing …" row's Clear. |
| `Clear pod filters from empty result` | The no-matches empty-state action. |
| `Show <breakdown>` | Discloses hidden statuses, e.g. `Show 1 archived`. Appears under the list and, when a filter is also on, as the no-matches footer. |
| `Open pod <name>, <status>, <location>[, <provider>][, <project>], <activity>[, Owned by another organization member][, <reason>]` | One pod row. `<provider>` is included only when it differs from `<location>`; `<activity>` is `last used 3m ago` or `no activity yet`. |
| `Open pending approvals, N pending` | The approvals row above the list. |
| `Filter status` / `Filter project` / `Filter environment` | The filter sheet's three pickers. |
| `Only my pods filter` | The filter sheet's switch row. |
| `Cancel pod filters` / `Apply pod filters` | The filter sheet's actions. |

### Pod detail

| Label | Control |
| --- | --- |
| `Back` | The way out (`app-back-button`). |
| `Pod actions` | The overflow glyph; the same name stays on the spinner that replaces it while a delete is in flight. |
| `Refresh pod details` | The named custom accessibility action for pull-to-refresh. |
| `Pod detail: <name>` | A marker naming the screen, since the bar title is only the pod's name. |
| `Status, <label>` / `Status, <label>, <detail>` | The status row (a live region while the lifecycle is transitional). |
| `Restoring pod…` / `Archiving pod…` / `Cancelling capacity wait…` / `Updating pod…` | Replaces the status row while an action is in flight. |
| `Pod failure: <reason>` | The failure paragraph. |
| `Open session for <name>` | Only when `showsOpenSession`; disabled unless the pod can hold a conversation. |
| `Cancel capacity wait for <name>` | Only while a bounded capacity wait is `waiting`. |
| `Edit and retry pod <name>` | A failed launch. Replaces Restore. |
| `Restore pod <name>` | Any pod that is not live and did not fail. |
| `<label>, <value>` | Every information row: `Project`, `Environment`, `Location`, `Host`, `Network`, `Idle timeout`, `Archive after`, and in the launch report `Organization setup` / `Environment setup` / `Project setup`, `Your pi settings`, `Left out`, `Secrets sent`, `Provider`, `Image`. `Host` is also a button. |
| `Expand launch report` / `Collapse launch report` | The disclosure row, with `, <attention>` appended when there is something to look at. Its expanded state is announced separately. |
| `Try refreshing pod details` | The inline refresh-failure card. |
| `Retry loading pod details` | The full-screen load failure. |
| `Loading pod details` | The first-load spinner. |
| `Back to Pods` | The not-found screen's action. |
| `Archive pod` / `Cancel archiving pod` | The archive confirmation. |
| `Delete pod permanently` / `Cancel deleting <name>` | The delete confirmation. |

Overflow sheet items are plain text: `Refresh status`, `Archive`, `Delete pod`.

### Launch flow

| Label | Control |
| --- | --- |
| `Cancel new pod` / `Cancel retry pod` | The leading Cancel. Disabled while a launch is in flight. |
| `Choose pod environment` | Wraps the environment picker. |
| `Launch new pod` / `Retry pod launch` | The primary action (visible text `Launch pod` / `Retry launch`). |
| `Launch pod error` | The failure card (live region). |
| `Launching pod` | The in-flight overlay (live region); its visible text is `Launching pod…`. |
| `Loading environments` | The catalog spinner. |
| `Retry loading environments` | The catalog-failure action. |

### Model & thinking picker

| Label | Control |
| --- | --- |
| `Model: <name>. Thinking: <label>. Choose provider and model` | The toolbar button with a model chosen. Without one it is just `Choose provider and model`; the `Thinking: …` clause is dropped when no level is known. |
| `Done choosing model and thinking level` | The Done action. |
| `Search model names or IDs` / `Clear model search` | The model search field and its clear glyph. |
| `Model catalog error: <error>` | The error notice (live region). |
| `Pod disconnected while choosing a model` | The offline notice, shown only when there is no error. |
| `Provider, <provider>. Choose provider` | The provider row. |
| `Provider, Not available` / `Thinking, Not available` / `Thinking, <label>` | The read-only rows for a section with nothing to choose. |
| `Model <name>, <modelId>, <provider>. <action>` | One model row. |
| `Thinking <label>. <action>` | One thinking row. |

`<action>` is `Currently selected` for the active row, `Switch to this model` /
`Use this thinking level` when the row can be tapped, and otherwise says why it
cannot: `Unavailable while the pod is disconnected` or `Unavailable while a
switch is in progress`. A row in either of those states is also marked
**disabled**, so `assertIsNotEnabled` holds and a screen reader does not offer a
frozen row as an ordinary one. The same applies to an environment row while its
delete is in flight.

| Label | Control |
| --- | --- |
| `Search providers` / `Clear provider search` | The provider picker's field. |
| `Provider <p>, <n> models. Currently selected` / `… Show models from this provider` | One provider row (`1 model` in the singular). |

Toasts: `Switched to <name>.` and `Thinking level changed to <label>.`

### Environments list

| Label | Control |
| --- | --- |
| `Refresh environments` | Top-bar refresh (wide only) and the named custom action. |
| `New environment from toolbar` | The toolbar add glyph. |
| `New environment from empty state` | The first-run action. |
| `Try loading environments again` | The load-failure action. |
| `Retry refreshing environments` | `RefreshErrorTile` above stale rows. |
| `Loading environments` | The first-load spinner. |
| `Open environment <name>` / `Open environment <name>, draft, needs approval` | One row. |
| `Delete environment <name>` | The row's delete glyph. |
| `Confirm delete environment <name>` / `Cancel deleting <name>` | Its confirmation. |
| `Dismiss environment error` | The notice raised when a delete fails. |

### Environment detail

| Label | Control |
| --- | --- |
| `Refresh environment <name>` | The named custom action for pull-to-refresh (reloads secrets **and** editor data). |
| `Edit environment <name>` | The top-bar Edit. |
| `Status, Active` / `Status, Draft — not launchable` | The status row. |
| `Description, <text>` | Present only when there is one. |
| `Activate environment <name>` | Drafts only; visible text becomes `Activating…` in flight. |
| `Confirm activate environment <name>` / `Cancel activating <name>` | Its confirmation. |
| `Setup script: <script>` / `Bake script: <script>` | The selectable script blocks. |
| `Network access, Open` / `Network access, Restricted` | |
| `Built-in services, Allowed` / `Built-in services, Blocked` | |
| `Allowed hosts, <comma list>` / `Allowed hosts, None` | |
| `Environment secret name` / `Environment secret value` / `Save environment secret` | The write-only secret form (from `SecretEntryFields`'s `semanticsPrefix`). |
| `Show secret value for environment secret` / `Hide secret value for environment secret` | The reveal toggle. |
| `Delete environment secret <name>` | One secret's delete glyph. |
| `Confirm delete environment secret <name>` / `Cancel deleting environment secret <name>` | Its confirmation. |
| `Delete detail environment <name>` | The screen's own delete; visible text becomes `Deleting…`. |
| `Confirm delete detail environment <name>` / `Cancel deleting <name>` | Its confirmation. |
| `Success: <message>` / `Error: <message>` | The status card (live region). |
| `Confirm discard unsaved secret` / `Keep editing unsaved secret` | The guard on leaving with a typed but unsaved secret. |

### Environment editor

| Label | Control |
| --- | --- |
| `Cancel New environment` / `Cancel Edit environment` | The leading Cancel. Disabled while saving. |
| `Create environment form` / `Save environment form` | The commit action; disabled until the trimmed name is non-empty. Visible text becomes `Saving…`. |
| `New environment name` / `Edit environment name` | |
| `New environment description` / `Edit environment description` | |
| `New environment setup script` / `Edit environment setup script` | |
| `New environment bake script` / `Edit environment bake script` | |
| `New environment allowed network hosts` / `Edit environment allowed network hosts` | |
| `Confirm discard environment changes` / `Keep editing environment` | The unsaved-changes guard, raised by Cancel and by system back. |

### Naming a form field

`AppTextField(semanticsLabel = …)` puts the name on the field's **content
description** and leaves `label` as the visible floating label, so every field
below is found with `onNodeWithContentDescription`: `Search pods and projects`,
`Search model names or IDs`, `Search providers`, `Environment secret name`,
`Environment secret value`, and every `<subject> …` field in the environment
editor.

The fields are **controlled**: their value comes from the state and nothing
else. A driver that types into one and does not feed the text back will see the
field re-sync to its old text as soon as the next field takes focus, which
looks like the edit being silently undone. The UI tests hold real state for
this reason; a manual pass through the app is unaffected, because the view
model is holding it.

---

## Test tags

| Object | Tags |
| --- | --- |
| `PodListTestTags` | `pod-list-screen`, `pod-list-header`, `pod-list-filter`, `pod-filter-sheet`, `pod-list-approvals`, `pod-list-disclose-hidden`, `podRow(id)` → `pod-row-<id>` |
| `PodDetailTestTags` | `pod-detail-screen`, `pod-detail-marker`, `pod-detail-actions`, `pod-detail-status`, `pod-detail-info`, `pod-detail-launch-report`, `pod-detail-launch-report-toggle`, `pod-detail-failure`, `pod-detail-open-session`, `pod-detail-cancel-wait`, `pod-detail-edit-retry`, `pod-detail-restore`, `pod-detail-error`, `pod-detail-not-found` |
| `LaunchPodTestTags` | `launch-pod-screen`, `launch-pod-cancel`, `launch-pod-launch`, `launch-pod-error`, `launch-pod-launching`, `launch-pod-retry-templates`, and `ENVIRONMENT_PICKER` = `app-option-picker-Environment` (set by `AppOptionPicker` itself) |
| `ModelPickerTestTags` | `model-picker-button`, `model-picker-screen`, `model-picker-done`, `model-picker-provider-row`, `model-picker-models`, `model-picker-thinking`, `model-picker-error`, `model-picker-offline`, `provider-picker-screen`, `provider-picker-list` |
| `TemplateListTestTags` | `environment-list-screen`, `environment-list-new`, `environment-list-drafts`, `environment-list-active`, `row(id)` → `environment-row-<id>` |
| `TemplateDetailTestTags` | `environment-detail-screen`, `environment-detail-edit`, `environment-detail-overview`, `environment-detail-activate`, `environment-detail-setup-script`, `environment-detail-bake-script`, `environment-detail-network`, `environment-detail-secrets`, `environment-detail-delete-section`, `environment-detail-delete`, `environment-status-card` |
| `TemplateEditorTestTags` | `environment-editor-screen`, `environment-editor-cancel`, `environment-editor-save`, `environment-editor-name-section`, `environment-editor-setup-script`, `environment-editor-bake-script`, `environment-editor-network`, `environment-editor-saving`, and `NETWORK_ACCESS_PICKER` = `app-option-picker-Network access` |

Design-system tags these screens also raise: `app-list`, `app-back-button`,
`app-floating-action`, `app-confirm-dialog`, `app-notice-dialog`, `app-sheet`,
`empty-state`, `refresh-error-tile`, `unsupported-list-item`,
`plain-text-editor`, `save-secret`.

Shared feature tags: `workstation-wait-card` (`-elapsed`, `-phase`, `-cancel`,
`-retry`) and `billing-summary-row` / `billing-summary-alert`.

`plain-text-editor` appears **three times** on the environment editor (setup
script, bake script, allowed hosts), so drive those by their accessible names
rather than by the tag.

---

## Deliberate divergences from the Flutter client

- **Timers and lifecycle observers belong to the screen.** The Flutter views own
  a `Timer.periodic` and a `WidgetsBindingObserver`. Here the view model exposes
  `pollIfInitializing()` / `refreshPods()` and the composable drives them from a
  `LaunchedEffect` and a `LifecycleEventEffect(ON_RESUME)`, so a poll dies with
  the screen instead of outliving it.
- **`PopScope` becomes `BackHandler`.** The launch flow blocks back outright
  while a launch is in flight; the editor and the environment detail confirm
  first and then leave. The Cupertino edge-swipe cases have no Android
  counterpart.
- **`AbsorbPointer` becomes a pointer-consuming overlay** on the editor and the
  launch flow, which is the same "the form is inert right now" behaviour.
- **`autofocus`** on the editor's name field and the model search is dropped: it
  raises the keyboard over the form on a phone.
- **`leadingWidth`** is a Cupertino navigation-bar measurement with no Material
  counterpart.
- **Two-column pod cards** keep their seam (`currentWindowWidth() >= 1050.dp`)
  but no phone width reaches it.
- **`showAppNotice` / `showAppConfirm`** become `AppDialogHostState.notice` /
  `.confirm` suspending calls, rendered by one `AppDialogHost` per screen.

## Wiring

Nothing here is reachable yet: `shell/AppNavHost.kt` still routes `pods`,
`pods/{podId}`, `pods/launch` and `settings/environments` to their placeholder
screens, and `AppContainer` builds no repositories. Wiring them needs, per
route:

```kotlin
val pods = ApiPodRepository(container.api)          // com.pipod.app.features.pods
val environments = ApiTemplateRepository(container.api)

// pods
PodListScreen(
    viewModel = viewModel { PodListViewModel(pods, currentUserId = me?.user?.id) },
    onOpenPod = { router.push(Routes.podDetail(it.id)) },
    onOpenApprovals = { router.push(Routes.APPROVALS) },
    onLaunchNewPod = { router.push(Routes.LAUNCH) },
    pendingApprovalsCount = approvals,
)
```

- `currentUserId` comes from `ApiClient.me().user.id`. Until the shell supplies
  it, `onlyMine` and the "Owned by another organization member" row stay off —
  which is the same thing the Flutter client does before `me` resolves.
- `pendingApprovalsCount` is the count the shell already computes for the tab
  badge.
- `PodDetailScreen`'s `onEditAndRetry(templateId)` builds
  `/pods/launch?retry=1[&templateId=…]`; `LaunchPodViewModel` then takes
  `initialTemplateId` and `isRetry` from those query parameters. Retry mode
  travels explicitly because an empty pod carries no environment to infer it
  from.
- The launch route owns success navigation: `onLaunched` should
  `router.replace(Routes.podDetail(pod.id))`, and the screen deliberately does
  not leave by itself.
- `TemplateDetailScreen`'s `onEdit` receives the `EnvironmentEditorData` the
  detail already fetched; hand it straight to `TemplateEditorViewModel`.

## Known gaps

- The `androidTest` Compose suites in both packages **compile but have not been
  run**: the orchestrator owns the one device. They are written against the
  labels above, so they double as the acceptance-pass script.
- `PodListScreen` renders its own scaffold rather than `AppListScaffold`,
  because the search field and the "Showing …" row have to stay pinned above
  the scrolling rows the way the Flutter `SliverPersistentHeader` does. It
  raises the same `app-list` tag and the same named refresh action.
