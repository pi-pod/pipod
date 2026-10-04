#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { AccountClient } from "./account/api.js";
import { requireAccountClient } from "./account/client.js";
import { runAccountDoctor } from "./account/doctor.js";
import { runAccountJobs } from "./account/jobs.js";
import { runAccountLaunch } from "./account/launch.js";
import { runBillingCommand } from "./account/billing-cli.js";
import { runLogin, runLogout, runOpenAccount, runOpenOrgAdmin, runWhoami } from "./account/login.js";
import {
  runAccountAttach,
  runAccountFork,
  runAccountGc,
  runAccountList,
  runAccountPodAction,
  runAccountRename,
  runAccountSend,
  runAccountStop,
  type AccountPodFlags,
} from "./account/pods.js";
import { runAccountReceive } from "./account/receive.js";
import { bundledPiVersion } from "./client/piversion.js";
import { runCredentials } from "./commands/credentials.js";
import { runSecrets } from "./commands/secrets.js";
import { runTemplates } from "./commands/templates.js";
import { runDiff } from "./commands/layers.js";
import { runPull } from "./commands/pull.js";
import { runPush } from "./commands/push.js";
import { runSettings } from "./commands/settings.js";
import { findConfigPath } from "./config.js";
import { CancelledError, EXIT, PiPodError, isPiPodError } from "./errors.js";
import { launcherVersion } from "./image.js";
import {
  color,
  error,
  hint as printHint,
  info,
  isVerbose,
  out,
  plain,
  setVerbose,
  warn,
} from "./log.js";
import { printInitResult, scaffold } from "./scaffold.js";
import { runUpdate } from "./update.js";
import { displayPath, ensureUserConfig } from "./userconfig.js";

export const VERSION = launcherVersion();

const SUBCOMMANDS = [
  "init",
  "login",
  "logout",
  "whoami",
  "account",
  "org-admin",
  "gc",
  "doctor",
  "attach",
  "list",
  "stop",
  "rename",
  "fork",
  "send",
  "receive",
  "archive",
  "restore",
  "jobs",
  "credentials",
  "secrets",
  "templates",
  "push",
  "pull",
  "diff",
  "settings",
  "billing",
  "update",
] as const;

type Subcommand = (typeof SUBCOMMANDS)[number];

export const SIGNED_OUT_COMMANDS = new Set<Subcommand>(["login", "whoami", "init", "doctor", "update"]);

const ALIASES: Record<string, Subcommand> = {
  a: "attach",
  ls: "list",
};

const HELP = `pipod ${VERSION} — run pi sessions in server-managed pods

Usage:
  pipod [options]                   launch a pod for this project and start pi
  pipod [options] -- <pi args…>     launch and pass arguments to pi: prompt words,
                                    --model <id>, --thinking <level>, --tui-mode <mode>,
                                    -e/--extension <path>, --skill <path>,
                                    --prompt-template <path> (each repeatable)
  pipod <command> [options]         run a command
  pipod help [command]              show help (same as --help)

Sign in first with \`pipod login\`. A pod-scoped PI_POD_SERVER_TOKEN also counts as
signed in. While signed out, only login, whoami, init, doctor, update, help, and
version are available.

Pod commands:
  list [pod]             List pods; \`list <pod>\` shows one machine's group (ls)
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

Settings resolve on the server: built-in → org → org-template → user → user-template
→ org policy. Each bundle has a local directory as its source of truth (see
\`pipod push --help\`); local project settings apply after \`pipod push\`, and the
first launch in a project offers to bootstrap a template.

Per-launch Pi resources (--extension, --skill, --prompt-template) name files or
directories inside the pod as absolute paths and add to the pod's configured Pi
resources for that launch; anything else Pi-related belongs in the pi.args config.

Workspace seeding: launching from a directory with no .pi-pod/config.json seeds the
new pod from that directory (its git repository root when inside one). A clean,
pushed checkout whose remote tip matches HEAD is cloned at that exact commit;
anything else — dirty trees, unpushed commits, private remotes without usable
credentials, plain directories — is streamed in as a tar archive (git-ignored
paths, node_modules and .pi-pod/env excluded). Private-remote credentials are
forwarded only after a prompt (\`--yes\` approves it) and are never stored.
\`--dry-run\` prints the decision without prompting or creating a pod. Forks,
reused pods, \`--on\` co-location and \`--no-seed\` never seed.

Run \`pipod <command> --help\` for command-specific usage.
`;

