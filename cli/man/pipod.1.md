# pipod(1) -- run pi coding-agent sessions in server-managed pods

## SYNOPSIS

```
Usage:
  pipod [options]                   launch a pod for this project and start pi
  pipod [options] -- <pi args…>     launch and pass arguments to pi: prompt words,
                                    --model <id>, --thinking <level>, --tui-mode <mode>,
                                    -e/--extension <path>, --skill <path>,
                                    --prompt-template <path> (each repeatable)
  pipod <command> [options]         run a command
  pipod help [command|topic]        print the full manual entry

Sign in first with `pipod login`. A pod-scoped PI_POD_SERVER_TOKEN also counts as
signed in. While signed out, only login, whoami, init, doctor, update, help, and
version are available.

Pod commands:
  list [pod]             List pods; `list <pod>` shows one machine's group (ls)
  attach [pod]           Reconnect to a pod session (a)
  stop [pod…]            Stop pods now (files kept; attach restarts them)
  fork <pod>             Launch a new pod forked from a pod's session
  rename <pod> <name>    Rename a pod
  send [pod] <path>      Copy host files into a pod
  receive [pod] <path>   Copy pod files into the current directory
  archive [pod…]         Hide pods from the list (files kept; restore brings them back)
  restore [pod…]         Bring archived pods back
  gc                     Report retention state; --delete removes reclaimable pods

Account commands:
  login                  Sign in to a pi pod server via Zitadel
  logout                 Revoke this session and delete the stored credentials
  whoami                 Show the signed-in account
  account                Open the Zitadel self-service console
  org-admin              Open the Zitadel Console for this organization
  billing                Open Stripe Checkout or the billing portal (authenticated)
  credentials            Connect account model-provider sign-ins

Configuration commands:
  init                   Scaffold .pi-pod/ config, env, env.example, and init.sh
  templates              Manage account templates
  push                   Upload a local config layer to its server bundle
  pull                   Write a server bundle into its local config layer
  diff                   Show local vs server drift for a config layer
  secrets                Manage server and project secret scopes
  settings               Show or edit one server settings config directly
  jobs                   Manage server-scheduled jobs

Maintenance commands:
  doctor                 Check auth, server, org, and launch-resolution layers
  update                 Upgrade pi pod itself

Launch options:
  --template <name|id>   Launch from an account template
  --on <pod|self>        Co-locate the new pod on an existing pod's machine
  --reuse                Restart this project's newest stopped pod instead of creating one
  --no-seed              Start the pod with an empty workspace (skip workspace seeding)
  --dry-run              Resolve and print the launch plan; create nothing

General options:
  -y, --yes              Skip supported confirmations
  -v, --verbose          Debug logging (secrets redacted)
  --version              Print CLI, Node, and bundled Pi versions
  -h, --help             Show help

Topics (pipod help <topic>):
  setup                  First-time setup, in order, and who does each step
  layers                 How org, user, and template settings combine
  launch                 What a launch does: templates, workspace seeding, Pi resources
  config                 Every config.json key (man pipod-config)
  files                  Every file pipod reads or writes
  environment            Environment variables

`pipod <command> --help` is a command's usage; `pipod help <command>` is its full
manual entry; `man pipod` is the whole manual.
```

## DESCRIPTION

pi pod runs pi sessions in pods: sandboxes on a pi pod server, which you attach to from a
terminal or the phone apps and leave running when you detach. You use one server, as a
member of one organization on it.

What a pod starts with is decided on the server, from settings layers: the organization's
defaults, your own defaults, and a template, which is the environment for one project. Each
layer holds pod config (pipod-config(5)), an init script that runs in every pod at launch, a
bake script that is built into the pod image once, and Pi files. Secrets are stored apart from
the layers and reach pods as environment variables. `pipod help layers` explains how they
combine.

Every server layer has a local source of truth: a directory you edit with any editor, then
upload with `pipod push`. `pipod pull` writes the server's copy back, and `pipod diff`
compares the two.

