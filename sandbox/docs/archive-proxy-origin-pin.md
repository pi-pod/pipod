# Archive proxy origin pin (runtime GAP-1)

Runtime-only egress fence: the box never sends the proxy bearer token to an
origin that is not durably pinned. This closes GAP-1 from
`archive-factory-design-1235-rev2.md` §6 (per-request affinity refuses drifted
PUTs/GETs but cannot stop the box first sending token bytes after env edit +
autostart). The pin is a ref-pin at the HTTP dispatch boundary: mismatch means
no-send.

Status: runtime candidate on this branch only. No factory, no promotion, no
`PR294` change, no production/template/runtime rollout. The server factory
(`stampForCreate` / `inheritForRestore` / `verifiedHostArchive`) is a later,
separately reviewed step that WRITES this file; this repo only READS it
(except the tested operator command below, which writes it explicitly).

## Compatibility decision (explicit)

- `local`, `s3`, `none` drivers: behavior unchanged in ALL backends.
- `proxy` driver: pinned in ALL host backends. There is deliberately NO
  static-mode exemption, because `PI_POD_SANDBOX_HOST_BACKEND` is itself env
  and an exemption would be an env-controlled bypass.
- This is a fail-closed behavior change for existing static+proxy deploys:
  after updating, proxy activation throws `archive_proxy_origin_missing`
  until a binding is installed. Existing static+proxy operators MUST install a
  verified binding BEFORE updating (see "Operator install" below) — never
  trust-on-first-use from the ambient, possibly drifted env. `box`+`local`
  (the default) boots unchanged with no binding.
- Old Box assets are never modified and archive enrollment is never enabled
  by this module.

## Binding

Fixed path (no override, no alternate pin, no env indirection):

```
<PI_POD_SANDBOX_STATE_DIR>/archive-proxy-binding.json
```

`proxyBindingPath(stateDir)` in `src/archive/proxy-origin-pin.ts` is the
single owner of this path. `stateDir` is `path.resolve()`d; the filename is
`archive-proxy-binding.json`.

Schema (exact, versioned, no credentials, no table/manager):

```json
{
  "version": 1,
  "hostId": "box-abc123",
  "origin": "https://proxy.example.com"
}
```

| Field | Rule |
|---|---|
| `version` | Must be exactly `1`. Any other value is invalid. |
| `hostId` | Bare object-key-safe name (`^[A-Za-z0-9][A-Za-z0-9._-]*$`), exactly equal to the runtime `PI_POD_SANDBOX_HOST_ID`. No normalization, no case folding. |
| `origin` | Canonical bare origin (see below). Must already be canonical byte-for-byte; non-canonical bytes are invalid. Never includes credentials, path, query, or fragment. |

Exactly these three keys: extra fields are rejected, so a future factory
field cannot slip past this review. The file holds no token, no secret, no S3
keys — only the host name and the origin it may dial.

## Canonicalization

`canonicalizeProxyOrigin(input)` is the single owner. Strict raw rejects run
on the RAW string before `new URL` can normalize anything away:

1. Must be a string, 1–2048 bytes.
2. No whitespace or control characters.
3. No `?` or `#` anywhere (query/fragment rejected, even empty).
4. After `scheme://`: the authority (up to the first `/`) must be non-empty
   and contain no `@` (userinfo rejected); the remainder must be exactly empty
   or `/` — any other path (`/prefix`, `/../`, `/%2e%2e/`, `/.`) is REJECTED,
   not normalized, so the producer shape stays unambiguous.
5. Then via URL parse: scheme `https:`, or `http:` only for loopback test
   hosts (`127.0.0.1`, `::1`, `[::1]`, `localhost`). Production remains HTTPS;
   loopback HTTP exists only for tests. No userinfo, no query, no fragment, no
   non-root path (re-checked post-parse).
6. Scheme and host lowercased; default ports omitted (`:443` for https, `:80`
   for http — `URL` already strips these); non-default ports kept; IPv6 hosts
   bracketed; no trailing slash.