const SUBCOMMAND_HELP: Record<Subcommand, string> = {
  login: `Usage: pipod login [--server <url>] [--issuer <url>] [--org <alias>] [--device] [--token <jwt>]

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
`,
  account: `Usage: pipod account

Open the Zitadel self-service console in your browser to manage profile,
password, MFA, and active sessions.
`,
  "org-admin": `Usage: pipod org-admin

Open the Zitadel Console in your browser. Organization owners manage members
and role grants there.
`,
  billing: `Usage: pipod billing checkout [--plan standard|pro] [--trial]
       pipod billing portal
       pipod billing change --plan standard|pro [--yes]
       pipod billing change preview --plan standard|pro
       pipod billing change confirm --quote <quoteId> [--yes]

Authenticated Stripe Checkout and billing portal. Checkout sends trial:false
(paid) unless --trial. Closed public trial refuses --trial with 402. Change
previews a Standard<->Pro plan change and confirms it only after an explicit
yes; stale quotes are never auto-confirmed. Return
pages do not grant a plan. Public npm is not a supported install path; use a
GitHub release tarball or git clone + npm run build.
`,
  logout: `Usage: pipod logout

Revoke the current account session and delete ~/.pi-pod/auth.json. Pod
operations are unavailable until the next \`pipod login\`.
`,
  whoami: `Usage: pipod whoami

Show the signed-in server, user, permissions, active organization, and console
links. Exits 1 when signed out.
`,
  init: `Usage: pipod init [--force]

Scaffold project configuration under .pi-pod/ in the current directory:
config.json, env.example, env (mode 600), and init.sh.

Options:
  --force                Overwrite scaffold files that already exist
`,
  doctor: `Usage: pipod doctor [--template <name|id>]

Check each layer a launch depends on: account auth, server reachability and
version, organization membership and roles, secret references, and the
server-resolved settings bundle chain for this directory. Works while signed
out to diagnose auth problems. Exits non-zero when a layer fails.

Options:
  --template <name|id>   Plan the checked launch with this template
`,
  list: `Usage: pipod list [pod] [--all] [--archived] [--template <name|id>] [--quiet]

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
`,
  attach: `Usage: pipod attach [pod] [--yes] [-- <prompt…> [--tui-mode <mode>]]

Alias: a

Reconnect to a pod session through the server gateway. Name the pod by id,
short ref (p-…), or name; omit it when this project has exactly one pod.
Quitting detaches: the pod keeps running until the server's idle policy reaps
it or \`pipod stop\` stops it. Raw pod shells are not available.
Attaching to an archived pod offers to restore it first.

After --:
  <prompt…>              Words are sent to the session as a startup prompt
  --tui-mode <mode>      Local TUI layout for this attach: regular or fullscreen

Options:
  -y, --yes              Restore an archived pod without asking
`,
  stop: `Usage: pipod stop [pod…]

Stop pods now by id, short ref (p-…), or name; omit the argument when this
project has exactly one pod. Stopped pods keep their files and \`pipod attach\`
restarts them. Stopping a pod that hosts co-located pods stops those too.
`,
  fork: `Usage: pipod fork <pod> [--session <path>] [launch options] [-- <pi args…>]

Launch a new pod whose session starts as a fork of <pod>'s current session.
<pod> is an id, short ref (p-…), or name. The workspace is not copied —
commit and push first if the new pod needs those changes. --on is not
supported: a fork launches a new sandbox, not a co-located pod.

Options:
  --session <path>       Fork a specific session file instead of the newest
  --template <name|id>   Launch the new pod from an account template
  --dry-run              Resolve and print the launch plan; create nothing
  -y, --yes              Skip supported confirmations
`,
  rename: `Usage: pipod rename <pod> <name>

Rename a server-managed pod. <pod> is an id, short ref (p-…), or the current
name.
`,
  send: `Usage: pipod send [pod] <path> [--yes]

Copy a host file or directory into a pod through the server. Omit the pod when
this project has exactly one. Sending to an archived pod offers to restore it
first.

Options:
  -y, --yes   Restore an archived pod without asking
`,
  receive: `Usage: pipod receive [pod] <path> [--yes]

Copy a file or directory from a pod into the current local directory. <path>
may be a workdir-relative path or an absolute path inside that workdir, such
as foo or /workspace/foo. The destination must not already exist. Omit the
pod when this project has exactly one. Receiving from an archived pod offers
to restore it first.

Options:
  -y, --yes   Restore an archived pod without asking
`,
  archive: `Usage: pipod archive [pod…] [--all] [--template <name|id>] [--idle <duration>] [--dry-run] [--yes]

Archive pods by id, short ref (p-…), or name. Archiving hides pods from
\`pipod list\` (\`pipod list --archived\` shows them); it never deletes work, and
\`pipod restore\` brings them back. Archiving a pod that hosts co-located pods
archives those too.

Options:
  -a, --all              Archive every pod (cannot be combined with pod refs)
  --template <name|id>   Only pods launched from that template (whole account)
  --idle <duration>      Only pods whose last activity is older than this (4h, 2d, 30m)
  --dry-run              Print the matching pods; archive nothing
  -y, --yes              Skip the bulk confirmation
`,
  restore: `Usage: pipod restore [pod…] [--all] [--yes]

Bring archived pods back by id, short ref (p-…), or name. Restoring a host
restores the co-located pods archived with it. \`pipod attach\` then starts the
pod; a workspace in cold storage takes longer the bigger it is.

Options:
  -a, --all   Restore every archived pod (cannot be combined with pod refs)
  -y, --yes   Skip the --all confirmation
`,
  gc: `Usage: pipod gc [--delete] [--yes]

List the archived and failed pods that can be deleted for good; --delete deletes
them. (The server stops idle pods and moves stopped workspaces to cold storage on
its own schedule; that never deletes anything.)

Options:
  --delete    Permanently delete the reclaimable pods
  -y, --yes   Delete without a confirmation prompt
`,
  jobs: `Usage: pipod jobs [action] [args] [--quiet] [--yes] [--project] [--org]

Manage scheduled jobs the pi pod server runs for you: at each trigger it
launches a pod from the job's template and sends the job's prompt. Local job
files in .pi-pod/jobs/ (project) or ~/.pi-pod/jobs/ (user) are the reviewable
source; \`jobs push\` promotes them to the server. <job> is an id, short ref
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
`,
  credentials: `Usage: pipod credentials [action]

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
`,
  secrets: `Usage: pipod secrets [action]

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
`,
  templates: `Usage: pipod templates [action]

Manage pod templates on the pi pod server. A template stores config, init and
bake scripts, Pi settings files, named secrets, and agent instructions.
Templates are personal by default: only their owner sees and launches them.
--org at creation or \`templates share\` makes one org-wide.

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
                        file removes them); \`pipod push\` leaves them alone
  --org                 create only: make the template org-wide from the start
  --with-secrets        With --from-here: also upload project env values as
                        template secrets
  -y, --yes             Skip confirmations (rm)
`,
  push: `Usage: pipod push [template [<name>] | user | org] [--dir <path>]
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
`,
  pull: `Usage: pipod pull [template [<name>] | user | org] [--dir <path>] [--yes]

Write a server config bundle into its local source files (see
\`pipod push --help\` for the layer → directory table). A diff preview
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
`,
  diff: `Usage: pipod diff [template [<name>] | user | org] [--dir <path>]

Compare a config layer's local source with its server bundle (see
\`pipod push --help\` for the layer → directory table). Secrets compare by
name only. Exits 1 when they differ, 0 when they match.

Options:
  --dir <path>   org only: read the org source from <path> instead
`,
  settings: `Usage: pipod settings <user|org> [show | edit | set <key> <value> | unset <key>]

Show or edit a persistent settings bundle on the server: your own user bundle,
or the org-wide defaults (org scope needs the org:manage permission). Edits
change only the config; scripts and Pi files stay as they are — replace the
whole bundle from local files with \`pipod push user\` or \`pipod push org\`.
Edits use compare-and-swap on the bundle version, so concurrent changes fail
cleanly instead of overwriting each other.

Actions:
  show                    Print the settings bundle as JSON (default)
  edit                    Edit the config in $VISUAL/$EDITOR, then save
  set <key> <value>       Set one dotted key to a JSON value, or to the text as
                          a string: pipod settings user set pi.model provider/model
  unset <key>             Remove one dotted key, so the layers below decide it
`,
  update: `Usage: pipod update [--dry-run]

Upgrade pi pod itself: a registry install updates to the latest published
version; a git checkout pulls its upstream and rebuilds.

Options:
  --dry-run   Report what an update would do without changing anything
`,
};