## SETUP

Setting pi pod up for yourself or an organization, in order. A person has to do the steps
marked (person): each needs a browser, a hidden prompt, or a decision about access or money.
An agent can do the rest with the commands shown, but should show the person every change
before applying it.

### 1. A server and an account (person)

On your own server, the host's owner installs it (docs/self-host.md in the pipod repository)
and creates accounts with `selfhost/add-user <email>` on the host, adding `--owner` for
someone who may change organization settings. On a server someone else runs, ask its owner
for an account.

### 2. Install the CLI and sign in (person)

```
npm install -g @pipod/cli        # Node 22.19 or later
pipod login --server <url>
pipod doctor
```

`login` opens a browser, or prints a code to confirm on another device. `doctor` checks the
sign-in, the server, your organization and roles, and what a launch here would resolve.

### 3. Model providers (person)

`pipod credentials connect` connects every provider your local pi is signed in to;
`pipod credentials connect <provider>` signs in to one. The sign-ins belong to your account
and apply to every pod you launch.

### 4. Organization defaults

Only with the org:manage permission (`pipod whoami` lists yours); otherwise skip to step 5.
These reach every member's next pod: pod size, network policy, a default model, tools baked
into the image, shared setup. Change one key with `pipod settings org set <key> <value>`, or
the whole layer from its local source:

```
pipod pull org                   # writes ~/.pi-pod/org/
                                 # edit config.json, init.sh, bake.sh, pi/
pipod diff org
pipod push org
```

Values for secrets the whole organization shares: `pipod secrets set org <NAME>` (person).
Organization policy (limits rather than defaults) is set in the web dashboard,
`<server>/dashboard/`.

### 5. Your own defaults

Your model and thinking level, your Pi settings, personal setup such as a git identity:

```
pipod settings user set pi.model <provider>/<model>
pipod settings user set pi.thinking high
```

or the whole layer: `pipod pull user`, edit ~/.pi-pod/config.json and ~/.pi/agent/, then
`pipod diff user` and `pipod push user`.

### 6. A template for each project

In the project's directory:

```
pipod init                       # writes .pi-pod/
                                 # edit .pi-pod/config.json, init.sh, and bake.sh
pipod --dry-run                  # what a launch would resolve; creates nothing
pipod                            # the first launch offers to create the template and pin it
```

Without a launch, `pipod templates create <name> --from-here` creates it; then pin it by
adding `"template": "<name>"` to .pi-pod/config.json. Afterwards the project stays its
source: edit the files, `pipod diff`, `pipod push`. Its secret values:
`pipod secrets set template/<name> <NAME>` (person), or `.pi-pod/env` on this machine. To
tell its pods' agents what access the template is meant to have:
`pipod templates edit <name> --agent-instructions <file>`.

### Rules for an agent

- Never put a secret value on a command line or in a chat; transcripts are stored. Name the
  secret and let the person type it into `pipod secrets set`.
- Run `pipod diff <layer>` before `pipod push <layer>`: a push replaces the whole layer.
  With no terminal, push declines instead of asking, so show the person the diff, then run
  `pipod push <layer> --yes`.
- Organization changes reach every member's next pod, and `pipod templates share` cannot be
  undone: confirm both with the person first.
- Iterate with `pipod doctor` and `pipod --dry-run`; both create nothing.

## LAYERS

Each launch is resolved on the server from these layers, lowest first:

```
built-in defaults
organization defaults
org-wide template          (when the launch uses one)
your user layer
personal template          (when the launch uses one)
organization policy        (limits, applied last)
```

The template is the one the launch names: `--template`, or the `template` pinned in the
project's .pi-pod/config.json. Within the layers:

- config merges key by key, and the later layer wins; an array replaces the one below it.
- init scripts all run, in layer order, and so do bake scripts.
- Pi files merge the same way, file by file, except that settings.json package lists add
  up. They hold no credentials: models.json and mcporter.json name a secret as `$NAME`,
  and the server refuses a literal key.

