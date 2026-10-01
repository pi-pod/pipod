/**
 * Create-operation idempotency ledger (plan §6.5).
 *
 * The Manager and API compile against these signatures; the ledger persists key +
 * fingerprint before allocation and records an explicit resolution for every failure.
 */
import { createHmac } from "node:crypto";
import type Database from "better-sqlite3";
import { OPERATION_KEY } from "../wire.js";
import { badRequest, notFound } from "../errors.js";
import type { ErrorDetails, OperationStatus, OperationStatusWire, SandboxInfoWire } from "../wire.js";

export interface OperationError {
  code: string;
  message: string;
  hint?: string;
  details?: ErrorDetails;
}

export type OperationResolution = "preallocation" | "cleaned" | "quarantined";

export interface OperationRow {
  key: string;
  kind: "create";
  /** HMAC of the canonical request under the host secret; never the request itself. */
  fingerprint: string;
  status: OperationStatus;
  sandboxId: string | null;
  createdAt: number;
  finishedAt: number | null;
  expiresAt: number;
  cancelRequested: boolean;
  result: SandboxInfoWire | null;
  error: OperationError | null;
  bootId: string;
  /** Whether a failed/cancelled create left host resources behind; null while unresolved. */
  resolution: OperationResolution | null;
}

export type BeginOutcome =
  | { outcome: "started"; op: OperationRow }
  | { outcome: "duplicate"; op: OperationRow }
  | { outcome: "conflict"; op: OperationRow };

export interface OperationLedgerOptions {
  /** Keyed fingerprint secret (the master token); fingerprints must not be reversible. */
  secret: string;
  /** How long terminal tombstones are retained after completion. */
  retentionMs: number;
  bootId: string;
  now?: () => number;
}

interface StoredRow {
  key: string;
  kind: string;
  fingerprint: string;
  status: string;
  sandbox_id: string | null;
  created_at: number;
  finished_at: number | null;
  expires_at: number;
  cancel_requested: number;
  result_json: string | null;
  error_json: string | null;
  boot_id: string;
  resolution: string | null;
}

/**
 * Canonical JSON: object keys sorted recursively so key order never changes the
 * fingerprint; arrays keep order; `undefined` object values are dropped (matching
 * `JSON.stringify` semantics); the top-level `operationKey` is excluded because it
 * names the ledger row rather than describing the request.
 */