export interface GlobalFlags {
  /** `--on <pod|self>`: co-locate the launch on an existing pod's machine. */
  on?: string;
  reuse?: boolean;
  /** `--no-seed`: leave a fresh pod's workspace empty. */
  seed?: boolean;
  dryRun: boolean;
  verbose: boolean;
  help: boolean;
  version: boolean;
  all: boolean;
  yes: boolean;
  destroy: boolean;
  quiet: boolean;
  archived: boolean;
  template?: string;
  /** `archive --idle <duration>`: only pods whose last activity is older than this. */
  idle?: string;
  project?: boolean;
  force: boolean;
  server?: string;
  org?: string;
  jobsOrg?: boolean;
  token?: string;
  session?: string;
  issuer?: string;
  device?: boolean;
}

export interface ParsedArgs {
  subcommand: Subcommand | null;
  subcommandArgs: string[];
  flags: GlobalFlags;
  piArgs: string[];
  seenFlags: Set<string>;
}

const SELF_PARSING_SUBCOMMANDS = new Set<Subcommand>(["credentials", "secrets", "templates", "push", "pull", "diff", "settings", "billing"]);
const UNIVERSAL_FLAGS = new Set(["--verbose", "--version", "--help"]);
const FLAG_SCOPE: Record<string, ReadonlySet<string>> = {
  "--template": new Set(["launch", "list", "doctor", "fork", "archive"]),
  "--project": new Set(["jobs"]),
  "--on": new Set(["launch"]),
  "--reuse": new Set(["launch"]),
  "--no-seed": new Set(["launch"]),
  "--dry-run": new Set(["launch", "update", "fork", "archive"]),
  "--idle": new Set(["archive"]),
  "--session": new Set(["fork"]),
  "--all": new Set(["list", "archive", "restore"]),
  "--yes": new Set(["launch", "fork", "archive", "restore", "gc", "jobs", "credentials", "templates", "attach", "send", "receive", "push", "pull"]),
  "--delete": new Set(["gc"]),
  "--quiet": new Set(["list", "jobs"]),
  "--archived": new Set(["list"]),
  "--force": new Set(["init"]),
  "--server": new Set(["login"]),
  "--org": new Set(["login", "jobs"]),
  "--token": new Set(["login"]),
  "--issuer": new Set(["login"]),
  "--device": new Set(["login"]),
};

