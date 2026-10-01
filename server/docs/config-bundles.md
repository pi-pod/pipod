# Config bundles

A **config bundle** is everything the server resolves for a launch, in three parts:

1. **`config`** — one JSON object per layer (org defaults, positioned template,
   user defaults), merged per key; later layers win. A resolve-only project
   preview layer (`POST /v1/pods/resolve` `projectConfig`) may sit on top for
   template bootstrapping; launches never take project config.
2. **Init / bake scripts** — script **content**, not paths. Org and user layers
   each carry `initScript` / `bakeScript` strings (`init_script` / `bake_script`
   columns); templates carry their own pair. The repo-relative paths
   (`envFile`, `initScript`, `bakeScript` config keys) are the CLI's to open on
   its own disk — the server never reads them.
3. **`piFiles`** — the canonical **flat** Pi file set:
   `{settings, models, mcporter, subagents, agents}` (all optional).
   Settings layers merge org → template → user; `settings.json` package lists
   stay additive.

## Layer order and policy

Merge order: org defaults → template (positioned before user defaults for
org-owned templates, after for personal ones) → user defaults → project
preview. Org **policy** is constraints, not defaults: ceilings
(`maxIdleTimeoutMinutes`, `maxArchiveAfterMinutes`), `allowedProviders`,
`requireTemplate`, egress rules, and concurrency caps clamp the merged result
last, and every clamp is reported — never silent. `deniedProviders` merges by
union across layers and denies at launch with the denying layers named.

Resolve responses report `configProvenance` (winning layer per leaf),
`layerOrder`, `warnings`, and `clamps` alongside the config.

## Secrets are not bundle content

Bundles carry no secret values. Pod secrets resolve from the `secrets` table
(org / template / user scopes) at launch; proposals carry `secretNames` only,
and the apply response returns those names so the app can prompt for values
the proposing agent could not set. Model credentials in `piFiles.models.json`
must be `$VAR` references — literals are stripped on write.

## Retired keys

Reads strip retired keys silently (no warnings, no provenance entries); writes
reject them with `400` and the removal spelled out. Retired from the bundle
contract (server never reads them): top-level `envFile`, `initScript`,
`bakeScript`, `template`, `reuse`, and `pi.hostConfig.skills` / `extensions`.
Earlier removals (`repo`, `autoStopOnExit`, `autoDelete`, `orphanTtlMinutes`,
`stopTimeoutSeconds`, `deleteTimeoutSeconds`, `pi.version`, `pi.shellOnExit`,
`pi.detachSequence*`) behave the same. The client-facing projection additionally
omits `providers` (server-side placement wiring) and the retired keys, and
narrows `pi.hostConfig` to its enforced booleans.

Live and enforced — do not remove: `workdir`, `labels`, `initOnFailure`,
`providers`, `pi.command`/`pi.args`, `pi.hostConfig.settings`/`packages`
(the two booleans gate what merged Pi files may carry into a pod).

## Migration instructions (for writers)

- **Flat `piSettings`**: `POST`/`PATCH` `/templates` accept only the flat file
  set. A legacy `{user, project}` payload fails `400` naming the migration:
  merge the old project scope over the user scope per file (project wins,
  both `settings.json` package lists kept), take `models` from the user scope
  only. Rows stored before the removal keep serving flattened (read-time
  migration); they normalize on next write.
- **Retired config keys**: delete them from the payload and retry — the server
  ignores them, so dropping them changes nothing it does. Pending settings
  proposals authored before a removal list stripped and apply their live
  content.
