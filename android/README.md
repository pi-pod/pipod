# pi pod for Android

The native Android client for [pi pod](https://pipod.dev) — run every pi session
inside a fresh pod, from your phone.

This app replaces the Flutter mobile client. It is Kotlin 2.4 / Jetpack Compose
on `minSdk 26`. The object graph is wired explicitly in `AppContainer` without
a dependency-injection framework; HTTP and the session transport use OkHttp, JSON is
kotlinx.serialization, credentials live in `EncryptedSharedPreferences`, and the
OIDC ID-token signature is verified against the provider's JWKS with
`java.security`.

## What it does

- **Pods** — every pod the organization can see, with search and filters,
  co-located children grouped under their host, and a detail screen covering
  resolved config, capacity waits, and archive/restore/delete.
- **Session** — the live agent conversation: streaming transcript, markdown and
  ANSI output, tool cards, image attachments, interrupt, model and
  thinking-level switching, queued prompts, reattach replay, and pod-side
  extension UI surfaces.
- **Approvals** — the inbox of interactions an agent is blocked on, answerable
  inline in the conversation or from the tab.
- **Jobs** — scheduled runs, their schedules read as sentences, and run history.
- **Environments, settings and credentials** — environment templates,
  organization and personal config bundles with optimistic-concurrency saves,
  write-only secrets, and model-provider credentials.
- **Platform** — `pipod://` deep links and local approval notifications.

## Layout

```
app/src/main/kotlin/com/pipod/app/
  core/                 no Compose below this line
    config/             build-time config (BuildConfig) + debug launch overrides
    api/                ApiClient, AuthInterceptor, the /v1 models
    auth/               OIDC discovery/PKCE/JWKS, the browser sign-in flow
    session/            session WebSocket, transcript reducer, remote extension UI
    credentials/        the model-provider login WebSocket
    format/             presentation strings, error copy, ANSI, markdown
    push/               local approval banners and notification permission
    deeplink/           pipod:// and notification payload routing
  ui/                   the design system: brand palette, controls, scaffolds
  shell/                the tab frame, the route table, width limits
  features/             one package per screen area
  di/AppContainer.kt    the process-wide object graph, wired by hand
docs/
  design-system.md      every shared composable and when to use it
  session-core.md       the headless session API the chat screen renders
  pods-screens.md       the pod and environment screens, labels and test tags
  manual-testing.md     how each feature is exercised by hand, with results
scripts/
  mac-build.sh          sync + Gradle on the shared build Mac
  device.sh             drive the emulator on that Mac (install, tap, screenshot)
```

## Building

The workstation this is developed on cannot run a Gradle/Kotlin daemon without
thrashing swap, so compilation happens with `tailscale ssh agent@mac-mini-m4` on the shared Mac. Complete [manual-testing connection setup](docs/manual-testing.md#current-manual-testing-host) first.
`scripts/mac-build.sh` wraps it: it rsyncs the project into a workdir of your
own, serialises builds behind a lock, and propagates Gradle's exit code.

```bash
export PIPOD_MAC_WORKDIR=work/android-<yours>/pi-pod-android   # your own directory
export PIPOD_DEVICE_SERIAL=emulator-5554                    # your owned emulator
./scripts/mac-build.sh assembleDebug
./scripts/mac-build.sh connectedDebugAndroidTest              # needs your own AVD
```

Nothing about the script is required: with a local JDK 21 and an Android SDK
that has `android-37.0`, plain `./gradlew assembleDebug` works.

Toolchain: JDK 21, Gradle 9.3.1, AGP 9.1, Kotlin 2.4, `compileSdk 37`,
`targetSdk 36`, `minSdk 26` with core-library desugaring (so `java.time` is
available).

## Running against a server

`app/build.gradle.kts` compiles the server URL, OIDC issuer and client id into
`BuildConfig`; every one can be overridden at build time with a Gradle property
or an environment variable:

```bash
./gradlew assembleDebug \
  -PpipodServerUrl=https://api.pipod.dev \
  -PpipodOidcIssuer=https://auth.pipod.dev \
  -PpipodOidcMobileClientId=…
```

A **debug** build additionally accepts the same values as launch extras, so a
local server or a throwaway identity provider can be pointed at without
rebuilding:

```bash
adb shell am start -n com.pipod/.MainActivity \
  -e PIPOD_SERVER_URL   http://127.0.0.1:8080 \
  -e PIPOD_OIDC_ISSUER  http://127.0.0.1:18094 \
  -e PIPOD_DEV_TOKEN    "$JWT"
```

`RuntimeConfig.applyLaunchExtras` is a no-op in a release build. That is
deliberate and load-bearing: a shipped app that could be told which identity
provider to trust would accept that provider's tokens as the signed-in user, and
the dev-token bypass would be a sign-in bypass. The build additionally **fails**
if `pipodDevToken` is set while assembling a release variant.

## Testing

```bash
./scripts/mac-build.sh connectedDebugAndroidTest  # on a device: Compose UI and semantics
```

Instrumented tests are not a nicety here — the app is driven by its
accessibility tree during manual acceptance, so every control's name is
asserted. `docs/manual-testing.md` records what has been exercised by hand,
against which backend, and what has not.

## Signing and release

Release signing comes from `keystore.properties` at the project root or the
matching environment variables (`PIPOD_KEYSTORE_FILE`, `PIPOD_KEYSTORE_PASSWORD`,
`PIPOD_KEY_ALIAS`, `PIPOD_KEY_PASSWORD`). Without them the release variant builds
**unsigned** rather than falling back to the debug key: an artifact signed with a
debug key that looks shippable is worse than one that obviously is not.

Play Store releases run from the maintainers' release pipeline, not from this repository.
