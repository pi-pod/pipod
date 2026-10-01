# Production Release blackbox

This is an external UI acceptance boundary for the separately installed,
minified `com.pipod` Release APK. It is not app-injected instrumentation.

## Identity and classloader boundary

`release-blackbox` is a standalone Android application module with no
`project(":app")` dependency. AGP builds two disposable APKs:

- host: `com.pipod.releaseblackbox.runner`
- instrumentation: `com.pipod.releaseblackbox.runner.test`, whose generated
  `targetPackage` is the host and whose runner is `AndroidJUnitRunner`

The host and test APK share the normal debug signer. The actual Release APK is
signed independently. `check_artifacts.py` verifies all three package names,
manifest `targetPackage`, both signer relationships, Release non-debuggability,
R8-renamed classes, a generated resource-shrinker reachability report, absence
of the Compose test host, and absence of
`com.pipod.app` class descriptors from the test APK.

This follows Android's documented self-instrumentation principle (instrument a
separate test-owned package) and UiAutomator's documented opaque-box,
cross-application model:

- https://source.android.com/docs/core/tests/development/instr-self-e2e
- https://developer.android.com/training/testing/other-components/ui-automator-legacy
- https://developer.android.com/studio/test/advanced-test-setup#configure-instrumentation-manifest-settings

The production app is reached only through an external shell launch of its own
launcher component and package-qualified `By`/`Until` selectors. No production
Kotlin, Compose, Espresso, resource, manifest, ProGuard, or test-host surface
is linked. The runner manifest declares `<queries>` visibility for exactly
`com.pipod` and `com.android.chrome`: the Chrome entry exists only so the host
`PackageManager` can resolve the browser version for the safe numeric
boundary inventory digit tags, with no other browser interaction.

## Exact tests

The workflow selects one of two exact methods. The public job selects the
credential-free `releaseSignInReachesIdpUsername`; the protected live job
selects `realPkceShowsPods`, stages credentials in the disposable runner host,
and passes the literal `pipodLive=1` and `pipodScope=auth`. Live reads and
deletes that staged file before launch. Those flags and staging gate only the
live method: they do not branch any shared pre-boundary helper.

After that live-only read, both methods execute the identical sequence:
`clickAppSignInAction()` → `requireChromeOpen(signInClickedAtMs)` →
`reachIdpUsernameBoundary(signInClickedAtMs)`. The first helper selects the
app-owned semantic Button description
`By.pkg(TARGET_PACKAGE).desc(APP_SIGN_IN_DESCRIPTION)` where the constant is
exactly `Sign in` (exact package and contentDescription; no generic text and no
clickable filter), emits `assert_app_sign_in_action`, captures the original
click instant with monotonic `SystemClock.elapsedRealtime()`, and clicks once.
That original instant is threaded through every shared and post-boundary
browser-ownership check. The selector is the semantic button, not its visible
Text child: `SignInScreen` sets `semanticsLabel="Sign in"` on the `AppButton`
itself, so the button node carries contentDescription `Sign in` while the inner
`Text` node carries text `Sign in`.

There is one explicitly separate harness-only action described below:
`signin-reissued-after-fre`. It is not a general retry and is never app
behavior. It can occur only after an exact Chrome first-run action dismisses a
Custom Tab back to the exact app foreground while that same exact semantic
Sign-in node is present **and its control is enabled**; it is guarded to one
click total and consumes the existing boundary deadline.

Both tests then reach the IdP username boundary through exactly one shared
Kotlin helper, `reachIdpUsernameBoundary(signInClickedAtMs)`. That helper owns
all Chrome onboarding handling, the closed inventory, label readiness, the
origin gate, and the same-snapshot unique non-omnibox field, and it returns
that field. There is no second onboarding or readiness path: the
credential-free proof asserts the returned field and stops, and live PKCE
begins typing only after the same helper returns.

The R4 hosted public/live divergence was observed on the same hosted image and
API (`pipod-ci-34`, API 34) and the same build configuration. Public inventory
identified Chrome major 113 and version code 567263637; live's Chrome version
is unknowable because that run stopped before inventory. Both runs had the
same complete pre-Chrome block:
`prechrome_fg_chrome` / `prechrome_error_none` /
`prechrome_progress_present` / `prechrome_elapsed_5_15`, and both emitted
`phase_chrome_first_run`. The exact live failure branch was the top-of-loop
`requireBrowserOwnsCredentialUi(signInClickedAtMs)` immediately after a first-
run control click: the public path nondeterministically remained in Chrome,
while R4 lost Chrome foreground. This is evidence for a narrow harness
recovery, not proof of why Chrome lost foreground; no browser, app, emulator,
or timing root cause is claimed.

For prior context, Hosted run 35065332907 at head 9ab5dc4 reached
`phase_app_sign_in` and then emitted the older pre-Chrome evidence
`fg_own`/`error_none`/`progress_absent`/`elapsed_gt30` before
`assert_chrome_open`: the exact Sign in action was not activated, not an OIDC
discovery timeout. No claim is made about why the physical click was lost
beyond the visible-text-child selector versus the semantic button. A local
exact API34 actual-Release test of the uncommitted `.clickable(true)` variant
failed before `phase_app_sign_in` under `assert_app_sign_in`, so the clickable
filter does not match this Compose semantics tree and is not applied.

