# Config simplification

## Removed (local schema, hard migration errors)

| Key | Why | Migration |
|---|---|---|
| `envFile` | Client filesystem layout leaking into the server bundle. The bundle already carries secret *values/names*; the local path was only ever read by `compileBundleSource` and `projectEnvPath`, and the org layer already used a fixed path. | The project env file is always `.pi-pod/env`. Move the file, delete the key. |
| `initScript` | Same leak. Script *contents* travel in the bundle body (`initScript` string); the config value was only the local read/write path. | The project init script is always `.pi-pod/init.sh`. |
| `bakeScript` | Same leak, same shape as `initScript`. Bake itself is fully retained — only the path pointer is fixed. | The project bake script is always `.pi-pod/bake.sh`. |
| `reuse` | Stored reuse is retired server-side: the bundle-write contract rejects it, reads strip it, and resolve omits it. Launches are flag-driven. | Pass `--reuse` to reuse a stopped project pod (fresh pods are the default). Delete the key. |
| `pi.hostConfig.skills` | True no-op both sides: zero server reads, zero local consumers — the whole local agents directory always syncs. | Delete the key. |
| `pi.hostConfig.extensions` | Same, both sides. | Delete the key. |
| `--no-reuse` (CLI) | Redundant once stored `reuse` is gone: fresh pods are the default, so declining reuse is a no-op. `--reuse` alone covers the choice. | Retired as a plain unknown option. Drop the flag. |
| `init --print-shell-snippet` (CLI) | Shell integration, not configuration. The snippet only tested `cwd` for `.pi-pod/config.json` while the launcher walks to `$HOME`, so it mis-dispatched in subdirectories. Removing the generator breaks nothing installed. | Retired as a plain unknown option. |
| `--provider` (CLI) | Single-provider build: sandbox is the only backend, so there is nothing to select. | Retired as a plain unknown option. Drop the flag. |
| `provider`, `deniedProviders` (config) | Single-provider build: sandbox is the only backend, so selection/denial lists are meaningless. Unlike the rows above, these warn-and-ignore (old files keep running) instead of failing closed. | Delete the keys. |

Retired config keys fail closed in `validateConfig` (and in `planAccountLaunch`
before resolve — covering nested `pi.hostConfig` lists and the machine layer
`~/.pi-pod/config.json`, whose only ever-read keys are the template pin,
`secretResolver`, and `pi.chords`/`pi.sessionNaming`/`pi.podExtensions`) because silently ignoring a
custom script path would read the wrong file. Server-resident bundles carrying
retired keys (old templates) are stripped with a warning on pull and
launch-preview — `push` clears them; `diff` strips silently by design (it is
report-only). These warnings fire against old servers or un-migrated bundles:
a new server already strips retired keys and flattens legacy Pi settings on
read. Reads stay lenient, writes fail closed, and the server's own 400
remains as backstop.

## Stripped from outgoing bundles (never sent)

One deep boundary, `stripNonBundleKeys` (`toOutgoingBundleConfig` for raw files),
drops everything a bundle payload must not contain: the rejected keys
(`template` — the local pin, a template id travels instead; `reuse`;
`envFile`/`initScript`/`bakeScript`; `pi.hostConfig.skills`/`extensions`) plus
client-only metadata (`$schema`, `secretResolver`, `pi.chords`/`pi.sessionNaming`/`pi.podExtensions`).
Covered paths: project/user/org-dir compilation, the launch bootstrap preview,
`templates create/edit --config`, and `settings user|org|template edit|set` — the settings
verbs validate the edited config locally first (types and retired keys fail
before any write request) and throw on non-bundle keys with the fix, so an
explicit `set reuse true` fails visibly rather than vanishing.

## Retained: `config.json`

