# Restart-time image verification

## Outcome and trust boundary

A measured Metis restart spent 361.7 of 362.4 seconds in image verification;
reconciling 799 sandbox rows took less than a second. The expensive work was
reconstructing comparison trees from retained blobs, not adopting archives.

The goal is to reuse that work without starting the API before the integrity gate.
The cache is host-owned state under `images/verifications-v1/` (directory 0700,
records 0600), outside pod mounts. As with the existing image store, a hostile host
administrator or a forged host snapshot is outside this boundary. A receipt alone
is never enough to mount a lower.

## What stays checked

Every stored ref still passes the boot gate, not just refs used by resumable rows.
The config blob is still hashed and its `rootfs.diff_ids` cross-checked against
recorded layer sources. Each distinct compressed blob is cryptographically hashed
once per offline validation pass. A missing/corrupt blob is fetched and verified,
or startup fails. Pinned sandbox layer selections still have to match the image.
`resolve()` still refuses caches not admitted by verification.

The initial scope-narrowing proposal was rejected during implementation because it
removed these existing safeguards. Neither the integrity checks nor CI were changed
to accommodate the optimization.

## What is reused

After full verification, a versioned receipt binds the diff_id, compressed blob
digest and media type to the extracted tree's content digest, metadata fingerprint,
uncompressed byte count and verification time. The tree digest is **not** the OCI
tar's diff_id: it describes the extracted contents, modes, ownership, links and xattrs.

On restart, the compressed blob is still checked. A receipt then skips decompression,
temporary extraction and content hashing only if:

- its blob, diff_id and media type match the current verified mapping;
- its uncompressed size fits the current per-layer limit;
- it is less than six hours old (future timestamps are misses too);
- the live tree's metadata fingerprint matches.

The fingerprint includes paths, types, modes, owners, sizes, inodes, link counts,
mtime and ctime; normal filesystem writes, link changes and xattr changes invalidate
it. Missing, malformed, expired or mismatched receipts fall back to full verification
and the existing repair path. An interrupted repair cannot leave reusable old evidence.
Identical blob/lower mappings shared by ref aliases are checked once within the
offline boot pass; that memoization is not kept across passes.

The six-hour content scrub detects corruption beneath the filesystem. It refreshes
matching receipts after a successful content check, and durably removes a receipt
when corruption is found, so restarting cannot resurrect it. Receipt age is bounded
independently of the timer: repeated restarts cannot postpone content verification.
Changing either fingerprint/digest algorithm requires a new cache namespace/version.

## Verification and deployment

Use the production offline verifier (`dist/scripts/verify-images.js`) against an
explicit disposable state directory for cold/warm runs, content/mode/xattr changes,
missing blobs, invalid selections and expired receipts. Do not run an offline verifier
against state owned by a live service. Existing integration/root qualification remains
required; no unit tests are added or run.

The first verification after upgrading populates receipts and may remain slow. Measure
a second restart on unchanged inputs using the `sandbox boot phase` log, and report
`image-verify` and total time separately. A real sandbox-container recreate stops its
live pods: do not use one merely as a benchmark. Prefer a disposable volume containing
only copies of the host image cache for production-scale measurements, and defer any
live activation that cannot preserve active work.
