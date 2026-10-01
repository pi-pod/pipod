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
| [`docs/`](docs) | [Self-hosting](docs/self-host.md) and cross-component notes. |

## How it fits together

The CLI and the apps are clients of the server. The server owns pod lifecycle and launches each
pod into the sandbox service on the same host; inside a pod it runs pi behind a small shim, and
clients drive that session over the server's gateway. Identity is [Zitadel](https://zitadel.com)
(OIDC); the server stores no passwords.

To run your own instance, follow [docs/self-host.md](docs/self-host.md).

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

[pipod.dev](https://pipod.dev) runs this code with an extension that adds per-user hosts,
metering and billing. Those parts are not in this repository; they plug into the interface in
[`server/src/server/edition.ts`](server/src/server/edition.ts), which this server runs without.

## License

[AGPL-3.0-only](LICENSE). Copyright © 2026 Billzo, LLC.

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request and
[SECURITY.md](SECURITY.md) to report a vulnerability.
