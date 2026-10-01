import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import type { EgressPolicy, ResourceSpec, SandboxHold } from "../wire.js";

export type Tier = "hot" | "warm" | "stopped" | "archived" | "error";

/** Additive columns introduced after the initial schema; applied idempotently at open. */
const COLUMN_MIGRATIONS: ReadonlyArray<{ column: string; ddl: string }> = [
  { column: "owner_key", ddl: "ALTER TABLE sandboxes ADD COLUMN owner_key TEXT" },
  { column: "revision", ddl: "ALTER TABLE sandboxes ADD COLUMN revision INTEGER NOT NULL DEFAULT 0" },
  {
    column: "runtime_generation",
    ddl: "ALTER TABLE sandboxes ADD COLUMN runtime_generation INTEGER NOT NULL DEFAULT 0",
  },
  { column: "cgroup_rel", ddl: "ALTER TABLE sandboxes ADD COLUMN cgroup_rel TEXT" },
  { column: "hold_json", ddl: "ALTER TABLE sandboxes ADD COLUMN hold_json TEXT" },
  {
    column: "archive_shared",
    ddl: "ALTER TABLE sandboxes ADD COLUMN archive_shared INTEGER NOT NULL DEFAULT 0",
  },
];

export interface SandboxRow {
  id: string;
  image: string;
  imageDigest: string;
  workdir: string;
  tier: Tier;
  createdAt: number;
  lastActivityAt: number;
  stoppedAt: number | null;
  archiveAfterMinutes: number;
  idleTimeoutMinutes: number;
  resources: ResourceSpec;
  ceiling: ResourceSpec;
  egress: EgressPolicy;
  netIndex: number;
  error: string | null;
  archiveKey: string | null;
  archiveSha256: string | null;
  archiveSize: number | null;
  /** cgroup CPU counter at the last reaper tick — the delta is the activity veto (§6.1). */
  lastCpuUsec: number;
  labels: Record<string, string>;
  layers: string[];
  /** Immutable owner set at create/import; never derived from labels. */
  ownerKey: string | null;
  /** Transition revision; bumped on every tier change. */
  revision: number;
  /** Bumped on every launch. */
  runtimeGeneration: number;
  /** cgroup path (relative to the cgroup root) the running sandbox was placed at; null = legacy flat. */
  cgroupRel: string | null;
  /** Quiescence hold; wake/archive/resize/delete are refused while set. */
  hold: SandboxHold | null;
  /** The archive object may be referenced by another host (imported, or exported under a hold); never deleted here. */
  archiveShared: boolean;
}