Both tests also reset and launch the target through exactly one shared Kotlin
helper, `resetAndLaunchTarget()`. It presses home, force-stops the target,
clears its data, resolves the target's **exact launcher component** from the
installed package's own metadata, and launches it with a drained external
`am start -W -n <component>` unquoted. `UiAutomation.executeShellCommand`
splits on exec argv, it is not a shell, so single quotes would be literal and
break the ComponentName. The component is PackageManager-derived for the
pinned package and contains no whitespace, which the fixed-tagged
`assert_launch_component_no_whitespace` guard asserts before the unquoted
launch with no dynamic output. `-W` makes the shell command
return only after the launch completed, which removes asynchronous
context-launch uncertainty and gives deterministic sequencing of force-stop /
`pm clear` / start / foreground wait. This does not assert a proven app root
cause for any one run: it only makes the launch itself deterministic. The
component is used, never emitted, and nothing about
the boundary changes: no production classpath, no broad intent or action, and
no signature, build-configuration, or origin comparison anywhere in the
launch. The foreground wait after it polls exact window ownership:
`device.currentPackageName == TARGET_PACKAGE` on the monotonic clock inside
the existing `APP_START_TIMEOUT_MS` budget at `BROWSER_POLL_MS` cadence,
asserted as a boolean under `assert_launch_foreground`, with the exact final
equals still gated under `assert_launch_foreground_package`. App node
existence never decides foreground: the previous
`Until.hasObject(By.pkg(TARGET_PACKAGE))` proxy was an accessibility-node
condition that could stay false while the app already owned the foreground
during startup/Compose restoration, and hosted stage2 run 35064127703
isolated exactly that harness falsehood (per-check launch component/start
passed, crash unknown/none, before any phase or pre-Chrome slot, same code
passing locally on API34) — a wrong proxy, not a proven app launch race.

`-W` introduces no new fixed wait constant and changes no timeout: it returns
when the launch completes, inside the same `--timeout` process bound. That
shell wait is itself additionally bounded by the overall process timeout, so
the fixed-wait sums below (255 s public, 435 s live) are not claimed as
literal totals; they leave a 165 s overhead margin on the public job
(420−255) and a 45 s margin on live (480−435) for that launch completion plus
harness overhead.

- `ReleaseBlackboxTest#releaseSignInReachesIdpUsername`: credential-free; requires a
  separately installed, non-debuggable `com.pipod`, clears its data, launches
  it externally, calls the one shared `clickAppSignInAction()` helper (exact
  app-owned semantic Button description `By.pkg(TARGET_PACKAGE).desc("Sign in")`
  with no clickable filter — never the visible `Text` child via `appText("Sign in")`
  for this initial action), requires the hosted `com.android.chrome` browser, then calls
  the shared boundary helper: Chrome first run is handled through at most
  eight actions within the existing shared deadline, one freshly queried
  exact Chrome-owned control per iteration (exact package plus
  Chromium-confirmed resource ID plus exact dismiss/decline text;
  `terms_accept`/`negative_button` are version-drift legacy with explicit safe
  states only, LightweightFirstRun `button_primary` is deliberately omitted,
  never account sign-in, never generic Accept/Next/Skip matching). The
  harness-only one-shot recovery below is the only non-Chrome action in that
  loop. Then the closed inventory is emitted and the boundary
  settles on exactly one non-omnibox credential field. This test asserts that
  returned field and returns. Label readiness accepts only the exact
  `Login Name` label or its regex-anchored case-insensitive exact
  text/contentDescription equivalents, still requiring exact Chrome
  ownership; reaching the boundary additionally requires the internally
  inspected origin to be the expected IdP host with no browser-error
  category. On this test there is no `setText`, no credential read, no `Next`
  click, and no text submission of any kind. Missing onboarding handling is
  an unproven hypothesis, never a claimed cause. Shared boundary readiness
  waits are raised conservatively for hosted latency (90s readiness, 60s
  field settle); the public step bounds the run with `--timeout 420`.
- `ReleaseBlackboxTest#realPkceShowsPods`: fail-closed live gate; repeats the
  same Release identity checks, requires both `pipodLive=1` and
  `pipodScope=auth`, reads and deletes the staged credential file once, and
  reaches the
  identical shared boundary above — same onboarding handling, same inventory,
  same readiness, same origin gate, same unique-field proof. It then diverges:
  it types into the exact `UiObject2` the boundary returned (no second
  readiness wait and no duplicate `phase_idp_username_ready`), advances,
  completes the labelled Zitadel password field owned by the hosted
  `com.android.chrome` browser (never its omnibox), then requires foreground
  `com.pipod` plus exact package-qualified `Pods` and `Settings`, and an
  unconditional package-qualified absence of `Sign in`. Live worst-case fixed
  waits are 435s (30s reset/foreground + 30s Sign in + 45s Chrome + 90s
  shared readiness + 60s boundary field + 30s password field + 90s callback
  + 60s Pods); the live step keeps the explicit `--timeout 480` with a 45s
  overhead margin above that sum. The recovery introduces no wait constant,
  so the public 255s and live 435s fixed-wait sums are unchanged.

`run_instrument.py` allowlists these exact `Class#method` identities and only
three non-secret instrumentation keys. `pipodScope` is accepted only as the
literal value `auth`; any other value, including `full`, is rejected. It
delegates output classification to the existing acceptance `parse_instrument`,
requiring exactly one test, status OK, `OK (1 test)`, and session completion
`-1`; crashes, short messages, ignored/error statuses, wrong count, or
incomplete output fail closed.

## Secret-safe fixed diagnostics

Both tests report fixed phase/assertion-category tags through
`Instrumentation.sendStatus` with the single custom Bundle key `pipodDiag`
at status code 0 (the AndroidJUnitRunner OK code, additive-safe under
`am instrument -r`: it adds no failure signal to the bounded parser), never
through stdout or logcat. No values, URLs, credential
lengths, raw output, or logcat content are emitted. Phase tags name only the
fixed stage reached:

- `phase_app_sign_in`, `phase_chrome_open`, `phase_chrome_first_run`
  (optional, emitted once when the first Chrome-owned first-run control is
  acted on), `phase_signin_reissued_after_fre` (optional at most once, only
  after `phase_chrome_first_run` and before `phase_idp_username_ready`; the
  safe reporting name is **signin-reissued-after-fre**, a harness-only Custom
  Tab recovery and never app behavior), `phase_signin_reissued_no_fre` (the
  same one-shot recovery when no first-run control had been acted on — optional
  at most once, mutually exclusive with the previous phase, and before any
  `phase_chrome_first_run`; safe reporting name **signin-reissued-no-fre**),
  `phase_chrome_foreground_settled`
  (optional at most once, anywhere between `phase_chrome_open` and
  `phase_idp_username_ready`: the bounded settle budget below was used and
  exact Chrome foreground was then observed again; harness timing only, never
  app behavior), `phase_idp_username_ready`,
  `phase_idp_username_setter_returned`
  (setter returned; content is never read back or labelled verified),
  `phase_idp_username_advance`, `phase_idp_password_ready`,
  `phase_idp_password_setter_returned`, `phase_idp_password_submit`,
  `phase_callback_app_return` (exact target package back in the foreground),
  `phase_pods` (exact `Pods`/`Settings`/no-`Sign in` under `assert_pods`)
