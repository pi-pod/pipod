# Jobs and Settings screens

The third top-level tab (Jobs) and the second (Settings), ported from
`pi-pod-flutter/lib/features/jobs/` and `pi-pod-flutter/lib/features/settings/`.

Every screen comes in two forms: one taking its view model, and one taking a
hand-made state object plus callbacks. The second is what a Compose UI test —
and the on-device acceptance pass — drives, so no screen needs a server to be
looked at.

---

## Jobs

`com.pipod.app.features.jobs`

### Composables

| Composable | Signature |
| --- | --- |
| `JobsListScreen` | `(viewModel: JobListViewModel, onOpenJob: (Job) -> Unit, modifier, selectedJobId: String? = null, dialogs: AppDialogHostState)` |
| `JobsListScreen` | `(state: JobListState, onRefresh: () -> Unit, onOpenJob: (Job) -> Unit, onDelete: (Job) -> Unit, modifier, selectedJobId: String? = null, dialogs, toastHostState)` |
| `JobDetailScreen` | `(viewModel: JobDetailViewModel, onBack: () -> Unit, onOpenPod: (String) -> Unit, modifier, onDeleted: (() -> Unit)? = null, dialogs)` |
| `JobDetailScreen` | `(state: JobDetailState, onBack: () -> Unit, onRefresh: () -> Unit, onCommand: (String) -> Unit, onDelete: () -> Unit, onOpenPod: (String) -> Unit, modifier, dialogs)` |

There is no jobs-specific split composable. The jobs tab is a plain list that
pushes `Routes.jobDetail(id)`; the only adaptive seam it sits inside is
`AdaptiveShell`, which moves the tab bar between the bottom and the side.
`selectedJobId` marks a row and stays for a future two-pane host.

A job the server marks `scope = "org"` is shared with the whole organization.
The list row carries a `Shared with org` chip (`JobListTestTags.shared(id)`) —
short because `StatusChip` caps itself at 128dp — while the row's accessible
name and the detail's `Scope` row (`JobDetailTestTags.SCOPE`) both say
`Shared with organization` in full. Pause and delete each ask first, in the
words of `JobScopeCopy`: acting on one of those affects everybody.

### View models and helpers

| API | Signature |
| --- | --- |
| `JobListViewModel` | `(repository: JobRepository, serverHost: String? = RuntimeConfig.serverUrl, onDraftCountChanged: ((Int) -> Unit)? = null)` |
| `JobDetailViewModel` | `(repository: JobRepository, jobId: String, initialJob: Job? = null, serverHost: String? = RuntimeConfig.serverUrl)` |
| `ApiJobRepository` | `(api: ApiClient)` — implements `JobRepository` |
| `JobNotifications` | `changed: SharedFlow<Unit>` / `postChanged()` |
| `selectedJobIdFromJobsLocation` | `(location: String): String?` |
| `jobStatusText` | `(job: Job, now: Instant = Instant.now()): String` |
| `jobNextRunLabel` | `(isoString: String, now: Instant = Instant.now()): String` |
| `humanizeJobRunStatus` | `(status: String): String` |

`onDraftCountChanged` feeds the Jobs tab badge (`SessionStore.setJobDraftsCount`).
A command or a delete in the detail calls `JobNotifications.postChanged()`, which
a mounted list collects and refreshes on.

`JobDetailViewModel` folds Flutter's `JobDetailRoute` in: pass `initialJob` when
a row was tapped and the detail opens on content, or omit it for a deep link and
the screen shows the `Loading job` spinner until the id resolves.

### Semantics labels — Jobs list

| Label | On |
| --- | --- |
| `Jobs` | the top-bar title (a heading) |
| `Refresh jobs` | the toolbar action (wide windows) and the pull-to-refresh custom action |
| `Loading jobs` | the first-load column, a live region; the visible text is `Loading jobs…` |
| `No jobs yet` / `Couldn’t load jobs` | the empty state's title |
| `Try loading jobs again` | the empty state's retry, only after a failure |
| `Retry refreshing jobs` | the refresh-error tile above stale rows |
| `Open job {name}, {schedule}, {status}` | the row; `{schedule}` is `JobSchedule.summary`, `{status}` is `jobStatusText` |
| `More actions for job {name}` | the row's overflow glyph |
| `Removing job {name}` | replaces the overflow glyph while a delete is in flight, a live region |
| `Confirm delete job {name}` / `Cancel deleting job {name}` | the delete confirmation |
| `Dismiss jobs error` | the failure notice raised by a refused delete |

