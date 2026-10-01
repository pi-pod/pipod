This repository is the open-source pi pod: `cli/`, `server/`, `sandbox/`, `ios/`, `android/`. It is licensed AGPL-3.0-only as a whole; there are no per-component licenses.

Never write or run unit tests. Typecheck, build, static checks, migration rehearsals against an explicit disposable database, and manual acceptance checks still apply.

Hosted-service code (per-user hosts, metering, billing) does not belong here. It plugs into `server/src/server/edition.ts`; extend that interface rather than adding hosted behavior to the server.

Follow each component's own `AGENTS.md` and [CONTRIBUTING.md](CONTRIBUTING.md).