Organization policy holds limits rather than defaults: maximum idle and archive times,
allowed providers, a required template, network rules, concurrency. It clamps the merged
result, and `pipod doctor` and `pipod --dry-run` report every clamp. It is set in the web
dashboard by someone with the policy:write permission.

Where each layer's source lives, and the commands that change it:

```
org        ~/.pi-pod/org/: config.json, init.sh, bake.sh, pi/, env
           pipod pull|diff|push org; pipod settings org set      (org:manage)
user       ~/.pi-pod/config.json and ~/.pi/agent/
           pipod pull|diff|push user; pipod settings user set
template   a project: .pi-pod/config.json, init.sh, bake.sh, env, and .pi/
           pipod pull|diff|push [template [<name>]]; pipod templates
```

What belongs where: the organization layer holds what everyone needs (pod size, network
policy, shared tools); your user layer holds your preferences (model, Pi settings, git
identity); a template holds one project's environment (cloning and installing it, the hosts
it needs, its secrets). A project's own files reach pods only through its template, after
`pipod push`. The web dashboard, `<server>/dashboard/`, edits the same layers.

Secrets have their own order, lowest first: org, user, template, then the project's
.pi-pod/env on the machine you launch from. `pipod secrets list` shows which layer each
name comes from.

## LAUNCH

`pipod` with no command launches a pod for the current directory and attaches to it.
`pipod --dry-run` resolves the same launch and prints it without creating anything.

The launch uses the template named by `--template`, or else the one pinned in the project's
.pi-pod/config.json. In a project with a .pi-pod/config.json and no pinned template, the
first launch offers to create a template from the project and pin it.

Workspace seeding: launching from a directory with no .pi-pod/config.json seeds the new pod
from that directory (its git repository root when inside one). A clean, pushed checkout whose
remote tip matches HEAD is cloned at that exact commit; anything else (dirty trees, unpushed
commits, private remotes without usable credentials, plain directories) is streamed in as a
tar archive, without git-ignored paths, node_modules, or .pi-pod/env. Private-remote
credentials are forwarded only after a prompt (`--yes` approves it) and are never stored.
`--dry-run` prints the decision without prompting or creating a pod. Forks, reused pods,
`--on` co-location, and `--no-seed` never seed. A project with a .pi-pod/config.json gets its
workspace from its init scripts instead.

Arguments after `--` go to pi: prompt words start the session, and `--model`, `--thinking`,
and `--tui-mode` apply to this launch. Per-launch Pi resources (`--extension`, `--skill`,
`--prompt-template`) name files or directories inside the pod as absolute paths and add to
the pod's configured Pi resources for that launch; anything else Pi-related belongs in the
`pi.args` config.

`--reuse` restarts this project's newest stopped pod instead of creating one. `--on <pod>`
starts the new pod on an existing pod's machine, sharing its files; `--on self` does that
from inside a pod.

Inside a pod, signed in with the pod's own token, every launch (`--on self` included) and
every job it schedules uses the template that pod launched from; the server refuses any other.

## COMMANDS

### pipod login

```
Usage: pipod login [--server <url>] [--issuer <url>] [--org <alias>] [--device] [--token <jwt>]

Sign this machine in to a pi pod server via Zitadel (authorization code + PKCE,
in your browser). Where no browser can open here (over SSH, on a headless
server), it prints a page and a code to confirm on any other device instead.
The session is stored in ~/.pi-pod/auth.json.

Options:
  --server <url>   Server to sign in to (default: the previous session's server,
                   $PI_POD_ACCOUNT_URL, or the production server)
  --issuer <url>   OIDC issuer (default: $PI_POD_ISSUER, else the one the
                   server publishes); needed only for a server too old to
                   publish its own
  --org <alias>    Only sign in to the organization with this primary domain;
                   omit it to sign in to your own organization
  --device         Sign in with a code on another device even if a browser
                   could open here
  --token <jwt>    Use an existing access token instead of the browser flow (dev/CI)
```