function canonicalize(value: unknown, topLevel: boolean): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) {
    // `undefined`/functions/holes stringify to null inside arrays; mirror that.
    return `[${value.map((item) => (typeof item === "function" || item === undefined ? "null" : canonicalize(item, false))).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([k, v]) => {
        if (v === undefined || typeof v === "function") return false;
        // Only the envelope field is stripped, and only at the top level — a nested
        // `operationKey` inside e.g. labels is request data and must stay hashed.
        if (topLevel && k === "operationKey") return false;
        return true;
      })
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v, false)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function parseJson<T>(raw: string | null): T | null {
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    // Rows are only ever written by this ledger, so corrupt JSON cannot happen;
    // surfacing null keeps a single bad row from crashing status reads.
    return null;
  }
}

function hydrate(stored: StoredRow): OperationRow {
  return {
    key: stored.key,
    kind: "create",
    fingerprint: stored.fingerprint,
    status: stored.status as OperationStatus,
    sandboxId: stored.sandbox_id,
    createdAt: stored.created_at,
    finishedAt: stored.finished_at,
    expiresAt: stored.expires_at,
    cancelRequested: stored.cancel_requested === 1,
    result: parseJson<SandboxInfoWire>(stored.result_json),
    error: parseJson<OperationError>(stored.error_json),
    bootId: stored.boot_id,
    resolution: (stored.resolution as OperationResolution | null) ?? null,
  };
}

/** True only for terminal rows known to hold no host resources — safe to retry off-host. */
function crossHostRetrySafe(op: OperationRow): boolean {
  return (
    (op.status === "failed" || op.status === "cancelled") &&
    (op.resolution === "preallocation" || op.resolution === "cleaned")
  );
}

export class OperationLedger {
  private readonly db: Database.Database;
  private readonly secret: string;
  private readonly retentionMs: number;
  private readonly bootId: string;
  private readonly clock: () => number;

  constructor(db: Database.Database, opts: OperationLedgerOptions) {
    this.db = db;
    this.secret = opts.secret;
    this.retentionMs = opts.retentionMs;
    this.bootId = opts.bootId;
    this.clock = opts.now ?? Date.now;
    // Additive schema owned by this ledger; the sandboxes table lives in Store.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS create_operations (
        key TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        status TEXT NOT NULL,
        sandbox_id TEXT,
        created_at INTEGER NOT NULL,
        finished_at INTEGER,
        expires_at INTEGER NOT NULL,
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        result_json TEXT,
        error_json TEXT,
        boot_id TEXT NOT NULL,
        resolution TEXT
      );
      CREATE INDEX IF NOT EXISTS create_operations_sandbox ON create_operations(sandbox_id);
      CREATE INDEX IF NOT EXISTS create_operations_expires ON create_operations(expires_at);
    `);
    // Migrate tables created before the resolution column existed (e.g. a DB file
    // written by an earlier build); PRAGMA-guarded so fresh creates are untouched.
    const columns = this.db.prepare("PRAGMA table_info(create_operations)").all() as Array<{ name: string }>;
    if (!columns.some((col) => col.name === "resolution")) {
      this.db.exec("ALTER TABLE create_operations ADD COLUMN resolution TEXT");
    }
  }

  /** Canonical-JSON HMAC of the request (minus `operationKey`); stable across key order. */
  fingerprint(request: unknown): string {
    const canonical = canonicalize(request, true);
    return createHmac("sha256", this.secret).update(`pi-pod-sandbox:create:${canonical}`).digest("hex");
  }

  private read(key: string): OperationRow | null {
    const row = this.db.prepare("SELECT * FROM create_operations WHERE key = ?").get(key) as
      | StoredRow
      | undefined;
    return row === undefined ? null : hydrate(row);
  }

  /** Persist the key before creation; duplicate/conflict are decided against the stored fingerprint. */
  begin(key: string, fingerprint: string): BeginOutcome {
    if (!OPERATION_KEY.test(key)) {
      throw badRequest(`invalid operation key ${JSON.stringify(key)}`, "use 8-128 chars of A-Za-z0-9._:-");
    }
    // Check-and-insert must be atomic so two concurrent creates with the same key
    // cannot both observe "no row" and both launch sandboxes.
    const txn = this.db.transaction((k: string, fp: string): BeginOutcome => {
      const existing = this.read(k);
      const now = this.clock();
      if (existing === null) {
        this.db
          .prepare(
            `INSERT INTO create_operations
               (key, kind, fingerprint, status, sandbox_id, created_at, finished_at, expires_at, cancel_requested, result_json, error_json, boot_id)
             VALUES (?, 'create', ?, 'pending', NULL, ?, NULL, ?, 0, NULL, NULL, ?)`,
          )
          .run(k, fp, now, now + this.retentionMs, this.bootId);
        return { outcome: "started", op: this.read(k)! };
      }
      if (existing.fingerprint !== fp) {
        return { outcome: "conflict", op: existing };
      }
      // A crash between launch and `succeed`/`fail` leaves a `failed/interrupted`
      // tombstone; a retry with the same key+request restarts instead of replaying
      // the stale failure.
      // A quarantined interruption means a sandbox may still exist or cleanup is
      // uncertain, so re-running the create could double-allocate: report the row
      // as-is until recovery resolves it, instead of silently starting over.
      if (
        existing.status === "failed" &&
        existing.error?.code === "interrupted" &&
        existing.resolution !== "quarantined"
      ) {
        this.db
          .prepare(
            `UPDATE create_operations SET status = 'pending', fingerprint = ?, sandbox_id = NULL,
               created_at = ?, finished_at = NULL, expires_at = ?, cancel_requested = 0,
               result_json = NULL, error_json = NULL, boot_id = ?, resolution = NULL WHERE key = ?`,
          )
          .run(fp, now, now + this.retentionMs, this.bootId, k);
        return { outcome: "started", op: this.read(k)! };
      }
      return { outcome: "duplicate", op: existing };
    });
    return txn(key, fingerprint);
  }

  /** Bind an opt-in singleton claim before any image lookup; recovery retains its ID. */
  bindClaim(key:string,sandboxId:string):void {
    const row=this.read(key);
    if(!row || row.status!=="pending" || (row.sandboxId!==null && row.sandboxId!==sandboxId))
      throw new Error("create operation cannot bind a second sandbox identity");
    this.db.prepare("UPDATE create_operations SET sandbox_id=? WHERE key=? AND status='pending'").run(sandboxId,key);
  }

  private activeSingletonClaim(sandboxId:string|null,key:string):boolean {
    if(!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='singleton_allocations'").get())return false;
    return Boolean(this.db.prepare(`SELECT 1 FROM singleton_allocations WHERE retired_at IS NULL
      AND (sandbox_id=? OR operation_key=?)`).get(sandboxId,key));
  }

  succeed(key: string, sandboxId: string, result: SandboxInfoWire): OperationRow {
    const existing = this.read(key);
    if (existing === null) throw notFound(`operation ${JSON.stringify(key)} not found`);
    const now = this.clock();
    this.db
      .prepare(
        `UPDATE create_operations SET status = 'succeeded', sandbox_id = ?, finished_at = ?,
           expires_at = ?, result_json = ?, resolution = NULL WHERE key = ?`,
      )
      .run(sandboxId, now, now + this.retentionMs, JSON.stringify(result), key);
    return this.read(key)!;
  }

  fail(
    key: string,
    error: OperationError,
    sandboxId?: string | null,
    resolution?: OperationResolution,
  ): OperationRow {
    const existing = this.read(key);
    if (existing === null) throw notFound(`operation ${JSON.stringify(key)} not found`);
    const now = this.clock();
    // Persist only the bounded wire fields; the caller's error object may carry
    // provider internals that must never land in SQLite or on the wire.
    const stored: OperationError = {
      code: error.code,
      message: error.message,
      ...(error.hint === undefined ? {} : { hint: error.hint }),
      ...(error.details === undefined ? {} : { details: error.details }),
    };
    const sandbox = sandboxId === undefined ? existing.sandboxId : sandboxId;
    // Conservative default: with no sandbox id nothing was allocated (preallocation);
    // with one, resources may be live until recovery says otherwise (quarantined).
    const resolved = this.activeSingletonClaim(sandbox,key) ? "quarantined" :
      resolution ?? (sandbox == null ? "preallocation" : "quarantined");
    this.db
      .prepare(
        `UPDATE create_operations SET status = 'failed', sandbox_id = ?, finished_at = ?,
           expires_at = ?, error_json = ?, resolution = ? WHERE key = ?`,
      )
      .run(sandbox, now, now + this.retentionMs, JSON.stringify(stored), resolved, key);
    return this.read(key)!;
  }

  /** Terminal `cancelled` after the caller rolled the sandbox back. */
  cancel(key: string, sandboxId?: string | null, resolution?: OperationResolution): OperationRow {
    const existing = this.read(key);
    if (existing === null) throw notFound(`operation ${JSON.stringify(key)} not found`);
    const now = this.clock();
    const sandbox = sandboxId === undefined ? existing.sandboxId : sandboxId;
    // A cancel with no sandbox id means the create never got that far (cleaned);
    // cancelling around a live id leaves cleanup uncertain (quarantined).
    const resolved = this.activeSingletonClaim(sandbox,key) ? "quarantined" :
      resolution ?? (sandbox == null ? "cleaned" : "quarantined");
    this.db
      .prepare(
        `UPDATE create_operations SET status = 'cancelled', sandbox_id = ?, finished_at = ?,
           expires_at = ?, resolution = ? WHERE key = ?`,
      )
      .run(sandbox, now, now + this.retentionMs, resolved, key);
    return this.read(key)!;
  }

  /** Recovery updates the resolution once host resources are confirmed released (or not). */
  resolve(key: string, resolution: OperationResolution): OperationRow {
    const existing = this.read(key);
    if (existing === null) throw notFound(`operation ${JSON.stringify(key)} not found`);
    this.db.prepare("UPDATE create_operations SET resolution = ? WHERE key = ?")
      .run(this.activeSingletonClaim(existing.sandboxId,key)?"quarantined":resolution, key);
    return this.read(key)!;
  }

  /** Flag a pending operation; the creator checks it after launch and rolls back. */
  requestCancel(key: string): OperationRow | null {
    const existing = this.read(key);
    if (existing === null) return null;
    // Terminal rows are immutable history; only a pending create can be steered.
    if (existing.status !== "pending") return existing;
    this.db.prepare("UPDATE create_operations SET cancel_requested = 1 WHERE key = ?").run(key);
    return this.read(key)!;
  }

  get(key: string): OperationRow | null {
    return this.read(key);
  }

  bySandbox(sandboxId: string): OperationRow | null {
    const row = this.db
      .prepare("SELECT * FROM create_operations WHERE sandbox_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(sandboxId) as StoredRow | undefined;
    return row === undefined ? null : hydrate(row);
  }

  /** Startup: pending rows from earlier boots become `failed` with code `interrupted`. */
  interruptPending(): OperationRow[] {
    const now = this.clock();
    const errorJson = JSON.stringify({
      code: "interrupted",
      message: "the sandbox service restarted before the create finished",
    });
    // Only other-boot rows qualify: this boot's own pending creates are still live
    // (the creator thread survived the restart check that calls this method).
    // Nothing is known about the interrupted rows until recovery runs, so they land
    // quarantined — cross-host retry stays unsafe until explicitly resolved.
    this.db
      .prepare(
        `UPDATE create_operations SET status = 'failed', finished_at = ?, expires_at = ?,
           error_json = ?, resolution = 'quarantined' WHERE status = 'pending' AND boot_id != ?`,
      )
      .run(now, now + this.retentionMs, errorJson, this.bootId);
    const rows = this.db
      .prepare("SELECT * FROM create_operations WHERE status = 'failed' AND finished_at = ?")
      .all(now) as StoredRow[];
    return rows
      .filter((row) => {
        const err = parseJson<OperationError>(row.error_json);
        return err?.code === "interrupted";
      })
      .map(hydrate);
  }

  purgeExpired(): number {
    // Pending rows always carry a fresh-enough expiry while a create is in flight,
    // but belt-and-braces: only terminal tombstones are ever eligible for deletion.
    const protectedClaims=Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='singleton_allocations'").get());
    const info = this.db.prepare(protectedClaims
      ? `DELETE FROM create_operations WHERE status != 'pending' AND expires_at < ?
         AND NOT EXISTS (SELECT 1 FROM singleton_allocations a WHERE a.retired_at IS NULL
           AND (a.sandbox_id=create_operations.sandbox_id OR a.operation_key=create_operations.key))`
      : "DELETE FROM create_operations WHERE status != 'pending' AND expires_at < ?").run(this.clock());
    return Number(info.changes);
  }

  toWire(op: OperationRow): OperationStatusWire {
    // Typed structurally (not as a literal) so this compiles both before and after
    // `OperationStatusWire` gains the agreed `resolution`/`crossHostRetrySafe` fields.
    const wire: OperationStatusWire & {
      resolution: OperationResolution | null;
      crossHostRetrySafe: boolean;
    } = {
      key: op.key,
      kind: "create",
      status: op.status,
      sandboxId: op.sandboxId,
      createdAt: new Date(op.createdAt).toISOString(),
      finishedAt: op.finishedAt === null ? null : new Date(op.finishedAt).toISOString(),
      expiresAt: new Date(op.expiresAt).toISOString(),
      cancelRequested: op.cancelRequested,
      resolution: op.resolution,
      crossHostRetrySafe: !this.activeSingletonClaim(op.sandboxId,op.key) && crossHostRetrySafe(op),
      ...(op.result === null ? {} : { result: op.result }),
      ...(op.error === null
        ? {}
        : {
            error: {
              code: op.error.code,
              message: op.error.message,
              ...(op.error.hint === undefined ? {} : { hint: op.error.hint }),
              ...(op.error.details === undefined ? {} : { details: op.error.details }),
            },
          }),
    };
    return wire;
  }
}