Section headings, verbatim: `Waiting for your approval` (with the drafts
footer), `Active`, `Paused`, `Completed`. Row status text is one of
`Needs review`, `Active`, `Next in 3m`, `Paused`, `Completed`,
`Status unavailable`. An undecodable row renders
`This app can’t display this schedule.`

### Semantics labels — Job detail

| Label | On |
| --- | --- |
| `Job detail: {name}` | the top-bar title (a heading); the visible title is the job's name |
| `Back` | the way out |
| `Refresh job {name}` | pull-to-refresh's custom action |
| `Loading job` | the spinner while a linked job resolves |
| `Status, {status}` | e.g. `Draft — not scheduled yet`, `Completed — every scheduled time has passed`, `Active`, `Paused` |
| `Next run, {absolute} ({countdown})` | active jobs with a next run |
| `Last run, {relative}` | jobs that have run |
| `Environment, {name}` | `Default (empty pod)` with no template, `Loading…` while it resolves, the raw id if it cannot be read |
| `Model, {model}` | |
| `Prompt: {prompt}` | the monospace prompt |
| `Scheduled time already passed` | the check beside an "at" time in the past |
| `Activate job {name}` | the draft's button |
| `Confirm activate job {name}` / `Cancel activating {name}` | that confirmation |
| `Pause job {name}` / `Resume job {name}` | the lifecycle button |
| `Delete job {name}` | the delete button |
| `Confirm delete job {name}` / `Cancel deleting {name}` | that confirmation |
| `Job action succeeded: {message}` / `Job action error: {message}` | the inline result tile, a live region |
| `Run {when}, {status}` / `Open pod for Run {when}, {status}, {error}` | a run row; prefixed only when the run has a pod |

Card headings, verbatim: `Schedule` (footer
`Cron schedules are evaluated in UTC.`), `Scheduled time` / `Scheduled times`
(footer `Shown in your local time zone.`), `Prompt` (footer
`pi receives exactly this text in a fresh pod at every run.`), `Runs with`,
`Recent runs`. Command results are
`Job is active. Next run in 3m.`,
`Job paused. Its schedule won’t fire until you resume it.`, or
`Job is {status}.` An undecodable run renders
`This app can’t display this job run.`

### Test tags — Jobs

`JobListTestTags`: `SCREEN` = `job-list-screen`, `ACTIVE_SECTION` =
`job-list-active`, `PAUSED_SECTION` = `job-list-paused`, `COMPLETED_SECTION` =
`job-list-completed`, `row(id)` = `job-row-$id`, `more(id)` =
`job-row-more-$id`, `deleting(id)` = `job-row-deleting-$id`, `shared(id)` =
`job-row-shared-$id`.

`JobDetailTestTags`: `SCREEN` = `job-detail-screen`, `MESSAGE` =
`job-detail-message`, `STATUS_CARD` = `job-detail-status`, `SCHEDULE_CARD` =
`job-detail-schedule`, `PROMPT_CARD` = `job-detail-prompt`, `CONFIG_CARD` =
`job-detail-runs-with`, `RUNS_SECTION` = `job-detail-runs`, `ACTIONS_CARD` =
`job-detail-actions`, `SCOPE` = `job-detail-scope`, `ACTIVATE` =
`job-detail-activate`, `PAUSE` = `job-detail-pause`, `RESUME` =
`job-detail-resume`, `DELETE` = `job-detail-delete`, `run(id)` = `job-run-$id`.

Shared tags the design system sets and these screens rely on: `app-list`,
`app-back-button`, `app-confirm-dialog`, `app-notice-dialog`, `app-sheet`,
`empty-state`, `refresh-error-tile`, `unsupported-list-item`.

---

## Settings

`com.pipod.app.features.settings`

### Composables