- `assert_*` category tags are emitted before each fail boundary. Broad
  categories mark the entry of a group (`assert_harness`, `assert_scope`,
  `assert_release_target`, `assert_launch_target`, `assert_credentials`,
  `assert_app_sign_in`, `assert_chrome_open`, `assert_idp_username_ready`,
  `assert_idp_username_field`, `assert_idp_username_advance`,
  `assert_idp_password_ready`, `assert_idp_password_field`,
  `assert_idp_password_submit`, `assert_callback_app_return`, `assert_pods`,
  `assert_browser_owns_ui`).

### Per-check assertion categories

A broad category names a group, not a check: the first real-origin public run
failed with `diag_assert assert_release_target` while the pending check was
actually the post-launch foreground wait, three checks later. So every actual
JUnit assertion and every `failNow` is now preceded by a fixed tag naming
exactly that one check, and the last `diag_assert` on the wire is the exact
pending check. This matters most for the **pre-phase** checks, which carry no
phase tag at all and would otherwise leave only their group behind:

- harness: `assert_harness_test_package`, `assert_harness_host_package`,
  `assert_harness_external_target`, `assert_harness_requested_target`
- live opt-in and scope: `assert_scope_live_optin`, `assert_scope_auth`
- installed Release identity: `assert_release_target_package`,
  `assert_release_target_nondebuggable`, `assert_release_target_launcher`
- reset and launch: `assert_launch_component` (exact launcher component
  resolution), `assert_launch_component_no_whitespace` (the flattened
  component contains no whitespace), `assert_launch_start` (the drained
  `am start -W -n` itself), `assert_launch_foreground` (the bounded exact
  `currentPackageName` ownership poll after it — never app node existence),
  `assert_launch_foreground_package` (the exact package
  comparison)
- credentials: `assert_credentials_file`, `assert_credentials_deleted`,
  `assert_credentials_keys`
- app Sign in action: `assert_app_sign_in_action`, emitted immediately before
  the one shared click in `clickAppSignInAction()` (the wait itself stays under
  `assert_app_sign_in`). The initial action never uses `appText("Sign in")`;
  the Pods-phase unconditional absence check still uses package-qualified text
  as appropriate.
- shared boundary: `assert_chrome_identity`, `assert_idp_origin`,
  `assert_idp_username_field_multiple`, `assert_idp_username_field_settled`,
  `assert_idp_username_boundary_return`
- post-boundary interactions: `assert_idp_username_ownership`,
  `assert_idp_username_click`, `assert_idp_username_setter`,
  `assert_idp_password_click`, `assert_idp_password_setter`. Each is emitted
  before the operation it names, so an exception from ownership, click, or
  setter cannot be misattributed to cardinality; the exact Next actions
  already carry their own advance/submit tags.
- live divergence: `assert_idp_password_field_multiple`,
  `assert_idp_password_field_settled`,
  `assert_callback_app_return_foreground`, `assert_callback_app_return_package`,
  `assert_pods_screen`, `assert_pods_settings`, `assert_pods_no_sign_in`

Single-check groups (`assert_app_sign_in`, `assert_chrome_open`,
`assert_idp_username_ready`, `assert_idp_username_advance`,
`assert_idp_password_ready`, `assert_idp_password_submit`,
`assert_browser_owns_ui`) already name their one check and gain no sub-tag;
`assert_app_sign_in_action` is the adjacent click-operation tag emitted
immediately before the single shared click (the click itself throws rather
than asserting, so it names the operation, not a JUnit check).
Every tag is a compile-time constant on the same allowlisted channel: no
dynamic value, count, message, or component string travels with them.

`run_instrument.py` parses only exact allowlisted tags from
`INSTRUMENTATION_STATUS: pipodDiag=` lines, rejects unknown, malformed, or
out-of-order tags, and projects only the safe phase/assertion category on
both pass and fail (`diag_phase`, `diag_phases`, `diag_assert`, or
`diag_reject`; on failure the valid prefix collected before any violation is
projected first). That projection is **non-blocking**, like the inventory and
pre-Chrome projections: a failing run whose diag stream is malformed,
unknown, out of order, or missing still projects the valid prefix and the
fixed `diag_reject <token>`, and then reaches `parse_instrument` and crash
classification, so it reports why the *test* failed rather than why its
diagnostics did. Nothing is loosened for a passing run, which must still
carry the exact completed
sequence: the public prefix ending `phase_idp_username_ready` for the public
test, the full ordered sequence ending `phase_pods` for live PKCE. Missing
or incomplete diagnostics on a passing test fail closed through the same
strict parser in `require_diag_complete`, which runs after parse success
alongside `require_inventory_complete`, `require_prechrome_complete`, and the
passing-run zero-failure-block gate. The optional recovery phase is accepted
exactly once only after `phase_chrome_first_run` and before
`phase_idp_username_ready`; any other placement or cardinality fails closed.
The existing bounded parser stays raw-suppressed and the filtered crash
classification is retained.

### Shared boundary closed inventory (credential-free evidence)

The shared `reachIdpUsernameBoundary()` helper emits a closed inventory after
its onboarding/readiness loop and before its username assertion, so **both**
tests carry the identical nine slots in the identical order. The inventory is
credential-free boundary evidence: on both paths it is emitted before any
credential is typed or submitted and contains no credential data. Live keeps
its existing one-shot credential read earlier (before the boundary), so no
claim is made that inventory precedes that read. Every signal is a
fixed allowlisted category or a bounded count; no hierarchy, text, screenshot,
URL, error content, or other dynamic value is emitted or projected:

- `inv_onboarding_remaining_0..9|many` — remaining visible controls using
  only the exact currently allowed onboarding selectors, counted in the same
  order they are acted on. No new generic Accept/Next/Google-login handling.
