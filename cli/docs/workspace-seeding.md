# Workspace seeding

A pod's workdir starts empty. Init scripts (org, template, user) fill it for configured
projects; for everything else, `pipod` seeds the fresh pod from the directory it was launched in.

## When a launch seeds

The clone-or-archive workflow runs only for a **source-less launch**: no `.pi-pod/config.json`
is found in the launch directory or any parent up to `$HOME` (the same upward lookup every
other command uses, so `repo/src/` still belongs to `repo/`). It never runs when:

| Situation | Behavior |
|---|---|
| `.pi-pod/config.json` found | unchanged: the project tree is copied over `/pods/:id/files` when no template init script exists |
| `pipod fork <pod>` | the conversation is copied, never the workspace |
| a stopped pod is reused (`--reuse` only; the `reuse` config key is retired) | the warm disk keeps its own workspace |
| `--on <pod\|self>` | a co-located pod shares its host's workdir |
| `--no-seed` | the pod starts empty |

The **seed root** is `git rev-parse --show-toplevel` when the launch directory is inside a
work tree, otherwise the directory itself. `/` and the home directory are refused. Launching
from a subdirectory seeds the whole repository and prints the subdirectory so it is not a surprise.

## Clone or archive

A clone is preferred when the pod can fetch the host's exact **committed HEAD**. Local
staged, unstaged, and untracked changes do not prevent cloning and are **not copied** by a
successful clone. The local checkout is left untouched. Every check below fails closed into
an archive with a human-readable reason (`pipod --dry-run` prints it):

1. inside a git work tree
2. `origin` exists and rewrites to an `https://` URL (`git@host:x/y.git` and `ssh://` are rewritten; local paths cannot be cloned by a pod)
3. HEAD is on a branch
4. the branch has an upstream with no unpushed commits
5. no initialized submodules, no Git LFS attributes
6. the pod's egress policy admits the remote host
7. a live `git ls-remote` shows the remote branch at exactly the local HEAD commit

The server clones that exact commit into the empty workdir. If the clone fails for any
reason, the launch automatically falls back to an archive of the local working tree,
**including uncommitted changes**. The committed-only behavior applies to successful clones,
not archive or configured-project copy transports.

An **archive** is a gzip-compressed POSIX tar stream written to a temporary file and streamed
to `PUT /v1/pods/:id/workspace/archive`. It contains tracked and untracked non-ignored files,
directory and file modes, and symlinks that stay inside the tree. It excludes git-ignored
paths, `node_modules`, `.pi-pod/env`, sockets/FIFOs/devices, and symlinks that are absolute
or escape the tree. `.git` is included when it is a real directory (with credentials stripped
from `.git/config` URLs) so dirty and unpushed repositories arrive as repositories; when the
archive would exceed the size cap, the launch retries without history and says so.

Default client-side caps: 256 MiB compressed, 2 GiB uncompressed, 200,000 entries.

## Credentials

- Anonymous access is tried first with every prompt disabled.
- For a private remote, the host's `git credential fill` is consulted, then `gh auth token`.
- The credential is verified with a second `ls-remote` before anyone is asked anything.
- **You are asked before a token is forwarded.** `--yes` approves the prompt; declining, or a
  non-interactive launch without `--yes`, sends an archive instead.
- The token travels once in the clone request body, is used for that clone, and is never
  written to pod metadata, resolved configuration, audit rows, command arguments, logs, or
  files inside the pod. SSH keys are never forwarded.
- `--dry-run` and `pipod doctor` never read credentials; they report "would clone with
  forwarded credentials if they work".

## Pi starts after the seed

A seeding launch sends `workspaceSeed: true` in the launch body. The server provisions the
sandbox, reports the pod ready, and holds Pi until the clone or archive route records a
successful seed. When the client ends up not seeding (nothing to send, an oversized tree, a
failed transfer, an already-populated workdir), it posts to `/pods/:id/workspace/skip` so Pi
starts at once; the server also opens the gate on its own after a timeout, so a client that
dies mid-seed never strands the pod. Configured projects keep their post-start copy and do not
arm the gate.

A seed only ever fills an empty workdir. When init scripts (or the image) have already
populated it by the time provisioning finishes, as a template whose init clones its
repositories does, the server records the seed as `skipped` and starts Pi with the pod. The
client then sends nothing: no clone request, no archive. Older servers leave the gate armed,
and the client sends the seed for the routes to refuse.

## Older servers

A server with a strict launch schema rejects the `workspaceSeed` flag; the client retries the
launch without it and Pi starts immediately, as before. When the workspace routes are missing
(404), a tree under the 24 MiB `/files` limit is copied entry by entry; a larger tree is
reported and the pod starts empty. `pipod send <path>` fills it afterwards.

## Manual testing

Follow the pi-pod CLI manual-testing technique (build the checkout, invoke `node dist/cli.js`,
drive the TUI from tmux, archive every pod you create). Cases worth a real pod
on the sandbox backend:

1. **Public clone** — `cd` into a clean, pushed clone of a public repository with no
   `.pi-pod/`, run `node <repo>/dist/cli.js`. Expect `workspace seed: the pod will clone …`,
   then `!git log -1` inside the pod shows the same commit and `!git status` is clean.
2. **Private GitHub clone** — same with a private repository and `gh auth login` done. Expect
   the forwarding prompt; approve; `!git remote -v` inside the pod shows the https URL with no
   token, and `!cat .git/config` holds no token.
3. **Declined forwarding** — answer `n`; expect an archive, and the pod still holds the tree.
4. **Dirty repository clone** — in a pushed, cloneable repository, stage a change, edit it
   again, and add an untracked file. Launch; expect `will clone … (local uncommitted changes
   are not copied)`. Inside the pod, `!git status` is clean, tracked content matches HEAD,
   and the untracked file is absent. The host's staged, unstaged and untracked changes remain.
5. **Non-git archive** — a plain directory of files; expect the files without a `.git`.
6. **100+ MiB streaming archive** — a repository without `origin`, with a large untracked binary; watch the
   `upload 25% …` lines; verify the file's checksum in the pod.
7. **Interrupted upload** — Ctrl-C during upload; expect the pod deleted and no
   `pi-pod-seed-*.tar.gz` left in the temp directory.
8. **Nested pod launch** — from inside a pod, launch a child from a source-less directory;
   symlinks are skipped with a warning, files arrive.
9. **Template/init-script collision** — `--template <one whose init script clones>`; expect
   `workspace already populated … nothing sent`, no archive build or upload, and the
   pod's `workspaceSeed` reported `skipped`.
10. **`--no-seed`, `--dry-run`, `fork`, `--on`** — none create a transfer; `--dry-run` prints
    the decision and creates no pod.
