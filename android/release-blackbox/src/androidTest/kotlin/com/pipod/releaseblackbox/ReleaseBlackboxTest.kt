package com.pipod.releaseblackbox

import android.content.Context
import android.content.pm.ApplicationInfo
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import java.io.File
import java.io.FileInputStream
import java.util.regex.Pattern
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * External acceptance for the separately installed, minified production Release APK.
 *
 * Instrumentation targets the disposable runner host, not com.pipod. Every app
 * interaction is through Android intents and UiAutomator accessibility selectors;
 * this module has no production-project or production-classpath dependency.
 *
 * Secret-safe diagnostics: fixed phase/assertion-category tags are reported via
 * Instrumentation.sendStatus with a single custom Bundle key at status code 0
 * (the AndroidJUnitRunner OK code, additive-safe under `am instrument -r`:
 * it adds no failure signal to the existing bounded parser). The host runner
 * parses only exact allowlisted tags; no values, URLs, credential lengths, raw
 * output, or logcat are ever emitted here.
 *
 * Every actual assertion is preceded by the fixed tag that names exactly which
 * check is pending, so the last projected `diag_assert` identifies the single
 * check a failure was sitting on rather than the broad phase it belonged to.
 * Broad category tags are kept as the entry marker of a group; the per-check
 * tag is emitted immediately before the check itself. Every tag is a
 * compile-time constant: no dynamic value ever travels on this channel.
 */
