# Vendored pi-pod core

`src/core/` started as a full rsync of `pi-pod/src`. It is no longer a live
mirror of the CLI: the vendored CLI command surface (`cli.ts`, `attach.ts`,
`send.ts`, `doctor.ts`, `scaffold.ts`, `update.ts`, `secrets.ts`, `jobfiles.ts`,
`account/`, `commands/`) has been deleted — the server never imported any of it.

Every file left here is classified in [`scripts/core-manifest.txt`](../../scripts/core-manifest.txt):

- **`[shared]`** — re-vendored verbatim from pi-pod by `scripts/sync-core.sh`.
  Never hand-edit one: change it in pi-pod and re-sync, or reclassify it first.
- **`[forked]`** — a pi-pod file the server has deliberately diverged from,
  each with the reason recorded. `sync-core.sh` must not touch these.
- **`[pinned]`** — byte-identical to pi-pod today, but held back because it
  transitively depends on a forked file, so re-vendoring it alone could pull in
  an incompatibility.
- **Unlisted** — server-owned, with no pi-pod counterpart at all: the provider
  adapters, lifecycle, image publishing, labels, init scripts and the provider
  PTY session/RPC stack. The CLI no longer talks directly to the sandbox runtime; this tree is
  the server's copy of that stack, so edit it here.

`npm run check:core` enforces the classification. It hashes the shared files,
which catches a shared file edited in place here. Paired with the CLI —
`node --import tsx scripts/check-core-sync.ts --pi-pod ../cli`, which `sync-core.sh`
runs — it also catches the CLI moving ahead, and fails on any dual-tree file the
manifest never classified.

`.pi-pod-source-commit` records the last shared-subset sync, not a claim that
the whole directory matches that commit.