| Composable | Signature |
| --- | --- |
| `SettingsScreen` | `(viewModel: SettingsViewModel, repository: SettingsRepository, socketFactory: LoginSocketFactory, onOpenEnvironments: () -> Unit, modifier, openUrl: UrlOpener = NoUrlOpener, serverHost: String? = RuntimeConfig.serverUrl, dialogs)` |
| `SettingsScreen` | `(state: SettingsState, actions: SettingsActions, modifier, dialogs, toastHostState, listState: LazyListState = rememberLazyListState(), proposalsSection: @Composable () -> Unit = {}, organizationBundle: (@Composable () -> Unit)? = null, userBundle: (@Composable () -> Unit)? = null)` |
| `ProposalsSection` | `(proposals: List<SettingsProposal>, onOpenProposal: (SettingsProposal) -> Unit, modifier)` |
| `ProposalDetailScreen` | `(viewModel: ProposalDetailViewModel, onBack: () -> Unit, onSetSecret: (String) -> Unit, onResolved: () -> Unit, modifier, dialogs)` |
| `ProposalDetailScreen` | `(proposal: SettingsProposal, state: ProposalDetailState, onBack: () -> Unit, onApply: () -> Unit, onReject: () -> Unit, onSetSecret: (String) -> Unit, modifier, dialogs)` |
| `CredentialLoginSheet` | `(provider: ConnectableProvider, authType: String, socketFactory: LoginSocketFactory, onDismiss: () -> Unit, onConnected: (CredentialStatus) -> Unit, modifier, podId: String? = null, openUrl: UrlOpener = NoUrlOpener, serverHost: String? = RuntimeConfig.serverUrl)` |
| `ColumnScope.CredentialLoginView` | `(provider: ConnectableProvider, authType: String, state: CredentialLoginState, onSubmit: (String) -> Unit, onOpenUrl: (String) -> Unit, onCancel: () -> Unit)` |
| `ConfigBundleEditor` | `(editor: ConfigBundleEditorState, modifier, canEdit: Boolean = true, readOnlyReason: String? = null, dialogs)` |
| `ConfigBundleEditor` | `(subject: String, description: String, state: ConfigBundleEditorUiState, onToggle, onReload, onSave, onConfigChange, onInitScriptChange, onBakeScriptChange, modifier, canEdit, readOnlyReason)` |

There is **no route for a proposal**. When `SettingsState.openProposal` is set
the settings screen renders `ProposalDetailScreen` in place of its own content
and handles back itself; `onSetSecret(name)` is the port of Flutter's
`Navigator.pop(secretName)` and opens the secret form pre-filled.

### View models, holders and factories

| API | Signature |
| --- | --- |
| `SettingsViewModel` | `(repository: SettingsRepository, credentials: CredentialsRepository, account: SettingsAccount = SettingsAccount(), notifications: NotificationSettingsService = UnavailableNotificationSettings, serverHost: String? = RuntimeConfig.serverUrl)` |
| `SettingsAccount` | `(user, organization, canManageOrganization, adminConsoleUrl, signOutUnavailable, setOrganizationAlias: suspend (String) -> Unit, signOut: suspend () -> Unit, openExternalUrl: UrlOpener)` |
| `SettingsActions` | 25 named callbacks, all defaulted — see `SettingsScreen.kt` |
| `ProposalDetailViewModel` | `(proposal: SettingsProposal, repository: SettingsRepository, serverHost)` |
| `rememberProposalDetailViewModel` | `(proposal, repository, serverHost): ProposalDetailViewModel` |
| `CredentialLoginViewModel` | `(provider, authType, socketFactory, podId, openUrl, serverHost, scope: CoroutineScope? = null)` — a plain holder with `close()`, not a `ViewModel` |
| `rememberCredentialLoginViewModel` | `(provider, authType, socketFactory, podId, openUrl, serverHost)` — remembered per sheet, closed on dispose |
| `ConfigBundleEditorState` | `(subject: String, description: String, load: ConfigBundleLoader, save: ConfigBundleSaver, serverHost)` |
| `rememberConfigBundleEditor` | `(subject, description, load, save, serverHost): ConfigBundleEditorState` |
| `ApiSettingsRepository` / `ApiCredentialsRepository` | `(api: ApiClient)` |
| `apiLoginSocketFactory` | `(api: ApiClient): LoginSocketFactory` |
| `androidUrlOpener` | `(context: Context): UrlOpener` |

Wiring notes for the host:

- `canManageOrganization` is `permissions.contains("org:manage")` from `/v1/me`.
- `signOutUnavailable` is `RuntimeConfig.devToken.isNotEmpty()`.
- `adminConsoleUrl` is `MeResponse.adminConsoleUrl`.
- Call `viewModel.setAccount(...)` whenever the session reloads. The
  organization-alias field is seeded once and then left alone, so a reload never
  discards a half-typed alias.

### Optimistic concurrency

