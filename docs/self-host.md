# Self-hosting pi pod

The path from an empty Linux host to a working `pipod`, and every upgrade after that. Four
things run, all on one host: **Postgres**, **Zitadel** (OIDC), the **server** (control
plane), and the **native sandbox** the server launches pods into.
[`../selfhost/`](../selfhost/) holds the whole deployment, built from the commit you have
checked out: installing is `selfhost/upgrade`, and upgrading is
`git pull && selfhost/upgrade`.

Steps 1–3 give you a working instance used from this host. [Going public](#going-public) is
the later step that lets other machines and the phone apps in.

You need a Linux host with **8 GB of RAM** and cgroup v2 (the default on current Debian and
Ubuntu), Docker with the Compose plugin, `git`, `openssl`, and Node 22.19 or later (for the
CLI). Pods may use the host's memory and CPU less a reserve kept for everything else, and
a standard pod (2 vCPU / 4 GiB) needs its whole 4 GiB of that, so 8 GB runs one standard pod
at a time and 16 GB runs three. A 4 GB host works with smaller pods — see
[Sizing](#sizing-the-host-and-the-pod-shape). On Debian stable, whose own `nodejs` is
still 20:

```bash
apt-get update && apt-get install -y ca-certificates curl git openssl
curl -fsSL https://get.docker.com | sh
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs
```

Commands below run from the repository root.

```bash
git clone https://github.com/pi-pod/pipod.git
cd pipod
```

## 1. Install

```bash
selfhost/upgrade
```

The first run writes `selfhost/.env` with a fresh secret for everything that needs one, then
builds the server and the sandbox from this checkout, publishes the pod base image to a
registry inside the deployment, starts it all, and sets up Zitadel: the `pipod` project, its
roles, and the apps the CLI and the phone apps sign in with. It ends by saying what to do next.

`selfhost/.env` holds every secret of the deployment. Two of them have no second copy
anywhere — **back both up offline now**, separately from the database dumps (see
[Back up and restore](#back-up-and-restore)):

- **`ZITADEL_MASTERKEY`** seals Zitadel's own keys in Postgres; a database restored
  without it is unusable.
- **`SECRETS_KEK`** encrypts stored secrets; lose it and every one is unreadable.

Only two ports are published. 8080 (the server) listens on every interface for clients on
other machines; keep it off the internet until you [go public](#going-public). Docker
publishes ports past host firewalls such as `ufw`, so block it in your cloud provider's
firewall, or bind it to loopback as [Going public](#going-public) does. Zitadel's 8081 and
the base-image registry's 5000 are bound to `127.0.0.1`, and Postgres is not published at
all. Pods reach the server inside the deployment, so nothing about this
host's own addresses needs configuring.

Run every `docker compose` command in this guide from `selfhost/`.

## 2. Give yourself an account

```bash
selfhost/add-user you@example.com --owner
```

That creates you inside the deployment's `default` organization and prints a one-time
password, which Zitadel asks you to replace when you first sign in. `--owner` grants every
permission and lets you manage the organization's members; leave it off for everyone else,
who become members (they launch and manage their own pods). Running it again for an existing
user only adds what is missing, and `--new-password` issues a fresh one-time password — the
way back in for someone who forgot theirs, since a fresh instance cannot send email (see
[Email](#email)).

## 3. Install the CLI and sign in

```bash
(cd cli && npm ci && npm run build) && npm install -g ./cli
pipod login --server http://127.0.0.1:8080
```

That builds the CLI from this checkout, so it always matches the server. On a machine without
the checkout, install the published release from npm instead — it needs Node 22.19 or later:

```bash
npm install -g @pipod/cli
```

A CLI newer than the server is refused with a message saying so; upgrade the server first.

`pipod login` asks the server where to sign in, opens your browser, and waits for it. Where
there is no browser to open — on the server itself, or in any SSH session — it prints a page
and a short code instead, and you finish signing in in any browser that reaches Zitadel. On
this install Zitadel answers only on the host's `127.0.0.1:8081`, so forward it from the
machine whose browser you use, and open the page `login` printed there:

```bash
ssh -L 8081:127.0.0.1:8081 root@<this host>
```

Keep the tunnel up while `login` waits. Do not reach for a public address to avoid the tunnel:
signing in from other machines is [going public](#going-public), not a shortcut. Once you
have gone public, the page opens on any device, a phone included, with no tunnel at all.
`pipod login --device` asks for a code even where a browser could open. The server is
remembered, so later commands need nothing but `pipod`.

Then check the result, and launch your first pod from a project directory:

```bash
pipod doctor
pipod credentials connect      # the model providers your local pi is signed in to
pipod
```

`doctor` names the server's release revision and fails when its database is missing
migrations or launch admission is held.

### The dashboard

The server also serves a web dashboard at `http://127.0.0.1:8080/dashboard/`, for the settings
every launch is built from: the organization's defaults and policy, your own defaults, and
templates. Sign in with the same account as `pipod login`. From another machine, forward both
the server and Zitadel, since the browser reaches each as `127.0.0.1`:

```bash
ssh -L 8080:127.0.0.1:8080 -L 8081:127.0.0.1:8081 root@<this host>
```

What you can change follows your permissions, and the server enforces them whatever the page
shows: an `--owner` changes everything; a member edits their own settings and personal
templates and reads the rest. People and organizations stay in the Zitadel Console, which the
dashboard links to.

### The phone apps

The iOS and Android apps sign in to your server too, once it is [public](#going-public):
on the sign-in screen tap **Server · Change**, enter the address the CLI signs in to
(`api.example.com`), then **Sign in**. The app asks the server where to sign in, as the CLI
does, and remembers it until you choose again; **Use pi pod cloud** goes back. They need
HTTPS — a phone cannot reach `127.0.0.1`, and the apps never send sign-in tokens in the
clear. The apps do not edit settings or templates themselves: **Web dashboard** in their
Settings opens [the dashboard](#the-dashboard) at `SERVER_URL` in the phone's browser. This
repository does not publish app builds; build one from [`ios/`](../ios) or
[`android/`](../android) as their READMEs describe.

### Zitadel

Everything above configured Zitadel for you. Its Console is at
`http://127.0.0.1:8081/ui/console` (through the tunnel), for the instance's own settings.
Sign in as `admin@pipod.127.0.0.1` (`admin@pipod.<ZITADEL_EXTERNALDOMAIN>` once you have gone
public) with the `ZITADEL_ADMIN_PASSWORD` from `selfhost/.env`; Zitadel makes you change it
at first sign-in. People are easier to manage with
`selfhost/add-user`; more organizations, with `server/zitadel/scripts/provision-org.sh`.

### Email

Nothing sends mail yet. A fresh instance has no SMTP provider, so an invite or a password
reset produces a code that never reaches anyone and no error anywhere — which is why
`selfhost/add-user` hands out passwords itself. Add a provider in the Console under
Instance → Settings → SMTP provider; any host works, and the hosted deployment uses Mailgun
at `smtp.mailgun.org:587` with TLS on.

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
   and waits until it is healthy;
7. compares Zitadel's `pipod` project with the release's roles and apps, and warns
   about any drift without changing anything.

An install from before the dashboard has no `pipod-dashboard` app in Zitadel yet, so the first
upgrade past it warns about drift. Run `selfhost/upgrade --apply-zitadel` once to create it. If
you have [gone public](#going-public), set `SERVER_URL` in `.env` first: the dashboard signs in
back to that address, and Zitadel refuses any address it was not given.

Likewise, signing in with a code where no browser opens needs the device-code grant on the
`pipod-cli` app, which installs from before it lack: `upgrade` reports `app pipod-cli
grantTypes differs` until you run `selfhost/upgrade --apply-zitadel`. Until then `pipod login`
over SSH falls back to the browser flow, which also needs the port it names forwarded
(`ssh -L 8081:127.0.0.1:8081 -L 43117:127.0.0.1:43117 root@<this host>`).

Then update the CLI and check the result:

```bash
pipod update    # rebuilds the CLI here, or upgrades it from npm if installed that way
pipod doctor    # names the new revision
cd selfhost && docker compose ps   # db, zitadel, server, sandbox, registry up; backup exited 0
```

If `upgrade` warned about drift in the Zitadel project, apply the release's version of it —
it only ever creates and updates, never removes, but it does reset anything changed in the
Zitadel Console, such as a `pipod-web` redirect (set it again afterwards):

```bash
selfhost/upgrade --apply-zitadel
```

### Rolling back

An older release cannot run past a newer one's migrations: its server refuses to
start against a database a newer release migrated, and says so in its log. Roll
back with the dump the upgrade took first (see [Restore](#restore)), then check out
the commit you upgraded from and run `selfhost/upgrade`.

## Running it

Docker restarts every service after a crash, and after a reboot once Docker itself starts at
boot (the `get.docker.com` install sets that up). From `selfhost/`:

```bash
docker compose ps                  # what is running
docker compose logs -f server      # follow one service: server, sandbox, zitadel or db
docker compose restart server
docker compose down                # stop everything; data stays in Docker volumes
docker compose up -d               # start it again, taking a backup first
```

To remove pi pod from the host for good, `docker compose down -v` deletes every volume with
it: the database, Zitadel, and every pod's workspace. Copy `selfhost/backups/` and
`selfhost/.env` off the host first if you might want any of it back.

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

Give the server and Zitadel their own HTTPS names, served by a reverse proxy on this host.
The examples use `api.example.com` and `auth.example.com`; point DNS records for both at
this host and open ports 80 and 443.

With Caddy, which gets the certificates itself, write `selfhost/Caddyfile` with your
domains:

```caddyfile
api.example.com {
	# Metrics stay on the private network.
	respond /metrics 404
	reverse_proxy server:8080
}

auth.example.com {
	# Zitadel serves gRPC and HTTP on one cleartext HTTP/2 port.
	reverse_proxy h2c://zitadel:8080
}
```

and add Caddy to the deployment in `selfhost/compose.override.yml`. This also binds 8080 to
loopback, since Caddy reaches the server over the Compose network:

```yaml
services:
  server:
    ports: !override
      - "127.0.0.1:8080:8080"
  caddy:
    image: caddy:2
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config

volumes:
  caddy_data:
  caddy_config:
```

Then set these together in `.env` and run `selfhost/upgrade --apply-zitadel` — they must
agree, and a mismatch in any one of them is the usual cause of a login that returns a token
the server rejects:

| Where | Set to |
| --- | --- |
| `.env` | `ZITADEL_EXTERNALDOMAIN=auth.example.com`, `ZITADEL_EXTERNALPORT=443`, `ZITADEL_EXTERNALSECURE=true`, `ZITADEL_TLS_MODE=external` |
| `.env` | `ZITADEL_ISSUER=https://auth.example.com` |
| `.env` | `SERVER_URL=https://api.example.com`, where the dashboard signs in back to |
| `.env`, only if you serve the web app | `WEB_ORIGINS=https://app.example.com` |
| Zitadel Console | the `pipod-web` app's redirect URI, to `https://app.example.com/auth/callback` |
| the CLI | `pipod login --server https://api.example.com` — the server tells it the new issuer |

`ZITADEL_ISSUER` is compared exactly against the `iss` claim: no trailing slash,
right scheme. The server still fetches signing keys over the Compose network
(`ZITADEL_JWKS_URL`, default `http://zitadel:8080/oauth/v2/keys`); set it only if
that route stops working.

Zitadel adds a changed `ZITADEL_EXTERNALDOMAIN` to the existing instance when it next
starts, so going public after you have used the instance on loopback keeps its users and
settings.

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

- `PI_POD_SANDBOX_RESERVE_MEMORY_GB` / `_CPU` (default 3 GB / 0.5) — what admission keeps
  back for Postgres, Zitadel and the server: it refuses to commit guarantees beyond
  `host total − reserve`.
- `PI_POD_SANDBOX_FLEET_MEMORY_GB` / `_CPU` (default `auto`, the same `host total −
  reserve`) — a kernel-enforced ceiling on the whole sandbox subtree. This is what stops a
  bursting sandbox from reclaiming memory out of the services on the machine that also
  holds `SECRETS_KEK`. Set a number instead to hold pods to less.

Admission is a promise, not a measurement: it commits each live sandbox's whole memory
ceiling against that budget and refuses anything that does not fit; exact fits are admitted.
So a host runs as many pods as their *shapes* fit, whether or not they are busy — and a pod
holds its share until it stops (on its own after 15 idle minutes; `pipod stop` or
`pipod archive` at once). The budget is the host's total less the reserve, and the largest
pod anyone may launch is yours to set in `.env`:

- `POD_MAX_CPU` / `POD_MAX_MEMORY_GB` / `POD_MAX_DISK_GB` — the per-pod ceiling,
  default 2 vCPU / 4 GiB / 20 GiB. Compose hands the same values to the server, which
  bounds each launch, and to the sandbox, which writes them into each sandbox's
  cgroup and disk quota. A larger CPU or disk request is lowered to the ceiling
  with a warning. Memory up to the standard 4 GiB is lowered the same way, so the
  default shape still launches under a smaller ceiling; a request for more memory
  than the ceiling is refused, never shrunk.

| Host | `.env` | Admission budget | Pods |
| --- | --- | --- | --- |
| 16 GB / 8 vCPU | the defaults | 12.1 GiB, 7.5 cores (measured on a 15.1 GiB host) | three at 2 vCPU / 4 GiB |
| 8 GB / 4 vCPU | the defaults | about 4.7 GiB, 3.5 cores | one at 2 vCPU / 4 GiB |
| 4 GB / 2 vCPU | `PI_POD_SANDBOX_RESERVE_MEMORY_GB=1.5`, `POD_MAX_CPU=1`, `POD_MAX_MEMORY_GB=2` | about 2.3 GiB, 1.5 cores | one at 1 vCPU / 2 GiB |

A bigger machine takes bigger pods the same way: on a 32 GB / 8 vCPU host, for example,
`POD_MAX_CPU=4` and `POD_MAX_MEMORY_GB=16` (the fleet ceiling grows with the host on its
own). Each launch then asks for the org or template shape, up to that ceiling. To run more,
smaller pods — or to make a larger shape the default — set it once in the org defaults. They
apply to every project; a project's own `.pi-pod/config.json` reaches the server only through
a template, which the launcher offers to create:

```bash
pipod settings org set resources.memoryGB 2
pipod settings org set resources.cpu 1
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
`git pull` never touches. For example, a lower process limit per sandbox:

```yaml
services:
  sandbox:
    environment:
      PI_POD_SANDBOX_MAX_PIDS: 1024
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

Model credentials have the same boundary. A pod's `~/.pi/agent/auth.json` holds the
API keys and OAuth access tokens leased to it (never an OAuth refresh token), and any
code in the pod can read them and use the pod's token to fetch the current lease.
Removing a credential takes it out of the owner's pods, but the provider still
accepts it: revoke it there if a pod may have exposed it.

A template's agent instructions ("read-write in staging, read-only in
production") reach the agent in every pod launched from it, but they enforce
nothing: a pod can do whatever its secrets and egress allow. Give a template
only the credentials and allowed hosts its instructions describe. Pods cannot
widen that through self-service: a pod token launches child pods and schedules
jobs only from the template its own pod launched from.

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
`ZITADEL_API_AUDIENCE`, and any going-public values from the old `.env`, then add:

```sh
COMPOSE_PROJECT_NAME=server   # the old directory's name: reuses its pgdata, sandbox_state and registry_data volumes
POSTGRES_PASSWORD=pipod       # the password that layout's database was created with
ZITADEL_PAT=<the token>       # your IAM_OWNER service user's personal access token
```

That instance's Zitadel was set up by hand, so `selfhost/upgrade` and `selfhost/add-user`
manage it with the token you made for it then (step 2 of the earlier guide). With it,
`upgrade` also records the CLI's client id, which `pipod login` then reads from the server.

For the former separate checkout the project name is `pi-pod-server`. Then
`selfhost/upgrade` dumps the existing database, migrates it to this release, and
brings your existing pods' workspaces up under the new sandbox.

## When it does not work

| Symptom | Cause |
| --- | --- |
| `selfhost/upgrade` stops at `backup` and the server never starts | The dump failed — usually a full disk. `docker compose logs backup`. Nothing was upgraded. |
| The server restarts in a loop; its log says *"upgraded by a newer pi pod release"* | You went back to an older release without restoring. Return to the newer one, or [restore](#restore) the dump taken before it. |
| The server restarts in a loop; its log says *"applying migrations failed"* | `docker compose stop server && docker compose run --rm server node dist/migrate.js` prints the database error. Fix it, or restore the latest dump. |
| `invalid server environment: ... Required` at startup | A required `.env` value is empty. |
| `invalid server environment` naming `SECRETS_KEK` with a value set | Placeholder (all-zero) or malformed base64 key — generate with `openssl rand -base64 32`. |
| `zitadel` exits at first boot, `migration failed ... PasswordComplexityPolicy` | A hand-edited `ZITADEL_ADMIN_PASSWORD` does not satisfy the password policy (upper and lower case, a number and a symbol). Fix it and run `selfhost/upgrade`. |
| `selfhost/upgrade` says *"no Zitadel admin token"* | The instance's Zitadel was not set up by `selfhost/upgrade` — see [Moving from the hand-built layout](#moving-from-the-hand-built-layout). |
| `selfhost/upgrade` says *"this host already has a pi pod database but no selfhost/.env"* | The secrets that database was created with are gone from this checkout. Restore `.env` from your backup; new secrets cannot open the old data. |
| Launches fail with *"launch admission is held"* | The server log says why. An image built without `selfhost/upgrade` has no `SOURCE_SHA` to record and leaves it held; unresolved launches or host operations leave it for you: `docker compose exec server node dist/fleet.js launch-gate status`. |
| Login succeeds, every API call is 401 | `ZITADEL_API_AUDIENCE` is still unset, or `ZITADEL_ISSUER` does not match `iss` exactly. |
| Login succeeds, nothing is permitted | The user has no role grant, or lives outside the organization that granted the roles: `selfhost/add-user <email>` grants them. |
| Invites and password resets never arrive | No SMTP provider, or one whose credential was dropped — [Email](#email). `selfhost/add-user <email> --new-password` lets someone in meanwhile. |
| `pipod login --device` says the identity provider *"does not allow this CLI to sign in with a code"* | The install predates sign-in with a code: `selfhost/upgrade --apply-zitadel`. |
| `pipod login` signs in to pipod.dev, or Zitadel says the client is unknown | The CLI is pointed at another server: `pipod login --server <this server>`. A server that predates sign-in discovery needs `--issuer` and `PI_POD_OIDC_CLIENT_ID`. |
| `the image mirror is private` on launch | The base image was not published — the server was started without `selfhost/upgrade`. Run it. A failed pull is remembered for ten minutes. |
| A launch fails with *"the server is full"*, or the server log says `provisioning failed: … (507)` | Running pods hold the whole budget. Stop one (`pipod stop`), lower the default shape, or grow the host — [Sizing](#sizing-the-host-and-the-pod-shape). |
| A launch fails with `memoryGB … exceeds this deployment's … per-sandbox limit` | The org, template or launch asked for more memory than `POD_MAX_MEMORY_GB`. Ask for less, or raise it in `.env` and run `selfhost/upgrade` — [Sizing](#sizing-the-host-and-the-pod-shape). |
| A `.pi-pod/config.json` `resources` block changes nothing | A project layer only reaches the server through a template. Answer `y` to the launcher's *create template* prompt, or set the shape once in the org defaults: `pipod settings org set resources.memoryGB 2`. |
| `pod transport supervisor stayed alive but did not connect` | A pod cannot reach the server: `PUBLIC_URL` (if you set one) is wrong, or `10.79.0.0/24` collides with a network of this host's — see the `pods` network in `compose.yml`. |
| `doctor` reports a removed provider (`e2b`/`daytona`) | Stale project-layer `provider` pin — remove it; only `sandbox` is supported. |
| Pods die after a few minutes idle | The sandbox's `PI_POD_SANDBOX_API_HOST` does not match its bridge gateway. |
| A pod cannot reach something on your network (a git host, a `PUBLIC_URL` on a LAN address) | Pods are kept off private, shared and reserved addresses whatever their egress mode. List what they need in `PI_POD_SANDBOX_PRIVATE_EGRESS` in `.env`, then `selfhost/upgrade`. |
| The dashboard says *"this server has no dashboard sign-in configured"* | The install predates the dashboard: `selfhost/upgrade --apply-zitadel`. |
| Zitadel answers the dashboard's sign-in with *"redirect_uri is missing in the client configuration"*, or the dashboard says sign-in *"returns only to …"* | The browser reaches the server at an address other than `SERVER_URL` or loopback — usually a public install whose `SERVER_URL` is unset. Set `SERVER_URL` to the address in the browser (`https://api.example.com`) and run `selfhost/upgrade --apply-zitadel`. A plain-HTTP address other than loopback cannot work: Zitadel returns sign-ins over HTTP only to loopback. |
| Browser calls blocked by CORS | `WEB_ORIGINS` is empty, or lists a URL with a path or trailing slash instead of a bare origin. |