- `inv_origin_expected|browser_error|other|unavailable` — the omnibox URL
  is inspected internally (exact `https` + `auth.pipod.dev` host compare, or
  the exact host-only omnibox string `auth.pipod.dev` — never a substring,
  suffix, or path — plus `chrome-error` scheme compare and fixed known
  error-page indicators) and only the enum leaves the device. Crossing the
  boundary requires `expected` on both tests.
- `inv_login_exact_text_`, `inv_login_exact_desc_`, `inv_login_ci_text_`,
  `inv_login_ci_desc_` (each `0..9|many`) — `Login Name` exposure as exact
  text, exact contentDescription, and regex-anchored case-insensitive exact
  text/desc. Readiness accepts only these probes.
- `inv_field_nonomnibox_0..9|many` — non-omnibox `EditText` count from a
  bounded poll taken before emission; the emitted count and the enforced
  unique field are the same snapshot, so crossing the boundary still requires
  exactly one and 0/multiple failures project the actual final count. That
  same single element is what live PKCE types into.
- `inv_chrome_major_<digits>` / `inv_chrome_version_code_<digits>` — Chrome
  major (1..999) and `longVersionCode` (>0) as strictly generated decimal
  digits on the proven `pipodDiag` channel (separate Bundle keys were
  observed not to arrive on API34, even as digit strings). Anchored
  numeric-prefix recognition with range validation; allowed only in the two
  trailing inventory slots and projected only as `inv_num pipodChromeMajor N`
  / `inv_num pipodChromeVersionCode N`, never as raw tags.

`run_instrument.py` requires all nine inventory slots exactly once in the
fixed order above for a passing run of **either** test; unknown, malformed, or
duplicate inventory fails closed, missing inventory on a passing test fails
closed, and on failure only the valid safe prefix is projected (`inv_tag`,
`inv_num`, or `inv_reject` with a fixed token). Both tests project their
inventory non-blocking before output classification, so a failing run still
surfaces the safe prefix it reached and then classifies on the original
instrument reason.

### Shared pre-Chrome diagnostics (fixed four-slot closed block)

Both tests capture `SystemClock.elapsedRealtime()` immediately before the Sign
in click and pass it to the one shared `requireChromeOpen(startedAtMs)`
helper. That helper polls every 500 ms until the hosted Chrome browser is
present, an exact app error surface appears, or the **existing** 45 s
`BROWSER_START_TIMEOUT_MS` deadline measured from that click expires — no new
wait is introduced. Exactly
four fixed tags are emitted immediately before `assert_chrome_open`, always in
this dimension order, and only then does the exact Chrome
foreground/ownership gate run and emit `phase_chrome_open`: an observed
non-`none` error fails that same Chrome assertion immediately instead of
spending the remaining deadline, while the no-error path consumes only what is
left of the same 45 s, so both worst-case step sums are unchanged.

- `prechrome_fg_own|chrome|other` — exact `currentPackageName` mapping at the
  instant the bounded wait ended (`com.pipod`, `com.android.chrome`, anything
  else including none).
- `prechrome_error_none|network|discovery|timeout|unknown_error_dialog` — the
  first exact app error surface observed during the bounded wait, else the
  state when it ended. The surface is detected **only** by the production
  sign-in screen's fixed contentDescription prefix `Sign in error: `, through
  package-qualified anchored selectors: the message is never read back, so no
  error text exists in the harness to emit. The notice surface carries the
  different fixed prefix `Authentication notice: ` and can never match.
  Classification is most specific first against fixed known copy only:
  `discovery` is semantic config-document copy only — the `OIDC discovery …`
  family that survives `FriendlyError` as prose (`OIDC discovery issuer
  mismatch`, `OIDC discovery document is missing …`, `OIDC discovery document
  has invalid …`); `network` is the app's generic transport surface observed
  during OIDC discovery — the fixed `FriendlyError` transport-fallback and
  connectivity sentences, including its fallback
  (`Something went wrong talking to the server. …`), which is what discovery
  transport IO/timeouts collapse into (`OidcClient` maps them to
  `OidcTransientException`, rendered as that fallback), so `network` is not
  proof of an API call; `timeout` is reserved and reachable only if the
  explicit fixed timeout copy (`The server took too long to respond. Try
  again.`) reaches the UI — the current production pre-Chrome flow carries no
  explicit overall timeout copy and its socket timeouts collapse to `network`,
  so no claim is made that they distinguish `timeout` today; any other error
  surface — including the browser-launch rejection
  (`Could not open the sign-in page in a browser.`) — is
  `unknown_error_dialog`; no surface is `none`.
  No other error probe exists, and `pm clear` plus the screen's own
  clear-on-click mean any surface seen belongs to this attempt.
- `prechrome_progress_present|absent` — **present means observed at least once
  during the bounded wait**, never a final-state read: the in-flight indicator
  is transient by construction. The primary probe is the exact app-package
  `android.widget.ProgressBar` class, which should match the in-flight
  indicator; the exact fixed app
  string `Signing in…` is corroborating redundancy as a second package-qualified exact
  probe. No generic or partial text matching.
- `prechrome_elapsed_lt5|5_15|15_30|gt30` — monotonic elapsed milliseconds
  from the click to the end of the bounded wait, on half-open boundaries:
  `lt5` is [0, 5 s), `5_15` is [5 s, 15 s), `15_30` is [15 s, 30 s), `gt30` is
  [30 s, ∞). Exactly 5 s, 15 s and 30 s fall in the later bucket of each pair.
  `elapsedRealtime` is used rather than wall-clock time so a clock adjustment
  cannot move a bucket.

`run_instrument.py` allowlists these fourteen tags and parses them as their
own closed four-slot block — never a phase, never an assertion category, never
inventory — and projects only fixed safe lines (`diag_prechrome <tag>`).
Unknown, malformed, duplicate, out-of-order, or missing slots fail closed:
unknown/malformed values are rejected by the required diag parser first, and
duplicate/out-of-order/missing are rejected by `require_prechrome_complete`,
which **both** tests must satisfy on a passing run. On failure the valid
prefix is projected first, then the fixed `prechrome_reject <token>` token;
projection is non-blocking before output classification, so a failing run
(including a failing Chrome open) still surfaces its block and then reaches
the existing `parse_instrument` and crash classification on the original
instrument reason.