function resolveSubcommand(positional: string | undefined): Subcommand | null {
  if (positional === undefined) return null;
  const resolved = ALIASES[positional] ?? positional;
  return (SUBCOMMANDS as readonly string[]).includes(resolved) ? resolved as Subcommand : null;
}

export function checkFlagScope(subcommand: string | null, seenFlags: ReadonlySet<string>): string[] {
  const command = subcommand ?? "launch";
  const ignored: string[] = [];
  for (const flag of seenFlags) {
    if (UNIVERSAL_FLAGS.has(flag)) continue;
    const scope = FLAG_SCOPE[flag];
    if (!scope || scope.has(command)) continue;
    if (flag === "--dry-run") {
      throw new PiPodError(`--dry-run is not supported by \`pipod ${subcommand}\``, {
        hint: "nothing was done — remove the flag to run the command for real",
        exitCode: EXIT.USAGE,
      });
    }
    if (flag === "--on" && command === "fork") {
      throw new PiPodError("forking into a co-located pod is not supported yet", {
        hint: "fork without --on, or launch a plain co-located pod",
        exitCode: EXIT.USAGE,
      });
    }
    ignored.push(flag);
  }
  return ignored;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: GlobalFlags = {
    dryRun: false,
    verbose: false,
    help: false,
    version: false,
    all: false,
    yes: false,
    destroy: false,
    quiet: false,
    archived: false,
    force: false,
  };
  const positionals: string[] = [];
  const piArgs: string[] = [];
  const seenFlags = new Set<string>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      piArgs.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("-")) {
      positionals.push(arg);
      const command = positionals.length === 1 ? resolveSubcommand(arg) : null;
      if (command && SELF_PARSING_SUBCOMMANDS.has(command)) {
        const tail = argv.slice(i + 1);
        positionals.push(...tail.filter((entry) => entry !== "--help" && entry !== "-h"));
        if (tail.some((entry) => entry === "--help" || entry === "-h")) flags.help = true;
        break;
      }
      continue;
    }

    const equals = arg.indexOf("=");
    const name = equals >= 0 ? arg.slice(0, equals) : arg;
    const inlineValue = equals >= 0 ? arg.slice(equals + 1) : undefined;
    const takeValue = (): string => {
      if (inlineValue !== undefined) return inlineValue;
      const value = argv[++i];
      if (value === undefined) throw new PiPodError(`${name} requires a value`, { exitCode: EXIT.USAGE });
      return value;
    };
    const canonical = canonicalFlagName(name);
    seenFlags.add(canonical);

    switch (name) {
      case "--on": flags.on = takeValue(); break;
      case "--reuse": flags.reuse = true; break;
      case "--no-seed": flags.seed = false; break;
      case "--dry-run": flags.dryRun = true; break;
      case "--verbose":
      case "-v": flags.verbose = true; break;
      case "--version": flags.version = true; break;
      case "--help":
      case "-h": flags.help = true; break;
      case "--all":
      case "-a": flags.all = true; break;
      case "--yes":
      case "-y": flags.yes = true; break;
      case "--delete": flags.destroy = true; break;
      case "--quiet":
      case "-q": flags.quiet = true; break;
      case "--archived": flags.archived = true; break;
      case "--template": flags.template = takeValue(); break;
      case "--idle": flags.idle = takeValue(); break;
      case "--project": flags.project = true; break;
      case "--force": flags.force = true; break;
      case "--server": flags.server = takeValue(); break;
      case "--org":
        if (resolveSubcommand(positionals[0]) === "jobs") flags.jobsOrg = true;
        else flags.org = takeValue();
        break;
      case "--token": flags.token = takeValue(); break;
      case "--session": flags.session = takeValue(); break;
      case "--issuer": flags.issuer = takeValue(); break;
      case "--device": flags.device = true; break;
      default:
        throw new PiPodError(`unknown pi pod option "${name}"`, {
          hint: "pass Pi options after `--`, for example: pipod -- --model claude-opus",
          exitCode: EXIT.USAGE,
        });
    }
  }

  let commandPositionals = positionals;
  if (positionals[0] === "help") {
    flags.help = true;
    seenFlags.add("--help");
    commandPositionals = positionals.slice(1);
  }
  const subcommand = resolveSubcommand(commandPositionals[0]);
  if (!subcommand && commandPositionals.length > 0) {
    throw new PiPodError(`unknown pi pod command "${commandPositionals[0]}"`, {
      hint: "pass all Pi arguments after `--`, for example: pipod -- \"review this change\"",
      exitCode: EXIT.USAGE,
    });
  }
  if (subcommand === "jobs" && flags.org !== undefined) {
    // `--org` before `jobs` parses login-style and takes a value; for jobs it is a
    // boolean that belongs after the action. Fail rather than silently scoping wrong.
    throw new PiPodError(`--org ${flags.org} does not apply here`, {
      hint: "for jobs it is a flag after the action: `pipod jobs push --org` (login takes `--org <alias>`)",
      exitCode: EXIT.USAGE,
    });
  }
  return {
    subcommand,
    subcommandArgs: subcommand ? commandPositionals.slice(1) : [],
    flags,
    piArgs,
    seenFlags,
  };
}