@RunWith(AndroidJUnit4::class)
class ReleaseBlackboxTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val device = UiDevice.getInstance(instrumentation)
    private val hostContext: Context = instrumentation.targetContext

    // Set once, at the home screen, by resetAndLaunchTarget(). Until then, and
    // if that read is unusable, it holds a sentinel no foreground can equal.
    private var launcherPackage: String = UNRESOLVED_LAUNCHER_PACKAGE

    @Test
    fun releaseSignInReachesIdpUsername() {
        emit(ASSERT_HARNESS)
        requireHarnessIdentity()
        emit(ASSERT_RELEASE_TARGET)
        requireInstalledReleaseTarget()
        resetAndLaunchTarget()

        val signInClickedAtMs = clickAppSignInAction()

        requireChromeOpen(signInClickedAtMs)

        // Credential-free boundary: the one shared boundary helper, then
        // return. No setText, no credential reads, no Next click, no text
        // submission of any kind.
        val field = reachIdpUsernameBoundary(signInClickedAtMs)
        emit(ASSERT_IDP_USERNAME_BOUNDARY_RETURN)
        assertNotNull("IdP username boundary field missing", field)
    }

    @Test
    fun realPkceShowsPods() {
        emit(ASSERT_HARNESS)
        requireHarnessIdentity()
        emit(ASSERT_SCOPE)
        requireLiveAuthScope()
        emit(ASSERT_RELEASE_TARGET)
        requireInstalledReleaseTarget()
        emit(ASSERT_CREDENTIALS)
        val credentials = readAndDeleteCredentials()
        resetAndLaunchTarget()

        val signInClickedAtMs = clickAppSignInAction()

        requireChromeOpen(signInClickedAtMs)
        // Exactly the same shared boundary the public proof asserts: one
        // helper owns onboarding, inventory, readiness, the origin gate, and
        // the same-snapshot unique field. Live diverges only after it returns,
        // reusing that returned field rather than re-resolving one.
        val usernameField = reachIdpUsernameBoundary(signInClickedAtMs)
        typeLogin(usernameField, credentials.login, signInClickedAtMs)
        typePassword(credentials.password, signInClickedAtMs)

        emit(ASSERT_CALLBACK_APP_RETURN)
        // Callback/app return is its own phase: the exact target package must
        // own the foreground before any Pods claim is examined. Each of its
        // two checks names itself immediately before running.
        emit(ASSERT_CALLBACK_APP_RETURN_FOREGROUND)
        assertTrue(
            "PKCE callback did not return to the production app",
            device.wait(Until.hasObject(By.pkg(TARGET_PACKAGE)), CALLBACK_TIMEOUT_MS),
        )
        emit(ASSERT_CALLBACK_APP_RETURN_PACKAGE)
        assertEquals("PKCE did not return to the production app", TARGET_PACKAGE, device.currentPackageName)
        emit(PHASE_CALLBACK_APP_RETURN)
        // Monotonic instant of the callback, for the one elapsed slot of the
        // post-auth block below: it measures the authenticated screen's own
        // wait, not anything before it.
        val callbackAtMs = SystemClock.elapsedRealtime()
        // Pods is a separate phase with its own assertions, each named by its
        // own fixed tag immediately before it.
        emit(ASSERT_PODS)
        emit(ASSERT_PODS_SCREEN)
        val pods = device.wait(Until.findObject(appText("Pods")), PODS_TIMEOUT_MS)
        if (pods == null) {
            // Live run 35113969533 failed exactly here against production with
            // no evidence of what the app was showing: every authentication
            // phase passed through phase_callback_app_return, and the only
            // signal was this missing exact title. The block records what the
            // screen was instead, from exact package-qualified selectors only.
            emitPostAuthBlock(callbackAtMs)
            failNow("real PKCE did not return to the exact authenticated Pods screen")
        }
        emit(ASSERT_PODS_SETTINGS)
        assertTrue("authenticated shell Settings action missing", device.hasObject(appText("Settings")))
        emit(ASSERT_PODS_NO_SIGN_IN)
        assertFalse(
            "PKCE returned to an unauthenticated Sign in screen",
            device.hasObject(appText("Sign in")),
        )
        emit(PHASE_PODS)
    }

    // Every check below is a pre-phase check: no phase tag exists yet, so the
    // per-check tag emitted immediately before it is the only thing that names
    // what a failure was sitting on.
    private fun requireHarnessIdentity() {
        emit(ASSERT_HARNESS_TEST_PACKAGE)
        assertEquals("unexpected instrumentation package", TEST_PACKAGE, instrumentation.context.packageName)
        emit(ASSERT_HARNESS_HOST_PACKAGE)
        assertEquals("unexpected self-instrumentation target", HOST_PACKAGE, hostContext.packageName)
        emit(ASSERT_HARNESS_EXTERNAL_TARGET)
        assertNotEquals("blackbox instrumentation must not target the app", TARGET_PACKAGE, hostContext.packageName)
        emit(ASSERT_HARNESS_REQUESTED_TARGET)
        assertEquals(
            "pipodTargetPackage must explicitly request com.pipod",
            TARGET_PACKAGE,
            InstrumentationRegistry.getArguments().getString(ARG_TARGET_PACKAGE),
        )
    }

    private fun requireLiveAuthScope() {
        emit(ASSERT_SCOPE_LIVE_OPTIN)
        assertEquals(
            "LIVE required: pipodLive=1 (credentials never imply opt-in)",
            "1",
            InstrumentationRegistry.getArguments().getString(ARG_LIVE),
        )
        emit(ASSERT_SCOPE_AUTH)
        assertEquals(
            "pipodScope must be auth",
            "auth",
            InstrumentationRegistry.getArguments().getString(ARG_SCOPE),
        )
    }

    // Package identity only. This helper never compares a signature, a build
    // configuration, or an origin: it resolves the installed package, requires
    // it to be non-debuggable, and requires it to have a launcher entry.
    private fun requireInstalledReleaseTarget() {
        emit(ASSERT_RELEASE_TARGET_PACKAGE)
        val app = hostContext.packageManager.getApplicationInfo(TARGET_PACKAGE, 0)
        assertEquals("resolved the wrong target package", TARGET_PACKAGE, app.packageName)
        emit(ASSERT_RELEASE_TARGET_NONDEBUGGABLE)
        assertEquals(
            "installed com.pipod is debuggable; production Release required",
            0,
            app.flags and ApplicationInfo.FLAG_DEBUGGABLE,
        )
        emit(ASSERT_RELEASE_TARGET_LAUNCHER)
        assertNotNull(
            "installed com.pipod has no launcher intent",
            hostContext.packageManager.getLaunchIntentForPackage(TARGET_PACKAGE),
        )
    }

    // Deterministic external launch of the installed production Release.
    //
    // The context `startActivity` this replaced returned as soon as the intent
    // was accepted, so the foreground wait below was never sequenced against
    // the preceding force-stop/`pm clear`: the shell `am start -W -n` removes
    // that asynchronous context-launch uncertainty and gives deterministic
    // sequencing of force-stop / `pm clear` / start / foreground wait. This
    // does not assert a proven app root cause for any one run: it only makes
    // the launch itself deterministic. The launch is now the same
    // external shell channel as the reset, with the exact launcher component
    // resolved from the installed package's own metadata, and `-W` makes the
    // drained command return only once the launch has completed.
    //
    // `executeShellCommand` splits on exec argv, it is not a shell, so
    // single quotes would be literal and break the ComponentName. The
    // component is PackageManager-derived for the pinned package and
    // contains no whitespace, which the fixed-tagged guard below asserts
    // before the unquoted launch. No dynamic value is emitted.
    //
    // Still external blackbox: a shell command and package metadata, no app
    // classpath, no broad intent or action, and no signature/configuration or
    // origin comparison. The component is used, never emitted.
    //
    // Foreground is exact window ownership, never accessibility-node
    // presence. `Until.hasObject(By.pkg(TARGET_PACKAGE))` is an
    // accessibility-node condition and can stay false while the app already
    // owns the foreground during startup/Compose restoration: hosted stage2
    // run 35064127703 failed exactly that node wait with the launch
    // component/start checks passed, crash unknown/none, before any phase or
    // pre-Chrome slot, while the same code passed locally on API34. That
    // isolates a wrong harness proxy, not a proven app launch race. The
    // bounded wait below therefore polls exact `currentPackageName`
    // ownership on the monotonic clock inside the existing
    // APP_START_TIMEOUT_MS budget at BROWSER_POLL_MS cadence, and the exact
    // final equals still gates under ASSERT_LAUNCH_FOREGROUND_PACKAGE.
    private fun resetAndLaunchTarget() {
        emit(ASSERT_LAUNCH_TARGET)
        device.pressHome()
        shell("am force-stop $TARGET_PACKAGE")
        shell("pm clear $TARGET_PACKAGE")
        // The device is at home and the target is stopped and cleared, so
        // whoever owns the screen at this instant is this image's launcher.
        // That is the whole reason to read it: a foreground lost to the home
        // screen later in the run is then named `launcher` rather than
        // collapsing into `other`, on whatever image CI runs, without
        // resolving an intent or hard-coding a launcher package. The value is
        // only ever compared for exact equality and never emitted, logged, or
        // matched as a substring. An empty read, or one the harness already
        // names, leaves the sentinel in place and such a foreground stays
        // `other` rather than being mislabelled.
        launcherPackage = UNRESOLVED_LAUNCHER_PACKAGE
        val atHome = device.currentPackageName.orEmpty()
        if (atHome.isNotEmpty() && atHome != TARGET_PACKAGE && atHome != BROWSER_PACKAGE) {
            launcherPackage = atHome
        }
        emit(ASSERT_LAUNCH_COMPONENT)
        val component = hostContext.packageManager.getLaunchIntentForPackage(TARGET_PACKAGE)?.component
            ?: failNow("installed com.pipod has no launcher intent")
        emit(ASSERT_LAUNCH_COMPONENT_NO_WHITESPACE)
        val flattened = component.flattenToShortString()
        assertFalse("launcher component contains whitespace", flattened.any { it.isWhitespace() })
        emit(ASSERT_LAUNCH_START)
        shell("am start -W -n " + flattened)
        emit(ASSERT_LAUNCH_FOREGROUND)
        val launchDeadline = SystemClock.elapsedRealtime() + APP_START_TIMEOUT_MS
        var launchForeground = TARGET_PACKAGE == device.currentPackageName
        while (!launchForeground && SystemClock.elapsedRealtime() < launchDeadline) {
            Thread.sleep(BROWSER_POLL_MS)
            launchForeground = TARGET_PACKAGE == device.currentPackageName
        }
        assertTrue(
            "production Release package never reached foreground",
            launchForeground,
        )
        emit(ASSERT_LAUNCH_FOREGROUND_PACKAGE)
        assertEquals("wrong package launched", TARGET_PACKAGE, device.currentPackageName)
    }

    // The one shared Sign in action. Both tests start auth through this
    // single helper, so both select the identical node with the identical
    // selector and perform the identical single click.
    //
    // The selector is the app-owned semantic Button description, not its
    // visible Text child: SignInScreen sets semanticsLabel="Sign in" on the
    // AppButton itself, so the button node carries contentDescription "Sign in"
    // while the inner Text node carries text "Sign in". Hosted run 35065332907 at
    // head 9ab5dc4 reached phase_app_sign_in and then emitted the full
    // pre-Chrome block fg_own/error_none/progress_absent/elapsed_gt30 before
    // assert_chrome_open: the app stayed foreground for 45s with no progress
    // or error surface ever observed, i.e. the exact Sign in action was never
    // activated. This helper therefore selects
    // By.pkg(TARGET_PACKAGE).desc("Sign in"): exact package, exact
    // contentDescription. No generic text, no text child, no clickable filter:
    // a local exact API34 actual-Release test of the uncommitted
    // .clickable(true) variant failed before phase_app_sign_in under
    // assert_app_sign_in with the exact message production Release did not
    // show Sign in, so the clickable filter does not match this Compose
    // semantics tree and is not applied. The semantic AppButton description
    // remains preferable to the visible Text child. This initial helper has
    // one wait and one click only. The separate shared-boundary recovery is
    // guarded to one harness-only reissue after an acted Chrome first-run
    // control; it is not a retry in this helper.
    private fun clickAppSignInAction(): Long {
        emit(ASSERT_APP_SIGN_IN)
        val signIn = device.wait(
            Until.findObject(By.pkg(TARGET_PACKAGE).desc(APP_SIGN_IN_DESCRIPTION)),
            APP_START_TIMEOUT_MS,
        ) ?: failNow("production Release did not show the Sign in action")
        emit(PHASE_APP_SIGN_IN)
        emit(ASSERT_APP_SIGN_IN_ACTION)
        // Monotonic instant of the click itself, taken immediately before it
        // and handed to the one shared pre-Chrome helper: both tests measure
        // the same interval from the same event with the same clock.
        val signInClickedAtMs = SystemClock.elapsedRealtime()
        signIn.click()
        return signInClickedAtMs
    }

    // The one shared pre-Chrome path. Both tests reach the hosted browser
    // through this helper, so both record the identical four-slot diagnostic
    // block from the identical code.
    //
    // The bounded wait ends on the hosted Chrome browser, on an exact app
    // error surface, or at the existing [BROWSER_START_TIMEOUT_MS] deadline
    // measured from the click instant the caller captured. No new budget is
    // introduced: the enforcement below consumes only what is left of that
    // same 45s, so both worst-case step sums are unchanged.
    //
    // Only closed state is recorded — three fixed enums and one boolean.
    // App-owned nodes are inspected exclusively through package-qualified
    // exact selectors; no text or contentDescription is ever read back, so no
    // message content exists here to emit. No hierarchy dump, screenshot,
    // logcat, or raw string leaves this helper.
    private fun requireChromeOpen(startedAtMs: Long) {
        val deadline = startedAtMs + BROWSER_START_TIMEOUT_MS
        var chromeSeen = false
        var progressSeen = false
        var observedError = PRECHROME_ERROR_NONE
        while (SystemClock.elapsedRealtime() < deadline) {
            // Progress is sticky: the in-flight indicator is transient by
            // construction, so a final-state read would under-report it.
            if (!progressSeen && appProgressPresent()) progressSeen = true
            if (device.hasObject(By.pkg(BROWSER_PACKAGE))) {
                chromeSeen = true
                break
            }
            observedError = preChromeError()
            if (observedError != PRECHROME_ERROR_NONE) break
            Thread.sleep(BROWSER_POLL_MS)
        }
        // The error slot is the first surface observed during the bounded
        // wait, or the state at the instant that wait ended.
        if (observedError == PRECHROME_ERROR_NONE) observedError = preChromeError()
        val foreground = when (device.currentPackageName.orEmpty()) {
            TARGET_PACKAGE -> PRECHROME_FG_OWN
            BROWSER_PACKAGE -> PRECHROME_FG_CHROME
            else -> PRECHROME_FG_OTHER
        }
        val error = observedError
        val progress = if (progressSeen) PRECHROME_PROGRESS_PRESENT else PRECHROME_PROGRESS_ABSENT
        val elapsed = elapsedBucket(SystemClock.elapsedRealtime() - startedAtMs)
        // Exactly four tags, in this fixed dimension order, immediately before
        // the chrome-open assertion category. Each emitted value is one of the
        // fourteen compile-time PRECHROME_ constants: there is no
        // concatenation, formatting, or dynamic value on this path.
        emit(foreground)
        emit(error)
        emit(progress)
        emit(elapsed)
        emit(ASSERT_CHROME_OPEN)
        // An observed exact app error ends this attempt: Chrome cannot open
        // for it, so fail this same Chrome assertion immediately instead of
        // spending the remaining deadline waiting for a browser that cannot
        // arrive. Same category, same fixed message, no raw output. Only the
        // no-error path consumes the remaining slice below.
        if (error != PRECHROME_ERROR_NONE) {
            failNow("Sign in did not open the hosted Chrome browser")
        }
        // Unchanged enforcement for the no-error path: exact Chrome foreground
        // on the remaining slice of the same 45s deadline, then the same exact
        // ownership gate.
        val remainingMs = (deadline - SystemClock.elapsedRealtime()).coerceAtLeast(0L)
        assertTrue(
            "Sign in did not open the hosted Chrome browser",
            chromeSeen || device.wait(Until.hasObject(By.pkg(BROWSER_PACKAGE)), remainingMs),
        )
        requireBrowserOwnsCredentialUi(startedAtMs)
        emit(PHASE_CHROME_OPEN)
    }

    // Exact app-owned error surface only, classified into a fixed enum.
    //
    // The sign-in screen labels its error text with the fixed
    // contentDescription prefix `Sign in error: `, and that prefix is the
    // whole detection rule: every probe is an anchored package-qualified
    // selector, so a match is a boolean and the message never enters this
    // process. The notice surface carries the different fixed prefix
    // `Authentication notice: `, which no anchored pattern here can match.
    //
    // Classification runs most specific first and is cheap in the common
    // case: the generic surface probe gates everything else, so a normal poll
    // iteration costs one query. `discovery` is semantic config-document copy
    // only; `network` is the app's generic transport surface during discovery
    // (not proof of an API call); `timeout` is reserved for the explicit
    // fixed timeout copy; anything else — including the browser-launch
    // rejection — is `unknown_error_dialog`.
    private fun preChromeError(): String {
        if (!appErrorSurface(SIGN_IN_ERROR_ANY)) return PRECHROME_ERROR_NONE
        if (appErrorSurface(SIGN_IN_ERROR_DISCOVERY)) return PRECHROME_ERROR_DISCOVERY
        if (appErrorSurface(SIGN_IN_ERROR_TIMEOUT)) return PRECHROME_ERROR_TIMEOUT
        if (appErrorSurface(SIGN_IN_ERROR_NETWORK)) return PRECHROME_ERROR_NETWORK
        return PRECHROME_ERROR_UNKNOWN_DIALOG
    }

    private fun appErrorSurface(patterns: List<Pattern>): Boolean =
        patterns.any { device.hasObject(By.pkg(TARGET_PACKAGE).desc(it)) }

    // `present` means observed at least once during the bounded wait, never a
    // final-state read. The exact app-package ProgressBar class is the primary
    // probe and should match the in-flight indicator; the exact fixed app
    // string `Signing in…` is corroborating redundancy as a second
    // package-qualified exact probe. No generic or partial text matching.
    private fun appProgressPresent(): Boolean {
        if (device.hasObject(By.pkg(TARGET_PACKAGE).clazz(PROGRESS_BAR_CLASS))) return true
        return device.hasObject(By.pkg(TARGET_PACKAGE).text(SIGNING_IN_LABEL))
    }

    // Monotonic elapsed milliseconds since the click, bucketed on precise
    // half-open boundaries: lt5 is [0,5s), 5_15 is [5s,15s), 15_30 is
    // [15s,30s), gt30 is [30s,∞). Exactly 5s/15s/30s fall in the later
    // bucket of each pair.
    private fun elapsedBucket(elapsedMs: Long): String = when {
        elapsedMs < PRECHROME_ELAPSED_5S_MS -> PRECHROME_ELAPSED_LT5
        elapsedMs < PRECHROME_ELAPSED_15S_MS -> PRECHROME_ELAPSED_5_15
        elapsedMs < PRECHROME_ELAPSED_30S_MS -> PRECHROME_ELAPSED_15_30
        else -> PRECHROME_ELAPSED_GT30
    }

    // The one shared IdP username boundary. Both tests reach it through this
    // single helper: the credential-free public proof asserts the returned
    // field and stops, and live PKCE starts typing only after it returns.
    // There is no second onboarding or readiness path left to drift from.
    // Every loop iteration requires exact Chrome foreground ownership, with
    // two narrow harness-only exceptions, both spent from this loop's own
    // deadline and both ahead of any credential-bearing step.
    //
    // First: an exact app foreground plus an *enabled* exact app Sign-in
    // control permits one reissued click per run to recover a dismissed
    // Custom Tab. phase_signin_reissued_after_fre records a recovery after an
    // exact first-run action, phase_signin_reissued_no_fre one before any had
    // matched; both are the same single one-shot. While the exact semantic
    // node is present but its control is disabled — which is what the app's
    // own 1.5s abandon grace looks like from here — this helper polls on
    // within the same deadline without spending the one-shot.
    //
    // Second: a foreground this loop cannot act on is tolerated for a total
    // of MAX_FOREGROUND_SETTLE_MS across the whole wait, because dismissing
    // a first-run screen hands the window between activities and a read
    // inside that handover names whoever holds it at that instant. The
    // optional phase phase_chrome_foreground_settled records, once, that the
    // budget was used and Chrome then owned the foreground again.
    //
    // All other losses — and a tolerated one that outlives the budget, and
    // that deadline expiring — fail closed through the same ownership gate
    // and its fixed diagnostic block. Every gate from the end of this loop
    // onward is unchanged and unconditional.
    //
    // Chrome first run is handled only through exact Chrome-owned controls:
    // exact package plus Chromium-confirmed resource ID plus exact
    // dismiss/decline text that declines account/sync or dismisses UMA.
    // Never signin_fre_continue_button / fre_continue_button (those sign into
    // a Google account), never generic text matching (Accept, Next, Skip),
    // never Google account sign-in. The legacy terms_accept / negative_button
    // IDs are version-drift: terms is acted on only with its exact text, and
    // negative_button only after this run already accepted terms.
    // LightweightFirstRun button_primary is intentionally NOT handled:
    // confirming the exact LightweightFirstRunActivity needs shell dumpsys
    // parsing outside UiAutomator selectors, so handling omits it and fails
    // closed to the Login Name wait instead. Absence of these controls is not
    // a failure: whether onboarding blocks the IdP page is an unproven
    // hypothesis.
    //
    // Readiness accepts only the exact Login Name label or its
    // regex-anchored case-insensitive exact text/contentDescription
    // equivalents, still requiring exact Chrome ownership and exactly one
    // non-omnibox credential field from the same polled snapshot whose size
    // is emitted. A closed inventory (fixed allowlisted count tags plus
    // strictly generated Chrome identity digit tags on the proven pipodDiag
    // channel) is emitted
    // once immediately before the checks; nothing raw (no URL, text,
    // hierarchy, screenshot, or error content) is ever emitted. Reaching the
    // boundary additionally requires the internally inspected origin to be
    // the expected IdP host with no browser-error category: either an
    // internally parsed HTTPS URL on exactly that host, or the exact
    // host-only omnibox string. Nothing looser is accepted.
    private fun reachIdpUsernameBoundary(signInClickedAtMs: Long): UiObject2 {
        var firstRunEmitted = false
        var firstRunSteps = 0
        var signInReissued = false
        var termsAcceptedThisRun = false
        var settleSpentMs = 0L
        var settleEmitted = false
        val deadline = System.currentTimeMillis() + BOUNDARY_BROWSER_READY_TIMEOUT_MS
        while (System.currentTimeMillis() < deadline) {
            val foregroundPackage = device.currentPackageName.orEmpty()
            if (foregroundPackage != BROWSER_PACKAGE) {
                // Harness-only recovery for a dismissed Custom Tab: exact app
                // package in the foreground, an enabled exact Sign-in, and one
                // reissued click per run. It consumes the existing boundary
                // deadline: there is no retry budget and no app-behaviour
                // inference.
                //
                // Acting on a Chrome first-run control is deliberately NOT a
                // prerequisite. requireChromeOpen already proved exact Chrome
                // foreground before this loop, so the app owning it now is a
                // loss of that tab whether or not a first-run control has
                // matched yet. Public run 35104247401 failed exactly there:
                // browserown_fg_own / onboarding_absent / signin_visible at
                // elapsed_15_30 with no phase_chrome_first_run on the wire,
                // which a first-run prerequisite cannot recover. Which of the
                // two the run hit is reported by the phase emitted below, not
                // by refusing to recover one of them.
                val recoveryEligible = !signInReissued &&
                    foregroundPackage == TARGET_PACKAGE
                if (recoveryEligible) {
                    // The action must be an *enabled* Sign-in control, not
                    // merely a present semantic node. The production screen
                    // keeps `semanticsLabel="Sign in"` on its button while the
                    // in-flight attempt disables it (`Signing in…`), and a
                    // returning foreground starts the app's own 1.5s abandon
                    // grace before that attempt is given up, so the node is
                    // present and the control is dead for that whole window:
                    // clicking it would be swallowed and would consume this
                    // one-shot for nothing.
                    //
                    // Enabled is read from the node that actually carries it.
                    // A local API34 dump of the actual Release shows the exact
                    // `Sign in` contentDescription on a non-clickable child
                    // that reports enabled=true in both states, while its
                    // parent at identical bounds is clickable=true with
                    // enabled=false exactly while `Signing in…` is displayed.
                    // The selector is therefore that exact parent — app
                    // package, clickable, enabled, with the exact semantic
                    // child — and nothing looser: no text, no generic
                    // clickable, no structural walk. If the tree ever stops
                    // matching, this resolves to null and the wait below fails
                    // closed instead of clicking something unproven.
                    val enabledSignIn = device.findObject(
                        By.pkg(TARGET_PACKAGE).clickable(true).enabled(true)
                            .hasChild(By.pkg(TARGET_PACKAGE).desc(APP_SIGN_IN_DESCRIPTION)),
                    )
                    if (enabledSignIn != null) {
                        // Set the guard before the operation: even if click throws,
                        // this code can never issue the action twice.
                        signInReissued = true
                        enabledSignIn.click()
                        // One of two whole constants, naming which loss this
                        // one-shot recovered from: after an exact first-run
                        // action, or before any had matched. The guard above
                        // makes them mutually exclusive within a run.
                        if (firstRunEmitted) {
                            emit(PHASE_SIGNIN_REISSUED_AFTER_FRE)
                        } else {
                            emit(PHASE_SIGNIN_REISSUED_NO_FRE)
                        }
                        while (
                            System.currentTimeMillis() < deadline &&
                            device.currentPackageName.orEmpty() != BROWSER_PACKAGE
                        ) {
                            Thread.sleep(BROWSER_POLL_MS)
                        }
                        requireBrowserOwnsCredentialUi(signInClickedAtMs)
                        continue
                    }
                    if (device.hasObject(By.pkg(TARGET_PACKAGE).desc(APP_SIGN_IN_DESCRIPTION))) {
                        // Exact semantic node present but not actionable yet:
                        // this is what the abandon grace looks like. Re-evaluate
                        // on the next poll of this same loop. Nothing is spent —
                        // no one-shot, no phase emission, no settle budget — and the
                        // existing boundary deadline is still the only thing that
                        // ends the wait. If it expires with the action still
                        // disabled, the gate below the loop fails closed with the
                        // ownership block exactly as any other loss does.
                        Thread.sleep(BROWSER_POLL_MS)
                        continue
                    }
                }
                // Bounded transitional tolerance for a foreground this loop
                // cannot act on. Dismissing a first-run screen hands the
                // window between activities, and a read taken inside that
                // handover reports whoever holds it at that instant — the
                // launcher, the system UI, or the app — for a state that is
                // over within a poll or two. Chrome first-run is the one
                // place this harness deliberately drives that handover, and
                // it can drive it up to MAX_CHROME_FIRST_RUN_STEPS times.
                //
                // Tolerating it is bounded three ways and weakens nothing:
                // MAX_FOREGROUND_SETTLE_MS is a total across the whole wait
                // (never per loss, never reset), it is spent only from the
                // boundary deadline this loop already owns, and no
                // credential-bearing step runs inside it — every gate from
                // the end of this loop onward, and every gate in the field
                // poll and the typing helpers, is the same unconditional
                // exact-Chrome check as before. A loss that outlives the
                // budget fails closed through that same gate and the same
                // four-slot block, with the budget's own cost bounded so the
                // block still lands early in the deadline.
                if (settleSpentMs < MAX_FOREGROUND_SETTLE_MS) {
                    settleSpentMs += BROWSER_POLL_MS
                    Thread.sleep(BROWSER_POLL_MS)
                    continue
                }
                requireBrowserOwnsCredentialUi(signInClickedAtMs)
            } else if (settleSpentMs > 0L && !settleEmitted) {
                // Exact Chrome foreground observed again after tolerated
                // loss: the optional phase records that this run needed the
                // budget and that the wait continued with Chrome owning the
                // UI. Once per run, never on the path that fails closed.
                settleEmitted = true
                emit(PHASE_CHROME_FOREGROUND_SETTLED)
            }

            // One freshly queried exact Chrome-owned control per iteration,
            // bounded both by the shared deadline and by the maximum number
            // of first-run actions. No selector result is reused across
            // screens or iterations.
            var acted = false
            if (firstRunSteps < MAX_CHROME_FIRST_RUN_STEPS) {
                for (control in CHROME_SAFE_FIRST_RUN_CONTROLS) {
                    val match = device.findObject(
                        By.pkg(BROWSER_PACKAGE).res(control.resourceId).text(control.text),
                    )
                    if (match != null) {
                        match.click()
                        acted = true
                        break
                    }
                }
                if (!acted) {
                    val terms = device.findObject(
                        By.pkg(BROWSER_PACKAGE).res(CHROME_TERMS_ACCEPT_RESOURCE).text("Accept & continue"),
                    )
                    if (terms != null) {
                        terms.click()
                        termsAcceptedThisRun = true
                        acted = true
                    }
                }
                if (!acted && termsAcceptedThisRun) {
                    val decline = device.findObject(
                        By.pkg(BROWSER_PACKAGE).res(CHROME_SYNC_DECLINE_RESOURCE).text("No thanks"),
                    )
                    if (decline != null) {
                        decline.click()
                        acted = true
                    }
                }
            }
            if (acted) {
                firstRunSteps++
                if (!firstRunEmitted) {
                    emit(PHASE_CHROME_FIRST_RUN)
                    firstRunEmitted = true
                }
            }
            if (anyLoginLabelPresent()) break
            Thread.sleep(BROWSER_POLL_MS)
        }
        requireBrowserOwnsCredentialUi(signInClickedAtMs)
        // Poll the field list bounded BEFORE any inventory emission, so the
        // emitted count and the enforced unique field are the same snapshot:
        // an emitted 0 can never later pass with one.
        val fields = pollUsernameFields(signInClickedAtMs)
        requireBrowserOwnsCredentialUi(signInClickedAtMs)
        // Closed snapshot: count first, emit fixed tags once immediately
        // before the checks, then enforce from the same locals. Counts are
        // bounded to 0..9/many, the origin is a fixed enum, and Chrome
        // identity travels as strictly generated decimal digits on the
        // proven pipodDiag channel (separate Bundle keys were observed not
        // to arrive on API34).
        val onboardingCount = countRemainingOnboarding()
        val origin = classifyOrigin()
        val exactTextCount = device.findObjects(By.pkg(BROWSER_PACKAGE).text(LOGIN_LABEL)).size
        val exactDescCount = device.findObjects(By.pkg(BROWSER_PACKAGE).desc(LOGIN_LABEL)).size
        val ciTextCount = device.findObjects(By.pkg(BROWSER_PACKAGE).text(CI_LOGIN_NAME)).size
        val ciDescCount = device.findObjects(By.pkg(BROWSER_PACKAGE).desc(CI_LOGIN_NAME)).size
        val fieldCount = fields.size
        // Atomic with respect to Chrome identity lookup: both validated
        // lookups complete before the first inventory emit, so an identity
        // failure leaves no partial inventory on the wire and the trailing
        // digit tags cannot observe a mid-emission version change. Both
        // lookups fail with the same fixed message, so one category names
        // them immediately before the pair.
        emit(ASSERT_CHROME_IDENTITY)
        val browserMajor = chromeMajor()
        val browserVersionCode = chromeVersionCode()
        emit("inv_onboarding_remaining_" + invSuffix(onboardingCount))
        emit("inv_origin_" + origin)
        emit("inv_login_exact_text_" + invSuffix(exactTextCount))
        emit("inv_login_exact_desc_" + invSuffix(exactDescCount))
        emit("inv_login_ci_text_" + invSuffix(ciTextCount))
        emit("inv_login_ci_desc_" + invSuffix(ciDescCount))
        emit("inv_field_nonomnibox_" + invSuffix(fieldCount))
        // Strictly generated decimal digits through the proven channel:
        // toString on the pre-evaluated locals is total, so this
        // emission cannot throw before the username phase.
        emit("inv_chrome_major_" + browserMajor.toString())
        emit("inv_chrome_version_code_" + browserVersionCode.toString())
        // Readiness assertion only after the full inventory is on the wire,
        // immediately before the label checks it guards.
        emit(ASSERT_IDP_USERNAME_READY)
        if (exactTextCount + exactDescCount + ciTextCount + ciDescCount == 0) {
            failNow("OIDC browser did not present the labelled login page (onboarding cause unproven)")
        }
        emit(PHASE_IDP_USERNAME_READY)
        // The origin gate is its own pending check, not part of readiness.
        emit(ASSERT_IDP_ORIGIN)
        if (origin != INV_ORIGIN_EXPECTED) {
            failNow("IdP origin is not the expected host")
        }
        emit(ASSERT_IDP_USERNAME_FIELD)
        // The enforced field is the same polled snapshot whose size was
        // just emitted above: on 0/multiple the actual final bounded count
        // is already on the wire before either failure below, and each of
        // the two cardinality failures names itself first.
        emit(ASSERT_IDP_USERNAME_FIELD_MULTIPLE)
        if (fields.size > 1) failNow("OIDC page exposed more than one credential field")
        emit(ASSERT_IDP_USERNAME_FIELD_SETTLED)
        if (fields.size != 1) failNow("OIDC credential field never settled to exactly one")
        return fields.single()
    }

    private fun anyLoginLabelPresent(): Boolean {
        // Narrow readiness only: exact text/desc or regex-anchored
        // case-insensitive exact text/desc. No substring matching.
        if (device.findObject(By.pkg(BROWSER_PACKAGE).text(LOGIN_LABEL)) != null) return true
        if (device.findObject(By.pkg(BROWSER_PACKAGE).desc(LOGIN_LABEL)) != null) return true
        if (device.findObject(By.pkg(BROWSER_PACKAGE).text(CI_LOGIN_NAME)) != null) return true
        if (device.findObject(By.pkg(BROWSER_PACKAGE).desc(CI_LOGIN_NAME)) != null) return true
        return false
    }

    private fun countRemainingOnboarding(): Int {
        // Observation only (no clicks): every exact currently allowed
        // selector, counted in the same order it is acted on above.
        var remaining = 0
        for (control in CHROME_SAFE_FIRST_RUN_CONTROLS) {
            if (device.findObject(By.pkg(BROWSER_PACKAGE).res(control.resourceId).text(control.text)) != null) {
                remaining++
            }
        }
        if (device.findObject(By.pkg(BROWSER_PACKAGE).res(CHROME_TERMS_ACCEPT_RESOURCE).text("Accept & continue")) != null) {
            remaining++
        }
        if (device.findObject(By.pkg(BROWSER_PACKAGE).res(CHROME_SYNC_DECLINE_RESOURCE).text("No thanks")) != null) {
            remaining++
        }
        return remaining
    }

    private fun classifyOrigin(): String {
        // The omnibox text is inspected internally and never emitted: only
        // the fixed enum below leaves this function.
        val url = device.findObject(By.pkg(BROWSER_PACKAGE).res(CHROME_OMNIBOX_RESOURCE))?.text.orEmpty().trim()
        val scheme = try {
            Uri.parse(url).scheme.orEmpty()
        } catch (e: Exception) {
            ""
        }
        if (scheme.equals(CHROME_ERROR_SCHEME, ignoreCase = true)) return INV_ORIGIN_BROWSER_ERROR
        for (indicator in CHROME_ERROR_INDICATORS) {
            if (device.findObject(By.pkg(BROWSER_PACKAGE).text(indicator)) != null) {
                return INV_ORIGIN_BROWSER_ERROR
            }
        }
        if (url.isEmpty()) return INV_ORIGIN_UNAVAILABLE
        // Chrome often displays the host alone without a scheme: accept only
        // the exact expected host string, never a substring, suffix, or path.
        if (url.equals(EXPECTED_IDP_HOST, ignoreCase = true)) return INV_ORIGIN_EXPECTED
        val uri = try {
            Uri.parse(url)
        } catch (e: Exception) {
            null
        }
        val uriScheme = try {
            uri?.scheme.orEmpty()
        } catch (e: Exception) {
            ""
        }
        val host = try {
            uri?.host.orEmpty()
        } catch (e: Exception) {
            ""
        }
        if (uriScheme.equals("https", ignoreCase = true) && host.equals(EXPECTED_IDP_HOST, ignoreCase = true)) {
            return INV_ORIGIN_EXPECTED
        }
        return INV_ORIGIN_OTHER
    }

    private fun pollUsernameFields(signInClickedAtMs: Long): List<UiObject2> {
        // Bounded poll returning the final snapshot. The caller emits its
        // size in the inventory before enforcing uniqueness on the same
        // list, so 0/multiple failures project the actual final count.
        // Never treat an arbitrary EditText as the IdP form: Chrome's omnibox
        // is also an EditText and must never receive credentials.
        var fields: List<UiObject2> = emptyList()
        val deadline = System.currentTimeMillis() + BOUNDARY_FIELD_TIMEOUT_MS
        while (System.currentTimeMillis() < deadline) {
            requireBrowserOwnsCredentialUi(signInClickedAtMs)
            fields = device.findObjects(By.clazz(EDIT_TEXT_CLASS).pkg(BROWSER_PACKAGE))
                .filterNot(::isBrowserChromeField)
            if (fields.size == 1) break
            Thread.sleep(BROWSER_POLL_MS)
        }
        return fields
    }

    private fun chromeMajor(): Int {
        val versionName = try {
            hostContext.packageManager.getPackageInfo(BROWSER_PACKAGE, 0).versionName
        } catch (e: Exception) {
            null
        }
        val major = versionName?.substringBefore('.')?.toIntOrNull()
        if (major == null || major < CHROME_MAJOR_MIN || major > CHROME_MAJOR_MAX) {
            failNow("Chrome identity unavailable")
        }
        return major
    }

    private fun chromeVersionCode(): Long {
        val info = try {
            hostContext.packageManager.getPackageInfo(BROWSER_PACKAGE, 0)
        } catch (e: Exception) {
            null
        } ?: failNow("Chrome identity unavailable")
        val code = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            info.longVersionCode
        } else {
            @Suppress("DEPRECATION")
            info.versionCode.toLong()
        }
        if (code <= 0L) failNow("Chrome identity unavailable")
        return code
    }

    private fun invSuffix(count: Int): String = if (count >= 10) "many" else count.toString()

    private fun typeLogin(field: UiObject2, login: String, signInClickedAtMs: Long) {
        // The shared boundary already emitted ASSERT_IDP_USERNAME_READY,
        // PHASE_IDP_USERNAME_READY, and ASSERT_IDP_USERNAME_FIELD for exactly
        // this field, so nothing is re-emitted or re-waited here: a second
        // readiness pass would duplicate the username-ready phase and could
        // bind a different element than the one the boundary proved unique.
        // Each post-boundary interaction names itself first, so an exception
        // from ownership, click, or setter cannot be misattributed to the
        // cardinality checks above: the last tag on the wire is the operation
        // that was pending, not the group it followed.
        emit(ASSERT_IDP_USERNAME_OWNERSHIP)
        requireBrowserOwnsCredentialUi(signInClickedAtMs)
        emit(ASSERT_IDP_USERNAME_CLICK)
        field.click()
        emit(ASSERT_IDP_USERNAME_SETTER)
        // The setter returning is the only signal recorded; content is never
        // read back and must never be labelled verified.
        field.text = login
        emit(PHASE_IDP_USERNAME_SETTER_RETURNED)
        emit(ASSERT_IDP_USERNAME_ADVANCE)
        (device.findObject(browserText("Next")) ?: failNow("OIDC Next action missing after login")).click()
        emit(PHASE_IDP_USERNAME_ADVANCE)
    }

    private fun typePassword(password: String, signInClickedAtMs: Long) {
        val field = waitForOidcField(
            label = PASSWORD_LABEL,
            signInClickedAtMs = signInClickedAtMs,
            readyTag = PHASE_IDP_PASSWORD_READY,
            readyAssertTag = ASSERT_IDP_PASSWORD_READY,
            fieldAssertTag = ASSERT_IDP_PASSWORD_FIELD,
            multipleAssertTag = ASSERT_IDP_PASSWORD_FIELD_MULTIPLE,
            settledAssertTag = ASSERT_IDP_PASSWORD_FIELD_SETTLED,
        )
        // Same post-boundary contract as the username path: each interaction
        // names itself first, so an exception from click or setter cannot be
        // misattributed to cardinality. The exact Next actions already carry
        // their own advance/submit tags below.
        emit(ASSERT_IDP_PASSWORD_CLICK)
        field.click()
        emit(ASSERT_IDP_PASSWORD_SETTER)
        // The setter returning is the only signal recorded; content is never
        // read back and must never be labelled verified.
        field.text = password
        emit(PHASE_IDP_PASSWORD_SETTER_RETURNED)
        emit(ASSERT_IDP_PASSWORD_SUBMIT)
        (device.findObject(browserText("Next")) ?: failNow("OIDC Next action missing after password")).click()
        // Some hosted-browser builds leave a second confirmation on screen.
        device.findObject(browserText("Next"))?.click()
        emit(PHASE_IDP_PASSWORD_SUBMIT)
    }

    private fun waitForOidcField(
        label: String,
        signInClickedAtMs: Long,
        readyTag: String,
        readyAssertTag: String,
        fieldAssertTag: String,
        multipleAssertTag: String,
        settledAssertTag: String,
    ): UiObject2 {
        // A label timeout ends with the readiness category: the ready assert
        // is emitted first and nothing on the timeout path overwrites it.
        // Label found emits the ready phase; only then does the field
        // cardinality check emit the field category.
        emit(readyAssertTag)
        val deadline = System.currentTimeMillis() + FIELD_TIMEOUT_MS
        var labelFound = false
        while (System.currentTimeMillis() < deadline) {
            requireBrowserOwnsCredentialUi(signInClickedAtMs)
            if (device.findObject(browserText(label)) != null) {
                labelFound = true
                break
            }
            Thread.sleep(BROWSER_POLL_MS)
        }
        if (!labelFound) failNow("OIDC labelled credential field missing")
        emit(readyTag)
        emit(fieldAssertTag)
        // Each cardinality failure names itself: the multiple-field category
        // is pending inside the poll, the settled category from the moment
        // the bounded poll can only end by running out.
        emit(multipleAssertTag)
        while (System.currentTimeMillis() < deadline) {
            requireBrowserOwnsCredentialUi(signInClickedAtMs)
            val fields = device.findObjects(By.clazz(EDIT_TEXT_CLASS).pkg(BROWSER_PACKAGE))
                .filterNot(::isBrowserChromeField)
            if (fields.size == 1) return fields.single()
            if (fields.size > 1) failNow("OIDC page exposed more than one credential field")
            Thread.sleep(BROWSER_POLL_MS)
        }
        emit(settledAssertTag)
        failNow("OIDC credential field never settled to exactly one")
    }

    private fun isBrowserChromeField(field: UiObject2): Boolean {
        val resource = field.resourceName.orEmpty()
        val description = field.contentDescription.orEmpty()
        return resource == CHROME_OMNIBOX_RESOURCE ||
            description.equals(CHROME_OMNIBOX_DESCRIPTION, ignoreCase = true)
    }

    private fun requireBrowserOwnsCredentialUi(signInClickedAtMs: Long) {
        // The browser category is emitted only on an actual ownership
        // failure, so a normal label timeout keeps its readiness category.
        // The package is read exactly once and the same snapshot both decides
        // the failure and is classified into the block below: re-reading it
        // there could report `browserown_fg_chrome` for a failure that only
        // happened because Chrome did not own the foreground.
        val foregroundPackage = device.currentPackageName.orEmpty()
        if (BROWSER_PACKAGE != foregroundPackage) {
            emitBrowserOwnershipBlock(foregroundPackage, signInClickedAtMs)
            emit(ASSERT_BROWSER_OWNS_UI)
            failNow("credentials must only be typed into the hosted Chrome OIDC browser")
        }
    }

    // The classified package is the caller's failing snapshot, never a fresh
    // read: the block describes the state that failed the gate. The exact
    // Chrome branch is therefore unreachable by construction and kept only so
    // the mapping stays total over the fixed packages; `browserown_fg_chrome`
    // on the wire would mean an emitter bug, not a Chrome foreground.
    private fun emitBrowserOwnershipBlock(foregroundPackage: String, signInClickedAtMs: Long) {
        val launcher = launcherPackage
        val ownerForeground = when (foregroundPackage) {
            TARGET_PACKAGE -> BROWSEROWN_FG_OWN
            BROWSER_PACKAGE -> BROWSEROWN_FG_CHROME
            SYSTEM_UI_PACKAGE -> BROWSEROWN_FG_SYSTEM_UI
            PLAY_SERVICES_PACKAGE -> BROWSEROWN_FG_PLAY_SERVICES
            HOST_PACKAGE -> BROWSEROWN_FG_HARNESS
            ANDROID_SYSTEM_PACKAGE -> BROWSEROWN_FG_ANDROID
            launcher -> BROWSEROWN_FG_LAUNCHER
            else -> BROWSEROWN_FG_OTHER
        }
        val ownerOnboarding = if (countRemainingOnboarding() > 0) {
            BROWSEROWN_ONBOARDING_PRESENT
        } else {
            BROWSEROWN_ONBOARDING_ABSENT
        }
        val ownerSignIn = if (
            device.hasObject(By.pkg(TARGET_PACKAGE).desc(APP_SIGN_IN_DESCRIPTION))
        ) {
            BROWSEROWN_SIGNIN_VISIBLE
        } else {
            BROWSEROWN_SIGNIN_ABSENT
        }
        val ownerElapsed = browserOwnElapsedBucket(
            SystemClock.elapsedRealtime() - signInClickedAtMs,
        )
        // One complete fixed block, in parser order, immediately before the
        // sole ASSERT_BROWSER_OWNS_UI emission. Only whole allowlisted
        // constants leave the device; no package, URL, node, or UI text does.
        emit(ownerForeground)
        emit(ownerOnboarding)
        emit(ownerSignIn)
        emit(ownerElapsed)
    }

    private fun browserOwnElapsedBucket(elapsedMs: Long): String = when {
        elapsedMs < PRECHROME_ELAPSED_5S_MS -> BROWSEROWN_ELAPSED_LT5
        elapsedMs < PRECHROME_ELAPSED_15S_MS -> BROWSEROWN_ELAPSED_5_15
        elapsedMs < PRECHROME_ELAPSED_30S_MS -> BROWSEROWN_ELAPSED_15_30
        else -> BROWSEROWN_ELAPSED_GT30
    }

    // The classified state of the authenticated screen at the instant its
    // exact title was not found. Emitted once, only on that failure, and only
    // from exact app-package selectors: three anchored presence probes, one
    // foreground package equality, and one monotonic bucket. No text,
    // description, URL, node, hierarchy, screenshot, or error message is ever
    // read back or emitted, so nothing about the account or its pods can
    // travel on this channel.
    //
    // The three probes are the exact fixed surfaces the authenticated pod list
    // can show instead of its title:
    //   shell    exact `Settings` destination — the authenticated shell drew
    //   progress exact `Loading pods` indicator description, or the app's own
    //            ProgressBar class — the account fetch had not finished
    //   error    exact `Retry refreshing pods` action — the load-error tile
    //            drew, whose message itself is never read
    //   signin   exact `Sign in` action — the app fell back to signed-out
    private fun emitPostAuthBlock(callbackAtMs: Long) {
        val launcher = launcherPackage
        val foreground = when (device.currentPackageName.orEmpty()) {
            TARGET_PACKAGE -> POSTAUTH_FG_OWN
            BROWSER_PACKAGE -> POSTAUTH_FG_CHROME
            SYSTEM_UI_PACKAGE -> POSTAUTH_FG_SYSTEM_UI
            PLAY_SERVICES_PACKAGE -> POSTAUTH_FG_PLAY_SERVICES
            HOST_PACKAGE -> POSTAUTH_FG_HARNESS
            ANDROID_SYSTEM_PACKAGE -> POSTAUTH_FG_ANDROID
            launcher -> POSTAUTH_FG_LAUNCHER
            else -> POSTAUTH_FG_OTHER
        }
        val shell = if (device.hasObject(appText("Settings"))) {
            POSTAUTH_SHELL_PRESENT
        } else {
            POSTAUTH_SHELL_ABSENT
        }
        val progress = if (postAuthProgressPresent()) {
            POSTAUTH_PROGRESS_PRESENT
        } else {
            POSTAUTH_PROGRESS_ABSENT
        }
        val error = if (
            device.hasObject(By.pkg(TARGET_PACKAGE).desc(PODS_RETRY_DESCRIPTION))
        ) {
            POSTAUTH_ERROR_PRESENT
        } else {
            POSTAUTH_ERROR_ABSENT
        }
        val signIn = if (
            device.hasObject(By.pkg(TARGET_PACKAGE).desc(APP_SIGN_IN_DESCRIPTION))
        ) {
            POSTAUTH_SIGNIN_VISIBLE
        } else {
            POSTAUTH_SIGNIN_ABSENT
        }
        val elapsed = postAuthElapsedBucket(SystemClock.elapsedRealtime() - callbackAtMs)
        // One complete fixed block, in parser order, immediately after the
        // ASSERT_PODS_SCREEN category that names the failing check and
        // immediately before the failure itself.
        emit(foreground)
        emit(shell)
        emit(progress)
        emit(error)
        emit(signIn)
        emit(elapsed)
    }

    // `present` is a final-state read, unlike the sticky pre-Chrome probe:
    // this runs once, after a bounded wait has already ended, so there is no
    // interval to observe.
    private fun postAuthProgressPresent(): Boolean {
        if (device.hasObject(By.pkg(TARGET_PACKAGE).desc(PODS_LOADING_DESCRIPTION))) return true
        return device.hasObject(By.pkg(TARGET_PACKAGE).clazz(PROGRESS_BAR_CLASS))
    }

    // Monotonic milliseconds since the callback, on half-open boundaries
    // scaled to this screen's own 60s wait: lt15 is [0,15s), 15_30 is
    // [15s,30s), 30_60 is [30s,60s), gt60 is [60s,∞).
    private fun postAuthElapsedBucket(elapsedMs: Long): String = when {
        elapsedMs < PRECHROME_ELAPSED_15S_MS -> POSTAUTH_ELAPSED_LT15
        elapsedMs < PRECHROME_ELAPSED_30S_MS -> POSTAUTH_ELAPSED_15_30
        elapsedMs < POSTAUTH_ELAPSED_60S_MS -> POSTAUTH_ELAPSED_30_60
        else -> POSTAUTH_ELAPSED_GT60
    }

    private fun readAndDeleteCredentials(): Credentials {
        val file = File(hostContext.filesDir, CREDS_FILE)
        emit(ASSERT_CREDENTIALS_FILE)
        if (!file.isFile) failNow("PKCE credential file missing from the runner host")
        val values = mutableMapOf<String, String>()
        try {
            file.bufferedReader().useLines { lines ->
                lines.forEach { line ->
                    val separator = line.indexOf('=')
                    if (separator > 0) values[line.substring(0, separator)] = line.substring(separator + 1)
                }
            }
        } finally {
            emit(ASSERT_CREDENTIALS_DELETED)
            assertTrue("PKCE credential file was not deleted after one read", file.delete())
        }
        val login = values[LOGIN_KEY].orEmpty()
        val password = values[PASSWORD_KEY].orEmpty()
        emit(ASSERT_CREDENTIALS_KEYS)
        if (login.isEmpty() || password.isEmpty()) failNow("PKCE credential file missing required keys")
        return Credentials(login, password)
    }

    private fun appText(text: String) = By.text(text).pkg(TARGET_PACKAGE)

    private fun browserText(text: String) = By.text(text).pkg(BROWSER_PACKAGE)

    private fun emit(tag: String) {
        val status = Bundle()
        status.putString(DIAG_KEY, tag)
        instrumentation.sendStatus(DIAG_STATUS_CODE, status)
    }

    private fun failNow(message: String): Nothing = throw AssertionError(message)

    private fun shell(command: String) {
        instrumentation.uiAutomation.executeShellCommand(command).use { descriptor ->
            // Drain the pipe so the shell command has completed before launch.
            FileInputStream(descriptor.fileDescriptor).use { stream -> stream.readBytes() }
        }
    }

    private data class Credentials(val login: String, val password: String)

    private data class ChromeFirstRunControl(val resourceId: String, val text: String)

    private companion object {
        const val TARGET_PACKAGE = "com.pipod"
        const val HOST_PACKAGE = "com.pipod.releaseblackbox.runner"
        const val TEST_PACKAGE = "com.pipod.releaseblackbox.runner.test"
        const val BROWSER_PACKAGE = "com.android.chrome"
        const val SYSTEM_UI_PACKAGE = "com.android.systemui"
        const val PLAY_SERVICES_PACKAGE = "com.google.android.gms"

        // The framework's own package, matched only by exact equality.
        const val ANDROID_SYSTEM_PACKAGE = "android"

        // Contains a character no package name may contain, so no foreground
        // read can ever equal it. See the launcher capture in resetAndLaunchTarget().
        const val UNRESOLVED_LAUNCHER_PACKAGE = "/unresolved-launcher"
        const val ARG_TARGET_PACKAGE = "pipodTargetPackage"
        const val ARG_LIVE = "pipodLive"
        const val ARG_SCOPE = "pipodScope"
        const val CREDS_FILE = "pipod-acceptance.env"
        const val LOGIN_KEY = "LOGIN"
        const val PASSWORD_KEY = "PASSWORD"
        const val EDIT_TEXT_CLASS = "android.widget.EditText"
        const val PROGRESS_BAR_CLASS = "android.widget.ProgressBar"
        // The exact fixed in-flight label the production sign-in button shows
        // while a sign-in is running. Package-qualified exact text only.
        const val SIGNING_IN_LABEL = "Signing in…"
        const val APP_SIGN_IN_DESCRIPTION = "Sign in"
        const val LOGIN_LABEL = "Login Name"
        const val PASSWORD_LABEL = "Password"
        // The exact fixed contentDescription prefix the production sign-in
        // screen sets on its error text. The notice surface carries the
        // different fixed prefix `Authentication notice: `, so none of the
        // anchored patterns below can ever match a notice.
        const val SIGN_IN_ERROR_PREFIX = "Sign in error: "

        // UiAutomator matches text/desc patterns against the whole value, so
        // every pattern here is anchored by construction and built only from
        // fixed copy: exact for a fixed message, prefix for a fixed message
        // family whose tail is a discovery field name. Patterns are used as
        // selectors, never as readers: no message text enters this process.
        private fun signInErrorExact(message: String): Pattern =
            Pattern.compile("^" + Pattern.quote(SIGN_IN_ERROR_PREFIX + message) + "$", Pattern.DOTALL)

        private fun signInErrorPrefix(prefix: String): Pattern =
            Pattern.compile("^" + Pattern.quote(SIGN_IN_ERROR_PREFIX + prefix) + ".*$", Pattern.DOTALL)

        // Any app error surface at all: the fixed prefix and nothing else.
        val SIGN_IN_ERROR_ANY: List<Pattern> = listOf(signInErrorPrefix(""))
        // Semantic discovery/config-document errors only: the ApiError copy that
        // survives FriendlyError as prose (`OIDC discovery issuer mismatch`,
        // `OIDC discovery document is missing ...`, `OIDC discovery document has
        // invalid ...`). The one `OIDC discovery` prefix covers the family.
        // Discovery transport IO/timeouts collapse to the network fallback
        // below, never here.
        val SIGN_IN_ERROR_DISCOVERY: List<Pattern> = listOf(
            signInErrorPrefix("OIDC discovery"),
        )
        // Reserved: reachable only if the explicit fixed timeout copy reaches
        // the UI. The current production pre-Chrome flow carries no explicit
        // overall timeout copy, and discovery socket timeouts collapse to the
        // network fallback, so no claim is made that socket timeouts
        // distinguish this slot today.
        val SIGN_IN_ERROR_TIMEOUT: List<Pattern> = listOf(
            signInErrorExact("The server took too long to respond. Try again."),
        )
        // The app's generic transport surface observed during OIDC discovery:
        // the fixed FriendlyError transport-fallback and connectivity copy.
        // OidcClient maps discovery transport IO (including socket timeouts)
        // to OidcTransientException, which FriendlyError renders as its
        // fallback, so this is generic discovery-transport evidence, not proof
        // of an API call (the API origin is not read on the pre-Chrome path).
        val SIGN_IN_ERROR_NETWORK: List<Pattern> = listOf(
            signInErrorExact(
                "Something went wrong talking to the server. " +
                    "Check your connection and try again.",
            ),
            signInErrorExact("You appear to be offline. Check your connection and try again."),
            signInErrorExact("A network problem kept that from finishing. Try again."),
            signInErrorPrefix("Couldn’t reach the pi pod server"),
        )
        // Regex-anchored case-insensitive exact Login Name: the same label,
        // no substring matching. Derived from LOGIN_LABEL so the exact and
        // lenient probes cannot drift apart.
        val CI_LOGIN_NAME: Pattern = Pattern.compile("^" + Pattern.quote(LOGIN_LABEL) + "$", Pattern.CASE_INSENSITIVE)
        // Fixed known Chrome error-page indicators, package-qualified exact
        // text only: they can only ever project the browser_error enum, so a
        // miss fails closed to other/unavailable instead of passing.
        val CHROME_ERROR_INDICATORS = listOf(
            "This site can't be reached",
            "This site can’t be reached",
            "No internet",
        )
        const val EXPECTED_IDP_HOST = "auth.pipod.dev"
        const val CHROME_ERROR_SCHEME = "chrome-error"
        const val INV_ORIGIN_EXPECTED = "expected"
        const val INV_ORIGIN_BROWSER_ERROR = "browser_error"
        const val INV_ORIGIN_OTHER = "other"
        const val INV_ORIGIN_UNAVAILABLE = "unavailable"
        const val CHROME_MAJOR_MIN = 1
        const val CHROME_MAJOR_MAX = 999
        const val CHROME_OMNIBOX_RESOURCE = "com.android.chrome:id/url_bar"
        const val CHROME_OMNIBOX_DESCRIPTION = "Search or type web address"
        // Exact Chrome-owned first-run controls only: Chromium-confirmed
        // resource ID plus exact dismiss/decline text. Never the
        // continue-as-account buttons, never a generic text match, never
        // Google account sign-in. LightweightFirstRun button_primary is
        // deliberately absent (exact-activity confirmation is out of scope).
        const val CHROME_FRE_DISMISS_RESOURCE = "com.android.chrome:id/signin_fre_dismiss_button"
        const val CHROME_UMA_DISMISS_RESOURCE = "com.android.chrome:id/fre_uma_dialog_dismiss_button"
        const val CHROME_FRE_GENERIC_DISMISS_RESOURCE = "com.android.chrome:id/fre_dismiss_button"
        // Legacy version-drift IDs: terms_accept is acted on only with its
        // exact text, and negative_button only after this run accepted terms.
        const val CHROME_TERMS_ACCEPT_RESOURCE = "com.android.chrome:id/terms_accept"
        const val CHROME_SYNC_DECLINE_RESOURCE = "com.android.chrome:id/negative_button"
        const val DIAG_KEY = "pipodDiag"
        // Status code 0 is the AndroidJUnitRunner OK code: additive-safe under
        // `am instrument -r`, adding no failure signal to the bounded parser.
        const val DIAG_STATUS_CODE = 0
        const val PHASE_APP_SIGN_IN = "phase_app_sign_in"
        const val PHASE_CHROME_OPEN = "phase_chrome_open"
        const val PHASE_CHROME_FIRST_RUN = "phase_chrome_first_run"
        const val PHASE_SIGNIN_REISSUED_AFTER_FRE = "phase_signin_reissued_after_fre"
        const val PHASE_SIGNIN_REISSUED_NO_FRE = "phase_signin_reissued_no_fre"
        const val PHASE_CHROME_FOREGROUND_SETTLED = "phase_chrome_foreground_settled"
        const val PHASE_IDP_USERNAME_READY = "phase_idp_username_ready"
        const val PHASE_IDP_USERNAME_SETTER_RETURNED = "phase_idp_username_setter_returned"
        const val PHASE_IDP_USERNAME_ADVANCE = "phase_idp_username_advance"
        const val PHASE_IDP_PASSWORD_READY = "phase_idp_password_ready"
        const val PHASE_IDP_PASSWORD_SETTER_RETURNED = "phase_idp_password_setter_returned"
        const val PHASE_IDP_PASSWORD_SUBMIT = "phase_idp_password_submit"
        const val PHASE_CALLBACK_APP_RETURN = "phase_callback_app_return"
        const val PHASE_PODS = "phase_pods"
        // Broad category tags: the entry marker of a group of checks.
        const val ASSERT_HARNESS = "assert_harness"
        const val ASSERT_SCOPE = "assert_scope"
        const val ASSERT_RELEASE_TARGET = "assert_release_target"
        const val ASSERT_LAUNCH_TARGET = "assert_launch_target"
        const val ASSERT_CREDENTIALS = "assert_credentials"
        const val ASSERT_APP_SIGN_IN = "assert_app_sign_in"
        const val ASSERT_APP_SIGN_IN_ACTION = "assert_app_sign_in_action"
        const val ASSERT_CHROME_OPEN = "assert_chrome_open"
        const val ASSERT_IDP_USERNAME_READY = "assert_idp_username_ready"
        const val ASSERT_IDP_USERNAME_FIELD = "assert_idp_username_field"
        const val ASSERT_IDP_USERNAME_ADVANCE = "assert_idp_username_advance"
        const val ASSERT_IDP_PASSWORD_READY = "assert_idp_password_ready"
        const val ASSERT_IDP_PASSWORD_FIELD = "assert_idp_password_field"
        const val ASSERT_IDP_PASSWORD_SUBMIT = "assert_idp_password_submit"
        const val ASSERT_CALLBACK_APP_RETURN = "assert_callback_app_return"
        const val ASSERT_PODS = "assert_pods"
        const val ASSERT_BROWSER_OWNS_UI = "assert_browser_owns_ui"
        // Per-check tags: emitted immediately before the single check they
        // name, so the last one on the wire is the exact pending check. Every
        // one is a compile-time constant with no dynamic part.
        const val ASSERT_HARNESS_TEST_PACKAGE = "assert_harness_test_package"
        const val ASSERT_HARNESS_HOST_PACKAGE = "assert_harness_host_package"
        const val ASSERT_HARNESS_EXTERNAL_TARGET = "assert_harness_external_target"
        const val ASSERT_HARNESS_REQUESTED_TARGET = "assert_harness_requested_target"
        const val ASSERT_SCOPE_LIVE_OPTIN = "assert_scope_live_optin"
        const val ASSERT_SCOPE_AUTH = "assert_scope_auth"
        const val ASSERT_RELEASE_TARGET_PACKAGE = "assert_release_target_package"
        const val ASSERT_RELEASE_TARGET_NONDEBUGGABLE = "assert_release_target_nondebuggable"
        const val ASSERT_RELEASE_TARGET_LAUNCHER = "assert_release_target_launcher"
        const val ASSERT_LAUNCH_COMPONENT = "assert_launch_component"
        const val ASSERT_LAUNCH_COMPONENT_NO_WHITESPACE = "assert_launch_component_no_whitespace"
        const val ASSERT_LAUNCH_START = "assert_launch_start"
        const val ASSERT_LAUNCH_FOREGROUND = "assert_launch_foreground"
        const val ASSERT_LAUNCH_FOREGROUND_PACKAGE = "assert_launch_foreground_package"
        const val ASSERT_CREDENTIALS_FILE = "assert_credentials_file"
        const val ASSERT_CREDENTIALS_DELETED = "assert_credentials_deleted"
        const val ASSERT_CREDENTIALS_KEYS = "assert_credentials_keys"
        const val ASSERT_CHROME_IDENTITY = "assert_chrome_identity"
        const val ASSERT_IDP_ORIGIN = "assert_idp_origin"
        const val ASSERT_IDP_USERNAME_FIELD_MULTIPLE = "assert_idp_username_field_multiple"
        const val ASSERT_IDP_USERNAME_FIELD_SETTLED = "assert_idp_username_field_settled"
        const val ASSERT_IDP_USERNAME_BOUNDARY_RETURN = "assert_idp_username_boundary_return"
        // Post-boundary interaction points: emitted before each operation so
        // an exception there cannot be misattributed to cardinality. The
        // exact Next actions already carry their own advance/submit tags.
        const val ASSERT_IDP_USERNAME_OWNERSHIP = "assert_idp_username_ownership"
        const val ASSERT_IDP_USERNAME_CLICK = "assert_idp_username_click"
        const val ASSERT_IDP_USERNAME_SETTER = "assert_idp_username_setter"
        const val ASSERT_IDP_PASSWORD_CLICK = "assert_idp_password_click"
        const val ASSERT_IDP_PASSWORD_SETTER = "assert_idp_password_setter"
        const val ASSERT_IDP_PASSWORD_FIELD_MULTIPLE = "assert_idp_password_field_multiple"
        const val ASSERT_IDP_PASSWORD_FIELD_SETTLED = "assert_idp_password_field_settled"
        const val ASSERT_CALLBACK_APP_RETURN_FOREGROUND = "assert_callback_app_return_foreground"
        const val ASSERT_CALLBACK_APP_RETURN_PACKAGE = "assert_callback_app_return_package"
        const val ASSERT_PODS_SCREEN = "assert_pods_screen"
        const val ASSERT_PODS_SETTINGS = "assert_pods_settings"
        const val ASSERT_PODS_NO_SIGN_IN = "assert_pods_no_sign_in"
        // Fixed pre-Chrome diagnostic block. Four slots, always emitted in
        // this dimension order by the one shared requireChromeOpen helper
        // immediately before ASSERT_CHROME_OPEN. It is its own closed block:
        // never a phase, never an assertion category, never inventory.
        const val PRECHROME_FG_OWN = "prechrome_fg_own"
        const val PRECHROME_FG_CHROME = "prechrome_fg_chrome"
        const val PRECHROME_FG_OTHER = "prechrome_fg_other"
        const val PRECHROME_ERROR_NONE = "prechrome_error_none"
        const val PRECHROME_ERROR_NETWORK = "prechrome_error_network"
        const val PRECHROME_ERROR_DISCOVERY = "prechrome_error_discovery"
        const val PRECHROME_ERROR_TIMEOUT = "prechrome_error_timeout"
        const val PRECHROME_ERROR_UNKNOWN_DIALOG = "prechrome_error_unknown_error_dialog"
        const val PRECHROME_PROGRESS_PRESENT = "prechrome_progress_present"
        const val PRECHROME_PROGRESS_ABSENT = "prechrome_progress_absent"
        const val PRECHROME_ELAPSED_LT5 = "prechrome_elapsed_lt5"
        const val PRECHROME_ELAPSED_5_15 = "prechrome_elapsed_5_15"
        const val PRECHROME_ELAPSED_15_30 = "prechrome_elapsed_15_30"
        const val PRECHROME_ELAPSED_GT30 = "prechrome_elapsed_gt30"
        // Fixed browser-ownership failure block. Four slots, always emitted
        // in this order immediately before ASSERT_BROWSER_OWNS_UI. Foreground
        // is classified only from exact package equality; the other slots
        // expose only allowlisted selector presence and a monotonic bucket.
        const val BROWSEROWN_FG_OWN = "browserown_fg_own"
        const val BROWSEROWN_FG_CHROME = "browserown_fg_chrome"
        const val BROWSEROWN_FG_SYSTEM_UI = "browserown_fg_system_ui"
        const val BROWSEROWN_FG_PLAY_SERVICES = "browserown_fg_play_services"
        const val BROWSEROWN_FG_HARNESS = "browserown_fg_harness"
        const val BROWSEROWN_FG_ANDROID = "browserown_fg_android"
        const val BROWSEROWN_FG_LAUNCHER = "browserown_fg_launcher"
        const val BROWSEROWN_FG_OTHER = "browserown_fg_other"
        const val BROWSEROWN_ONBOARDING_PRESENT = "browserown_onboarding_present"
        const val BROWSEROWN_ONBOARDING_ABSENT = "browserown_onboarding_absent"
        const val BROWSEROWN_SIGNIN_VISIBLE = "browserown_signin_visible"
        const val BROWSEROWN_SIGNIN_ABSENT = "browserown_signin_absent"
        const val BROWSEROWN_ELAPSED_LT5 = "browserown_elapsed_lt5"
        const val BROWSEROWN_ELAPSED_5_15 = "browserown_elapsed_5_15"
        const val BROWSEROWN_ELAPSED_15_30 = "browserown_elapsed_15_30"
        const val BROWSEROWN_ELAPSED_GT30 = "browserown_elapsed_gt30"
        // Fixed post-auth Pods-screen failure block. Six slots, always emitted
        // in this order immediately after ASSERT_PODS_SCREEN and immediately
        // before that failure, and never on a pass. Foreground is exact
        // package equality; the other slots expose only allowlisted selector
        // presence and a monotonic bucket.
        const val POSTAUTH_FG_OWN = "postauth_fg_own"
        const val POSTAUTH_FG_CHROME = "postauth_fg_chrome"
        const val POSTAUTH_FG_SYSTEM_UI = "postauth_fg_system_ui"
        const val POSTAUTH_FG_PLAY_SERVICES = "postauth_fg_play_services"
        const val POSTAUTH_FG_HARNESS = "postauth_fg_harness"
        const val POSTAUTH_FG_ANDROID = "postauth_fg_android"
        const val POSTAUTH_FG_LAUNCHER = "postauth_fg_launcher"
        const val POSTAUTH_FG_OTHER = "postauth_fg_other"
        const val POSTAUTH_SHELL_PRESENT = "postauth_shell_present"
        const val POSTAUTH_SHELL_ABSENT = "postauth_shell_absent"
        const val POSTAUTH_PROGRESS_PRESENT = "postauth_progress_present"
        const val POSTAUTH_PROGRESS_ABSENT = "postauth_progress_absent"
        const val POSTAUTH_ERROR_PRESENT = "postauth_error_present"
        const val POSTAUTH_ERROR_ABSENT = "postauth_error_absent"
        const val POSTAUTH_SIGNIN_VISIBLE = "postauth_signin_visible"
        const val POSTAUTH_SIGNIN_ABSENT = "postauth_signin_absent"
        const val POSTAUTH_ELAPSED_LT15 = "postauth_elapsed_lt15"
        const val POSTAUTH_ELAPSED_15_30 = "postauth_elapsed_15_30"
        const val POSTAUTH_ELAPSED_30_60 = "postauth_elapsed_30_60"
        const val POSTAUTH_ELAPSED_GT60 = "postauth_elapsed_gt60"
        // The exact fixed app-owned surfaces the authenticated pod list can
        // show instead of its title. Both are set by PodListScreen: the
        // activity indicator's contentDescription while the account loads, and
        // the load-error tile's retry action. Selectors only; the error
        // message itself is never read.
        const val PODS_LOADING_DESCRIPTION = "Loading pods"
        const val PODS_RETRY_DESCRIPTION = "Retry refreshing pods"
        // Shared half-open bucket boundaries in monotonic milliseconds.
        const val PRECHROME_ELAPSED_5S_MS = 5_000L
        const val PRECHROME_ELAPSED_15S_MS = 15_000L
        const val PRECHROME_ELAPSED_30S_MS = 30_000L
        // The post-auth block's own top boundary, scaled to PODS_TIMEOUT_MS.
        const val POSTAUTH_ELAPSED_60S_MS = 60_000L
        const val APP_START_TIMEOUT_MS = 30_000L
        const val BROWSER_START_TIMEOUT_MS = 45_000L
        const val FIELD_TIMEOUT_MS = 30_000L
        // Shared boundary readiness is raised conservatively for hosted
        // latency; both workflow steps bound their run above the summed waits.
        const val BOUNDARY_BROWSER_READY_TIMEOUT_MS = 90_000L
        const val BOUNDARY_FIELD_TIMEOUT_MS = 60_000L
        const val CALLBACK_TIMEOUT_MS = 90_000L
        const val PODS_TIMEOUT_MS = 60_000L
        const val BROWSER_POLL_MS = 500L
        const val MAX_CHROME_FIRST_RUN_STEPS = 8
        // Total tolerated non-Chrome foreground inside the shared boundary
        // wait, spent from that wait's own deadline and never added to it.
        // Twenty polls covers a handover of a poll or two after each of the
        // MAX_CHROME_FIRST_RUN_STEPS actions with margin, and still leaves
        // most of BOUNDARY_BROWSER_READY_TIMEOUT_MS for the page itself.
        const val MAX_FOREGROUND_SETTLE_MS = 10_000L
        val CHROME_SAFE_FIRST_RUN_CONTROLS = listOf(
            ChromeFirstRunControl(CHROME_FRE_DISMISS_RESOURCE, "Use without an account"),
            ChromeFirstRunControl(CHROME_FRE_DISMISS_RESOURCE, "Stay signed out"),
            ChromeFirstRunControl(CHROME_UMA_DISMISS_RESOURCE, "Done"),
            ChromeFirstRunControl(CHROME_FRE_GENERIC_DISMISS_RESOURCE, "No thanks"),
            ChromeFirstRunControl(CHROME_FRE_GENERIC_DISMISS_RESOURCE, "Stay signed out"),
        )
    }
}
