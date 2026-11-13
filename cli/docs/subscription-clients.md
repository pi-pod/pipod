# Subscription clients in Pi and pipod

The `@pipod/pi-muse-subscription` and `@pipod/pi-antigravity-bridge` packages drive the official Muse Code and Antigravity clients. They are not direct API providers, and their Pi connection markers are not portable provider credentials.

## Pod setup

1. Include the extension package in the template's Pi `settings.json` packages and install its official executable in the pod image or init script. Both executables must be on the Pi process's `PATH`; the extension packages do not bundle them. Muse also supports `museBin` in the pod's agent-directory `muse-sdk.json`; Antigravity supports `AGY_BIN`.
2. Start/attach a pod and use `/login muse-sdk` or `/login antigravity` in the attached session. These are ordinary Pi provider logins carried by pipod's existing remote-auth UI.
3. Muse displays its official SDK device code. Antigravity uses its official terminal sign-in on browserless hosts; Linux needs `script` from util-linux. Complete the browser flow and paste the code or final URL if asked. Cancellation stops the child login.
4. Select `muse-sdk/<advertised-model>` or `antigravity/<advertised-model>` in `/model`. Use the advertised catalog; listing a model is not proof of account entitlement.
5. Retain the official clients' state with this pod's home if reconnects and restarts should reuse the login. A new independent pod needs its own sign-in. A laptop login, a Pi connection marker copied from another host, or an account `meta`/`google` API key does not establish this state.

Account-level `pipod credentials` sharing is intentionally not offered for these client-managed logins. No native client token is imported into the account credential broker or sent to the launcher. An absent/expired official-client login remains the official client's responsibility; a Pi marker does not prove it is still authenticated.

Under allowlist egress, the package-provider registry identifies the clients' inference and account hosts for planning. Installer/download hosts still need explicit admission when an init script downloads binaries. Do not change an allowlist to open egress to conceal a missing host.

Antigravity keeps native shell and filesystem tools. Pi hooks cover its bridged Pi tools, not native Antigravity operations. The pi-pod fork defaults to ACP permission prompts and leaves `AskAntigravity` disabled. These are permission policies, not a sandbox. Confirm subscription access and billing with the official products; a successful connection marker or zero displayed API cost is not billing evidence.

## Separate pod execution from launcher rendering

Pipod loads attested package code locally for terminal renderers as well as pod-side for execution. Running a provider factory again locally can start a second CLI or authentication flow, populate the wrong model catalog, or write to the launcher's profile. Packages can opt into separate client entrypoints:

```json
{
  "pi": { "extensions": ["./src/index.ts"] },
  "pipod": { "clientExtensions": [] }
}
```

An empty list means **pod-only execution** (Muse). A display-capable extension can name a separate entrypoint:

```json
{
  "pi": { "extensions": ["./extensions/index.ts"] },
  "pipod": { "clientExtensions": ["./src/client-extension.ts"] }
}
```

That entrypoint should register renderers only, without providers, tools, sign-in, subprocesses, or mutable backend state. Antigravity shares its native-activity and poll-entry renderers this way. Commands and tool execution remain pod-owned and use the existing gateway/auth protocol; this adds no RPC passthrough.

Without `pipod.clientExtensions`, existing Pi entrypoint discovery is unchanged. An explicit empty or invalid list never falls back to executing the provider entrypoint. Client paths must resolve to files inside the installed package, including after symlink resolution. This selection is a correctness boundary, **not a sandbox**: selected renderers still run with the launcher's privileges and require the existing package attestation and trust decision. Older pipod releases do not honor the new declaration.

## Qualification

The extension forks are developed against Pi 1.5.2, Muse Code 1.4.18, and Antigravity CLI 1.5.8. Muse's private settings and raw-session log are experimental. Its complete-batch path is qualified only on known client versions; unknown builds retain the stable single-tool path. Repeat the real-client checks after client or Pi upgrades.

Useful acceptance checks include a real tool result reaching the model, parallel calls, steering, resume/branch/reload, abort recovery, long parked tools, remote-auth notifications and cancellation, and launcher-side rendering without runtime registrations. Local RPC acceptance is not evidence of deployed server revision, native pod lifecycle behavior, model entitlement, or subscription billing.
