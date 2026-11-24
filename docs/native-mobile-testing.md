# Native mobile testing

The supported application targets are Swift/SwiftUI iOS and Kotlin/Compose Android.
Each app directory owns its tests and manual-testing notes:

- [iOS](../ios/docs)
- [Android](../android/docs)

Use an explicitly owned simulator/emulator. Do not shut down other developers'
devices. Inspect screenshots after meaningful actions; an empty-screen or
zero-test pass is not evidence. Record untested production-dependent flows.

## Shared devices

Any local simulator or emulator works. From Linux, `ios/tools/` and `android/scripts/`
build and drive devices on a Mac reached over Tailscale SSH: set
`PIPOD_MAC_HOST=user@host`. The Mac may be shared, so keep to your own work directory and
device.

## Session landing, commands and bash summaries

Open a pod with several screens of history and a recognizable final reply. The reply should be visible without a swipe. Scroll up, load earlier messages, then jump to latest. Type `/` and select `/compact`; selection only fills the draft. Add focus instructions and check the preview, then run it. A misspelling should not send an ordinary prompt. Reopen the same pod and run a discovered extension command a second time.

Completed **bash tool calls** show an AI caption by default. This uses the same kind of background request as pi-lightweight-llm, through the pod’s `openai/gpt-6-luna` model, not the conversation model. Only bounded, redacted command/output excerpts are sent; OpenAI model usage can incur charges. Cached summaries are device-local. Expand a row for its original command and output. `/summaries off` stops future requests on this device for this server; `/summaries on` enables them again. No alternate provider is tried when the model, credentials or auxiliary bridge are unavailable: raw tool rows continue to work.

For a no-spend walkthrough start the dev fake provider with `FAKE_BASH_SUMMARIES=1` and send `TOOLS`. Check the completed and failed bash rows, a non-bash row, expansion, and `/summaries off`. Fixture captions are intentionally labeled as such; they prove native rendering and gateway routing, not supplier access.

## Sending during a turn or compaction

On a server that advertises live prompt delivery, **Send** during a turn steers
Pi at its next opportunity; **Queue after current turn** submits a follow-up.
Pi applies the pod’s `steeringMode` and `followUpMode` settings (`all` or
`one-at-a-time`) to the corresponding queue. Both actions start a normal turn
if Pi has already become idle by the time it receives the message.

Start a turn with a tool that takes long enough to interact. Queue a recognizable
message first, then steer with a different marker. Check that Pi takes the
steering input before the follow-up. Repeat with multiple messages and the two
batching settings. In a conversation with enough history to compact, run
`/compact`, then submit two more messages before it finishes. Check that both
run once, in the chosen order, and that they appear once after reopening.
Repeat with an attached image. A rejected message must not appear in replay;
if the connection drops before a verdict, the app must not offer an automatic
resend. Compaction holds are bounded and live on the gateway, so closing the
app does not cancel them. They are not durable across gateway replacement.

## Local API and debug sign-in

The workspace Makefile starts the development API and mints a short-lived JWT.
`make ios SIM_UDID=<id>` and `make android ANDROID_SERIAL=<serial>` pass it only
through Debug-only launch overrides. Release builds must ignore these overrides.
The launcher does not embed that token into a build artifact.

For sessions and lifecycle, use pods actually launched by your test backend.
Database-only fixture rows can render a representative list without containing
an attachable session. A fake provider exercises the real API/gateway but does
**not** verify real sandbox provisioning or real model behavior.

## Browser PKCE fixture

`native-oidc-fixture.mjs` tests the real native browser callback flow without a
production identity account. Start a dev API first, then:

```bash
mkdir -p .dev
(umask 077; make -s token > .dev/mobile-test.token)
node scripts/native-oidc-fixture.mjs 18093 .dev/mobile-test.token
```

It prints only its loopback issuer. Configure a Debug app with:

- server URL pointing to the running dev API;
- `PIPOD_OIDC_ISSUER=http://127.0.0.1:18093`;
- mobile client ID `388199923079774215`;
- **no** `PIPOD_DEV_TOKEN` override, and no previously persisted session.

Tap Sign in, then **Continue as fixture user** in the system browser. Exercise
Cancel sign-in, relaunch/restoration, refresh, sign-out, and invalid callbacks.
The page is explicitly labeled TEST ONLY and asks for no password.

For Android, `adb -s <serial> reverse tcp:18093 tcp:18093` makes loopback reachable
from the device and browser. Do the same for your API port. When the runner is a different physical host,
reverse-forward the API and fixture ports over SSH first using unused Mac ports.
A runner on the same Mac uses the existing loopback listeners directly. Use a separate fixture
port and API instance for each concurrent tester.

The fixture enforces S256, nonce, one-time expiring authorization codes, exact
client/redirect validation, refresh rotation, and revocation. It generates an
ephemeral RSA signing key in memory. Refresh tokens deliberately contain `+` to
catch incorrect form encoding. Its CSP permits only its own form endpoint and
the allowlisted `pipod:` callback; permitting the callback is necessary for
Chrome to follow a POST redirect into the native app.

The supplied access token remains the dev API's token: fixture refresh does not
extend that token's original lifetime. Restart the fixture with a freshly
minted token if it expires. The fixture binds only to loopback, stores no keys,
and never logs authorization URLs, tokens, or request bodies. Stop it and remove
`.dev/mobile-test.token` when done.

**This proves fixture-based browser integration, not production Zitadel, account
policy, App Store/TestFlight delivery, Google Play delivery, or remote push.**

## Launcher script syntax

```bash
bash -n scripts/native-mobile-dev.sh
```

App suites run independently in each app directory. A built AAB or IPA is not a
release: store uploads run from the maintainers' release pipelines.