interface RawRow {
  id: string;
  image: string;
  image_digest: string;
  workdir: string;
  tier: Tier;
  created_at: number;
  last_activity_at: number;
  stopped_at: number | null;
  archive_after_minutes: number;
  idle_timeout_minutes: number;
  resources_json: string;
  ceiling_json: string;
  egress_json: string;
  net_index: number;
  error: string | null;
  archive_key: string | null;
  archive_sha256: string | null;
  archive_size: number | null;
  last_cpu_usec: number;
  owner_key: string | null;
  revision: number;
  runtime_generation: number;
  cgroup_rel: string | null;
  hold_json: string | null;
  archive_shared: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sandboxes (
  id TEXT PRIMARY KEY,
  image TEXT NOT NULL,
  image_digest TEXT NOT NULL,
  workdir TEXT NOT NULL,
  tier TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  stopped_at INTEGER,
  archive_after_minutes INTEGER NOT NULL,
  idle_timeout_minutes INTEGER NOT NULL,
  resources_json TEXT NOT NULL,
  ceiling_json TEXT NOT NULL,
  egress_json TEXT NOT NULL,
  net_index INTEGER NOT NULL,
  error TEXT,
  archive_key TEXT,
  archive_sha256 TEXT,
  archive_size INTEGER,
  last_cpu_usec INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS labels (
  sandbox_id TEXT NOT NULL REFERENCES sandboxes(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (sandbox_id, key)
);
CREATE INDEX IF NOT EXISTS labels_kv ON labels(key, value);
CREATE TABLE IF NOT EXISTS layer_refs (
  sandbox_id TEXT NOT NULL REFERENCES sandboxes(id) ON DELETE CASCADE,
  digest TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (sandbox_id, digest)
);
CREATE INDEX IF NOT EXISTS layer_refs_digest ON layer_refs(digest);
`;

export class Store {
  private readonly db: Database.Database;

  constructor(dbDir: string) {
    fs.mkdirSync(dbDir, { recursive: true });
    this.db = new Database(path.join(dbDir, "sandbox.sqlite"));
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("synchronous = FULL");
    this.db.exec(SCHEMA);
    this.migrate();
  }

  private migrate(): void {
    const present = new Set(
      (this.db.prepare("PRAGMA table_info(sandboxes)").all() as { name: string }[]).map((c) => c.name),
    );
    for (const m of COLUMN_MIGRATIONS) {
      if (!present.has(m.column)) this.db.exec(m.ddl);
    }
  }

  get file(): string {
    return this.db.name;
  }

  /**
   * The open handle, for sibling ledgers (admission journal, operations, usage) that keep
   * their own additive tables in the same file so a reservation and the row it protects
   * commit in one transaction.
   */
  get database(): Database.Database {
    return this.db;
  }

  close(): void {
    this.db.close();
  }

  /** DR snapshots must not copy a WAL mid-transaction (§5.2). */
  backupTo(file: string): void {
    this.db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  }

  /**
   * Lean snapshot read (§8.1.1): every sandbox row in one round-trip, without the
   * per-row labels/layers lookups `hydrate` performs. The usage snapshot never
   * emits labels, env, layers, or image refs, so it must not pay that N+1 cost on
   * every poll. Labels/layers come back empty; every scalar column is identical
   * to `all()`.
   */
  allForUsageSnapshot(): SandboxRow[] {
    return (this.db.prepare("SELECT * FROM sandboxes ORDER BY id").all() as RawRow[]).map((r) =>
      this.hydrateScalars(r, {}, []),
    );
  }

  private hydrate(raw: RawRow): SandboxRow {
    const labels = Object.fromEntries(
      this.db
        .prepare("SELECT key, value FROM labels WHERE sandbox_id = ?")
        .all(raw.id)
        .map((r) => [(r as { key: string }).key, (r as { value: string }).value]),
    );
    const layers = this.db
      .prepare("SELECT digest FROM layer_refs WHERE sandbox_id = ? ORDER BY position")
      .all(raw.id)
      .map((r) => (r as { digest: string }).digest);
    return this.hydrateScalars(raw, labels, layers);
  }

  private hydrateScalars(
    raw: RawRow,
    labels: Record<string, string>,
    layers: string[],
  ): SandboxRow {
    return {
      id: raw.id,
      image: raw.image,
      imageDigest: raw.image_digest,
      workdir: raw.workdir,
      tier: raw.tier,
      createdAt: raw.created_at,
      lastActivityAt: raw.last_activity_at,
      stoppedAt: raw.stopped_at,
      archiveAfterMinutes: raw.archive_after_minutes,
      idleTimeoutMinutes: raw.idle_timeout_minutes,
      resources: JSON.parse(raw.resources_json) as ResourceSpec,
      ceiling: JSON.parse(raw.ceiling_json) as ResourceSpec,
      egress: JSON.parse(raw.egress_json) as EgressPolicy,
      netIndex: raw.net_index,
      error: raw.error,
      archiveKey: raw.archive_key,
      archiveSha256: raw.archive_sha256,
      archiveSize: raw.archive_size,
      lastCpuUsec: raw.last_cpu_usec,
      labels,
      layers,
      ownerKey: raw.owner_key ?? null,
      revision: raw.revision ?? 0,
      runtimeGeneration: raw.runtime_generation ?? 0,
      cgroupRel: raw.cgroup_rel ?? null,
      hold: raw.hold_json ? (JSON.parse(raw.hold_json) as SandboxHold) : null,
      archiveShared: raw.archive_shared === 1,
    };
  }

  insert(
    row: Omit<
      SandboxRow,
      "labels" | "layers" | "ownerKey" | "revision" | "runtimeGeneration" | "cgroupRel" | "hold" | "archiveShared"
    > &
      Partial<Pick<SandboxRow, "ownerKey" | "revision" | "runtimeGeneration" | "cgroupRel" | "hold" | "archiveShared">> & {
        labels: Record<string, string>;
        layers: string[];
      },
  ): void {
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO sandboxes (id, image, image_digest, workdir, tier, created_at, last_activity_at,
             stopped_at, archive_after_minutes, idle_timeout_minutes, resources_json, ceiling_json,
             egress_json, net_index, error, archive_key, archive_sha256, archive_size, last_cpu_usec,
             owner_key, revision, runtime_generation, cgroup_rel, hold_json, archive_shared)
           VALUES (@id, @image, @image_digest, @workdir, @tier, @created_at, @last_activity_at,
             @stopped_at, @archive_after_minutes, @idle_timeout_minutes, @resources_json, @ceiling_json,
             @egress_json, @net_index, @error, @archive_key, @archive_sha256, @archive_size, @last_cpu_usec,
             @owner_key, @revision, @runtime_generation, @cgroup_rel, @hold_json, @archive_shared)`,
        )
        .run({
          id: row.id,
          image: row.image,
          image_digest: row.imageDigest,
          workdir: row.workdir,
          tier: row.tier,
          created_at: row.createdAt,
          last_activity_at: row.lastActivityAt,
          stopped_at: row.stoppedAt,
          archive_after_minutes: row.archiveAfterMinutes,
          idle_timeout_minutes: row.idleTimeoutMinutes,
          resources_json: JSON.stringify(row.resources),
          ceiling_json: JSON.stringify(row.ceiling),
          egress_json: JSON.stringify(row.egress),
          net_index: row.netIndex,
          error: row.error,
          archive_key: row.archiveKey,
          archive_sha256: row.archiveSha256,
          archive_size: row.archiveSize,
          last_cpu_usec: row.lastCpuUsec,
          owner_key: row.ownerKey ?? null,
          revision: row.revision ?? 0,
          runtime_generation: row.runtimeGeneration ?? 0,
          cgroup_rel: row.cgroupRel ?? null,
          hold_json: row.hold ? JSON.stringify(row.hold) : null,
          archive_shared: row.archiveShared ? 1 : 0,
        });
      this.replaceLabelsInTx(row.id, row.labels);
      const insLayer = this.db.prepare(
        "INSERT OR REPLACE INTO layer_refs (sandbox_id, digest, position) VALUES (?, ?, ?)",
      );
      row.layers.forEach((digest, i) => insLayer.run(row.id, digest, i));
    });
    tx();
  }

  private replaceLabelsInTx(id: string, labels: Record<string, string>): void {
    this.db.prepare("DELETE FROM labels WHERE sandbox_id = ?").run(id);
    const ins = this.db.prepare("INSERT INTO labels (sandbox_id, key, value) VALUES (?, ?, ?)");
    for (const [k, v] of Object.entries(labels)) ins.run(id, k, v);
  }

  get(id: string): SandboxRow | null {
    const raw = this.db.prepare("SELECT * FROM sandboxes WHERE id = ?").get(id) as RawRow | undefined;
    return raw ? this.hydrate(raw) : null;
  }

  all(): SandboxRow[] {
    return (this.db.prepare("SELECT * FROM sandboxes ORDER BY created_at DESC").all() as RawRow[]).map((r) =>
      this.hydrate(r),
    );
  }

  /** Every selector must match — gc asks "sandboxes of this org that are mine", not "either". */
  findByLabels(selector: Record<string, string>): SandboxRow[] {
    const entries = Object.entries(selector);
    if (entries.length === 0) return this.all();
    const clauses = entries
      .map(
        () =>
          "EXISTS (SELECT 1 FROM labels l WHERE l.sandbox_id = sandboxes.id AND l.key = ? AND l.value = ?)",
      )
      .join(" AND ");
    const params = entries.flat();
    const raws = this.db
      .prepare(`SELECT * FROM sandboxes WHERE ${clauses} ORDER BY created_at DESC`)
      .all(...params) as RawRow[];
    return raws.map((r) => this.hydrate(r));
  }

  /** Every tier write bumps the transition revision, even a same-tier rewrite (§3.3). */
  setTier(id: string, tier: Tier, opts: { stoppedAt?: number | null; error?: string | null } = {}): void {
    const row = this.get(id);
    if (!row) return;
    this.db
      .prepare("UPDATE sandboxes SET tier = ?, stopped_at = ?, error = ?, revision = revision + 1 WHERE id = ?")
      .run(
        tier,
        opts.stoppedAt === undefined ? row.stoppedAt : opts.stoppedAt,
        opts.error === undefined ? row.error : opts.error,
        id,
      );
  }

  /**
   * Guarded tier write: applies only while the row still has `expectedRevision`. Returns
   * whether it applied. This is what makes archive-if-stopped safe against a stale read.
   */
  setTierIfRevision(
    id: string,
    expectedRevision: number,
    tier: Tier,
    opts: { stoppedAt?: number | null; error?: string | null } = {},
  ): boolean {
    const row = this.get(id);
    if (!row || row.revision !== expectedRevision) return false;
    const result = this.db
      .prepare(
        "UPDATE sandboxes SET tier = ?, stopped_at = ?, error = ?, revision = revision + 1 WHERE id = ? AND revision = ?",
      )
      .run(
        tier,
        opts.stoppedAt === undefined ? row.stoppedAt : opts.stoppedAt,
        opts.error === undefined ? row.error : opts.error,
        id,
        expectedRevision,
      );
    return result.changes === 1;
  }

  /** New launch, new generation: counters from the previous process tree are not comparable. */
  bumpRuntimeGeneration(id: string, cgroupRel: string | null): number {
    this.db
      .prepare("UPDATE sandboxes SET runtime_generation = runtime_generation + 1, cgroup_rel = ? WHERE id = ?")
      .run(cgroupRel, id);
    return this.get(id)?.runtimeGeneration ?? 0;
  }

  /**
   * Compare-and-set owner from `null` to `userKey` (§7.2 rollout). Never overwrites an
   * existing owner: the caller decides between idempotent replay and conflict.
   */
  setOwnerIfNull(id: string, userKey: string): "set" | "same" | "different" | "missing" {
    return this.db.transaction((): "set" | "same" | "different" | "missing" => {
      const row = this.db.prepare("SELECT owner_key FROM sandboxes WHERE id = ?").get(id) as
        | { owner_key: string | null }
        | undefined;
      if (!row) return "missing";
      if (row.owner_key === userKey) return "same";
      if (row.owner_key !== null) return "different";
      const result = this.db
        .prepare("UPDATE sandboxes SET owner_key = ?, revision = revision + 1 WHERE id = ? AND owner_key IS NULL")
        .run(userKey, id);
      return result.changes === 1 ? "set" : "different";
    })();
  }

  /** A hold is a guarded transition: it bumps the revision so in-flight guards miss. */
  setHold(id: string, hold: SandboxHold | null): void {
    this.db
      .prepare("UPDATE sandboxes SET hold_json = ?, revision = revision + 1 WHERE id = ?")
      .run(hold ? JSON.stringify(hold) : null, id);
  }

  setArchiveShared(id: string, shared: boolean): void {
    this.db.prepare("UPDATE sandboxes SET archive_shared = ? WHERE id = ?").run(shared ? 1 : 0, id);
  }

  setCgroupRel(id: string, cgroupRel: string | null): void {
    this.db.prepare("UPDATE sandboxes SET cgroup_rel = ? WHERE id = ?").run(cgroupRel, id);
  }

  /** Sandboxes owned by one tenant, for tenant status and cgroup cleanup. Never label-based. */
  byOwner(ownerKey: string): SandboxRow[] {
    return (
      this.db
        .prepare("SELECT * FROM sandboxes WHERE owner_key = ? ORDER BY created_at DESC")
        .all(ownerKey) as RawRow[]
    ).map((r) => this.hydrate(r));
  }

  /** Run `fn` inside one SQLite transaction (nested calls join the outer one). */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /** Resume grants fresh idle/archive grace, without rewriting usage or event lineage. */
  rebaseTimers(at = Date.now()): void {
    this.database.prepare(`UPDATE sandboxes SET last_activity_at = ?, revision = revision + 1,
      stopped_at = CASE WHEN stopped_at IS NULL THEN NULL ELSE ? END
      WHERE tier IN ('hot', 'warm', 'stopped', 'error')`).run(at, at);
  }

  touch(id: string, at = Date.now()): void {
    this.db.prepare("UPDATE sandboxes SET last_activity_at = ? WHERE id = ?").run(at, id);
  }

  setLabels(id: string, labels: Record<string, string>): void {
    const tx = this.db.transaction(() => this.replaceLabelsInTx(id, labels));
    tx();
  }

  mergeLabels(id: string, labels: Record<string, string>): void {
    const ins = this.db.prepare(
      "INSERT INTO labels (sandbox_id, key, value) VALUES (?, ?, ?) ON CONFLICT(sandbox_id, key) DO UPDATE SET value = excluded.value",
    );
    const tx = this.db.transaction(() => {
      for (const [k, v] of Object.entries(labels)) ins.run(id, k, v);
    });
    tx();
  }

  setRetention(id: string, archiveAfterMinutes: number): void {
    this.db.prepare("UPDATE sandboxes SET archive_after_minutes = ? WHERE id = ?").run(archiveAfterMinutes, id);
  }

  setResources(id: string, resources: ResourceSpec, ceiling: ResourceSpec): void {
    this.db
      .prepare("UPDATE sandboxes SET resources_json = ?, ceiling_json = ? WHERE id = ?")
      .run(JSON.stringify(resources), JSON.stringify(ceiling), id);
  }

  setArchive(
    id: string,
    archive: { key: string; sha256: string; size: number } | null,
  ): void {
    this.db
      .prepare("UPDATE sandboxes SET archive_key = ?, archive_sha256 = ?, archive_size = ? WHERE id = ?")
      .run(archive?.key ?? null, archive?.sha256 ?? null, archive?.size ?? null, id);
  }

  setCpuUsec(id: string, usec: number): void {
    this.db.prepare("UPDATE sandboxes SET last_cpu_usec = ? WHERE id = ?").run(usec, id);
  }

  delete(id: string): void {
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM labels WHERE sandbox_id = ?").run(id);
      this.db.prepare("DELETE FROM layer_refs WHERE sandbox_id = ?").run(id);
      this.db.prepare("DELETE FROM sandboxes WHERE id = ?").run(id);
    });
    tx();
  }

  /** Layers pinned by any sandbox, live or archived — an archive whose layers were pruned
   *  is an archive that cannot be restored (§5.2). */
  pinnedLayers(): Set<string> {
    return new Set(
      (this.db.prepare("SELECT DISTINCT digest FROM layer_refs").all() as { digest: string }[]).map(
        (r) => r.digest,
      ),
    );
  }

  usedNetIndexes(): Set<number> {
    return new Set(
      (this.db.prepare("SELECT net_index FROM sandboxes").all() as { net_index: number }[]).map(
        (r) => r.net_index,
      ),
    );
  }

  countByTier(): Record<Tier, number> {
    const out: Record<Tier, number> = { hot: 0, warm: 0, stopped: 0, archived: 0, error: 0 };
    for (const r of this.db
      .prepare("SELECT tier, COUNT(*) AS n FROM sandboxes GROUP BY tier")
      .all() as { tier: Tier; n: number }[]) {
      out[r.tier] = r.n;
    }
    return out;
  }
}