### Browser-ownership failure diagnostics (conditional four-slot block)

Every call to `requireBrowserOwnsCredentialUi` receives the original monotonic
Sign-in click instant. The gate reads the current package exactly once and
hands that same snapshot to the block, so the classification describes the
state that actually failed the gate rather than a second, later read. If exact
Chrome foreground ownership is lost, the sole failure branch emits one
complete fixed block immediately before `assert_browser_owns_ui`, in this
strict order:

1. `browserown_fg_own|chrome|system_ui|play_services|harness|android|launcher|other`
   — exact equality against `com.pipod`, `com.android.chrome`,
   `com.android.systemui`, `com.google.android.gms`, the fixed blackbox host,
   the fixed Android framework package, and the launcher package captured
   during the reset's existing Home transition; every other or missing package
   is `other`. The captured package is compared only and is never emitted or
   logged. Since the classified snapshot is the one that failed the
   exact-Chrome equality, `chrome` is unreachable by construction: the branch
   exists only to keep the mapping total, and that value on the wire would mean
   an emitter bug rather than a Chrome foreground.
2. `browserown_onboarding_present|absent` — whether any current Chrome node
   matches the same allowlisted onboarding selector set: exact Chrome package,
   exact Chromium resource ID, and exact allowlisted text. No generic control
   or raw text is read back.
3. `browserown_signin_visible|absent` — whether the exact app package owns a
   node with the exact semantic `Sign in` contentDescription. This is node
   presence only, never actionability: that description node reports
   `enabled="true"` even while the control it names is disabled.
4. `browserown_elapsed_lt5|5_15|15_30|gt30` — monotonic elapsed time since the
   **original** Sign-in click, using the same half-open [0,5), [5,15), [15,30),
   and [30,∞) second boundaries as pre-Chrome. A harness recovery click never
   resets this clock.

Only those sixteen whole constants are emitted. There is no raw package,
URL, node text, hierarchy, screenshot, or log content. The parser validates
unknown/malformed values, fixed order, duplicates, and exact conditional
completion: a complete block is required if and only if
`assert_browser_owns_ui` occurs. Order is enforced over the
ownership-related subsequence — the four slots, then the assertion — not over
wire adjacency: the parser filters everything else out first, so an unrelated
tag between the block and the assertion is not itself a violation. Emitting
them adjacently is a property of the single Kotlin failure branch, asserted
against that source, not something the stream parser could detect.
A passing test requires zero ownership failure blocks and zero ownership
assertions, which is what `require_browserown_absent` gates after parse
success. That gate reports its two failures distinctly: a stream the shared
parser rejects collapses to `browserown missing or rejected`, while a valid
but present block on a passing run is `browserown present on pass`. (The
emptiness check used to sit inside the same `try` as the parse call, so its
own `SystemExit` was caught by the parse handler and every pass-with-block run
reported the parse reason instead.) On a failing or timed-out run,
valid partial prefixes are projected as fixed `diag_browserown` lines followed
by a fixed `browserown_reject` reason without blocking the original
`parse_instrument` result or the existing filtered crash classification.

Live run `35118241304` did **not** reach the post-auth check: it failed here as
`browserown_fg_other` / `browserown_onboarding_absent` /
`browserown_signin_absent` / `browserown_elapsed_gt30`. The three named owner
values above close only that diagnostic ambiguity on a recurrence; they do not
claim which owner that run had, recover it, extend a timeout, or change any
click. A fresh live dispatch is still required to exercise the post-auth block.

## Post-auth Pods-screen failure block

Live run `35113969533` against production passed every authentication phase
through `phase_callback_app_return` and then failed waiting for the exact
authenticated `Pods` title, leaving **no evidence of what the app was showing**
— the same gap the ownership block closed one stage earlier. The live method
now emits a fixed six-slot block on exactly that failure:

1. `postauth_fg_own|chrome|system_ui|play_services|harness|android|launcher|other`
   — the same exact fixed/captured package classification for the foreground at
   that instant; the captured launcher package is never emitted or logged
2. `postauth_shell_present|absent` — exact app-package `Settings` destination:
   whether the authenticated shell drew at all
3. `postauth_progress_present|absent` — exact `Loading pods` indicator
   description, or the app's own `ProgressBar` class: the account fetch had not
   finished
4. `postauth_error_present|absent` — exact `Retry refreshing pods` action, the
   load-error tile's own control; the error message itself is never read
5. `postauth_signin_visible|absent` — exact `Sign in` action: the app fell back
   to signed-out
6. `postauth_elapsed_lt15|15_30|30_60|gt60` — monotonic buckets from the
   callback instant, scaled to this screen's own `PODS_TIMEOUT_MS` (60 s)

Together these separate the candidate causes that the failing run could not
distinguish: still loading, load error, signed out, or a shell without its
title. Each value is one of twenty compile-time constants. Every probe is an
anchored package-qualified selector used as a boolean, so no pod name, account
field, URL, node text, hierarchy, screenshot, or log content can travel on this
channel — a test asserts the projection leaks none of those even when the raw
stream contains them.

The category relationship is **one-directional**, unlike the ownership block's.
`assert_pods_screen` is emitted before the wait on every live run, pass or
fail, so its presence cannot require a block; that ordering is deliberate, so a
killed or hung run still leaves the pending-check category behind. A block,
however, is emitted only on that failure and only directly after that
category, so a block without it, or not directly after it, is a violation.
A passing run must carry no block at all, which `require_postauth_absent` gates
after parse success with the same two distinct tokens the ownership gate uses:
`postauth missing or rejected` for a stream the parser rejects, and
`postauth present on pass` for a valid but present block. On a failing or
timed-out run, valid partial prefixes project as fixed `diag_postauth` lines
followed by a fixed `postauth_reject` reason, without blocking the original
`parse_instrument` result or the filtered crash classification.