`ConfigBundleEditorState` reads a layer, remembers its `version`, and writes
that same version back. The server refuses a stale one. The editor **surfaces
the refusal and offers a reload** rather than retrying: it keeps the typed
edits and the old baseline, shows the failure through `FriendlyError`, and
leaves `version` where it was — retrying with the same version would be refused
again, and retrying with a fresh one is exactly the overwrite this prevents.
The footnote says so on screen:

> Version {n}. Saving is refused if someone else changed this bundle since it
> was loaded; reload to pick up their change.

Save is armed only once a field differs from the last loaded or saved contents,
so a pristine save cannot round-trip version N to N+1 with no diff.

### Semantics labels — Settings screen

| Label | On |
| --- | --- |
| `Settings` | the top-bar title (a heading) |
| `Refresh settings` | the toolbar action (wide windows) and the pull-to-refresh custom action |
| `Loading settings` | the 2dp background progress bar on the first load, a live region |
| `Email, {email}` / `Organization, {name}` | the account rows |
| `Switch organization` | the organization disclosure; its expanded state is announced separately, so the name never flips |
| `Organization alias` | the alias field |
| `Reauthorize organization` | the switch button |
| `Open admin console` | the identity-provider console link |
| `Sign out of pi pod` | the sign-out button |
| `Confirm sign out of pi pod` / `Cancel signing out` | the sign-out confirmation |
| `Dismiss sign out unavailable notice` | the development-build notice |
| `Loading model providers` | the providers spinner, a live region |
| `Connect model provider` | the connect button |
| `Reconnect {provider} model provider` | a credential's reconnect |
| `Test {provider} model provider` | a credential's test |
| `Delete {provider} model provider sign-in` | a credential's delete |
| `Confirm delete {provider} model provider sign-in` / `Cancel deleting {provider} sign-in` | that confirmation |
| `API key, {state}` / `OAuth, {state}` | a credential's health row; state is `Ready`, `Reconnect required`, `Temporarily unavailable`, or the server's own word |
| `Expires, {when}` / `Last refreshed, {when}` | a credential's timestamps |
| `Add secret` | opens the secret form |
| `User secret name` / `User secret value` | the secret fields (from `SecretEntryFields`) |
| `Save user secret` | the secret form's save |
| `Cancel adding secret` | the secret form's cancel |
| `Show secret value for user secret` / `Hide secret value for user secret` | the value field's reveal |
| `Delete user secret {name}` | a stored secret's delete |
| `Confirm permanently delete user secret {name}` / `Cancel deleting secret {name}` | that confirmation |
| `Open environments settings` | the environments row |
| `Edit organization config bundle` / `Edit user config bundle` | the bundle disclosures; expanded state is announced separately |
| `Loading organization config bundle` / `Loading user config bundle` | each bundle's first load |
| `Organization config bundle config JSON` / `… setup script` / `… bake script` | the three editors (`User config bundle …` for the user layer) |
| `Save {subject}` / `Reload {subject}` / `Retry loading {subject}` | each bundle's actions |
| `Confirm reload {subject}` / `Keep editing {subject}` | the discard confirmation |
| `Permission, {text}` | the notification row; text is `Not requested`, `Off`, `Enabled`, `Provisional`, `Temporary`, or `Unknown — pull to refresh` |
| `Enable notifications` | shown only when permission was never requested |
| `Open notification settings` | shown only when permission was refused |
| `Retry loading proposals` / `Retry loading model providers` / `Retry loading secrets` / `Retry loading notification state` | the four per-section retries |
| `Error: {text}` / `Success: {text}` | every inline status line, a live region |

Card headings, verbatim: `Account`, `Model providers`,
`User secrets (write-only)`, `Every pod you launch`, `Organization defaults`,
`Your defaults`, `Notifications`. Secrets are write-only: the list shows names
only and there is no reveal for a stored value.

### Semantics labels — Proposals

| Label | On |
| --- | --- |
| `Proposed change to {scope}, needs approval` | a row in the waiting section |
| `Proposal` | the detail's top-bar title |
| `Changes, {scope}` | the detail's summary row |
| `Loading current settings` | the progress bar while the current layer loads |
| `changes to` | the arrow between current and proposed |
| `Show raw` | the raw-JSON disclosure; expanded state is announced separately |
| `Apply proposal to {scope}` | the apply button |
| `Confirm apply proposal to {scope}` / `Cancel applying proposal to {scope}` | the apply confirmation |
| `Reject proposal for {scope}` | the reject button |
| `Confirm reject proposal for {scope}` / `Cancel rejecting proposal for {scope}` | the reject confirmation |
| `Proposal applied` / `Proposal applied, now set {names}` | the applied card, a live region |
| `Now set secret {name}` | one button per secret the applied proposal asks for |
| `Done reviewing proposal` | leaves the detail |
| `Proposal error: {text}` | the failure card, a live region |

