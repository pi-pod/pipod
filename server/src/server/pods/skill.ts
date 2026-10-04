/** The pi pod skill installed into every pod (spec §8.5): teaches the agent what pi pod is,
 * what templates and jobs are, and how to use the scoped pod token. */

export const SKILL_REMOTE_DIR = ".pi/agent/skills/pi-pod";

export function renderPodSkill(): string {
  return `---
name: pi-pod
description: >
  Use when the user wants to create or edit a pi pod "pod template" (secrets + init
  and bake scripts + network egress + agent instructions), create or activate a scheduled job,
  launch child pods, or asks how this pod / pi pod works or what access it is meant to have.
  Covers the pi-pod-server REST API and the scoped pod token this pod holds.
---

# pi pod: pods, templates, and the server API

You are running inside a **pod**: a disposable sandbox launched by pi-pod-server. Pods are
created from a **pod template** — a named bundle of:

- **secrets** (env var names; values are write-only on the server and injected at launch),
- an **init script** (bash that runs in every pod at launch: clone repos, fetch files,
  install — anything that needs secrets or differs per pod),
- an optional **bake script** (deterministic setup baked into the pod image once, so later
  launches skip it — see "Init and bake scripts" below),
- a **network egress configuration** (\`egress.mode\` of \`"open"\` or \`"allowlist"\` plus an
  \`egress.allow\` hostname list), and optional image/resource/idle settings,
- optional **agent instructions** (\`agentInstructions\`): what the agent in every pod launched
  from it should know, chiefly the access its pods are meant to have ("read-write in staging,
  read-only in production", "only the third-party APIs below").

A **session** is a pi agent session (like this one) inside a pod. This pod was launched from
one template; the user can ask you to create a *new* template so their next pod comes up
pre-configured. You cannot launch pods from a template you create (see "Child pods"): the user
launches it. Templates you create are **personal to the user** — only they see and launch
them. Sharing one org-wide is the user's step, not yours: \`pipod templates share <name>\`
(it needs the org:manage permission and cannot be undone).

## This pod's template and its access

When this pod's template has agent instructions, they are in your system prompt under
"Pod template", next to what the platform enforces for this pod: its network egress, the
names of the secrets in its environment, and that child pods and jobs use the same template.
They were frozen when this pod launched. The instructions describe the access the template's
author intends; stay within them even where a credential would technically allow more, and
when a task needs access beyond them, tell the user rather than working around it. A
different access pattern is a different template, launched by the user.

The template as it is stored now (an edit since launch applies from the next launch) is
\`template\` in \`GET /v1/settings/layers\` (see "Server settings bundles"), including its
\`agentInstructions\`.

## Your credentials

The environment carries:

- \`PI_POD_SERVER_URL\` — base URL of the pi pod server.
- \`PI_POD_SERVER_TOKEN\` — a scoped, pod-bound API token. Send it as
  \`Authorization: Bearer $PI_POD_SERVER_TOKEN\`.
- \`PI_POD_SERVER_POD_ID\` — this pod's id.

The token is deliberately limited. It can:

- create templates (they go **live immediately**) and scheduled jobs (they also go **live immediately**),
- read templates/jobs and update or delete **templates this pod created**,
- write (never read) secret *values* into templates this pod created, and list which names are set,
- read every **settings layer** behind this pod — organization defaults, the user's own
  layer, and this pod's template (see "Server settings bundles" below),
- **launch child pods** from this pod's own template and manage them — see "Child pods" below.

It cannot modify another pod's templates, create or change org-wide templates, write the
organization or user settings layers, read organization policy, touch pods it did not launch,
update/pause/resume/delete jobs, upload a pi sign-in, or touch org/user secrets.
Creating a job schedules it immediately, so confirm the schedule, model, and prompt with the user
before POSTing.

## Secrets etiquette

Prefer referencing secrets by NAME and letting the user enter values in the app: chat
transcripts are persisted and replayed, so a value pasted into chat is a value on a server.
If the user chooses to paste a value anyway, store it immediately with the API below and do
not repeat it back. This applies to every kind of key alike — model providers, scrapers, git
hosts; nothing is special-cased by name. If a pod is missing a key you cannot set yourself,
tell the user its NAME and where it belongs — \`pipod secrets set org <NAME>\` for a key the
whole organization shares, \`pipod secrets set user <NAME>\` for their own — or the same
secret screen in the app.

## API quick reference (all JSON, all under \`$PI_POD_SERVER_URL/v1\`)

Create a template:

    curl -sS -X POST "$PI_POD_SERVER_URL/v1/templates" \\
      -H "Authorization: Bearer $PI_POD_SERVER_TOKEN" -H "Content-Type: application/json" \\
      -d '{
        "name": "my-service",
        "description": "workspace for my-service",
        "agentInstructions": "Work only in acme/my-service. Push branches and open pull requests; never push to main.",
        "initScript": "#!/usr/bin/env bash\\nset -euo pipefail\\ngit clone https://github.com/acme/my-service.git\\ncd my-service && npm install\\n",
        "bakeScript": "#!/usr/bin/env bash\\nset -euo pipefail\\napt-get update && apt-get install -y jq\\n",
        "config": { "egress": { "mode": "allowlist", "builtins": true,
                                "allow": ["github.com", "registry.npmjs.org"] } }
      }'

Update a template you created (same fields, all optional):

    curl -sS -X PATCH "$PI_POD_SERVER_URL/v1/templates/<id>" \\
      -H "Authorization: Bearer $PI_POD_SERVER_TOKEN" -H "Content-Type: application/json" \\
      -d '{ "initScript": "..." }'

List / inspect templates:

    curl -sS "$PI_POD_SERVER_URL/v1/templates" -H "Authorization: Bearer $PI_POD_SERVER_TOKEN"

Delete a template this pod created:

    curl -sS -X DELETE "$PI_POD_SERVER_URL/v1/templates/<id>" \\
      -H "Authorization: Bearer $PI_POD_SERVER_TOKEN"

Set a secret value on a template this pod created (write-only; scope is \`template\`):

    curl -sS -X PUT "$PI_POD_SERVER_URL/v1/secrets/template/<templateId>/GH_TOKEN" \\
      -H "Authorization: Bearer $PI_POD_SERVER_TOKEN" -H "Content-Type: application/json" \\
      -d '{ "value": "..." }'

List which secret names are set on a template this pod created:

    curl -sS "$PI_POD_SERVER_URL/v1/secrets/template/<templateId>" \\
      -H "Authorization: Bearer $PI_POD_SERVER_TOKEN"

## Child pods

You can ask the server to launch another pod and drive it — a worker for a subtask, a clean
sandbox to verify a change, a fan-out across projects. The provider credential stays on the
server; you never hold one. Child pods are **billable, real sandboxes**: launch them when the
work needs isolation or parallelism, not by reflex, and delete them when you are done.

A child launches from **this pod's own template**, with the same secrets, egress, scripts, and
agent instructions; a pod launched without a template launches children without one. Omit
\`templateId\` and the server fills it in. Naming any other template answers 403, because a
child from another template could reach whatever that template reaches. Launch a child with
invocation flags:

    curl -sS -X POST "$PI_POD_SERVER_URL/v1/pods" \\
      -H "Authorization: Bearer $PI_POD_SERVER_TOKEN" -H "Content-Type: application/json" \\
      -d '{ "piOverrides": { "model": "<provider/model>" } }'

Give the child Pi resources that already exist **on the machine it will run on** — an
extension, a skill, a prompt template (a file or a directory, any name, repeatable). They are
added to the pod's own Pi arguments and re-applied on every later start, and the launch fails
with a message if one of them is not readable there:

    curl -sS -X POST "$PI_POD_SERVER_URL/v1/pods" \\
      -H "Authorization: Bearer $PI_POD_SERVER_TOKEN" -H "Content-Type: application/json" \\
      -d '{ "piOverrides": { "extensions": ["/abs/path/to/extension.ts"],
            "skills": ["/abs/path/to/skill-dir"], "promptTemplates": ["/abs/path/to/templates"] } }'

Paths are absolute and pod-local: nothing is uploaded from here, so for a pod with a machine of
its own the file has to be put there by an init script or a bundle. For a **co-located** child
(below) the machine is this one, so anything you write on this filesystem before launching is
already in place — which is how you hand a worker its own extension.

The smallest launch, from this pod's template with its defaults:

    curl -sS -X POST "$PI_POD_SERVER_URL/v1/pods" \\
      -H "Authorization: Bearer $PI_POD_SERVER_TOKEN" -H "Content-Type: application/json" \\
      -d '{}'

Preflight without creating anything (merged config, clamps, image and credential status):

    curl -sS -X POST "$PI_POD_SERVER_URL/v1/pods/resolve" \\
      -H "Authorization: Bearer $PI_POD_SERVER_TOKEN" -H "Content-Type: application/json" -d '{}'

Poll until it is ready (\`wait\` long-polls up to 25s, so this is not a busy loop):

    curl -sS "$PI_POD_SERVER_URL/v1/pods/<childId>?wait=25000" \\
      -H "Authorization: Bearer $PI_POD_SERVER_TOKEN"

List your subtree — this pod and everything it launched, transitively — and delete a child
when its work is done:

    curl -sS "$PI_POD_SERVER_URL/v1/pods?lineage=self" -H "Authorization: Bearer $PI_POD_SERVER_TOKEN"
    curl -sS -X DELETE "$PI_POD_SERVER_URL/v1/pods/<childId>" \\
      -H "Authorization: Bearer $PI_POD_SERVER_TOKEN"

Deleting a pod that still has live children answers 409 and names them; add \`?cascade=true\` to
take down the whole subtree. If \`pi-pod\` is installed here it uses this token automatically:
\`pi-pod list\` shows your subtree, \`pi-pod attach <child> -- "<prompt>"\` runs one turn in a child
and prints the reply, and \`pi-pod archive\` works too — no sign-in needed.

The rules the server enforces, so plan within them rather than retrying:

- **descendants only** — you may inspect, rename, archive, restore, drive, delete, and \`pi-pod send\`
  files to or \`pi-pod receive\` files from the pods you launched (and their children); every other
  pod in the organization answers 403,
- **same template** — children, forks, and co-located pods launch from this pod's template, and
  jobs you create run from it; any other \`templateId\` answers 403,
- you cannot delete or archive **yourself**,
- **depth** is capped (2 by default: this pod may launch children, and they may launch children),
- **fan-out** is capped (5 live children per pod) and so is the **whole tree** (10 live pods),
- launches are rate limited to 10 per minute per pod, so a loop fails fast instead of billing.

Children are independent once launched: they idle-stop and archive on their own policy, and they
keep running if this pod stops. That is what makes detached work possible — and why leaving them
behind costs the user money. Clean up.

## Co-located pods (workers on this machine)

A child can instead run **on this pod's own machine** as a separate process group — a real pod
in every way (own id, token, session, attachable from the user's phone or laptop), but free,
near-instant to start, and sharing this filesystem. Ask for it with \`placement\` instead of a
provider:

    curl -sS -X POST "$PI_POD_SERVER_URL/v1/pods" \\
      -H "Authorization: Bearer $PI_POD_SERVER_TOKEN" -H "Content-Type: application/json" \\
      -d '{ "placement": { "host": "self" }, "project": { "name": "worker-tests" },
            "piOverrides": { "model": "anthropic/claude-haiku-4-5-20251001" } }'

With \`pi-pod\` installed here: \`pi-pod --on self -- "<first prompt>"\`.

When to co-locate vs. launch a real sandbox:

- **Co-locate** for subagents and parallel work on *this* checkout: workers share the
  filesystem, start in seconds, cost nothing extra, and the user can open them natively.
- **Real child pod** when the work needs isolation: a different image, its own egress, its own
  resources, or code you do not want touching this workspace.

What placement changes:

- **Machine-shaped config is inherited** from this pod: image, resources, egress, and the
  idle/archive clocks. Naming those in the launch's project config is an error. Model,
  thinking, env, and the prompt still apply per child. Like every child, it launches from this
  pod's template.
- **Workdir**: by default the child shares this pod's workdir, and **no init scripts run** —
  the filesystem is already set up, and you can write any per-worker files (briefs, worktrees)
  yourself before launching. Set \`project.config.workdir\` to a fresh path to get a private
  directory instead; the full init chain runs there.
- **Shared-writer discipline is yours**: two agents editing one checkout behave like two
  terminals in one repo. Use git worktrees or split the work when that matters.
- **Lifecycle is coupled to this machine**: children die when this pod stops and report
  \`host_stopped\`; a busy child keeps this machine awake; archiving this pod archives them;
  deleting this pod deletes them.
- **No count cap** on co-located children (the nested fan-out/tree caps do not apply), but the
  10-per-minute launch rate limit still does.

Co-located children may themselves use \`"host": "self"\` — the new pod lands on the same real
machine. Delete workers when their task is done; they are free while stopped but clutter the
user's pod list.

## Model provider sign-in

Model credentials belong to the user's account, not to a pod: a provider they connect once
works in every pod they launch. The server keeps OAuth refresh tokens; pods receive access
tokens and API keys. To use a subscription (Claude Pro/Max, ChatGPT, …) or save an API key, the user
connects the provider in the pi pod app under **Settings → Model providers**, with
\`pipod credentials connect <provider>\`, or with \`/login\` while attached to a pod from the
pipod CLI. ChatGPT plans sign in through the \`openai\` provider ("Sign in with ChatGPT");
\`openai-codex\` is pi's legacy route. Signing in is deliberately human-only — you cannot do it
for them. If a sign-in stops working, they reconnect it the same way.

## Init and bake scripts

A template has two setup scripts, and which one a step goes in decides whether every pod
pays for it at launch:

- \`initScript\` runs **in every pod** at launch — as bash, non-interactive (\`CI=1\`,
  \`DEBIAN_FRONTEND=noninteractive\`), in the pod workdir, with the template's secrets
  already in the environment.
- \`bakeScript\` is **baked into the pod image**: the image is derived once per script edit
  (its tag carries a digest of the composed script) and every later launch boots with the
  results already on disk. On the first launch after an edit — or with a custom \`image\`
  pin — the server runs it live in the pod before init instead: same behavior, just slower
  until the image is built.

Put a step in \`bakeScript\` when it is deterministic and needs no secrets: \`apt-get
install\`, \`npm install -g\`, toolchain or browser downloads. Keep per-pod work in
\`initScript\`: clones, dependency installs inside the repo, anything reading env. An
\`apt-get install\` left in \`initScript\` costs minutes on every launch; in
\`bakeScript\` it costs one image build ever.

The bake contract follows from where it runs — an image build, not a pod:

- **No secrets, no env.** Image builds carry no injected variables, and secrets are never
  baked into images. A step that needs a token belongs in \`initScript\`.
- **No workspace.** It runs as root with cwd \`/root\`; the workdir does not exist yet.
- **Deterministic.** Same script, same image — nothing per-pod, per-branch, or
  time-sensitive.

Rules for both scripts:

- **Idempotent.** A stopped pod can be reused for a later launch, and the scripts re-run
  over the existing filesystem — write them so a second run is a fast no-op (fetch into an
  existing clone instead of failing on it; \`npm ci\` is naturally fine).
- If \`egress.mode\` is \`"allowlist"\`, every host either script downloads from must be
  in \`egress.allow\` (keep \`"builtins": true\` so derived hosts like base-URL endpoints
  are added). That includes bake hosts, so the live fallback behaves like the image build.
- A non-zero init exit fails the launch by default — test commands here before writing
  them in.
- Full config schema errors are returned on create/update, so invalid templates fail fast.

## Server settings bundles

Every launch resolves server-resident organization and user bundles plus an optional template. An
organization-scoped template is positioned before the user bundle; a user-scoped template is
positioned after it. Later config values win, arrays replace, setup scripts concatenate in that
same order, and Pi files merge per file. Request project settings, env, scripts, and Pi files are
retired launch inputs; push them to a template or server bundle instead. Organization policy clamps
the resolved result, and \`requireTemplate\` can require a selected template. Explicit
provider/model/thinking launch controls remain available.

Read the layers behind this pod — organization defaults, the user's own layer, and the
template this pod launched from as it is stored now (an edit since launch shows up here and
applies from the next launch):

    curl -sS "$PI_POD_SERVER_URL/v1/settings/layers" -H "Authorization: Bearer $PI_POD_SERVER_TOKEN"

Each of \`org\`, \`user\`, and \`template\` carries \`config\`, \`initScript\`, \`bakeScript\`,
\`piFiles\`, and \`version\`; \`template\` also carries \`agentInstructions\`. \`user\` is null in a pod launched without its owner's personal
settings (an organization job, and pods it launches); \`template\` is null when this pod
launched without one or it has since been deleted. Organization policy is not readable from a
pod; \`POST /v1/pods/resolve\` (above) reports every clamp it applies.

The organization and user layers are **read-only** to you: their scripts run in every later
pod, so changing them is the user's act. When one should change, show the user the exact edit
and how to make it with their own sign-in:

- one config key — \`pipod settings user set <key> '<json>'\` (or \`org\`, which needs the
  org:manage permission), for example \`pipod settings user set pi.model '"provider/model"'\`;
- scripts or Pi files — \`pipod pull user\` (or \`org\`), edit the local files, then
  \`pipod push user\` (or \`org\`);
- or the server's web dashboard, which **Web dashboard** in the pi pod app's Settings opens.

A template this pod created you can change yourself (see "Update a template" above).

## Jobs (scheduled prompts)

A **job** runs a prompt on a schedule: at each recurring cron tick or specified absolute time,
the server launches a fresh pod from the job's template, starts a session with the job's model,
and sends the prompt. The pod then idle-stops like any other. A job has:

- a **trigger**, either recurring cron — \`{ "type": "cron", "cron": "<5-field expression>" }\`,
  evaluated in **UTC** — or a finite schedule — \`{ "type": "at", "times": ["<ISO timestamp>"] }\`.
  Absolute timestamps require explicit timezones, are normalized to UTC, and may contain up to
  100 unique times. All schedules require at least 5 minutes between runs because each run is a pod.
  A finite job automatically becomes **completed** when its final occurrence is claimed,
- a **templateId** — the pod template to launch from. A job you create runs from this pod's
  own template: omit \`templateId\` and the server fills it in; any other answers 403,
- a **model** — \`"provider/model-id"\`, e.g. \`"anthropic/claude-opus-4-7"\`. Unless the user
  names one, use the provider and model id this session is running on: it is the one model
  you know their account can serve. Never invent a placeholder such as "default",
- a **prompt** — the instruction the session starts with. Make it self-contained: the pod is
  fresh, so the prompt is all the context the agent will have.

Creating a job schedules it **immediately**. Confirm the schedule, model, and prompt with
the user before POSTing. Jobs belong to the user who launched this pod. The referenced
template must exist and not be archived.

Create a recurring job:

    curl -sS -X POST "$PI_POD_SERVER_URL/v1/jobs" \\
      -H "Authorization: Bearer $PI_POD_SERVER_TOKEN" -H "Content-Type: application/json" \\
      -d '{
        "name": "nightly-triage",
        "description": "Summarize new issues every morning",
        "trigger": { "type": "cron", "cron": "0 6 * * *" },
        "model": "anthropic/claude-opus-4-7",
        "prompt": "Review the new GitHub issues on acme/my-service since yesterday and post a triage summary."
      }'

For one-time or finite work, use an \`at\` trigger instead:

    "trigger": {
      "type": "at",
      "times": ["2026-09-01T15:00:00Z", "2026-09-03T15:00:00Z"]
    }

One timestamp means run once. Creation requires at least one future occurrence. A failed
final run remains completed and is visible as failed in run history.

List and inspect (you cannot PATCH, pause, resume, or delete jobs):

    curl -sS "$PI_POD_SERVER_URL/v1/jobs" -H "Authorization: Bearer $PI_POD_SERVER_TOKEN"
    curl -sS "$PI_POD_SERVER_URL/v1/jobs/<id>/runs" -H "Authorization: Bearer $PI_POD_SERVER_TOKEN"

The user can pause, resume, or remove jobs with \`pi-pod jobs\` on their laptop, or from the app.


`;
}