The two new selectors are the app's own fixed strings (`PodListScreen` sets
`contentDescription = "Loading pods"` on its activity indicator and
`retrySemanticsLabel = "Retry refreshing pods"` on its load-error tile), and a
test asserts both against the app source so a rename breaks the build rather
than a live run. The title the wait looks for is likewise a constant —
`AppScaffold(title = "Pods", …)`, independent of the account — so a non-empty
pod set cannot remove it.

Nothing here changes what the test does to the account: after the callback the
live method still performs no click, `setText`, shell, swipe, or long-press. It
waits for the exact title, then asserts exact `Settings` present and
package-qualified `Sign in` absent. It cannot stop, rename, or delete a pod.

### Harness-only signin-reissued-after-fre recovery

Chrome onboarding handling is a bounded re-query, not a formally idempotent
operation: no claim is made that repeating a click is harmless, only that each
iteration re-resolves the current screen and that the loop performs at
most `MAX_CHROME_FIRST_RUN_STEPS` (8) actions and always inside the existing
90 s shared boundary deadline. Each iteration re-queries current UI state and
clicks at most one exact Chrome-owned control; no selector result is reused
across screens or iterations. The allowlist remains limited to
exact package + resource ID + text combinations for `Use without an account`,
`Stay signed out`, UMA `Done`, exact `No thanks`, and the legacy exact
`Accept & continue` then gated exact `No thanks` sequence. Google account
continue controls and generic Accept/Next/Skip selectors remain forbidden.
`phase_chrome_first_run` is emitted once on the first such action.

**Only** when foreground is exactly `com.pipod` and an **enabled** exact app
Sign-in control is present, the harness treats the state as a dismissed Custom
Tab. It re-resolves and clicks that exact semantic action once, with the local
guard set before clicking so it can never retry twice. It waits for exact
Chrome foreground only within the remaining shared deadline, and resumes the
same shared boundary loop. If any condition is false, or ownership is lost
again after that one click, it emits the browser-ownership block and fails.

One reissued click per run carries one of two names, chosen by whether an exact
first-run control had already been acted on: `phase_signin_reissued_after_fre`
(safe name **signin-reissued-after-fre**) or `phase_signin_reissued_no_fre`
(safe name **signin-reissued-no-fre**). The parser accepts at most one of them
per run and requires each to agree with the first-run phase on the wire. Both
describe harness recovery only, never production app behavior and never a
proven cause of a foreground loss.

Acting on a first-run control is deliberately **not** a prerequisite, because
the loss is observed without one. Hosted public run `35104247401`, at the same
build and image, emitted `prechrome_fg_chrome` / `prechrome_error_none` /
`prechrome_progress_present` / `prechrome_elapsed_5_15` and then
`browserown_fg_own` / `browserown_onboarding_absent` /
`browserown_signin_visible` / `browserown_elapsed_15_30` with **no**
`phase_chrome_first_run` on the wire: Chrome owned the foreground, then the app
did, with its Sign-in surface visible and no Chrome onboarding present, before
any exact first-run control matched. `requireChromeOpen` has already proved
exact Chrome foreground before this loop runs, so an app foreground inside it is
a lost tab either way; a first-run prerequisite would only refuse to recover
the case that was actually observed.

That recovery is exercised on the hosted image, not only in source contracts. A
never-merged scratch branch (`android-fre-ownership-probe`, which adds a probe
function that does not exist here) forced exactly that state — the app into the
foreground with the tab backgrounded, before any first-run control could match
— and hosted public run `35107473898` passed through it, emitting
`phase_app_sign_in`, `phase_chrome_open`, `phase_signin_reissued_no_fre`,
`phase_chrome_first_run`, `phase_idp_username_ready` with `inv_origin_expected`
and the full nine-slot inventory. The reissued tab showed Chrome first run,
which the same exact allowlisted controls dismissed. The settle budget below
has no equivalent hosted exercise: it is covered by the source and parser
contracts only.

Enabled is part of the selector, because presence alone is not an actionable
control. `SignInScreen` keeps `semanticsLabel = "Sign in"` on its button while
the in-flight attempt disables it (`enabled = !isSigningIn`), and returning to
the foreground starts the app's own `SIGN_IN_ABANDON_GRACE_MS` (1.5 s) wait
before the abandoned attempt is given up, so for that whole window the exact
node is present and the control is dead. Clicking it would be swallowed and
would burn the one-shot.

Enabled is read from the node that actually carries it. A local API34
`uiautomator dump` of the actual Release shows the exact `Sign in`
contentDescription on a **non-clickable child** that reports `enabled="true"`
in both states, while its parent at identical bounds is `clickable="true"`
with `enabled="false"` exactly while `Signing in…` is displayed. Putting
`.enabled(true)` on the description selector would therefore have filtered
nothing. The recovery selector is that exact parent —
`By.pkg(TARGET_PACKAGE).clickable(true).enabled(true).hasChild(By.pkg(TARGET_PACKAGE).desc(APP_SIGN_IN_DESCRIPTION))`
— and nothing looser: no text match, no generic clickable node, no structural
walk. A local instrumentation probe against that Release on API34, with the
IdP host blackholed so the in-flight state persists, observed the three states
this depends on: the selector matches when idle, misses while the exact
description node is still present and the control disabled, and matches again
once the control recovers. If the tree ever stops matching, the selector
resolves to nothing and the wait fails closed rather than clicking something
unproven.

When the exact description node is present but its control is not enabled, the
harness sleeps one `BROWSER_POLL_MS` and re-evaluates from the top of the same
loop: no one-shot consumed, no phase emitted, no new budget, and the existing
90 s shared boundary deadline is still the only thing that can end the wait. If
it expires with the action still disabled — as with any other ownership loss —
the gate below the loop fails closed with the same block. This describes what
the harness waits for; it is not a claim about why a Custom Tab was dismissed.

### Bounded foreground settle

A foreground the shared loop cannot act on — neither exact Chrome nor an
actionable app Sign-in — is tolerated for a total of
`MAX_FOREGROUND_SETTLE_MS` (10 s) across the whole wait. Dismissing a
first-run screen hands the window between activities, and a package read taken
inside that handover names whoever holds it at that instant; first run is the
one place this harness deliberately drives that handover, up to
`MAX_CHROME_FIRST_RUN_STEPS` times.

