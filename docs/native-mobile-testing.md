# Native mobile testing

The supported application targets are Swift/SwiftUI iOS and Kotlin/Compose Android.
Each app directory owns its tests and manual-testing notes:

- [iOS](../ios/docs)
- [Android](../android/docs)

Use an explicitly owned simulator/emulator. Do not shut down other developers'
devices. Inspect screenshots after meaningful actions; an empty-screen or
zero-test pass is not evidence. Record untested production-dependent flows.

## Shared devices

Any local simulator or emulator works. Maintainers also drive a shared Mac over
Tailscale (`tailscale ssh agent@mac-mini-m4`); `ios/tools/` and `android/scripts/`
hold the helpers, and they refuse any other host.

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