A person finishes the sign-in, in a browser or with the printed code; an agent can start
`pipod login` and wait for it. Signing in works before you belong to an organization, but
then nothing is permitted and `login` says access is pending organization membership: the
server's owner adds you (`selfhost/add-user` on a self-hosted host), or an organization owner
grants you a role in the Zitadel Console (`pipod org-admin`).

### pipod logout

```
Usage: pipod logout

Revoke the current account session and delete ~/.pi-pod/auth.json. Pod
operations are unavailable until the next `pipod login`.
```

### pipod whoami

```
Usage: pipod whoami

Show the signed-in server, user, permissions, active organization, and console
links. Exits 1 when signed out.
```

### pipod account

```
Usage: pipod account

Open the Zitadel self-service console in your browser to manage profile,
password, MFA, and active sessions.
```

### pipod org-admin

```
Usage: pipod org-admin

Open the Zitadel Console in your browser. Organization owners manage members
and role grants there.
```

### pipod billing

```
Usage: pipod billing checkout [--plan standard|pro] [--trial]
       pipod billing portal
       pipod billing change --plan standard|pro [--yes]
       pipod billing change preview --plan standard|pro
       pipod billing change confirm --quote <quoteId> [--yes]

Authenticated Stripe Checkout and billing portal. Checkout sends trial:false
(paid) unless --trial. Closed public trial refuses --trial with 402. Change
previews a Standard<->Pro plan change and confirms it only after an explicit
yes; stale quotes are never auto-confirmed. Return
pages do not grant a plan.
```

Billing exists only on the hosted service; a self-hosted server has none. Paying, and
changing plans, are a person's decisions: an agent may run `preview`, never `confirm`.

### pipod credentials

```
Usage: pipod credentials [action]

Manage account-scoped model-provider sign-ins. Connected credentials apply to
every pod you launch; OAuth refresh tokens stay in server custody and never
reach pods or this machine.

Actions:
  list                       Saved credentials and connectable providers (default)
  connect                    Connect every provider your local pi is signed in to:
                             API keys are imported, everything else is a fresh
                             account login; ready credentials are left alone
  connect <provider>         Sign in to a provider (OAuth by default)
  reconnect <provider>       Redo the sign-in for a saved credential
  test <provider>            Verify a saved credential against the provider
  remove <provider> [--yes]  Delete a saved credential (alias: rm)

connect options:
  --api-key            Enter an API key instead of the OAuth flow
  --api-key --from-pi  Import the API key your local pi resolves for that
                       provider (auth.json or env) instead of typing it.
                       OAuth grants are never imported.
```

`connect` and `reconnect` need a person, for the browser sign-in or the hidden key prompt;
`list` and `test` do not. A model-provider key is a credential here, not a secret: a template
refuses one.

### pipod init

```
Usage: pipod init [--force]

Scaffold project configuration under .pi-pod/ in the current directory:
config.json, env.example, env (mode 600), and init.sh.

Options:
  --force                Overwrite scaffold files that already exist
```

The files are the local source of the project's template. config.json starts with every
setting commented out: uncomment only what this project must decide for itself
(pipod-config(5)). init.sh runs in each new pod, in an empty workspace, so it usually clones
the repository and installs dependencies. Add .pi-pod/bake.sh for setup that belongs in the
image. env holds the project's secret values and is added to .gitignore; env.example lists
their names and is committed.

### pipod templates