`{scope}` is `SettingsProposal.scopeLabel`: `organization defaults`, or
`unsupported scope ({scope})` for one this build does not understand.

Section copy, verbatim: header `Waiting for your approval`, footer
`An agent drafted these from inside a pod. Nothing changes until you apply them here.`
Card headings: `Default init script: current → proposed`,
`Default bake script: current → proposed`, `Settings: current → proposed`,
`Secrets it asks you to set`. An undecodable proposal renders
`This app can’t display this approval.`

### Semantics labels — Provider sign-in

| Label | On |
| --- | --- |
| `Connecting to {provider}` | the opening row, a live region; the visible text is `Starting sign-in…` |
| `Sign-in choice for {promptId}` | a `select` prompt's picker |
| `Sign-in response for {promptId}` | a `text`, `secret` or `manual_code` prompt's field |
| `Submit sign-in response for {promptId}` | the `Continue` button |
| `Open {linkLabel} for {provider}` | a link carried by an `info` event |
| `Open {provider} sign-in page` | an `auth_url` event's button |
| `Open {provider} device sign-in page` | a `device_code` event's button |
| `{message}` | a `progress` event, a live region |
| `Provider sign-in error: {text}` | the failure line, a live region |
| `Cancel {provider} sign-in` | the way out |

The sheet's title is `Connect {provider}`; the blurb is
`Enter the provider API key. It will be stored in encrypted account custody.`
for `api_key` and
`Complete the provider sign-in to use it in every pod you launch.` otherwise.

### Test tags — Settings

`SettingsTestTags`: `SCREEN` = `settings-screen`, `ACCOUNT_CARD` =
`settings-account`, `PROVIDERS_CARD` = `settings-providers`, `SECRETS_CARD` =
`settings-secrets`, `ENVIRONMENTS_CARD` = `settings-environments`,
`ENVIRONMENTS_ROW` = `settings-environments-row`, `ORG_DEFAULTS_CARD` =
`settings-org-defaults`, `USER_DEFAULTS_CARD` = `settings-user-defaults`,
`NOTIFICATIONS_CARD` = `settings-notifications`, `ORGANIZATION_TOGGLE` =
`settings-organization-toggle`, `ORGANIZATION_ALIAS` =
`settings-organization-alias`, `ORGANIZATION_SWITCH` =
`settings-organization-switch`, `ADMIN_CONSOLE` = `settings-admin-console`,
`SIGN_OUT` = `settings-sign-out`, `CONNECT_PROVIDER` =
`settings-connect-provider`, `ADD_SECRET` = `settings-add-secret`,
`CANCEL_SECRET` = `settings-cancel-secret`, `ENABLE_NOTIFICATIONS` =
`settings-enable-notifications`, `OPEN_NOTIFICATION_SETTINGS` =
`settings-open-notification-settings`,
`credentialRow(providerId)` = `settings-credential-$providerId`,
`secretRow(name)` = `settings-secret-$name`.

`ProposalTestTags`: `SECTION` = `settings-proposals-section`, `SCREEN` =
`proposal-detail-screen`, `SUMMARY_CARD` = `proposal-summary`,
`INIT_SCRIPT_CARD` = `proposal-init-script`, `BAKE_SCRIPT_CARD` =
`proposal-bake-script`, `CONFIG_CARD` = `proposal-config`, `SECRETS_CARD` =
`proposal-secrets`, `ACTIONS_CARD` = `proposal-actions`, `APPLIED_CARD` =
`proposal-applied`, `APPLY` = `proposal-apply`, `REJECT` = `proposal-reject`,
`DONE` = `proposal-done`, `SHOW_RAW` = `proposal-show-raw`, `ERROR` =
`proposal-error`, `row(id)` = `proposal-row-$id`,
`setSecret(name)` = `proposal-set-secret-$name`.

`CredentialLoginTestTags`: `SHEET` = `credential-login`, `PROMPT` =
`credential-login-prompt`, `SUBMIT` = `credential-login-submit`, `CANCEL` =
`credential-login-cancel`, `OPEN` = `credential-login-open`, `ERROR` =
`credential-login-error`.

