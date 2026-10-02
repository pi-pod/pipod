# pi pod

Run [pi](https://github.com/earendil-works/pi) coding-agent sessions in server-managed pods.

```bash
npm install -g pipod         # or from a checkout of this directory: npm ci && npm run build && npm install -g .
pipod login --server <url>   # sign in to a pi pod server (the hosted one without --server)
pipod                        # launch a pod for the current directory and attach
pipod --help                 # every command and launch option
pipod update                 # upgrade the way it was installed
```

Running your own server: [docs/self-host.md](https://github.com/pi-pod/pipod/blob/main/docs/self-host.md).
A self-hosted server is deployed from a checkout; install the CLI from the same checkout so the
two match.

## Secrets

```bash
pipod secrets set org SERVICE_TOKEN       # hidden interactive prompt
pipod secrets set user SERVICE_TOKEN
pipod secrets set template/my-template SERVICE_TOKEN
pipod secrets set org SERVICE_TOKEN < /path/to/protected-value-file
```

Values come from the hidden prompt or stdin, never `NAME=value` arguments (which
can leak through shell history and process listings). Protect input files with
mode `0600`. The server accepts names up to 128 characters and values up to
64 KiB; list responses contain metadata only. Provider credentials belong at
org scope and are excluded from pod environments.

Authorized pod code can read inherited org/user/template values. Config bundles,
scripts and Pi files are readable configuration, not secret storage; use supported
environment references instead of literal credentials.

## Workspace seeding

`pipod` launched from a directory without `.pi-pod/config.json` seeds the new pod from that
directory (its git repository root when inside one):

- a clean, pushed checkout whose remote tip matches `HEAD` is **cloned at that exact commit**;
- anything else — dirty trees, unpushed commits, private remotes without usable credentials,
  plain directories — is **streamed in as a tar archive** (git-ignored paths, `node_modules`
  and `.pi-pod/env` excluded, `.git` included when it fits).

Credentials for a private remote are forwarded only after a prompt (`--yes` approves it) and
are never stored. `--dry-run` prints the decision without prompting or creating a pod;
`--no-seed` starts the pod empty. Forks, reused pods and `--on` co-location never seed.
Configured projects (with `.pi-pod/config.json`) keep their existing behavior.

Details, limits and a manual test checklist: [docs/workspace-seeding.md](docs/workspace-seeding.md).

Local images named in a prompt (clipboard pastes, `@shot.png`, file paths) are
attached inline for the pod agent: [docs/image-attachments.md](docs/image-attachments.md).

## Personal workstations (SaaS)

On the hosted service each user gets a whole machine of their own, which sleeps when idle. The
first command after it sleeps waits for it to come back — measured at 243 to 708 seconds in
production, so the CLI shows elapsed progress and says "several minutes" rather than promising
a number. Nothing is lost while it sleeps: every workspace stays on the workstation's disk.

The hosted service also reports the account's plan, active hours and spend cap, which `pipod
list` prints under the pods. A self-hosted server reports none of that, and the client then
shows none of it. The wire contract for both:
[docs/personal-workstation.md](docs/personal-workstation.md).

## Extension aux bridge

Server-attested pod extensions also render in the launcher (rendering hooks) while the
pod stays authoritative: the pod owns every slash command by default (`/pod local <name>`
runs the local copy explicitly), and `ctx.modelRegistry.complete()` executes pod-side with
real auth as a turn-external call. Text-only contract, bounds, cancellation and the
pi-lightweight-llm `/transcript` setup requirement: [docs/extension-aux-bridge.md](docs/extension-aux-bridge.md).