- `image` — custom images; unset tracks the launcher (`defaultImage`).
- `resources.{cpu,memoryGB,diskGB}` — sizing feeds the derived image ref and the server request.
- `egress.{mode,builtins,allow}` — network policy. `builtins` covers only what a committed file cannot state (git remote, env-file base URLs); `allow` admits the rest under `allowlist`.
- `name` — project identity for pod naming and list scoping; null derives from the directory.
- `template` — client-only pin selecting the template layer; never travels.
- `workdir` — not fixed. The server echoes it (`ResolveReport.workdir`, `resolvedConfig.workdir`), `receive` gates paths against it, and custom images may need a non-`/workspace` root.
- `initTimeoutSeconds` — server-side init budget (request semantics, not layout).
- `initOnFailure` — server-side init failure policy (`abort`/`prompt`/`continue`).
- `labels` — server-side pod labels (provisioning).
- `idleTimeoutMinutes` / `archiveAfterMinutes` — server idle/archive policy, surfaced in status/retention.
- `pi.model` / `pi.thinking` — defaults; per-launch `--model`/`--thinking`/`--extension`/`--skill`/`--prompt-template` travel as `piOverrides` (pod-local absolute paths, appended to the configured `pi.args`).
- `pi.command` / `pi.args` — how the pod starts pi (`buildPiArgv`); niche wrappers are real uses.
- `pi.hostConfig.{settings,packages}` — live gates. `settings` is enforced
  server-side; `packages` is enforced on both sides (local sanitize/filter plus
  the server install gate).
- `pi.chords` / `pi.sessionNaming` — client-only UI preferences, stripped before anything travels.
- `pi.podExtensions` — client-only: whether a pod's attested Pi extensions run on this machine without asking (`"ask"` or `"run"`). Read only from `~/.pi-pod/config.json`, so no server layer can choose to run code on someone's machine.
- `secretResolver` / `$schema` — client-only op:// resolution config / schema hint; never travel.

## Retained: CLI surface (complete inventory)