`ConfigBundleTestTags` are per subject, so the organization and user bundles are
distinguishable on one screen: `editor(subject)` = `config-bundle-$subject`,
`toggle(subject)` = `config-bundle-toggle-$subject`,
`save(subject)` = `config-bundle-save-$subject`,
`reload(subject)` = `config-bundle-reload-$subject`,
`retry(subject)` = `config-bundle-retry-$subject`,
`status(subject)` = `config-bundle-status-$subject`. The two subjects are
`organization config bundle` and `user config bundle`.

---

## A trigger and its confirmation never share a name

While a confirmation is up, the button that raised it is still on screen. Two
nodes with the same accessible name leave a screen reader saying the same words
for the question and the answer, and a driver unable to pick between them — one
of which acts immediately. Every destructive or irreversible action here is
named for what it does; its dialog's confirm action is named `Confirm …`:

| Control | Its confirmation |
| --- | --- |
| `Delete job {name}` (job detail) | `Confirm delete job {name}` |
| `Activate job {name}` (job detail) | `Confirm activate job {name}` |
| `More actions for job {name}` → `Delete job` (jobs list) | `Confirm delete job {name}` |
| `Delete user secret {name}` | `Confirm permanently delete user secret {name}` |
| `Delete {provider} model provider sign-in` | `Confirm delete {provider} model provider sign-in` |
| `Sign out of pi pod` | `Confirm sign out of pi pod` |
| `Reload {subject}` | `Confirm reload {subject}` |
| `Apply proposal to {scope}` | `Confirm apply proposal to {scope}` |
| `Reject proposal for {scope}` | `Confirm reject proposal for {scope}` |

Cancel is scoped rather than built from the confirm name — `Cancel deleting
{name}`, not `Cancel Confirm delete job {name}` — and `AppConfirmDialog` asserts
that the cancel name never contains the confirm name.

## Bringing the secret form into view

`SettingsState.secretFormFocusRequest` is a counter, bumped only by
`openSecretForm(name)` — the path an applied proposal takes — and never by
`showSecretForm()`, where the button that opened the form is already beside it.
The screen watches the counter and scrolls the secrets row to the top of the
viewport, which is the port of Flutter's `Scrollable.ensureVisible`. A counter
rather than a flag, so two proposals applied in a row each bring the form back
and nothing has to remember to clear it.

The index comes from `settingsItemKeys(state, hasOrganizationBundle,
hasUserBundle)`, which is the single source of the list's row order — the
renderer dispatches on the same keys, so a section becoming conditional cannot
put the scroll off by one. `SettingsItemKeysTest` pins the order.

## Deliberate differences from the Flutter original

- **Section headings.** Flutter draws the jobs list's group titles itself, in
  the `headline` style, with explicit header semantics. Here they are
  `AppListSection`'s own `header`, which already exposes a heading — the same
  choice the environments list made.
- **Unsupported-row placeholders inside a card.** The Flutter runs card and the
  Flutter secrets card put `UnsupportedListItemCard` inside a grouped section.
  A card cannot sit inside a card in this design system, so on the job detail
  those placeholders are siblings below the runs section.
- **Job run rows** carry the status text *and* a chevron in one trailing slot;
  `AppListTile` renders only one of `trailing` / `additionalInfo` / chevron.
- **`Job is active. `** keeps the Dart's trailing space when a job becomes
  active with no next run to report.
- **Deep-linked jobs.** `jobs_list_view.dart`'s `jobDeepLinkId` /
  `onDeepLinkHandled` pair is the shell's job in this app;
  `JobListViewModel.openLinkedJob(id, onOpen)` is the piece that belongs to the
  list, and it raises the same `Couldn’t open job` notice.
- **Refresh on return from environments (`CR-33`).** Flutter re-runs `_loadAll`
  after `/settings/environments` pops. Navigation is the host's here, so
  `AppNavHost` calls `viewModel.loadAll()` on return rather than the screen
  guessing when it was left.
- **`platform.dart`.** The Android build only ever took the Material branch, so
  the `usesAppleDesign` conditionals collapsed to constants.
- **The login holder is not a `ViewModel`.** One sign-in is one socket. An
  activity-scoped holder would hand a second attempt at the same provider back
  the finished first one, over a connection already closed; a composition-scoped
  one closes with the sheet. The cost is that rotating mid-sign-in restarts it.
  `ProposalDetailViewModel` and `SettingsViewModel` *are* `ViewModel`s, so a
  rotation keeps an open proposal and everything loaded behind it.
