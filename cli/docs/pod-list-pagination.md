# Pod-list pagination

`pipod ls` (also `pipod list`) reads every page before applying display filters or
rendering the oldest-activity-first tree. Quiet output contains each full pod ID
once. Project, template, account and machine-group scopes use the same page walk;
so do short-ref/name resolution and bulk archive/restore/GC selection.

## API contract

`GET /v1/pods` returns `{ pods, nextCursor }`. A page contains at most `limit`
pods (default 100, maximum 200). `nextCursor: null` means the last page, including
an empty result. Otherwise pass that opaque string as `cursor` on the next request,
keeping the same filters. Do not derive it from `lastActivityAt` or `createdAt`:
the cursor retains PostgreSQL microseconds and the pod UUID tie-breaker. The
order is descending `(COALESCE(last_activity_at, created_at), id)`.

The cursor contains a boundary, not a row lookup, so deleting the boundary pod
does not invalidate it. It is not an authorization grant: every page still
applies the authenticated organization, owner and pod-token subtree restrictions.
Malformed cursors and requests combining `cursor` with `before` return 400.

`before` remains the legacy timestamp-only boundary. A new CLI falls back to it
only when the response omits `nextCursor`; old clients continue working with new
servers but cannot recover ties or microseconds using their old page walk. Both
sides must be upgraded for lossless pagination of an unchanged roster.

This is a live listing, not a database snapshot. Concurrent activity can move a
pod ahead of an already-read boundary. The CLI deduplicates IDs if it sees a pod
again and fails explicitly on a repeated cursor rather than reporting a silently
truncated roster. Rerun a listing after concurrent activity for a fresh view.

## Manual acceptance (no unit tests)

Use an explicit disposable migrated database, never a production fixture insert.
Run the actual pod routes over loopback HTTP and the built CLI by absolute path:

- More than 400 pods with identical activity timestamps, including ties spanning
  multiple pages; every matching ID appears exactly once.
- Several distinct PostgreSQL timestamps within one millisecond; no IDs disappear
  at the page boundary. Include null activity with creation-time fallback.
- Empty, short, exact-multiple and final pages; authoritative `nextCursor` works
  even with pages smaller than the CLI's requested maximum.
- Account, project, template, state, owner, gone-row and pod-token subtree filters
  remain in force on subsequent pages. Archived pods filling an early page do not
  hide active pods on later pages. Check quiet and rendered output.
- Delete the last pod of one page, then follow its cursor successfully.
- Malformed cursor and simultaneous `cursor`/`before` return 400.
- A legacy server omitting `nextCursor` is still traversed with `before`.
  A server repeating a cursor fails without printing an incomplete quiet roster.

Live rollout acceptance uses read-only listings. It must not manufacture hundreds
of billable pods or change existing pods' timestamps to force a page boundary.