function canonicalFlagName(name: string): string {
  switch (name) {
    case "-v": return "--verbose";
    case "-h": return "--help";
    case "-a": return "--all";
    case "-y": return "--yes";
    case "-q": return "--quiet";
    default: return name;
  }
}

export async function main(argv: string[]): Promise<number> {
  const { subcommand, subcommandArgs, flags, piArgs, seenFlags } = parseArgs(argv);
  setVerbose(flags.verbose);
  if (flags.help) {
    process.stdout.write(subcommand ? SUBCOMMAND_HELP[subcommand] : HELP);
    return EXIT.OK;
  }
  for (const flag of checkFlagScope(subcommand, seenFlags)) {
    warn(`${flag} has no effect with \`pipod ${subcommand}\` — ignoring it`);
  }
  announceUserConfig();
  if (flags.version) return printVersion();

  switch (subcommand) {
    case "init":
      return runInit(flags);
    case "login":
      return runLogin({ server: flags.server, org: flags.org, token: flags.token, issuer: flags.issuer, device: flags.device });
    case "whoami":
      return runWhoami({});
    case "logout":
      return runLogout({});
    case "doctor":
      return runAccountDoctor({
        template: flags.template,
      });
    case "update":
      await runUpdate({ dryRun: flags.dryRun });
      return EXIT.OK;
  }

  const account = requireAccountClient();
  switch (subcommand) {
    case "account":
      return runOpenAccount({});
    case "org-admin":
      return runOpenOrgAdmin({});
    case "billing":
      return runBillingCommand(account, subcommandArgs);
    case "gc":
      return runAccountGc(account, { ...podFlagsOf(flags), destroy: flags.destroy });
    case "attach":
      return runAccountAttach(account, subcommandArgs, piArgs, { yes: flags.yes });
    case "list":
      return runAccountList(account, podFlagsOf(flags), subcommandArgs[0]);
    case "stop":
      return runAccountStop(account, subcommandArgs, podFlagsOf(flags));
    case "rename":
      return runAccountRename(account, subcommandArgs);
    case "fork":
      return runAccountFork(account, subcommandArgs, {
        yes: flags.yes,
        dryRun: flags.dryRun,
        template: flags.template,
        session: flags.session,
        on: flags.on,
      }, piArgs);
    case "send":
      return runAccountSend(account, subcommandArgs, { yes: flags.yes });
    case "receive":
      return runAccountReceive(account, subcommandArgs, { yes: flags.yes });
    case "archive":
      return runAccountPodAction(account, subcommandArgs, podFlagsOf(flags), "archive");
    case "restore":
      return runAccountPodAction(account, subcommandArgs, podFlagsOf(flags), "restore");
    case "jobs":
      return runAccountJobs(account, subcommandArgs, {
        quiet: flags.quiet,
        yes: flags.yes,
        project: flags.project,
        org: flags.jobsOrg,
      });
    case "credentials":
      return runCredentials(subcommandArgs, { client: account, yes: flags.yes });
    case "secrets":
      return runSecrets(subcommandArgs, { client: account, yes: flags.yes });
    case "templates":
      return runTemplates(subcommandArgs, { client: account, yes: flags.yes });
    case "push":
      return runPush(subcommandArgs, { client: account, yes: flags.yes });
    case "pull":
      return runPull(subcommandArgs, { client: account, yes: flags.yes });
    case "diff":
      return runDiff(subcommandArgs, { client: account });
    case "settings":
      return runSettings(subcommandArgs, { client: account });
    default:
      return runAccountLaunch({
        client: account,
        flags: {
          yes: flags.yes,
          on: flags.on,
          reuse: flags.reuse,
          seed: flags.seed,
          dryRun: flags.dryRun,
          template: flags.template,
        },
        piArgs,
      });
  }
}

