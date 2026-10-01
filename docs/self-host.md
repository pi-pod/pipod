# Self-hosting pi pod

The path from an empty Linux host to a working `pipod login`, and every upgrade after
that. Four things run, all on one host: **Postgres**, **Zitadel** (OIDC), the
**server** (control plane), and the **native sandbox** the server launches pods into.
[`../selfhost/`](../selfhost/) holds the whole deployment, built from the commit you
have checked out: installing is `selfhost/upgrade`, and upgrading is
`git pull && selfhost/upgrade`.

You need **8 GB of RAM**, Docker with the Compose plugin, `git`, `openssl`, and Node
22+ (for the CLI and the Zitadel bootstrap scripts). 4 GB is not enough for a pod of
the default shape: admission commits each sandbox's whole memory *ceiling*, so a standard
2 vCPU / 4 GiB pod needs 4 GiB of admission budget, and that budget is
`min(host total − reserve, fleet ceiling)`. On a 4 GB machine it is 2.83 GiB and every
launch is refused before it starts. A 4 GB host is usable, but only with a smaller
default pod shape — see [Sizing](#sizing-the-host-and-the-pod-shape). On Debian
stable, whose own `nodejs` is still 20:

```bash
apt-get update && apt-get install -y ca-certificates curl git openssl
curl -fsSL https://get.docker.com | sh
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs
# The sandbox mounts each workspace from a loopback file, and a container inherits
# /dev as it was when it started: load this before step 1, or every launch fails
# with "failed to setup loop device".
modprobe loop && echo loop > /etc/modules-load.d/loop.conf
```

> Loopback first. Steps 1–5 give you a working instance on `127.0.0.1` with no
> DNS and no TLS. [Going public](#going-public) is a separate, later step. Do not
> do both at once: almost every failure in this stack is an issuer or origin
> mismatch, and they are much easier to read one change at a time.

The repository is private while pi pod is pre-release, so clone it as an account
that has access — `gh repo clone`, or the `git@github.com:` remote. An anonymous
clone fails with `could not read Username for 'https://github.com'`, which is the
first thing you will hit, not a network problem. Commands below run from the
repository root unless they start with `cd`.

```bash
git clone https://github.com/pi-pod/pipod.git
cd pipod
```

## 1. Configure and start

```bash
cp selfhost/.env.example selfhost/.env && chmod 600 selfhost/.env
```

`selfhost/.env` holds every secret of the deployment and nothing else needs editing.
[`.env.example`](../selfhost/.env.example) says how to generate each value. Fill in
`POSTGRES_PASSWORD`, `ZITADEL_MASTERKEY`, `ZITADEL_ADMIN_PASSWORD`, `SECRETS_KEK`,
`PI_POD_SANDBOX_TOKEN`, and `PUBLIC_URL`; `ZITADEL_API_AUDIENCE` comes in step 3. Two
of them have no second copy anywhere:

- **`ZITADEL_MASTERKEY`** seals Zitadel's own keys in Postgres; a database restored
  without it is unusable.
- **`SECRETS_KEK`** encrypts stored secrets; lose it and every one is unreadable.

Back both up offline now, separately from the database dumps (see
[Back up and restore](#back-up-and-restore)).

`PUBLIC_URL` is where pods dial the server back from inside a sandbox, so it is this
host's own address — never `127.0.0.1`, which inside a pod is the pod itself.

```bash
selfhost/upgrade
```

[`upgrade`](../selfhost/upgrade) builds the server and sandbox images from this
checkout, publishes the pod base image the server launches from to the registry
inside the deployment, and runs `docker compose up -d`. Compose starts Postgres, then
`backup` (a one-shot dump, empty on the first run), then Zitadel and the server. The
server applies its own migrations before it serves; `upgrade` finishes when the server
is healthy. Its log says what it did:

```bash
cd selfhost && docker compose logs server | grep -E 'release:|migrations applied|launch admission'
```

Run every other `docker compose` command in this guide from `selfhost/` too.

Only two ports are published. 8080 (the server) listens on every interface because
pods reach it through this host; firewall it from the internet until you
[go public](#going-public). Zitadel's 8081 and the base-image registry's 5000 are bound
to `127.0.0.1`, and Postgres is not published at all.

## 2. A Zitadel admin token

Zitadel is up on `http://127.0.0.1:8081`. The bootstrap scripts authenticate with
a personal access token belonging to a service user, not with your password.

1. Open `http://127.0.0.1:8081/ui/console` and sign in as the first-boot admin.
   The username is `admin` plus the domain Zitadel derived for the `pipod`
   organization; the Console's Organization page shows the exact login name. The
   password is your `ZITADEL_ADMIN_PASSWORD`, and Zitadel makes you change it now.
   From your own machine, reach it through a tunnel:
   `ssh -L 8081:127.0.0.1:8081 root@<this host>`.
2. Create a **service user** (Users → Service Users), give it **IAM_OWNER**
   under Instance → Administrators, and generate a **personal access token**.

Export it for the rest of this section. It is the most powerful credential in
the deployment — do not put it in a file that gets committed.

```bash
export ZITADEL_PAT=<the token>
export ZITADEL_URL=http://127.0.0.1:8081
```

## 3. Create the project, then take the audience from it

```bash
cd server
ZITADEL_EXPECTED_ISSUER=$ZITADEL_URL node zitadel/scripts/reconcile-zitadel.mjs --apply
```

[`reconcile-zitadel.mjs`](../server/zitadel/scripts/reconcile-zitadel.mjs)
creates the `pipod` project, its roles, and the four OIDC apps from
[`zitadel/project/pipod-project.json`](../server/zitadel/project/pipod-project.json).
It only ever creates and updates — there is no remove — so it is safe to re-run,
and `--check` (the default) reports drift without touching anything. It requires
`ZITADEL_EXPECTED_ISSUER` as an explicit confirmation of which instance you are
about to change, and accepts `http://` only for `127.0.0.1`, `localhost`, or
`::1`.

It prints what you need:

```
project id (API audience): 300000000000000001
client id pipod-cli: 300000000000000002
client id pipod-desktop: ...
client id pipod-mobile: ...
client id pipod-web: ...
```

Put the **project id** in `selfhost/.env` as `ZITADEL_API_AUDIENCE` and apply it.
Keep the `pipod-cli` client id for step 5 — it is a different id from the
project's, and re-running the reconciler will not change it.

```bash
cd ../selfhost && docker compose up -d
```

Until `ZITADEL_API_AUDIENCE` is set, the server expects the dev-signer placeholder
`pipod-api` and rejects every real Zitadel token as a bad audience.

Optionally align the instance's token lifetimes with
[`zitadel/oidc-settings.json`](../server/zitadel/oidc-settings.json):

```bash
ZITADEL_EXPECTED_ISSUER=$ZITADEL_URL node zitadel/scripts/apply-oidc-settings.mjs --apply
```

The bundle sets those lifetimes as first-boot defaults, so on a brand-new
instance this is a no-op. It matters when you rebuild an instance later. Like
the reconciler it defaults to `--check` and needs `ZITADEL_EXPECTED_ISSUER`.

## 4. An organization, a user, and roles

Pods belong to organizations. Signing in without one succeeds and then does
nothing — the CLI says *"access is pending Zitadel organization membership or
role grants"*. From `server/`:

```bash
zitadel/scripts/provision-org.sh "my-org"
# now create the human user in the Console, inside my-org
zitadel/scripts/grant-org-admin.sh you@example.com "my-org"
```

That order matters, because the organization has to exist before the user does.
A user belongs to exactly one organization, and the server reads a caller's
organization from their token and keeps only the roles *that* organization
granted — so create the user **inside `my-org`**, not in the `pipod`
organization you signed in to in step 2. Switch the Console to `my-org` first.
Give them a password there: a fresh instance cannot mail an invite (see below).

[`grant-org-admin.sh`](../server/zitadel/scripts/grant-org-admin.sh)
then grants that user `ORG_OWNER` plus the project `owner` bundle, and refuses a
user who lives in another organization rather than reporting a grant that
conveys nothing. Both scripts read `ZITADEL_URL` and `ZITADEL_PAT` from the
environment you exported in step 2. Never grant `IAM_OWNER` to a tenant org
owner.

### Email

Nothing so far sends mail. A fresh instance has no SMTP provider, so an invite
or a password reset produces a code that never reaches anyone and no error
anywhere. Add a provider in the Console under Instance → Settings → SMTP
provider; any host works, and the hosted deployment uses Mailgun at
`smtp.mailgun.org:587` with TLS on.

You can seed it at first boot instead, and there is one trap if you do. The
`ZITADEL_DEFAULTINSTANCE_SMTPCONFIGURATION_SMTP_USER` and `..._SMTP_PASSWORD`
variables that Zitadel's own `defaults.yaml` still documents stopped mapping to
anything in v4, when the credential moved under `SMTP.PlainAuth`. Their
replacements, `..._SMTP_PLAINAUTH_USER` and `..._SMTP_PLAINAUTH_PASSWORD`, are
read only if some config file declares those keys. This is the smallest one that
does:

```yaml
DefaultInstance:
  SMTPConfiguration:
    SMTP:
      PlainAuth:
        User: # ZITADEL_DEFAULTINSTANCE_SMTPCONFIGURATION_SMTP_PLAINAUTH_USER
        Password: # ZITADEL_DEFAULTINSTANCE_SMTPCONFIGURATION_SMTP_PLAINAUTH_PASSWORD
```

Mount it and pass it as `--config` from `selfhost/compose.override.yml`, which
Compose merges automatically and `git pull` never touches. Set the other SMTP
variables without the credential and you get an *active* provider that cannot log
in, which is harder to notice than having none.

## 5. Log in

```bash
cd cli && npm ci && npm run build && cd ..
export PI_POD_OIDC_CLIENT_ID=<the pipod-cli client id from step 3>
node cli/dist/cli.js login --server http://127.0.0.1:8080 --issuer http://127.0.0.1:8081
node cli/dist/cli.js doctor
```

`doctor` names the server's release revision and fails when its database is missing
migrations or launch admission is held. Run it from your own project directory (not
inside a checkout whose `.pi-pod/config.json` pins a removed `provider`). The
deployment default is always `sandbox`; a stale project layer naming a removed
provider is rejected with the supported list.

Sign-in is a loopback PKCE flow in a browser: the CLI opens the authorization
endpoint on the issuer and waits on `http://127.0.0.1:43117/callback` (it tries
43117–43126; each is allowlisted on the `pipod-cli` app). A server has no browser
to open, so the CLI prints the URL instead — and whatever browser you use has to
reach *both* of those loopback addresses, as `127.0.0.1`. Forward them from the
host you are installing on and use your own browser:

```bash
ssh -L 8081:127.0.0.1:8081 -L 43117:127.0.0.1:43117 root@<this host>
```

Keep the tunnel up while `login` waits. Do not reach for a public address to
avoid the tunnel: the issuer is compared against the `iss` claim exactly, so
changing it is [going public](#going-public), not a shortcut.

Always pass `--issuer`. There is no discovery endpoint: the CLI infers the
issuer only for `api.pipod.dev` and for a loopback server, and for every other
hostname it falls back to the hosted `https://auth.pipod.dev` — so the moment
your instance has a real domain, omitting `--issuer` sends your login to
someone else's identity server. `--server` and `--issuer` are remembered, so
later commands need neither; `PI_POD_OIDC_CLIENT_ID` has no flag and must stay
exported until the first successful login writes it to the session file.

## Upgrading

```bash
git pull && selfhost/upgrade
```

That is the whole procedure, and you can skip releases: each one carries every
migration it needs. In order, `upgrade`:

1. builds the server and sandbox images from the new checkout, while the old ones
   keep serving;
2. recreates the sandbox when its image changed — **this ends live sessions.**
   Workspaces are on the `sandbox_state` volume, so attaching again resumes each pod
   with its files; finish or detach long-running work before you upgrade;
3. publishes the pod base image the new server launches from;
4. runs `backup`, which dumps both databases into `selfhost/backups/` while the old
   server is still serving, and keeps the newest seven (`PIPOD_BACKUP_KEEP`). If the
   dump fails, nothing below happens;
5. recreates Zitadel when its pin moved — it applies its own migrations as it starts;
6. stops the old server, then starts the new one, which applies its pending
   migrations and reopens launch admission if a migration held it before it serves,
   and waits until it is healthy.

Then check the result:

```bash
cd selfhost && docker compose ps      # db, zitadel, server, sandbox, registry up; backup exited 0
docker compose logs server | grep -E 'release:|migrations applied|schema is current|launch admission'
cd .. && node cli/dist/cli.js doctor  # names the new revision
```

Two things `upgrade` does not do:

- **Rebuild the CLI**: `cd cli && npm ci && npm run build`, or `pipod update`. A CLI
  newer than the server is refused with a message saying so; upgrade the server
  first.
- **Change the Zitadel project**: run `reconcile-zitadel.mjs` from step 3 without
  `--apply`. It reports drift between your instance and the release's roles and
  apps; apply only what it lists.

### Rolling back

An older release cannot run past a newer one's migrations: its server refuses to
start against a database a newer release migrated, and says so in its log. Roll
back with the dump the upgrade took first (see [Restore](#restore)), then check out
the commit you upgraded from and run `selfhost/upgrade`.

## Back up and restore

Every `docker compose up` writes `selfhost/backups/pipod-<UTC time>.sql.gz`, a
`pg_dumpall` of both databases: the product data and the whole identity server.
Copy them off the host on your own schedule — they live on the same disk as the
database. Back up separately:

- **`ZITADEL_MASTERKEY`**, offline. A `zitadel` database restored without it is
  unusable.
- **`SECRETS_KEK` (+ every id in `SECRETS_KEK_PREVIOUS`)**, offline and
  **separate from the database dumps**. A database theft without the keys
  protects stored secrets; keys and dumps stored together defeat that
  separation.
- **Retain historical keys for as long as you retain historical dumps.** An
  old dump restores only with the key versions that wrapped its rows — do not
  modify dumps in place and do not retire a key while any retained dump still
  needs it.

Sandbox workspaces are not in Postgres. They live on the `sandbox_state` volume,
and only *archived* ones reach object storage — with the default local archive
driver, nothing survives losing that host.

### Restore

Stop everything that writes, then load the dump over the running database. It
drops and recreates both databases:

```bash
cd selfhost
docker compose stop server zitadel
gunzip -c backups/pipod-<time>.sql.gz | docker compose exec -T db psql -q -U pipod -d postgres
docker compose up -d
```

Two errors are expected and harmless: `current user cannot be dropped` and
`role "pipod" already exists` — the dump tries to recreate the role it is
connected as.

## Going public

Terminate TLS at a reverse proxy and give Zitadel and the server their own
names. With Caddy on the same Compose network (a `caddy` service in
`selfhost/compose.override.yml`), change the domains in:

```caddyfile
api.example.com {
	reverse_proxy server:8080
}

auth.example.com {
	# Zitadel serves gRPC and HTTP on one cleartext HTTP/2 port.
	reverse_proxy h2c://zitadel:8080
}
```

Then set these together in `.env` and `docker compose up -d` — they must agree, and
a mismatch in any one of them is the usual cause of a login that returns a token the
server rejects:

| Where | Set to |
| --- | --- |
| `.env` | `ZITADEL_EXTERNALDOMAIN=auth.example.com`, `ZITADEL_EXTERNALPORT=443`, `ZITADEL_EXTERNALSECURE=true`, `ZITADEL_TLS_MODE=external` |
| `.env` | `ZITADEL_ISSUER=https://auth.example.com`, `PUBLIC_URL=https://api.example.com` |
| `.env`, only if you serve the web app | `WEB_ORIGINS=https://app.example.com` |
| Zitadel Console | the `pipod-web` app's redirect URI, to `https://app.example.com/auth/callback` |
| the CLI | `--issuer https://auth.example.com --server https://api.example.com` |

`ZITADEL_ISSUER` is compared exactly against the `iss` claim: no trailing slash,
right scheme. The server still fetches signing keys over the Compose network
(`ZITADEL_JWKS_URL`, default `http://zitadel:8080/oauth/v2/keys`); set it only if
that route stops working.

Changing `ZITADEL_EXTERNALDOMAIN` after first boot does not move an existing
instance. Decide the domain before step 1 if you know it.

Serve every public endpoint over HTTPS. Never copy `SECRETS_KEK` or database
credentials to another machine — sandboxes receive plaintext secret *values* at
launch, never the keys that protect them at rest.

## Sizing the host and the pod shape

The sandbox runs N isolated sandboxes inside one container. It is `privileged`, uses
the host cgroup namespace, and mounts `/sys/fs/cgroup` read-write, because it mounts
overlayfs, writes cgroup limits, and creates network namespaces. The isolation
boundary is the host kernel. Give it its own machine before you let untrusted people
run code in it.

A Docker memory limit on the sandbox service would **not** bound sandboxes: crun
places each sandbox's cgroup at the host cgroup root, outside the container's scope.
Two settings in `.env` do the real work:

- `PI_POD_SANDBOX_FLEET_MEMORY_GB` / `PI_POD_SANDBOX_FLEET_CPU` — kernel-enforced
  ceiling on the whole sandbox subtree. This is what stops a bursting sandbox
  from reclaiming memory out of Postgres, Zitadel, or the server on the machine that
  also holds `SECRETS_KEK`.
- `PI_POD_SANDBOX_RESERVE_MEMORY_GB` / `_CPU` — admission control refuses to commit
  guarantees beyond `host total − reserve`.

Admission is a promise, not a measurement: it commits each live sandbox's whole
memory ceiling against `min(host total − reserve, fleet ceiling)`, and refuses
anything that does not fit. Exact fits are admitted. So the host has to be sized
against the *pod shape you launch*. Two configurations, both verified end to end:

| Host | `.env` | Admission budget | Default pod shape |
| --- | --- | --- | --- |
| 8 GB / 4 vCPU | the defaults: fleet 4 GB / 3 GB reserve, fleet CPU 3 / 0.5 reserve | 4 GiB, 3 cores | the standard 2 vCPU / 4 GiB — one at a time |
| 4 GB / 2 vCPU | fleet 2 GB / 1.5 GB reserve, fleet CPU 1.5 / 0.5 reserve | 2 GiB, 1.5 cores | must be lowered to 1 vCPU / 2 GiB |

On a 4 GB host, lower the shape before the first launch — with the CLI from
step 5, once you are signed in. The org defaults apply to every project; a
project's own `.pi-pod/config.json` does not, because a project layer only
reaches the server through a template, which the launcher offers to create:

```bash
node cli/dist/cli.js settings org set resources.memoryGB 2
node cli/dist/cli.js settings org set resources.cpu 1
```

What the host currently believes is one request away, and it is the fastest way
to read a refused launch:

```bash
docker compose exec sandbox curl -fsS http://127.0.0.1:8433/v1/healthz
# .capacity.memory.budgetBytes / .committedBytes, .capacity.cpu.budgetCores
```

`sandbox` is the deployment's default and only provider. Do not set `E2B_API_KEY`
or `DAYTONA_API_KEY`: those providers are removed and their names are retired.

### Settings `.env` does not cover

Put them in `selfhost/compose.override.yml`, which Compose merges automatically and
`git pull` never touches. A larger per-pod disk, for example, needs both sides: the
server bounds the request, and the sandbox refuses a disk above its own maximum.

```yaml
services:
  server:
    environment:
      POD_MAX_DISK_GB: 40
  sandbox:
    environment:
      PI_POD_SANDBOX_MAX_DISK_GB: 40
```

The server's settings are listed in [`server/.env.example`](../server/.env.example);
the sandbox's in [`sandbox/src/config.ts`](../sandbox/src/config.ts).

## Secret key lifecycle (rotation)

Trust boundary first: anyone allowed to launch pods that inherit org secrets —
and any code running inside such an authorized pod — can read those secret
*values*. The API stays write-only for values, but envelope encryption protects
against database theft, not against the control plane or an authorized pod.
Template/init-script editors likewise influence code that runs with inherited
secrets; treat them as trusted for those scopes.

Before rotation, preserve the current key/id in `SECRETS_KEK_PREVIOUS` (a JSON
object mapping key IDs to base64 keys), generate a new key with a new unique
`SECRETS_KEK_ID`, and `docker compose up -d` with both keys configured. Never reuse a
key ID for different material. Keep these edits in `.env`, not shell arguments or
database dumps. Then, from `selfhost/`:

```bash
docker compose exec server node dist/secrets-maintenance.js status --batch-size 1000
docker compose exec server node dist/secrets-maintenance.js verify
docker compose exec server node dist/secrets-maintenance.js migrate --batch-size 500
docker compose exec server node dist/secrets-maintenance.js rewrap
```

`status` counts records by table, format, and key id; `verify` proves the
configured keys authenticate every live row; `migrate` converts legacy
envelopes to context-bound v2 in resumable, idempotent batches (opaque row ids
only, never values); `rewrap` moves v2 DEKs to the current KEK. Tune
`--batch-size` to the deployment. There is no public rotation endpoint. Retire a key
only after `status` reports zero references to that key and `verify` succeeds, a
restore rehearsal with the historical keys succeeds, and retained dumps no longer
need it. A compromised *credential value* (not the KEK) must additionally be revoked
at its upstream issuer — re-encrypting does not un-share it.

## Moving from the hand-built layout

Earlier versions of this guide had you build and migrate everything by hand from
`server/` (or from a separate `pi-pod-server` checkout), with a
`docker-compose.override.yml` and a local registry for the base image. The bundle
takes over that install's data in place.

An install from the separate `pi-pod-server` checkout first finishes the migrations
from before this repository existed: this release refuses a database that stopped
partway through them, and its log names the file it is missing. The last release of
that checkout ships them all, so run its migrations once, from that checkout, with its
server stopped (some of them must never run under an older server):

```bash
cd pi-pod-server && docker compose stop server
git fetch origin && git checkout 2edaee122acd0f82c18df328dfd54a34b8c319e3
docker compose build server && docker compose run --rm server node dist/migrate.js
cd ..
```

Then move. Stop the old stack from its directory — `server/` here, or `pi-pod-server`:

```bash
cd server && docker compose down && cd ..      # keeps every volume
cp selfhost/.env.example selfhost/.env && chmod 600 selfhost/.env
```

In `selfhost/.env`, carry over `ZITADEL_MASTERKEY`, `ZITADEL_ADMIN_PASSWORD`,
`SECRETS_KEK` (and `SECRETS_KEK_ID` / `SECRETS_KEK_PREVIOUS`), `PI_POD_SANDBOX_TOKEN`,
`PUBLIC_URL`, `ZITADEL_API_AUDIENCE`, and any going-public values from the old
`.env`, then add:

```sh
COMPOSE_PROJECT_NAME=server   # the old directory's name: reuses its pgdata, sandbox_state and registry_data volumes
POSTGRES_PASSWORD=pipod       # the password that layout's database was created with
```

For the former separate checkout the project name is `pi-pod-server`. Then
`selfhost/upgrade` dumps the existing database, migrates it to this release, and
brings your existing pods' workspaces up under the new sandbox.

## When it does not work

| Symptom | Cause |
| --- | --- |
| `selfhost/upgrade` stops at `backup` and the server never starts | The dump failed — usually a full disk. `docker compose logs backup`. Nothing was upgraded. |
| The server restarts in a loop; its log says *"upgraded by a newer pi pod release"* | You went back to an older release without restoring. Return to the newer one, or [restore](#restore) the dump taken before it. |
| The server restarts in a loop; its log says *"applying migrations failed"* | `docker compose run --rm server node dist/migrate.js` prints the database error. Fix it, or restore the latest dump. |
| `invalid server environment: ... Required` at startup | A required `.env` value is empty. |
| `invalid server environment` naming `SECRETS_KEK` with a value set | Placeholder (all-zero) or malformed base64 key — generate with `openssl rand -base64 32`. |
| `zitadel` exits at first boot, `migration failed ... PasswordComplexityPolicy` | `ZITADEL_ADMIN_PASSWORD` does not satisfy the password policy — step 1. Fix it and `docker compose up -d`. |
| Launches fail with *"launch admission is held"* | The server log says why. An image built without `selfhost/upgrade` has no `SOURCE_SHA` to record and leaves it held; unresolved launches or host operations leave it for you: `docker compose exec server node dist/fleet.js launch-gate status`. |
| Login succeeds, every API call is 401 | `ZITADEL_API_AUDIENCE` is still unset, or `ZITADEL_ISSUER` does not match `iss` exactly. |
| Login succeeds, nothing is permitted | No org, no role grant, or a user created outside the organization that granted the roles — step 4. |
| Invites and password resets never arrive | No SMTP provider, or one whose credential was dropped — step 4. |
| `the image mirror is private` on launch | The base image was not published — the server was started without `selfhost/upgrade`. Run it. A failed pull is remembered for ten minutes. |
| A launch fails naming capacity, or the server log says `provisioning failed: … (507)` | The host refused admission: the pod's memory or CPU ceiling does not fit `min(host total − reserve, fleet ceiling)`. Read the budget from the sandbox's `/v1/healthz` and either lower the default shape or grow the host — [Sizing](#sizing-the-host-and-the-pod-shape). |
| A `.pi-pod/config.json` `resources` block changes nothing | A project layer only reaches the server through a template. Answer `y` to the launcher's *create template* prompt, or set the shape once in the org defaults: `pipod settings org set resources.memoryGB 2`. |
| `failed to setup loop device` on launch | The host had no `/dev/loop*` when the sandbox container started: `modprobe loop`, then `docker compose up -d --force-recreate sandbox`. |
| `pod transport supervisor stayed alive but did not connect` | `PUBLIC_URL` is not reachable from inside a pod. |
| `doctor` reports a removed provider (`e2b`/`daytona`) | Stale project-layer `provider` pin — remove it; only `sandbox` is supported. |
| Pods die after a few minutes idle | The sandbox's `PI_POD_SANDBOX_API_HOST` does not match its bridge gateway. |
| Browser calls blocked by CORS | `WEB_ORIGINS` is empty, or lists a URL with a path or trailing slash instead of a bare origin. |