```
Usage: pipod templates [action]

Manage pod templates on the pi pod server. A template stores config, init and
bake scripts, Pi settings files, named secrets, and agent instructions.
Templates are personal by default: only their owner sees and launches them.
--org at creation or `templates share` makes one org-wide.

Agent instructions are added to the agent's system prompt in every pod launched
from the template, with the hosts and secrets the pod actually has: say what
access the template is meant to have. They guide the agent and enforce nothing;
the template's secrets and egress decide what a pod can reach. A pod's child
pods and the jobs it schedules launch from the pod's own template.

Actions:
  list             List templates with scope and key counts (default)
  show <name|id>   Show config, scripts, agent instructions, Pi settings, and
                   secret names
  create <name>    Create a template
  edit <name|id>   Update a template's name, description, config, scripts, or
                   agent instructions
  share <name|id>  Make a personal template org-wide (cannot be undone)
  rm <name|id>     Delete a template (alias: delete)

create/edit options:
  --name <name>         New name (edit only)
  --description <text>  Set the description
  --config <file>       Store this config file (same shape as .pi-pod/config.json)
  --from-here           create only: store this project's authored config,
                        scripts, and sanitized Pi files (contradicts --config)
  --init-script <file>  Store this init script
  --bake-script <file>  Store this bake script
  --agent-instructions <file>
                        Store this file as the agent instructions (an empty
                        file removes them); `pipod push` leaves them alone
  --org                 create only: make the template org-wide from the start
  --with-secrets        With --from-here: also upload project env values as
                        template secrets
  -y, --yes             Skip confirmations (rm)
```

A template is one project's environment. Keep a project as its source: accept the first
launch's offer, which creates the template and pins it in .pi-pod/config.json, or run
`create --from-here` and add `"template": "<name>"` to that file yourself. Then change it
with `pipod diff` and `pipod push` from the project.
A personal template sits above your user layer and an org-wide one below it
(`pipod help layers`); making one org-wide needs the org:manage permission.

### pipod push

```
Usage: pipod push [template [<name>] | user | org] [--dir <path>]
                  [--with-secrets] [--yes]

Replace a server config bundle with its local source, whole. The layer names
both sides; edit the local files with any editor, then push. A diff preview
precedes the confirmation.

Layers and their local source:
  template [<name>]  This project: .pi-pod/config.json, its init and bake
                     scripts, Pi files under .pi/, and the project env file
                     (secrets, with --with-secrets or a prompt). Without
                     <name> the project's pinned template is used.
  user               ~/.pi-pod/config.json and ~/.pi/agent/ (settings.json,
                     models.json, mcporter.json, subagents.json, agents/)
  org                ~/.pi-pod/org/: config.json, init.sh, bake.sh, pi/…, and
                     an optional env file whose values become org secrets

Inside a project the layer defaults to template; elsewhere it is required.
Provider credentials, hooks, mcpServers, and model credential values never
leave this machine.

Options:
  --dir <path>     org only: read the org source from <path> instead
  --with-secrets   Also upload the layer's env values as secrets
  -y, --yes        Apply the replacement without the confirmation prompt
```

Whatever the local source lacks is removed from the server layer, so start from
`pipod pull` when the server may have changes this machine does not. With no terminal to
confirm on, push declines unless `--yes` is given.

### pipod pull

```
Usage: pipod pull [template [<name>] | user | org] [--dir <path>] [--yes]

Write a server config bundle into its local source files (see
`pipod push --help` for the layer → directory table). A diff preview
precedes the confirmation; nothing is written when the two already match.

What pull keeps from the local files:
  config.json    client-only keys: $schema, template, secretResolver,
                 pi.chords, pi.sessionNaming
  settings.json  hooks and mcpServers (and packages when hostConfig.packages
                 is off)
  models.json    credential values the push had dropped
  agents/        files the bundle no longer contains are removed

Secrets stay on the server; their names are listed. The user layer has no
local script files, so user bundle scripts are shown but not written.

Options:
  --dir <path>   org only: write the org source to <path> instead
  -y, --yes      Apply the local changes without the confirmation prompt
```

### pipod diff