Examples:

```
https://PROXY.EXAMPLE.COM        → https://proxy.example.com
https://proxy.example.com:443    → https://proxy.example.com
https://proxy.example.com:8443   → https://proxy.example.com:8443
http://127.0.0.1:18433           → http://127.0.0.1:18433 (loopback test only)
https://user@proxy.example.com   → REJECTED (userinfo)
https://proxy.example.com/prefix → REJECTED (path)
https://proxy.example.com/../    → REJECTED (path, not normalized)
https://proxy.example.com?x=1    → REJECTED (query)
https://proxy.example.com#frag   → REJECTED (fragment)
http://example.com/              → REJECTED (non-loopback http)
```

Both sides are canonicalized and compared as exact strings:
`canonical(env URL) === binding.origin`. A drifted env URL never dials.

## Runtime read path (no cache)

`createPinnedProxyStore({ stateDir, hostId, url, token, timeoutMs })`:

1. Fail-fast once at construction (sync read) so `createObjectStore` throws
   at activation when unpinned — before any HTTP.
2. Installs a `resolveBase` dispatch hook in the raw transport. The hook
   re-reads and re-validates the file on EVERY request (`put`, `get`, `head`,
   `list`, `delete`) AFTER async PUT prep (source `stat`/stream setup) and
   adjacent to `fetch` with no await between — so a binding deleted or
   re-pointed during prep still blocks with no send. A logical copy is
   `get`+`put`, so both legs are gated. There is no in-memory cache and no
   per-method wrapper layer; the single dispatch guard is the fence.
3. Request URLs are built from the freshly validated BINDING origin (equal to
   the env canonical on success), so drifted env bytes never form a target.
4. All `fetch` calls use `redirect: "manual"` and treat any 3xx /
   `opaqueredirect` as a hard failure (`proxystore.ts`). Redirects are never
   followed with the bearer token.
5. Failures never include URLs, tokens, or reflected bytes. Transport errors
   are a fixed operation label plus the numeric status only
   (`archive proxy GET failed with HTTP 500` — the server's `statusText` is
   untrusted reflected bytes and is never interpolated). Network rejections
   are sanitized to `archive proxy <OP> failed: network error` keeping only
   the stable syscall code as `cause` (never the message or URL). Pin codes:
   - `archive_proxy_origin_missing` — file absent.
   - `archive_proxy_origin_invalid` — malformed JSON, wrong shape/version,
     non-canonical origin, bad hostId, symlink, directory/FIFO, group- or
     world-writable mode, oversize (`>8192` bytes), unreadable.
   - `archive_proxy_origin_mismatch` — binding host or origin differs from
     runtime host + env origin.
   - `archive_proxy_origin_config_invalid` — env URL itself is not a strict
     bare origin.

File checks (one sync bounded fd reader, reasonable for runtime permissions):

- `lstat`: symlink → invalid; then regular-file, group/world-writable
  (`mode & 0o022`), and size checks.
- `open(O_RDONLY|O_NOFOLLOW|O_NONBLOCK)`: a FIFO substituted between the calls
  opens but fails the regular-file check instead of hanging the reader;
  `ELOOP`/`ENOENT` map to invalid/missing.
- `fstat` re-checks regular-file + mode + size (closes the TOCTOU); the read
  is an exact size-capped `readSync` loop into a pre-sized buffer (no
  unbounded allocation, no arbitrary growth); short reads are invalid.
- `ENOENT` → missing; every other I/O or parse failure → invalid. No raw
  bytes, paths, or tokens are echoed in the error.

`src/config.ts` enforces the same strict bare-origin rule at startup for
`PI_POD_SANDBOX_ARCHIVE_PROXY_URL` and stores the canonical form in
`cfg.archive.url`. `cfg.archive.stateDir` carries the state dir so
`createObjectStore(cfg.archive)` can pin without a signature change.

## Producer contract (server factory / operator, later + now)