The tolerance is bounded three ways: the budget is a **total**, never per loss
and never reset; it is spent only from the existing 90 s boundary deadline and
adds nothing to it (the public 255 s and live 435 s worst-case sums are
unchanged); and nothing is clicked, typed, queried, or emitted while it is
being spent. Once it is exhausted, the loss falls through to the same
unconditional ownership gate and the same four-slot `browserown` block as
before, early enough in the deadline for that block to land. Every gate from
the end of the loop onward — the two after it, the field poll, and both typing
helpers — is the unchanged exact-Chrome check, so no credential-bearing step
runs inside any tolerated window.

When the budget has been used and exact Chrome foreground is observed again,
`phase_chrome_foreground_settled` is emitted once. Its presence means the run
needed the budget; its absence on a failure means the loss outlived it. Both
are harness timing facts. Neither is a proven cause of the R4 live foreground
loss, which remains unproven: this candidate covers the app-foreground case
with the one-shot reissue and the handover case with this budget, and any
other class of loss still fails closed with its category named.

Both optional windows come from one rule. `_optional_phase_valid` in
`run_instrument.py` decides which optional phase may appear where, the stream
parser applies it, and the strict success check enumerates its accepted orders
from it, so an accepted stream and a complete sequence cannot drift apart.

This R5 candidate changes no production app code, signing, workflow, hosted
image, API, or timeout. It changes only the standalone blackbox test, its
bounded parser/tests, and this documentation;
`.github/workflows/release-blackbox.yml` remains unchanged.

## Credentials and dispatch

Live auth exists only in `.github/workflows/release-blackbox.yml`. The
credential-free public job runs on `pull_request` and on `workflow_dispatch`
when `run_auth` is false: no protected environment, no secrets, no auth, and
no Play. It uses an ephemeral signer, a workflow-owned emulator, and the
actual Release plus host/test pair.

The public Release assembles at build-config parity with live: the API origin
comes from the non-secret `server_url` dispatch input whose default is exactly
`https://api.pipod.dev`, and automatic `pull_request` runs take
that same exact default through
`${{ inputs.server_url || 'https://api.pipod.dev' }}` because
`inputs` is empty outside a dispatch. Per explicit user request the
`server_url` input stays as an override; exact parity is the automatic
`pull_request` and default-dispatch value, not a claim about a custom
override. The issuer stays exactly the known
public `https://auth.pipod.dev` (exactly, with no trailing slash), which is also what the live job's protected
dispatch preflight requires of `PIPOD_OIDC_ISSUER` (exactly `https://auth.pipod.dev`, no trailing-slash variant). Both are non-secret and
are set only on that public Gradle assembly step. The earlier reserved
invalid-origin placeholder is gone: it made the public proof a different build
configuration from live, which is exactly what an environment-dependent
pre-Chrome failure needs to be reproducible. The live job still takes its
origin from the protected `PIPOD_ACCEPTANCE_SERVER_URL` variable, and its
protected dispatch preflight requires exactly
`https://api.pipod.dev` (no echo, exact, no trailing slash) —
the same literal the public job assembles with; nothing here changes live env,
transport, or signing.

### Origin migration (2026-09-16)

Both literals moved from `https://box.146-190-54-217.sslip.io` to
`https://api.pipod.dev` because the guardian of that stable box destroyed it at
14:49:05Z. The preflight is an exact-literal guard, so the protected
`PIPOD_ACCEPTANCE_SERVER_URL` environment variable on
`android-live-acceptance` **must be set to exactly `https://api.pipod.dev`**
(no trailing slash) for a live dispatch to pass preflight; changing the
variable without this workflow change, or this workflow change without the
variable, fails closed with the fixed `PIPOD_ACCEPTANCE_SERVER_URL mismatch`
message and no value echoed. Parity is preserved: public default, public
fallback, and live preflight are the one same literal, and a test refuses both
retired origins anywhere in the workflow.

The credential-free public proof stops at the IdP username boundary and never
calls the API origin, so this changes what it builds with, not what it
exercises. The live method reaches the API only after the callback, where the
acceptance user owns its pods on production.

Live PKCE is `workflow_dispatch && run_auth=true` only, always passes
`pipodScope=auth`, preserves the `backend` choice, and uses the protected
`android-live-acceptance` environment. Dispatch/approval remains a Root
action. The workflow does not upload to Play.

The existing protected environment/file contract is preserved:

1. `PIPOD_ACCEPTANCE_LOGIN` and `PIPOD_ACCEPTANCE_PASSWORD` are absent from the
   Gradle build step.
2. Existing `scripts/acceptance/write_creds.py` writes an `O_EXCL` 0600 file
   without printing values.
3. `credential_file.py` streams that file over stdin into the debuggable,
   disposable host's private storage. Values never enter Gradle properties,
   instrumentation extras, URLs, shell arguments, or logs.
4. The test reads the file once and deletes it before opening the browser.
5. `check_no_embedded_credentials.py` decompresses every APK entry and rejects
   exact protected values before dispatching auth.

The runner host being debuggable is intentional and does not weaken the tested
app: `ReleaseBlackboxTest` rejects a debuggable `com.pipod`. Browser actions use
only normal OIDC UI; there is no dev-token/JWT path.

## What the first real-origin public run actually failed on (run 35058733454)

The first public run at exact real-origin parity (run 35058733454) failed
before the app phase with `diag_assert assert_release_target`, and its fixed
assertion message was exactly `production Release package never reached
foreground`. That message maps to the foreground wait in
`resetAndLaunchTarget`, not to `requireInstalledReleaseTarget`: the package,
non-debuggable and launcher checks had all passed, and the pending check was
the foreground wait after the launch. Crash classification on that run was
`crash_class unknown` / `crash_site none` (no app or runner FATAL in the
filtered logcat), and `requireInstalledReleaseTarget`
compares no signature, no build configuration and no origin, and the run never
got as far as clicking Sign in, so **the real origin was never exercised** and
nothing about it is implicated. The observed stream is consistent with the
intermittent harness launch class seen on an earlier public successor, but
that similarity does not prove a race; so there is no origin allowlist
here and none is warranted.