```
Usage: pipod diff [template [<name>] | user | org] [--dir <path>]

Compare a config layer's local source with its server bundle (see
`pipod push --help` for the layer → directory table). Secrets compare by
name only. Exits 1 when they differ, 0 when they match.

Options:
  --dir <path>   org only: read the org source from <path> instead
```

### pipod secrets

```
Usage: pipod secrets [action]

Manage the secret layers pods see. Requires account or pod-token auth. Server
scopes are org, user, and template/<name>; project is this project's dotenv
file, the highest-precedence layer for launches from the project.

Actions:
  list                          Every secret a pod launched here would see,
                                which layer wins, and who set it (default)
  set <scope> <NAME>            Store a secret, its value read from a hidden
                                prompt or stdin (never the command line)
  rm <scope> <NAME>             Remove a secret (aliases: remove, unset)
  sync <scope>                  Upload a dotenv file to a server scope

sync options (scope must be org, user, or template/<name>):
  --file <path>   Dotenv file to upload (default: ~/.pi-pod/secrets/<scope>.env)
  --prune         Also delete server secrets that are not in the file
  --dry-run       Show what would change without writing

Values may be op:// references; they resolve just-in-time (at upload for
server scopes, at launch for the project file) and the references themselves
are never stored on the server.
```

Precedence, lowest first: org, user, template, project. A pod receives its secrets as
environment variables, and anything running in it can read them all. Stored values cannot be
read back, only replaced.

Keep values out of command lines and chats: a person types them at `set`'s hidden prompt,
or `sync` reads a dotenv file kept at mode 600. op:// references resolve through the
1Password CLI (`op`) on this machine. Model-provider keys belong in `pipod credentials`.

### pipod settings

```
Usage: pipod settings <user|org> [show | edit | set <key> <value> | unset <key>]

Show or edit a persistent settings bundle on the server: your own user bundle,
or the org-wide defaults (org scope needs the org:manage permission). Edits
change only the config; scripts and Pi files stay as they are — replace the
whole bundle from local files with `pipod push user` or `pipod push org`.
Edits use compare-and-swap on the bundle version, so concurrent changes fail
cleanly instead of overwriting each other.

Actions:
  show                    Print the settings bundle as JSON (default)
  edit                    Edit the config in $VISUAL/$EDITOR, then save
  set <key> <value>       Set one dotted key to a JSON value, or to the text as
                          a string: pipod settings user set pi.model provider/model
  unset <key>             Remove one dotted key, so the layers below decide it
```

Keys are those of pipod-config(5). `set` changes the server only: a later `pipod push` of the
same layer replaces it with the local source, so after a `set`, run `pipod pull` before
editing that source.

### pipod jobs

```
Usage: pipod jobs [action] [args] [--quiet] [--yes] [--project] [--org]

Manage scheduled jobs the pi pod server runs for you: at each trigger it
launches a pod from the job's template and sends the job's prompt. Local job
files in .pi-pod/jobs/ (project) or ~/.pi-pod/jobs/ (user) are the reviewable
source; `jobs push` promotes them to the server. <job> is an id, short ref
(j-…), or name.

Actions:
  list                 List server jobs (default)
  show <job>           Show a job's schedule, template, model, and prompt
  runs <job>           List a job's recent runs
  run <job>            Run an active job once, now; its schedule is unchanged
  activate <job>       Activate a job
  pause <job>          Pause a job's schedule
  resume <job>         Resume a paused job
  rm <job>             Remove a job; its schedule stops firing
  push [job…]          Create or update server jobs from local job files
  pull <job>           Write a server job to a local job file
  diff [job…]          Show local vs server drift; exits 1 when drifted

Options:
  --org        push: create org-scoped jobs or promote matching user jobs
               (promotion is one-way)
  --project    pull: write into this project's .pi-pod/jobs/ instead of
               ~/.pi-pod/jobs/
  -q, --quiet  list: print job ids only, one per line
  -y, --yes    Skip confirmations; pull: overwrite an existing local file
```

A job file is `<name>.json` (comments allowed), and its file name is the job's name:

