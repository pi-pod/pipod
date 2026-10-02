# pi pod for iOS

The native iOS client for [pi pod](https://pipod.dev) — run every pi session inside a
fresh pod, from your phone.

This app replaces the Flutter mobile client. It is Swift 6 toolchain / Swift 5 language
mode, SwiftUI + Observation, iOS 17+, iPhone only, and has **no third-party
dependencies**: networking is `URLSession`, the session transport is
`URLSessionWebSocketTask`, credentials live in the Keychain, and the OIDC ID-token
signature is verified against the provider's JWKS with `Security`/`CryptoKit`.

## What it does

- **Pods** — every pod the organization can see, with search and filters, co-located
  children grouped under their host, and a detail screen covering resolved config,
  capacity waits, and archive/restore/delete.
- **Session** — the live agent conversation: streaming transcript, markdown and ANSI
  output, tool cards, image attachments, interrupt, model and thinking-level switching,
  queued prompts, reattach replay, and pod-side extension UI surfaces.
- **Approvals** — the inbox of interactions an agent is blocked on, answerable inline in
  the conversation or from the tab.
- **Jobs** — scheduled runs, their schedules read as sentences, and run history.
- **Environments, settings and credentials** — environment templates, organization and
  personal config bundles with optimistic-concurrency saves, write-only secrets, and
  model-provider credentials.
- **Platform** — `pipod://` deep links, APNs registration and notification routing.

## Layout

```
project.yml            XcodeGen manifest — the source of truth for the project
PiPod.xcodeproj        generated from project.yml, committed so Xcode opens without XcodeGen
PiPod/
  Core/                no SwiftUI below this line
    Config.swift       build-time config, read from Info.plist
    Models/            the /v1 API models (+ JSONValue for genuinely dynamic payloads)
    Networking/        APIClient, HTTPTransport, TokenStore
    Auth/              OIDC discovery/PKCE/JWKS, Keychain storage, ASWebAuthenticationSession
    Session/           session WebSocket, transcript reducer, remote extension UI
    Format/            presentation strings, error copy, ANSI, markdown
    Push/              APNs registration and local banners
    DeepLink/          pipod:// and notification payload routing
    SessionStore.swift signed-in state for the whole app
  DesignSystem/        brand palette, status tones, shared components
  Features/            one directory per screen area
tools/remote-build.sh  build/run on a remote Mac
docs/manual-testing.md how each feature is exercised by hand
```

## Building

On a Mac, `xcodegen generate` (or open the committed project) and build the `PiPod` scheme.

From Linux, where there is no iOS toolchain, `tools/remote-build.sh` builds on a Mac you
reach over Tailscale SSH:

```bash
export PIPOD_MAC_HOST=you@your-mac               # Tailscale SSH target
export PIPOD_REMOTE_DIR=work/pipod-ios-<yours>   # your own directory on the Mac
# Default device: the Mac's configured simulator, else one named "Agent iPhone".
# Optional: PIPOD_SIM_NAME=pipod-<yours> for an explicitly owned new device.
./tools/remote-build.sh sync     # rsync + regenerate the Xcode project
./tools/remote-build.sh build
./tools/remote-build.sh run      # install + launch on your simulator
```

`sync` regenerates `PiPod.xcodeproj` every time. XcodeGen bakes the file list into the
project, so a committed project that predates a new file would silently leave it out of
the target — a test bundle with no tests still reports `TEST SUCCEEDED`.

Simulator builds are signed ad-hoc rather than unsigned. Without entitlements every
Keychain call fails with `-34018` and the app appears to forget your session on relaunch.

## Configuration

Per-configuration values live in `project.yml` and are compiled into `Info.plist`:

| Key | Debug | Release |
|---|---|---|
| `SERVER_URL` | `http://localhost:8080` | `https://api.pipod.dev` |
| `OIDC_ISSUER` | `https://auth.pipod.dev` | `https://auth.pipod.dev` |
| `OIDC_CLIENT_ID` | the mobile Zitadel client | same |
| `OIDC_REDIRECT_URI` | `pipod://auth/callback` | same |
| `APS_ENVIRONMENT` | `development` | `production` |

**Debug builds only** additionally accept launch arguments, which is the workspace's shared
dev contract across both native clients:

```bash
xcrun simctl launch <udid> com.pipod.app \
  -PIPOD_SERVER_URL http://127.0.0.1:18081 \
  -PIPOD_DEV_TOKEN "$TOKEN"
```

A dev token signs in without the browser, which is what makes an automated UI pass
possible. A Release build ignores every launch argument: a dev token must never be a
sign-in bypass, and nothing outside the app may choose its server.

A person chooses it instead, on the sign-in screen (**Server · Change**): the app reads the
server's `GET /v1/auth/config` for its issuer and `mobileClientId`, and keeps the choice
(`Config.serverChoice`) until they choose again. That is how a self-hosted pi pod is used;
only HTTPS addresses (and this device's loopback) are accepted.

## Identity

Bundle identifier `com.pipod.app`, display name "pi pod", URL scheme `pipod` — unchanged
from the app this replaces, so the existing App Store Connect record, provisioning profile
and registered OIDC redirect all still apply.

## Design

Colours come from the pi pod brand palette (Simple Purple `#6D2598` accent, and the status
tones in `DesignSystem/StatusTone.swift`, which are tuned to clear WCAG AA against their
own surface). Text, separator and surface roles resolve from the system's semantic colours
so the app inherits light/dark and accessibility behaviour rather than freezing a palette.
Never use the default iOS blue tint, and never `Color.green`/`.orange` for status.