The runtime never mints, repairs, or migrates the binding. The factory (or an
explicit reviewed per-host re-point op, or the operator command below) writes
it with this exact custody and ordering:

```
1. build payload = JSON.stringify({ version: 1, hostId, origin: canonical }, null, 2) + "\n"
   (keys in this order; origin already canonical; no other fields; no secrets)
2. mkdir -p <stateDir>                       (factory-owned provisioning)
3. open temp in the SAME directory
   (`<stateDir>/.archive-proxy-binding.json.<pid>.<uuid>.tmp`)
   with O_CREAT|O_EXCL|O_NOFOLLOW|O_WRONLY, mode 0600 — never follows or clobbers
4. write the payload through THAT fd, fsync THAT fd, close it
   (no reopen-by-path between write and fsync)
5. rename(temp, <stateDir>/archive-proxy-binding.json)  (atomic, same filesystem)
6. fsync(<stateDir> directory fd)            (makes the rename durable;
   rename alone does not fsync)
7. bounded read-back: the bytes on disk must parse to exactly the intended
   version+hostId+origin, or fail closed; a failed install unlinks the temp
   path only when its inode still matches (never another file)
```

Reference implementations: `writeProxyBindingAtomic(stateDir, { hostId, origin })`
in `src/archive/proxy-origin-pin.ts` (NOT called by the runtime boot or any
store method — it exists so the factory and tests use identical bytes and
ordering), and the zero-dependency operator command
`scripts/write-proxy-origin-binding.mjs` (same bytes, same ordering, same
read-back). Upgrades must NOT rewrite archive keys (create/restore-only); a
later default must never silently re-point a live host — that needs the
explicit re-point op.

## Operator install (required before updating static+proxy hosts)

```bash
node scripts/write-proxy-origin-binding.mjs \
  --state-dir <PI_POD_SANDBOX_STATE_DIR> \
  --host-id <PI_POD_SANDBOX_HOST_ID> \
  --origin <verified-bare-origin>
```

The origin must be the verified proxy origin for that host (from reviewed
deploy config — never copied from the possibly drifted ambient env on the
box). The command prints only `{path,version,hostId,origin}` on success
(exit 0); any failure exits nonzero with a safe message. It takes no
credentials and logs none. The command is exercised by
`test/archive-proxy-origin-pin-unit.test.ts` (success writes byte-exact
0600 bytes a pinned store accepts; failures exit nonzero with no file).
After installing, restart the runtime; proxy activation succeeds only when
the binding matches host + configured origin.

## What this does NOT do

- No enrollment, no affinity stamping, no `archive_profile`, no new table,
  no manager, no restore inheritance — those are server-side REV2 work.
- No rotation or availability story (GAP-2/GAP-3 unchanged): a replaced store
  still needs the old service readable + a dual-service window.
- No protection against malicious root — only accidental env drift +
  autostart. A compromised host writer can always change state.
- No migration of old Box assets and no silent local→proxy switch.

## Verification

- Unit: `test/archive-proxy-origin-pin-unit.test.ts` (missing, malformed,
  wrong host, drift across logical restart, live binding replacement, no-HTTP
  on mismatch for all five methods, delayed PUT-prep deletion repro, exact
  transport-error strings, network-error sanitization, redirects never
  followed, strict canonical rejects, producer read-back + temp hygiene,
  group-writable/symlink rejects, operator CLI, proof fail-hook hygiene,
  known-good roundtrip).
- Manual local: `scripts/proxy-origin-pin-proof.ts --out-dir <new-dir>` +
  `scripts/proxy-origin-pin-proof-server.mjs` — two-origin synthetic-token
  network demonstration with the real production module; records
  `originalOriginCount` vs `driftedOriginCount` plus the deletion check and
  asserts zero unexpected egress. Each run needs a fresh, not-yet-existing
  `--out-dir` (0700, files 0600, no-clobber); children are direct spawns with
  pid + kernel-start receipts, ownership rechecked on every signal/escalation.
