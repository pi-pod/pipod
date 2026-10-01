# Self-hosting pi pod

The minimum path from an empty Linux host to a working `pipod login`. Four
things run: **Postgres**, **Zitadel** (OIDC), the **server** (control plane), and
the **native sandbox** the server launches pods into, on the same host.

You need Docker with the Compose plugin, Node 22+, `git`, `openssl`, and **8 GB
of RAM**. 4 GB is not enough for a pod of the default shape: admission commits
each sandbox's whole memory *ceiling*, so a standard 2 vCPU / 4 GiB pod needs
4 GiB of admission budget, and that budget is `min(host total − reserve, fleet
ceiling)`. On a 4 GB machine it is 2.83 GiB and every launch is refused before
it starts. A 4 GB host is usable, but only with a smaller default pod shape —
see [Sizing](#sizing-the-host-and-the-pod-shape). Everything below is built from
source — the `ghcr.io/pi-pod/*` packages are private. On Debian stable, whose
own `nodejs` is still 20:

```bash
apt-get update && apt-get install -y ca-certificates curl git openssl
curl -fsSL https://get.docker.com | sh
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs
# The sandbox mounts each workspace from a loopback file, and a container inherits
# /dev as it was when it started: load this before step 5, or every launch fails
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

## 1. Postgres, Zitadel, and the server

[`server/docker-compose.yml`](../server/docker-compose.yml)
brings up all three. One Postgres holds both databases: `pipod` for the product
and `zitadel` for the identity server, created on first boot by
[`dev/postgres-init/01-zitadel-db.sql`](../server/dev/postgres-init/01-zitadel-db.sql).
There is no second Postgres and no separate identity host.

Write `server/.env` — it is gitignored, and it is the only file that holds
secrets:

```sh
# Zitadel. Masterkey is EXACTLY 32 characters and seals Zitadel's own keys in
# Postgres: back it up offline, or a database restore is unusable.
#   tr -dc 'A-Za-z0-9' </dev/urandom | head -c 32
ZITADEL_MASTERKEY=
# First-boot Console admin. Zitadel forces a change on first sign-in, and checks
# this one against the password policy while it sets itself up: 8+ characters
# with upper and lower case, a number and a symbol. A weaker one aborts the setup
# migration and Zitadel never starts; fix it and `docker compose up -d zitadel`.
#   echo "$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 20)aA1!"
ZITADEL_ADMIN_PASSWORD=

# Envelope-encryption key for stored secrets. Base64 of 32 random bytes:
#   openssl rand -base64 32
# Lose it and every stored secret is unreadable. It is not in the database.
# Missing or empty SECRETS_KEK stops startup: the base compose requires it
# (`${SECRETS_KEK:?...}`) and the server also rejects the old all-zero
# placeholder and malformed base64. Generate a real one now, then restrict it:
#   chmod 600 server/.env
SECRETS_KEK=
SECRETS_KEK_ID=kek-1

# Fill in after step 3 — the compose default only matches the dev signer.
ZITADEL_API_AUDIENCE=

# Where pods dial the gateway back, from inside a sandbox — so not 127.0.0.1,
# which there is the pod itself. This host's own address, reachable from a pod.
PUBLIC_URL=http://<this host>:8080
```

Two more variables matter and the base compose does not pass them
through, so `.env` alone will not reach the server. (`SECRETS_KEK_ID` and
`SECRETS_KEK_PREVIOUS` are already forwarded by the base compose — do not
add them here.) Add
`server/docker-compose.override.yml`, which Compose merges automatically:

```yaml
# Vars the base compose does not interpolate. No secrets here, only names.
services:
  server:
    environment:
      # Required to launch a pod at all: pods dial the gateway back at this URL.
      PUBLIC_URL: ${PUBLIC_URL:?an address a pod can reach}
      # Comma-separated browser origins. Empty means CORS off, which is correct
      # until you serve the web app.
      WEB_ORIGINS: ${WEB_ORIGINS:-}
```

Step 5 appends the sandbox to this same file.

Then:

```bash
cd server
docker compose up -d db zitadel
docker compose build server
docker compose run --rm server node dist/migrate.js   # prints "applied: 000_baseline.sql"
docker compose up -d server
curl -fsS http://127.0.0.1:8080/healthz
```

The compose publishes 5432, 8080 and 8081 on every interface. On a host with a
public address, firewall all three: nothing outside the host needs Postgres or
Zitadel, and 8080 only has to be reachable from the pods in step 5.

**Migrate before you start the server, every time.** The server image sets
`NODE_ENV=production`, and the server only auto-migrates outside production — so
a fresh instance comes up *healthy* against an empty schema and then fails on
the first real request. `/healthz` will not warn you. The migration is
idempotent; re-run it after every upgrade.

## 2. A Zitadel admin token

Zitadel is up on `http://127.0.0.1:8081`. The bootstrap scripts authenticate with
a personal access token belonging to a service user, not with your password.

1. Open `http://127.0.0.1:8081/ui/console` and sign in as the first-boot admin.
   The username is `ZITADEL_FIRSTINSTANCE_ORG_HUMAN_USERNAME` (`admin`) plus the
   domain Zitadel derived for the `pipod` organization; the Console's
   Organization page shows the exact login name. The password is your
   `ZITADEL_ADMIN_PASSWORD`, and Zitadel makes you change it now.
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

Put the **project id** in `.env` as `ZITADEL_API_AUDIENCE` and restart the
server. Keep the `pipod-cli` client id for step 6 — it is a different id from
the project's, and re-running the reconciler will not change it.

```bash
docker compose up -d server
```

The compose default `pipod-api` is a dev-signer placeholder. Leave it in place
and every real Zitadel token is rejected as a bad audience.

Optionally align the instance's token lifetimes with
[`zitadel/oidc-settings.json`](../server/zitadel/oidc-settings.json):

```bash
ZITADEL_EXPECTED_ISSUER=$ZITADEL_URL node zitadel/scripts/apply-oidc-settings.mjs --apply
```

The compose sets those lifetimes as first-boot defaults, so on a brand-new
instance this is a no-op. It matters when you rebuild an instance later. Like
the reconciler it defaults to `--check` and needs `ZITADEL_EXPECTED_ISSUER`.

## 4. An organization, a user, and roles

Pods belong to organizations. Signing in without one succeeds and then does
nothing — the CLI says *"access is pending Zitadel organization membership or
role grants"*.

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
does; mount it and pass it as `--config`:

```yaml
DefaultInstance:
  SMTPConfiguration:
    SMTP:
      PlainAuth:
        User: # ZITADEL_DEFAULTINSTANCE_SMTPCONFIGURATION_SMTP_PLAINAUTH_USER
        Password: # ZITADEL_DEFAULTINSTANCE_SMTPCONFIGURATION_SMTP_PLAINAUTH_PASSWORD
```

Set the other SMTP variables without the credential and you get an *active*
provider that cannot log in, which is harder to notice than having none.

## 5. The sandbox (native-only, static host)

[`sandbox`](../sandbox) runs N isolated
sandboxes inside one container. It is `privileged`, uses the host cgroup
namespace, and mounts `/sys/fs/cgroup` read-write, because it mounts overlayfs,
writes cgroup limits, and creates network namespaces. The isolation boundary is
the host kernel. Give it its own machine before you let untrusted people run
code in it.

Host backend is `static` (the default and the only backend in this edition):
the server reads `PI_POD_SANDBOX_URL` and never provisions anything. The `box`
backend is SaaS-only and inert here.

Add its token to `.env` — one value, used by both services:

```sh
# openssl rand -hex 32
PI_POD_SANDBOX_TOKEN=
```

Then join it to the server's Compose project, so the two share a network and the
API is never published. Append to the same
`server/docker-compose.override.yml`:

```yaml
# under the existing `services:` key
  server:
    environment:
      PI_POD_SANDBOX_TOKEN: ${PI_POD_SANDBOX_TOKEN:?}
      PI_POD_SANDBOX_URL: http://sandbox:8433
      SANDBOX_HOST_BACKEND: static
      # The base compose does not interpolate this one either, so setting it in
      # `.env` alone reaches nothing. The default is the registry below.
      PI_POD_SANDBOX_IMAGE_MIRROR: ${PI_POD_SANDBOX_IMAGE_MIRROR:-127.0.0.1:5000/pipod}
  sandbox:
    build: ../sandbox
    restart: unless-stopped
    privileged: true
    init: true   # reap detached `crun run -d` children (tini as PID 1)
    cgroup: host
    environment:
      PI_POD_SANDBOX_TOKEN: ${PI_POD_SANDBOX_TOKEN:?}
      PI_POD_SANDBOX_PORT: 8433
      PI_POD_SANDBOX_STATE_DIR: /state
      # Explicit local identity. The default is the container hostname, which changes
      # on every recreate and makes every capacity report `identity-mismatch`.
      PI_POD_SANDBOX_HOST_ID: local
      PI_POD_SANDBOX_API_HOST: 10.77.0.1
      # The only thing that actually bounds the sandboxes (see below). These are the
      # 8 GB values: a 4 GiB kernel-enforced ceiling over the whole sandbox subtree,
      # 3 GB kept back for Postgres + Zitadel + the server. The admission budget is
      # min(host total − reserve, fleet ceiling) = 4 GiB, which fits exactly one
      # standard 4 GiB pod. Leave them unset and the subtree has no ceiling at all.
      PI_POD_SANDBOX_FLEET_MEMORY_GB: ${PI_POD_SANDBOX_FLEET_MEMORY_GB:-4}
      PI_POD_SANDBOX_FLEET_CPU: ${PI_POD_SANDBOX_FLEET_CPU:-3}
      PI_POD_SANDBOX_RESERVE_MEMORY_GB: ${PI_POD_SANDBOX_RESERVE_MEMORY_GB:-3}
      PI_POD_SANDBOX_RESERVE_CPU: ${PI_POD_SANDBOX_RESERVE_CPU:-0.5}
    volumes:
      - sandbox_state:/state
      - /sys/fs/cgroup:/sys/fs/cgroup:rw
    # The registry below shares this network namespace, so this publishes its port:
    # the host pushes to 127.0.0.1:5000 and the sandbox pulls from 127.0.0.1:5000.
    ports:
      - "127.0.0.1:5000:5000"

  # The mirror the base image is published to — see below.
  registry:
    image: registry:3
    restart: unless-stopped
    network_mode: "service:sandbox"
    volumes:
      - registry_data:/var/lib/registry

# alongside the top-level `services:` key
volumes:
  sandbox_state:
  registry_data:
```

Merge the two `server:` blocks into one; a YAML file cannot repeat a key. Then:

```bash
docker compose up -d --build sandbox registry
# it binds a few seconds after the container starts, so poll rather than ask once
until docker compose exec sandbox curl -fsS http://127.0.0.1:8433/v1/healthz; do sleep 2; done
```

The server restarts at the end of the next section, once there is an image for it
to find.

`PI_POD_SANDBOX_API_HOST` is the bridge gateway address the in-pod keepalive
dials from inside a sandbox. Omit it and every detached pod eventually dies of
an idle timeout. [`sandbox/docker-compose.yml`](../sandbox/docker-compose.yml)
is the standalone version of this service, and the source of truth for the rest
of its settings — archive storage, fleet ceilings, bridge CIDR.

### Fleet ceilings (load-bearing on a shared host)

A Docker `mem_limit` on the sandbox service does **not** bound sandboxes: crun
places each sandbox's cgroup at the host cgroup root, outside the container's
scope. Two settings do the real work (defined in
[`sandbox/src/config.ts`](../sandbox/src/config.ts)):

- `PI_POD_SANDBOX_FLEET_MEMORY_GB` / `PI_POD_SANDBOX_FLEET_CPU` — kernel-enforced
  ceiling on the whole sandbox subtree. This is what stops a bursting sandbox
  from reclaiming memory out of Postgres, Zitadel, or the API.
- `PI_POD_SANDBOX_RESERVE_MEMORY_GB` / `_CPU` — admission control refuses to commit
  guarantees beyond `host total − reserve`.

Guarantees are not caps, so the fleet ceiling is the load-bearing one. Both
default to *unbounded* (`0`), which is why step 5 sets them explicitly: without
them a bursting sandbox can reclaim memory out of Postgres, Zitadel, or the API
on the machine that also holds `SECRETS_KEK`.

### Sizing the host and the pod shape

Admission is a promise, not a measurement: it commits each live sandbox's whole
memory ceiling against `min(host total − reserve, fleet ceiling)`, and refuses
anything that does not fit. Exact fits are admitted. So the host has to be sized
against the *pod shape you launch*, and the two numbers below are the only ones
that matter.

The reserve defaults to 1 GB memory / 0.5 CPU; the fleet ceiling defaults to
unbounded. Two configurations, both verified end to end:

| Host | Sandbox service | Admission budget | Default pod shape |
| --- | --- | --- | --- |
| 8 GB / 4 vCPU | fleet 4 GB / 3 GB reserve, fleet CPU 3 / 0.5 reserve (step 5's values) | 4 GiB, 3 cores | the standard 2 vCPU / 4 GiB — one at a time |
| 4 GB / 2 vCPU | fleet 2 GB / 1.5 GB reserve, fleet CPU 1.5 / 0.5 reserve | 2 GiB, 1.5 cores | must be lowered to 1 vCPU / 2 GiB |

On a 4 GB host, lower the shape before the first launch — with the CLI from
step 6, once you are signed in. The org defaults apply to every project; a
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

Size per-sandbox ceilings (2 vCPU / 4 GiB / 20 GB standard) against the same
budget.

`sandbox` is the deployment's default and only provider (`DEFAULT_PROVIDER`, no
`--provider` flag, no `deniedProviders`). Do not set `E2B_API_KEY` or
`DAYTONA_API_KEY`: those providers are removed and their names are retired.

### The base image is the one thing that is not self-contained

The `sandbox` provider does not build images — it pulls the managed base tag
from `PI_POD_SANDBOX_IMAGE_MIRROR`, whose default `ghcr.io/pi-pod` is a private
package. A launch against an unpopulated cache fails with *"the image mirror is
private and this deployment must preload the tag during rollout"*, and that
failure is remembered: publish the tag and the next launch still reports it until
a ten-minute cooldown expires.

The sandbox pulls over plain HTTP from a loopback address only, and with TLS from
anywhere else. On one host that makes `127.0.0.1:5000` — the registry sharing the
sandbox's network namespace, added above — the address both it and the host pushing
to it can use. Build
[`image/Dockerfile`](../server/image/Dockerfile)
and push it there. It needs the pi version as a build arg and the three files the
launcher normally composes (empty here), so a bare `docker build -f image/Dockerfile .`
fails on the first `COPY`:

```bash
cd server && npm ci                 # tsx is a devDependency
tag=$(node --import tsx dev/print-image.mts)   # e.g. pi-pod-base:r1-pi0.84.4-imgc730fa3798aa
pi=$(node -p 'require("./package-lock.json").packages["node_modules/@earendil-works/pi-coding-agent"].version')
ctx=$(mktemp -d) && cp image/Dockerfile "$ctx/"
: > "$ctx/pi-packages.txt"; : > "$ctx/pi-packages-npm.txt"; : > "$ctx/bake.sh"
docker build --build-arg "PI_VERSION=$pi" -t "127.0.0.1:5000/pipod/$tag" "$ctx"
docker push "127.0.0.1:5000/pipod/$tag"
docker compose up -d server                # only now: it prewarms this tag on boot
```

Start the server last. It prewarms the base image as it comes up, and against a
tag that is not published yet that logs a pull failure in the sandbox and spends
one of the three attempts before the ten-minute cooldown.

`PI_POD_SANDBOX_IMAGE_MIRROR=registry.example.com/you` points at any other registry
your sandbox host can pull from anonymously; the server then looks for
`registry.example.com/you/pi-pod-base:<tag>`. The tag digests the pi version,
the launcher, and the image assets, so it changes when you upgrade; a template
that adds packages or a bake script derives its own tag and needs that one
mirrored too. There are no other providers to fall back to: `sandbox` builds
nothing and pulls the managed base tag, so the mirror must be populated.

## 6. Log in

```bash
cd cli && npm ci && npm run build && cd ..
export PI_POD_OIDC_CLIENT_ID=<the pipod-cli client id from step 3>
node cli/dist/cli.js login --server http://127.0.0.1:8080 --issuer http://127.0.0.1:8081
node cli/dist/cli.js doctor
```

Run `doctor` from your own project directory (not inside a checkout whose
`.pi-pod/config.json` pins a removed `provider`). The deployment default is always
`sandbox`; a stale project layer naming a removed provider is rejected with the
supported list.

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

## Going public

Terminate TLS at a reverse proxy and give Zitadel and the server their own
names. With Caddy on the same Compose network, change the domains in:

```caddyfile
api.example.com {
	reverse_proxy server:8080
}

auth.example.com {
	# Zitadel serves gRPC and HTTP on one cleartext HTTP/2 port.
	reverse_proxy h2c://zitadel:8080
}
```

Then, together — these must agree, and a mismatch in any one of them is the
usual cause of a login that returns a token the server rejects:

| Where | Set to |
| --- | --- |
| `zitadel` service | `ZITADEL_EXTERNALDOMAIN=auth.example.com`, `ZITADEL_EXTERNALPORT=443`, `ZITADEL_EXTERNALSECURE=true`, and `--tlsMode external` in its `command:` — the base compose has `disabled` |
| `.env` | `ZITADEL_ISSUER=https://auth.example.com`, `PUBLIC_URL=https://api.example.com` |
| `.env`, only if you serve the web app | `WEB_ORIGINS=https://app.example.com` |
| Zitadel Console | the `pipod-web` app's redirect URI, to `https://app.example.com/auth/callback` |
| the CLI | `--issuer https://auth.example.com --server https://api.example.com` |

`ZITADEL_ISSUER` is compared exactly against the `iss` claim: no trailing slash,
right scheme. `ZITADEL_JWKS_URL` defaults to `<issuer>/oauth/v2/keys` and only
needs setting when the server reaches Zitadel by a different route than clients
do — which the base compose does, over the Compose network.

Changing `ZITADEL_EXTERNALDOMAIN` after first boot does not move an existing
instance. Decide the domain before step 1 if you know it.

Serve every public endpoint over HTTPS. Never copy `SECRETS_KEK`
or database credentials to a sandbox host — sandboxes receive plaintext secret
*values* at launch, never the keys that protect them at rest. The co-located
sandbox is reached over the Compose network (`http://sandbox:8433` here,
`http://pi-pod-sandbox:8433` in production); no WireGuard hop, no Caddy route,
no DNS record.

## Environment reference

Only three server variables are required; everything else has a default.

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | Set by the compose. `MIGRATION_DATABASE_URL` overrides it for the migration job, when that role is a different, owning user. |
| `ZITADEL_ISSUER` | yes | Must equal the `iss` claim exactly. |
| `SECRETS_KEK` | yes | Base64 of 32 bytes. Not recoverable from the database. Keep `.env` at mode `0600`; back it up separately from the database. |
| `SECRETS_KEK_ID` | no | Default `kek-1`; stored per secret so you can rotate. Already forwarded by the base compose — no override file needed. |
| `SECRETS_KEK_PREVIOUS` | no | JSON map of retired key ids to base64 keys, e.g. `{"kek-1":"<base64>"}`. Keep old keys configured until rotation verification passes and backup retention permits retirement. |
| `ZITADEL_API_AUDIENCE` | no | Default `pipod-api` is a dev placeholder — set it to the project id from step 3. |
| `PUBLIC_URL` | in practice | Pods dial the gateway at this URL from inside a sandbox, so `127.0.0.1` is the pod itself. |
| `WEB_ORIGINS` | no | Comma-separated. Empty disables CORS, correct for native-only clients. |
| `PI_POD_SANDBOX_TOKEN` | for `sandbox` | Same value here and in the sandbox service. |
| `PI_POD_SANDBOX_URL` | no | Default `http://pi-pod-sandbox:8433`, which is the production service name; step 5 names the service `sandbox`, hence the override. |
| `PI_POD_SANDBOX_HOST_ID` | — | Not a server variable: it belongs to the sandbox service (step 5), set explicitly to `local` there. The hostname default changes on every recreate and breaks placement. |
| `SANDBOX_HOST_BACKEND` | no | `static` (default, only backend here). The SaaS `box` backend is inert when static. |
| `PI_POD_SANDBOX_IMAGE_MIRROR` | for `sandbox` | Namespace holding `pi-pod-base:<tag>`. |

[`server/.env.example`](../server/.env.example)
lists the rest — roles, APNs, event retention.

## Back up

- **Postgres.** Both databases. This is the product data and the whole identity
  server.
- **`ZITADEL_MASTERKEY`**, offline. A `zitadel` database restored without it is
  unusable.
- **`SECRETS_KEK` (+ every id in `SECRETS_KEK_PREVIOUS`)**, offline and
  **separate from the database backups**. A database theft without the keys
  protects stored secrets; keys and dumps stored together defeat that
  separation.
- **Retain historical keys for as long as you retain historical backups.** An
  old backup restores only with the key versions that wrapped its rows — do not
  modify backups in place and do not retire a key while any retained backup
  still needs it.

Sandbox workspaces are not in Postgres. They live on the sandbox's state volume,
and only *archived* ones reach object storage — with the default
`PI_POD_SANDBOX_ARCHIVE_DRIVER=local`, nothing survives losing that host.

## Secret key lifecycle (rotation)

Trust boundary first: anyone allowed to launch pods that inherit org secrets —
and any code running inside such an authorized pod — can read those secret
*values*. The API stays write-only for values, but envelope encryption protects
against database theft, not against the control plane or an authorized pod.
Template/init-script editors likewise influence code that runs with inherited
secrets; treat them as trusted for those scopes.

Apply the tenant-key schema migration in a brief maintenance deployment: stop
API/gateway/workers, migrate, deploy the matching code, restart. Old upsert SQL
is incompatible with the new `(org_id, scope_type, scope_id, name)` constraint.
Once version-2 (context-bound) writes begin, do not roll back to an old-only
reader — it cannot authenticate v2 envelopes.

Before rotation, preserve the current key/id in `SECRETS_KEK_PREVIOUS` (a JSON
object mapping key IDs to base64 keys), generate a new key with a new unique
`SECRETS_KEK_ID`, and restart with both keys configured. Never reuse a key ID
for different material. Keep these edits in the protected env file, not shell
arguments or database backups. Run the operator command with that environment:

```bash
cd server
npm run secrets:maintenance -- status --batch-size 1000
npm run secrets:maintenance -- verify
npm run secrets:maintenance -- migrate --batch-size 500
npm run secrets:maintenance -- rewrap
```

`status` counts records by table, format, and key id; `verify` proves the
configured keys authenticate every live row; `migrate` converts legacy
envelopes to context-bound v2 in resumable, idempotent batches (opaque row ids
only, never values); `rewrap` moves v2 DEKs to the current KEK. Tune
`--batch-size` to the deployment. In a deployed image use
`node dist/secrets-maintenance.js <command>` with the same protected runtime
environment; no public rotation endpoint exists. Retire a key only after
`status` reports zero references to that key and `verify` succeeds, a restore
rehearsal with the historical keys succeeds, and
retained backups no longer need it. A compromised *credential value* (not the
KEK) must additionally be revoked at its upstream issuer — re-encrypting does
not un-share it.

## When it does not work

| Symptom | Cause |
| --- | --- |
| Every request 500s on a fresh, healthy instance | Migration not run. `docker compose run --rm server node dist/migrate.js`. |
| `invalid server environment: ... Required` at startup | One of `DATABASE_URL`, `ZITADEL_ISSUER`, `SECRETS_KEK` is unset. |
| `invalid server environment` naming `SECRETS_KEK` with a value set | Placeholder (all-zero) or malformed base64 key — generate with `openssl rand -base64 32`. |
| `zitadel` exits at first boot, `migration failed ... PasswordComplexityPolicy` | `ZITADEL_ADMIN_PASSWORD` does not satisfy the password policy — step 1. |
| Login succeeds, every API call is 401 | `ZITADEL_API_AUDIENCE` is still `pipod-api`, or `ZITADEL_ISSUER` does not match `iss` exactly. |
| Login succeeds, nothing is permitted | No org, no role grant, or a user created outside the organization that granted the roles — step 4. |
| Invites and password resets never arrive | No SMTP provider, or one whose credential was dropped — step 4. |
| `PUBLIC_URL is required when POD_TRANSPORT=ws` | Set `PUBLIC_URL`; the base compose does not. |
| A launch fails naming capacity, or the server log says `provisioning failed: … (507)` | The host refused admission: the pod's memory or CPU ceiling does not fit `min(host total − reserve, fleet ceiling)`. Read the budget from the sandbox's `/v1/healthz` and either lower the default shape or grow the host — [Sizing](#sizing-the-host-and-the-pod-shape). |
| A `.pi-pod/config.json` `resources` block changes nothing | A project layer only reaches the server through a template. Answer `y` to the launcher's *create template* prompt, or set the shape once in the org defaults: `pipod settings org set resources.memoryGB 2`. |
| `the image mirror is private` on launch | `PI_POD_SANDBOX_IMAGE_MIRROR` — see step 5. Already published? The failed launch is cached for ten minutes. |
| `failed to setup loop device` on launch | The host had no `/dev/loop*` when the sandbox container started: `modprobe loop`, then `docker compose up -d --force-recreate sandbox`. |
| `pod transport supervisor stayed alive but did not connect` | `PUBLIC_URL` is not reachable from inside a pod. |
| `doctor` reports a removed provider (`e2b`/`daytona`) | Stale project-layer `provider` pin — remove it; only `sandbox` is supported (step 6). |
| Pods die after a few minutes idle | `PI_POD_SANDBOX_API_HOST` does not match the bridge gateway. |
| Browser calls blocked by CORS | `WEB_ORIGINS` is empty, or lists a URL with a path or trailing slash instead of a bare origin. |