function podFlagsOf(flags: GlobalFlags): AccountPodFlags {
  return {
    all: flags.all,
    quiet: flags.quiet,
    archived: flags.archived,
    yes: flags.yes,
    template: flags.template,
    idle: flags.idle,
    dryRun: flags.dryRun,
  };
}

function announceUserConfig(): void {
  const result = ensureUserConfig();
  for (const file of result.created) info(`created ${color.bold(displayPath(file))}, this machine's pi pod preferences`);
}

function runInit(flags: GlobalFlags): number {
  const cwd = process.cwd();
  const existing = findConfigPath(cwd);
  if (existing !== null && path.dirname(path.dirname(existing)) !== fs.realpathSync(cwd)) {
    info(`note: ${color.bold(displayPath(existing))} defines an enclosing project; this scaffold shadows it here`);
  }
  const result = scaffold({ projectRoot: cwd, force: flags.force });
  printInitResult(result, cwd);
  return EXIT.OK;
}

function printVersion(): number {
  out(`pipod ${VERSION}`);
  out(`node ${process.versions.node}`);
  out(`pi ${bundledPiVersion()}`);
  return EXIT.OK;
}

export function reportError(errorValue: unknown): number {
  if (errorValue instanceof CancelledError) {
    error(errorValue.message);
    return errorValue.exitCode;
  }
  if (isPiPodError(errorValue)) {
    error(errorValue.message);
    if (errorValue.hint) printHint(errorValue.hint);
    if (isVerbose() && errorValue.cause) plain(String(errorValue.cause));
    return errorValue.exitCode;
  }
  error(errorValue instanceof Error ? errorValue.message : String(errorValue));
  if (errorValue instanceof Error && errorValue.stack) plain(color.dim(errorValue.stack));
  return EXIT.FAILURE;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  ["cli.js", "cli.ts", "pipod", "pi-pod", "pp"].includes(path.basename(process.argv[1]));

if (invokedDirectly) {
  // `pipod list | head` closes the pipe early; the reader has what it wanted.
  for (const stream of [process.stdout, process.stderr]) {
    stream.on("error", (failure: NodeJS.ErrnoException) => {
      if (failure.code === "EPIPE") process.exit(process.exitCode ?? 0);
      throw failure;
    });
  }
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((failure) => { process.exitCode = reportError(failure); });
}