```
{
  "description": "Triage new issues every morning",
  "trigger": { "type": "cron", "cron": "0 6 * * *" },
  "template": "my-service",
  "model": "anthropic/claude-opus-4-7",
  "prompt": "Review yesterday's new issues and post a triage summary."
}
```

`trigger` is a cron expression, evaluated in UTC, or `{ "type": "at", "times": [...] }` with
up to 100 ISO 8601 timestamps that each name their timezone. Runs must be at least 5
minutes apart, since each run is a pod. `model` (provider/model-id) is required.
`promptFile` names a file beside the job file instead of `prompt`; prompts are at most 64 KiB
and must say everything the run needs, since it starts in a fresh pod. A job runs on its own
until paused, so agree its schedule with the person before `pipod jobs push`.

### pipod list

```
Usage: pipod list [pod] [--all] [--archived] [--template <name|id>] [--quiet]

Alias: ls

List pods on the signed-in server with stable short refs (p-…). The project is
the directory's git repository (or the directory, or its .pi-pod/ config): a
listing shows that project's pods when it has any — its pinned template's when
it pins one — and every pod otherwise. Co-located pods are grouped under the pod
whose machine they share, with an ON column naming it.
With a pod argument, show just that machine's group: the pod and everything
co-located on it.

Status says where a pod's files are: a stopped pod keeps them on disk and restarts on
attach; an archived workspace is restored on next use, which takes longer the bigger it is.
Pods you archive stay hidden unless --archived is passed.

Options:
  -a, --all              Every pod; ignore the current project and its template pin
  --archived             Include logically archived pods
  --template <name|id>   Only pods launched from that template (whole account)
  -q, --quiet            Print pod ids only, one per line
```

### pipod attach

```
Usage: pipod attach [pod] [--yes] [-- <prompt…> [--tui-mode <mode>]]

Alias: a

Reconnect to a pod session through the server gateway. Name the pod by id,
short ref (p-…), or name; omit it when this project has exactly one pod.
Quitting detaches: the pod keeps running until the server's idle policy reaps
it or `pipod stop` stops it. Raw pod shells are not available.
Attaching to an archived pod offers to restore it first.

After --:
  <prompt…>              Words are sent to the session as a startup prompt
  --tui-mode <mode>      Local TUI layout for this attach: regular or fullscreen

Options:
  -y, --yes              Restore an archived pod without asking
```

### pipod stop

```
Usage: pipod stop [pod…]

Stop pods now by id, short ref (p-…), or name; omit the argument when this
project has exactly one pod. Stopped pods keep their files and `pipod attach`
restarts them. Stopping a pod that hosts co-located pods stops those too.
```

### pipod fork

```
Usage: pipod fork <pod> [--session <path>] [launch options] [-- <pi args…>]

Launch a new pod whose session starts as a fork of <pod>'s current session.
<pod> is an id, short ref (p-…), or name. The workspace is not copied —
commit and push first if the new pod needs those changes. --on is not
supported: a fork launches a new sandbox, not a co-located pod.

Options:
  --session <path>       Fork a specific session file instead of the newest
  --template <name|id>   Launch the new pod from an account template
  --dry-run              Resolve and print the launch plan; create nothing
  -y, --yes              Skip supported confirmations
```

### pipod rename

```
Usage: pipod rename <pod> <name>

Rename a server-managed pod. <pod> is an id, short ref (p-…), or the current
name.
```

### pipod send

```
Usage: pipod send [pod] <path> [--yes]

Copy a host file or directory into a pod through the server. Omit the pod when
this project has exactly one. Sending to an archived pod offers to restore it
first.

Options:
  -y, --yes   Restore an archived pod without asking
```

### pipod receive

```
Usage: pipod receive [pod] <path> [--yes]

Copy a file or directory from a pod into the current local directory. <path>
may be a workdir-relative path or an absolute path inside that workdir, such
as foo or /workspace/foo. The destination must not already exist. Omit the
pod when this project has exactly one. Receiving from an archived pod offers
to restore it first.

Options:
  -y, --yes   Restore an archived pod without asking
```

