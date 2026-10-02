# pi pod

Run [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) coding-agent sessions in
remote sandboxes ("pods"), from a terminal or a phone, on a server you run yourself.

| Path | What it is |
| --- | --- |
| [`cli/`](cli) | The command-line client (`pipod`). Launches and attaches to pods. |
| [`server/`](server) | The control plane: REST API, session gateway, lifecycle workers, Postgres. |
| [`sandbox/`](sandbox) | The native sandbox service: one container hosting many isolated pods. |
| [`ios/`](ios) | The Swift/SwiftUI iOS app. |
| [`android/`](android) | The Kotlin/Compose Android app. |
| [`selfhost/`](selfhost) | The self-hosted deployment: one Compose project, installed and upgraded with `selfhost/upgrade`. |
| [`docs/`](docs) | [Self-hosting](docs/self-host.md) and cross-component notes. |

## How it fits together

The CLI and the apps are clients of the server. The server owns pod lifecycle and launches each
pod into the sandbox service on the same host; inside a pod it runs pi behind a small shim, and
clients drive that session over the server's gateway. Identity is [Zitadel](https://zitadel.com)
(OIDC); the server stores no passwords.

## Run your own

On a Linux host with 8 GB of RAM, Docker with the Compose plugin, `git`, `openssl` and Node
22.19 or later:

```sh
git clone https://github.com/pi-pod/pipod.git && cd pipod
selfhost/upgrade                            # install: generates secrets, builds, starts
selfhost/add-user you@example.com --owner   # your account
(cd cli && npm ci && npm run build) && npm install -g ./cli
pipod login --server http://127.0.0.1:8080
```

Upgrading later is `git pull && selfhost/upgrade`. [docs/self-host.md](docs/self-host.md)
is the full guide: signing in from a server without a browser, HTTPS for other machines and
the phone apps, sizing, backups, and what to do when something fails.

## Install the CLI

On any other machine, install the CLI from npm, where it is published as
[`@pipod/cli`](https://www.npmjs.com/package/@pipod/cli). It needs Node 22.19 or later:

```sh
npm install -g @pipod/cli
pipod login --server <your server's URL>
pipod                  # launch a pod for the current directory and attach
pipod update           # upgrade it later
```

A CLI newer than its server is refused with a message saying so; upgrade the server first. See
[cli/README.md](cli/README.md) for what it does.

## Development

Each component builds on its own; see its README. From the repository root:

```sh
make help              # local dev: Postgres, the server, a signed-in simulator or emulator
make check-pi-pins     # the CLI and the server must bundle the same exact pi
```

The pi version is one pin shared by the CLI and the server. Change it with
`make bump-pi VERSION=x.y.z`, never by hand.

`server/src/core/` is a tracked copy of part of the CLI, classified file by file in
`server/scripts/core-manifest.txt`. Change a `[shared]` file in `cli/` and run
`server/scripts/sync-core.sh ../cli`.

## The hosted service

A hosted pi pod service at [pipod.dev](https://pipod.dev) is coming soon; it is not available
yet. It will run this code with an extension that adds per-user hosts, metering and billing.
Those parts are not in this repository; they plug into the interface in
[`server/src/server/edition.ts`](server/src/server/edition.ts), which this server runs without.

## License

[AGPL-3.0-only](LICENSE). Copyright © 2026 Billzo, LLC.

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request and
[SECURITY.md](SECURITY.md) to report a vulnerability.