Global: `-v/--verbose` (redacted debug logging), `--version`, `-h/--help`, `-y/--yes`
(answers exactly the prompts each command documents), `--` (everything after
belongs to pi verbatim). Launch-only: `--template` (apply a template),
`--on <pod|self>` (co-locate on a machine;
refuses `--dry-run` and forks with a reason), `--reuse` (warm-disk
reuse of this repo+branch's newest stopped pod), `--no-seed` (empty workspace),
`--dry-run` (resolve + print, create nothing). Out-of-scope flags warn and are
ignored, except `--dry-run`/`--on`-with-fork which are usage errors.

- Launch (bare `pipod`, the default): prompt words and `--model`/`--thinking`
  (server `piOverrides`) plus `--tui-mode` (local layout only) after `--`;
  anything else after `--` is rejected with a pointer to `pi.args`.
- `list [pod]` (`ls`): stable short refs; project/template scoping by default.
  `-a/--all` (whole account), `--archived` (state filter, orthogonal to scope),
  `--template` (filter), `-q/--quiet` (ids only, for piping). With a pod arg,
  shows that machine's co-located group.
- `attach [pod]` (`a`): rejoin a session; archived pods offer restore (`-y`
  accepts). After `--`: startup prompt words and `--tui-mode`.
- `stop [pod…]`: immediate stop, disk kept; co-located pods stop with the host.
  It never confirms, so `--yes` warns instead of pretending otherwise.
- `fork <pod>`: new pod from a session fork (`--session` picks the file).
  Accepts the launch template/dry-run flags; `--on` refused, reuse
  never applies (fresh sandbox, workspace not copied — hence the warning).
- `rename <pod> <name>`, `send [pod] <path>` (host→pod, `-y`), `receive [pod]
  <path>` (pod→cwd, workdir-relative or absolute inside it, `-y`).
- `archive [pod…]`: logical archival. `-a/--all`, `--template`, `--idle
  <duration>` (4h/2d/30m) select; `--dry-run` previews; `-y` skips the bulk
  confirm. `restore [pod…]` reverses it (`-a/--all`, `-y`; no filters).
- `gc`: retention report over every pod (always global — it takes no `--all`).
  `--delete` performs the reclaim, `-y` skips its confirm.
- `jobs [action]`: server-run scheduled launches from local job files.
  `list` (default, `-q`), `show`, `runs`, `activate`, `pause`, `resume`, `rm`,
  `push` (promote files; `--org` is a boolean after the action — a login-style
  `--org <alias>` placed before `jobs` is rejected rather than mis-scoped), `pull` (to
  `~/.pi-pod/jobs/` or `--project`'s `.pi-pod/jobs/`), `diff` (exit 1 on drift).
  `-y` skips confirms / overwrites on pull.
- `credentials [action]`: account model-provider sign-ins (tokens stay server-side).
  `list` (default), `connect [<provider>]` (bare = every connectable provider;
  `--api-key` for key entry, `--from-pi` to import the local pi key),
  `reconnect`, `test`, `remove|rm [--yes]`.
- `secrets [action]`: four layers (org, user, template, project-file wins).
  `list` (default: winner + shadows per name), `set <scope> <NAME>[=value]`
  (hidden prompt/stdin without `=`), `rm|remove|unset`, `sync <scope>` (server
  scopes only; `--file`, `--prune`, `--dry-run`). `template/<name>` addressing;
  provider credentials refused in template scope.
- `templates [action]`: personal by default, `--org`/`share` for org-wide.
  `list`, `show`, `create <name>` (`--config <file>` for an explicit config,
  `--from-here` to compile the project — mutually exclusive; `--init-script` /
  `--bake-script` to layer contents; `--description`; `--with-secrets` requires
  `--from-here`), `edit` (`--name/--description/--config/--init-script/--bake-script`;
  `--org` rejected — org-wide goes through `share`; whole-snapshot replace goes through `push`), `share` (one-way),
  `rm|delete [-y]`. A global `--yes` is honored (no false scope warning).
- `push [template [<name>]|user|org|policy]`: whole-bundle replace from the
  layer's local source (project `.pi-pod/`+`.pi/`, user `~/.pi-pod`+`~/.pi/agent`,
  org `~/.pi-pod/org/` or `--dir`, policy `policy.json` in that org directory),
  after a diff preview. The policy is config only and validated by the server.
  `--with-secrets` uploads env values (else a prompt per bundle); `-y` applies
  without confirming.
- `pull [layer]`: reverse of push (same sources; `--dir` for org and policy; `-y`).
  Client-only keys, host-coupled settings, and model credential values survive;
  server scripts with no local file warn instead of writing.
- `diff [layer]`: same sources, secrets by name only; exit 1 on drift (`--dir`
  for org and policy; no `-y` — it never writes).
- `settings [user|org|policy|template [<name>]] [show|edit|set <key> <json-value>|unset <key>]`:
  config-only compare-and-swap edits of the layers `push` replaces whole
  (scripts/Pi files untouched — that is `push`). `show` prints JSON; `edit` uses
  `$VISUAL`/`$EDITOR`; `set` takes a dotted key plus a JSON value. `template`
  without a name is the project's pin. The policy is checked by the server only.
- `login`: Zitadel PKCE in the browser; where none can open (SSH, headless), the
  device flow with a code finished on another device. `--server`, `--issuer`
  (self-hosted), `--org` (domain pin), `--device` (force the code), `--token`
  (dev/CI JWT). `logout` revokes and deletes
  auth; `whoami` reports server/user/org/permissions (exit 1 signed out);
  `account` / `org-admin` open the consoles.
- `doctor`: per-layer diagnosis (auth, server, org, secrets, resolve) plus the
  workspace-seed prediction. `--template` plans the checked launch.
  Works signed out; exit non-zero on failure.
- `init`: scaffolds `.pi-pod/` (`config.json` with no asserted defaults,
  `env.example`, owner-only `env`, executable `init.sh`; no `bake.sh` until
  needed). `--force` overwrites scaffold files (never `env`). Warns when
  shadowing an enclosing project.
- `update`: self-upgrade (registry or git checkout + rebuild); `--dry-run`
  reports only.

## Standardized without a flag day

Local validation deliberately does not claim to pre-validate everything the
server enforces: long-retired keys (`repo`, `autoDelete`, `orphanTtlMinutes`,
`pi.version`, detach sequences, …) warn as ordinary unknown keys and still run
(pinned by tests) — the server bundle contract is authoritative for anything
beyond the simplification-retired set above, and its 400 names any key it will
not store.

- Bundle bodies still carry script *contents* and flat Pi files; only config
  path pointers were removed. Conventional paths are fixed:
  `.pi-pod/env`, `.pi-pod/init.sh`, `.pi-pod/bake.sh` (scaffold, secrets,
  compile, pull, and launch-preview all share the `PROJECT_*` constants; the
  org layer already did).
- `TemplateBody.piSettings` accepts only the flat file map on writes; reads
  still accept legacy `{user,project}` via `flatPiSettings` for old servers and
  un-migrated rows (a new server flattens stored legacy rows on read; they
  normalize on next write).