### pipod archive

```
Usage: pipod archive [pod…] [--all] [--template <name|id>] [--idle <duration>] [--dry-run] [--yes]

Archive pods by id, short ref (p-…), or name. Archiving hides pods from
`pipod list` (`pipod list --archived` shows them); it never deletes work, and
`pipod restore` brings them back. Archiving a pod that hosts co-located pods
archives those too.

Options:
  -a, --all              Archive every pod (cannot be combined with pod refs)
  --template <name|id>   Only pods launched from that template (whole account)
  --idle <duration>      Only pods whose last activity is older than this (4h, 2d, 30m)
  --dry-run              Print the matching pods; archive nothing
  -y, --yes              Skip the bulk confirmation
```

### pipod restore

```
Usage: pipod restore [pod…] [--all] [--yes]

Bring archived pods back by id, short ref (p-…), or name. Restoring a host
restores the co-located pods archived with it. `pipod attach` then starts the
pod; a workspace in cold storage takes longer the bigger it is.

Options:
  -a, --all   Restore every archived pod (cannot be combined with pod refs)
  -y, --yes   Skip the --all confirmation
```

### pipod gc

```
Usage: pipod gc [--delete] [--yes]

List the archived and failed pods that can be deleted for good; --delete deletes
them. (The server stops idle pods and moves stopped workspaces to cold storage on
its own schedule; that never deletes anything.)

Options:
  --delete    Permanently delete the reclaimable pods
  -y, --yes   Delete without a confirmation prompt
```

### pipod doctor

```
Usage: pipod doctor [--template <name|id>]

Check each layer a launch depends on: account auth, server reachability and
version, organization membership and roles, secret references, and the
server-resolved settings bundle chain for this directory. Works while signed
out to diagnose auth problems. Exits non-zero when a layer fails.

Options:
  --template <name|id>   Plan the checked launch with this template
```

### pipod update

```
Usage: pipod update [--dry-run]

Upgrade pi pod itself: a registry install updates to the latest published
version; a git checkout pulls its upstream and rebuilds.

Options:
  --dry-run   Report what an update would do without changing anything
```

## FILES

```
~/.pi-pod/auth.json          this machine's sign-in (pipod login)
~/.pi-pod/config.json        this machine's preferences, and the config of your
                             user layer (pipod-config(5))
~/.pi/agent/                 your Pi files, the rest of your user layer:
                             settings.json, models.json, mcporter.json,
                             subagents.json, agents/
~/.pi-pod/org/               the organization layer's source: config.json,
                             init.sh, bake.sh, pi/, env
~/.pi-pod/secrets/           dotenv files for pipod secrets sync
~/.pi-pod/jobs/              your job files
.pi-pod/config.json          a project's config and its template pin
.pi-pod/init.sh              runs in each of the project's new pods
.pi-pod/bake.sh              built into the project's pod image
.pi-pod/env                  the project's secret values; never committed
.pi-pod/env.example          the names of the project's secrets; committed
.pi-pod/jobs/                the project's job files
.pi/                         the project's Pi files, as in ~/.pi/agent/
```

## ENVIRONMENT

```
PI_POD_ACCOUNT_URL     the server pipod login uses with no --server and no
                       previous session
PI_POD_ISSUER          the OIDC issuer pipod login uses, for a server too old
                       to publish its own
PI_POD_SERVER_URL      set in every pod: pipod there signs in with the pod's
PI_POD_SERVER_TOKEN    own token, which reaches only the pods it launched and
                       launches only from the pod's own template
VISUAL, EDITOR         the editor for pipod settings edit
NO_COLOR               plain output without color
```

## SEE ALSO

pipod-config(5), https://github.com/pi-pod/pipod, and docs/self-host.md there for running
a server.