Two changes follow from it, and only two of them are about that failure:

1. The launch itself is now deterministic (drained external `am start -W -n
   <component>` unquoted after the force-stop and `pm clear`), which removes
   asynchronous context-launch uncertainty and gives deterministic sequencing
   of force-stop / `pm clear` / start / foreground wait; it does not assert a
   proven app root cause. The broad category that misnamed the failure is now
   backed by per-check tags, so the same failure would project
   `assert_launch_foreground`.
2. The foreground wait itself no longer uses the accessibility-node proxy.
   Hosted stage2 run 35064127703 at this same head failed exactly
   `diag_assert assert_launch_foreground`, with the launch component and
   start checks passed, crash classification `unknown`/`none`, and no phase
   or pre-Chrome slot reached — while the same code passed locally on API34.
   That run isolates the real cause: `Until.hasObject(By.pkg(TARGET_PACKAGE))`
   is an accessibility-node condition that can stay false while the app
   already owns the foreground during startup/Compose restoration, so the
   predicate was a wrong harness proxy, not a proven app launch race. The
   wait now polls exact `currentPackageName` ownership on the monotonic clock
   inside the existing `APP_START_TIMEOUT_MS` budget at `BROWSER_POLL_MS`
   cadence, asserted as a boolean under `assert_launch_foreground` with the
   exact final equals still gated under `assert_launch_foreground_package`.
   No new timeout, no new budget, no app change.
3. The `callTimeout` finding below is a separate, independently-held source
   fact about the production app, fixed here on its own merits. It is not a
   diagnosis of that run.

## Production pre-Chrome flow: source findings

Read from the production sources, not inferred from a run.

- Between the Sign in click and the browser opening, the app performs exactly
  one network operation: OIDC discovery against the issuer.
  `SignInScreen` → `SessionStore.signIn()` → `ZitadelAuthService.signIn()` →
  `performSignIn()` calls `oidc.discover()` (a `GET` of
  `<issuer>/.well-known/openid-configuration` at `auth.pipod.dev`), then
  builds the authorization URL and calls `openUrl`. There is **no** API server
  preflight: `RuntimeConfig.serverUrl` is not read anywhere on that path, so
  the API origin should not affect pre-Chrome control flow at all. The origin
  is nevertheless now at exact parity with live, because "should not affect"
  is a source claim about control flow, not a measurement of the hosted
  environment, and reproducing an environment-dependent failure requires the
  same build configuration.
- `OidcClient` was constructed with the shared `AppContainer` `OkHttpClient`,
  which sets `connectTimeout` 15 s, `readTimeout` 60 s and `writeTimeout` 30 s
  but no whole-call bound. Those are per-operation bounds, not a bound on the
  whole call: connection setup, TLS, redirects and a slow body can each
  restart the clock, so pre-Chrome discovery could exceed the harness's 45 s
  Chrome-open deadline while the app was still legitimately working, and the
  UI had no way out of "Signing in…". **Fixed here, in production app code**:
  `AppContainer` now builds exactly one additional client from the existing
  shared `httpClient.newBuilder()` with `.callTimeout(20, TimeUnit.SECONDS)`
  (named `OIDC_CALL_TIMEOUT_SECONDS`) and passes it to `OidcClient` in
  `newOidcClient()`. The scope is deliberately one builder: the base API
  client and the WebSocket client are untouched, because a whole-call deadline
  is exactly wrong for a long-lived socket, and `OidcClient`,
  `ZitadelAuthService` and every other app file are unchanged. Discovery,
  token and JWKS requests are bounded by it; the browser is opened after those
  calls, so no time a person spends signing in is inside the bound. Exceeding
  it surfaces the app's existing fixed `FriendlyError` transport fallback,
  which is already the closed UI error state and which this harness already
  classifies as `prechrome_error_network` — no new copy, no new surface, no
  new state. The harness's 45 s Chrome-open deadline stays above that 20 s
  bound, so a bounded discovery failure lands as an app error surface inside
  the existing wait rather than as a harness timeout, and the fixed-wait sums
  (255 s public, 435 s live) are not claimed as literal totals: the launch
  shell wait above is itself additionally bounded by the overall process
  timeout. Trade-off, stated explicitly: the same `OidcClient` also performs
  the post-callback token exchange and any JWKS fetch, so the same 20 s
  whole-call bound applies there too. A post-callback timeout fails closed on
  that same existing transport error and requires a fresh browser/code to
  retry; there is no resume of a timed-out token call. Per explicit user
  request the fix stays one client builder; no second client, no per-call
  override, and no broader app change.
- The error-slot mapping is a source fact. `OidcClient.getJson` maps discovery
  transport `IOException`s (including socket timeouts) to
  `OidcTransientException`, which `FriendlyError.message` renders as its generic
  fallback — hence `network`, which is discovery-transport evidence rather than
  proof of an API call. The semantic discovery `ApiError`s survive
  `FriendlyError` as prose — hence `discovery`. The explicit timeout sentence
  has no producer on the current pre-Chrome path — hence `timeout` reserved.
  The browser-launch `ApiError` (`Could not open the sign-in page in a
  browser.`) matches no fixed pattern — hence `unknown_error_dialog`, as does
  any other error surface.
- The app has no `testTagsAsResourceId`, so its Compose `testTag`s are not
  exposed as resource IDs. The fixed `Sign in error: ` contentDescription
  prefix is therefore the only exact app-owned error surface available to an
  opaque-box harness, which is what the error slot uses.
- The API origin is still not read anywhere on the pre-Chrome path. The
  `callTimeout` above is on the OIDC client only, so it changes what bounds
  the issuer requests and nothing about which origins are contacted. Exact
  real-origin parity in the public job, and the four-slot pre-Chrome block,
  are both unchanged.

That earlier, already-merged pre-Chrome timeout change touched one production
app file, `app/src/main/kotlin/com/pipod/app/di/AppContainer.kt`, with one
client built from the existing shared builder plus the constant naming its
bound. The R5 browser-ownership candidate documented above makes no production
app change. It is Release-safe: no signing, manifest, ProGuard, permission,
credential-transport or workflow change, and no
behaviour change for any client other than OIDC.
