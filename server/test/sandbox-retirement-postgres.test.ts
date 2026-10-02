/**
 * Safe operator retirement, rev5 manifest handshake (contract rev5 §11).
 *
 * Fake hosts speak the rev5 routes (hold / archive?verify=1 / exact import); a
 * legacy mode omits them to prove fail-closed. Tracked on every scenario: zero
 * DELETEs of sandboxes, zero force-archives, and import bodies carrying the exact
 * object + full policy with never an `env` key (no secrets cross the import wire).
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { closePool, initPool, query } from "../src/server/db/index.js";
import { uuidv7 } from "../src/server/ids.js";
import { SandboxClient } from "../src/core/providers/sandbox/client.js";
import type { PodOnHost, SandboxHostRow } from "../src/server/pods/sandboxfleet.js";
import {
  guardedRehome,
  readReconcileExpected,
  reconcileProviderArchived,
  releasePodHold,
} from "../src/server/pods/sandbox-retirement.js";

const databaseUrl = process.env["PI_POD_TEST_DATABASE_URL"];

interface HostRow {
  state: string;
  revision: number;
  stoppedAt: string | null;
  archive: { key: string; sha256: string; size: number } | null;
  hold: { holder: string; reason?: string; since: string } | null;
  owner?: { userKey: string } | null;
  /** Adopted-row policy snapshot (for same-key replay divergence checks). */
  egress?: { mode: string; hosts?: string[] };
  config?: {
    image: string;
    imageDigest: string;
    workdir: string;
    resources: { cpu: number; memoryGB: number; diskGB: number };
    egress: { mode: string; hosts?: string[] };
    archiveAfterMinutes: number;
    idleTimeoutMinutes: number;
    labels: Record<string, string>;
    owner: { userKey: string } | null;
  };
  /** Digest this host resolves image refs to (import equality check). */
  imageDigest?: string;
}

interface FakeHost {
  url: string;
  close(): Promise<void>;
  rows: Map<string, HostRow>;
  imports: Array<{ id: string; body: Record<string, unknown> }>;
  /** Bump row revision just before the hold CAS (race with the caller's pre-check). */
  bumpBeforeHold: Set<string>;
  /** Bump revision on the second info GET (instability between dual proofs). */
  bumpOnSecondInfoGet: Set<string>;
  /** Destroy the import socket mid-request (ambiguous adoption). */
  dropImport: Set<string>;
  /** Reset per-test info-GET counters (beforeEach hygiene). */
  resetInfoGets: () => void;
  /** Adopt normally, then destroy the socket without responding (adopted-ambiguous). */
  adoptThenDrop: Set<string>;
  /** Destroy the retire socket mid-request (ambiguous retirement). */
  dropRetire: Set<string>;
  /** Apply the retire, then destroy the socket without responding (lost response). */
  retireThenDrop: Set<string>;
  /** Persistently destroy info-route sockets, including bounded transport retries. */
  failInfo: Set<string>;
  /** Successful retire POSTs, in order (assert no retire happened). */
  retirePosts: Array<{ id: string; body: unknown }>;
  /** Merge into the adopted row right after a successful import (concurrent mutation). */
  mutateAfterImport: Map<string, Record<string, unknown>>;
  /** Image ref → manifest digest this host resolves (mismatch if planted otherwise). */
  images: Map<string, string>;
  holdPuts: Array<{ id: string; body: unknown }>;
  holdDeletes: Array<{ id: string; body: unknown }>;
  deletes: string[];
  archivePosts: string[];
  /** When false, hold/archive routes 404 (pre-rev5 host). */
  rev5: boolean;
  /** When true, import HEAD-verifies a pre-planted store row and 409s on mismatch. */
  strictImport: boolean;
  store: Map<string, { key: string; sha256: string; size: number }>;
  /** Native host identity served on healthz/manifests; tests bind it to registry ids. */
  hostId: string;
}

async function startFakeHost(): Promise<FakeHost> {
  const rows = new Map<string, HostRow>();
  const imports: Array<{ id: string; body: Record<string, unknown> }> = [];
  const bumpBeforeHold = new Set<string>();
  let hostId = "test";
  const bumpOnSecondInfoGet = new Set<string>();
  const infoGets = new Map<string, number>();
  const dropImport = new Set<string>();
  const adoptThenDrop = new Set<string>();
  const dropRetire = new Set<string>();
  const retireThenDrop = new Set<string>();
  const failInfo = new Set<string>();
  const retirePosts: Array<{ id: string; body: unknown }> = [];
  const mutateAfterImport = new Map<string, Record<string, unknown>>();
  const images = new Map<string, string>();
  const holdPuts: Array<{ id: string; body: unknown }> = [];
  const holdDeletes: Array<{ id: string; body: unknown }> = [];
  const deletes: string[] = [];
  const archivePosts: string[] = [];
  const store = new Map<string, { key: string; sha256: string; size: number }>();
  const flags = { rev5: true, strictImport: true };
  const server: Server = createServer((req, res) => {
    const url = req.url ?? "";
    const send = (code: number, body: unknown) => {
      res.statusCode = code;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
    };
    const readBody = (done: (body: Record<string, unknown>) => void) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        try {
          done(JSON.parse(Buffer.concat(chunks).toString()));
        } catch {
          done({});
        }
      });
    };
    if (req.method === "GET" && url === "/v1/authz") {
      return send(200, { ok: true, runtime: "test", archiveStore: "s3" });
    }
    if (req.method === "GET" && url === "/v1/healthz") {
      const GB = 1024 ** 3;
      return send(200, {
        ok: true,
        version: "test",
        uptimeSeconds: 1,
        hostId,
        sandboxes: { hot: 0, warm: 0, stopped: 0, archived: 0 },
        host: {
          cpus: 8,
          memoryTotalBytes: 16 * GB,
          memoryAvailableBytes: 8 * GB,
          guaranteeCapacity: { cpu: 8, memoryBytes: 16 * GB },
          committed: { cpu: 0, memoryBytes: 0, diskBytes: 0 },
          diskCapacityBytes: 100 * GB,
        },
      });
    }
    const holdMatch = url.match(/^\/v1\/sandboxes\/([^/]+)\/hold$/);
    if (holdMatch) {
      const id = decodeURIComponent(holdMatch[1]!);
      if (!flags.rev5) return send(404, { error: { code: "not_found", message: "nope" } });
      if (req.method === "PUT") {
        return readBody((body) => {
          holdPuts.push({ id, body });
          const row = rows.get(id);
          if (!row) return send(404, { error: { code: "not_found", message: "unknown" } });
          // A concurrent transition lands between the caller's pre-check GET and this
          // CAS: the expected revision is now stale and must refuse.
          if (bumpBeforeHold.delete(id)) row.revision += 1;
          if (row.state !== "archived") return send(409, { error: { code: "conflict", message: "hold is archived-only" } });
          const expected = body["expectedRevision"];
          if (expected !== undefined && expected !== row.revision) {
            return send(409, { error: { code: "stale_revision", message: "moved" } });
          }
          const holder = body["holder"];
          if (typeof holder !== "string" || holder.length === 0) {
            return send(400, { error: { code: "bad_request", message: "holder required" } });
          }
          if (row.hold && row.hold.holder !== holder) {
            return send(409, { error: { code: "conflict", message: "held by another" } });
          }
          row.hold = { holder, since: new Date().toISOString() };
          row.revision += 1;
          return send(200, infoBody(id, row));
        });
      }
      if (req.method === "DELETE") {
        return readBody((body) => {
          holdDeletes.push({ id, body });
          const row = rows.get(id);
          if (!row || !row.hold) return send(200, {});
          if (body["force"] === true || body["holder"] === row.hold.holder) {
            row.hold = null;
            return send(200, {});
          }
          return send(409, { error: { code: "conflict", message: "holder mismatch" } });
        });
      }
    }
    const archMatch = req.method === "GET" && url.match(/^\/v1\/sandboxes\/([^/]+)\/archive(\?.*)?$/);
    if (archMatch) {
      if (!flags.rev5) return send(404, { error: { code: "not_found", message: "nope" } });
      const id = decodeURIComponent(archMatch[1]!);
      const row = rows.get(id);
      if (!row) return send(404, { error: { code: "not_found", message: "unknown" } });
      if (!row.archive) return send(409, { error: { code: "conflict", message: "no archive" } });
      const withVerify = url.includes("verify=1");
      const stored = store.get(row.archive.key);
      const matches = withVerify
        ? stored !== undefined && stored.sha256 === row.archive.sha256 && stored.size === row.archive.size
        : undefined;
      const config = row.config ?? {
        image: "img",
        imageDigest: "sha256:row",
        workdir: "/workspace",
        resources: { cpu: 2, memoryGB: 4, diskGB: 20 },
        egress: { mode: "allowlist", hosts: [] },
        archiveAfterMinutes: 60,
        idleTimeoutMinutes: 15,
        labels: {},
        owner: row.owner ?? null,
      };
      return send(200, {
        id,
        hostId,
        tier: row.state === "started" ? "hot" : row.state === "archived" ? "archived" : "stopped",
        state: row.state,
        revision: row.revision,
        stoppedAt: row.stoppedAt,
        archive: row.archive,
        hold: row.hold,
        config,
        ...(withVerify
          ? { object: { present: stored !== undefined, size: stored?.size ?? null, sha256: stored?.sha256 ?? null, matches: matches === true } }
          : {}),
      });
    }
    const infoMatch = req.method === "GET" && url.match(/^\/v1\/sandboxes\/([^/]+)$/);
    if (infoMatch) {
      const id = decodeURIComponent(infoMatch[1]!);
      if (failInfo.has(id)) {
        req.socket.destroy();
        return;
      }
      const row = rows.get(id);
      if (!row) return send(404, { error: { code: "not_found", message: "unknown sandbox" } });
      const seen = (infoGets.get(id) ?? 0) + 1;
      infoGets.set(id, seen);
      if (seen >= 2 && bumpOnSecondInfoGet.delete(id)) row.revision += 1;
      return send(200, infoBody(id, row));
    }
    if (req.method === "POST" && url === "/v1/sandboxes/import") {
      return readBody((body) => {
        // Adopted-ambiguous sabotage: process normally, then destroy instead of
        // responding. The server must keep the fence and reconcile by retry.
        const silent = typeof body["id"] === "string" && adoptThenDrop.delete(body["id"] as string);
        const sendOrDrop = (code: number, b: unknown) => {
          if (silent && code === 200) {
            req.socket.destroy();
            return;
          }
          return send(code, b);
        };
        const id = body["id"];
        if (typeof id !== "string") return sendOrDrop(400, { error: { code: "bad_request", message: "id required" } });
        // Ambiguity sabotage: destroy the socket. The server cannot tell whether the
        // adoption landed — the only safe answer is keep-held + idempotent retry.
        if (dropImport.delete(id)) {
          imports.push({ id, body });
          req.socket.destroy();
          return;
        }
        const silentAdopt = adoptThenDrop.delete(id);
        imports.push({ id, body });
        const want = body["archive"] as { key?: unknown; sha256?: unknown; size?: unknown } | undefined;
        // Idempotent retry: the identical request replays success; same object with any
        // other divergence (policy included) is a 409 naming it — never silent first-wins.
        const dupe = rows.get(id);
        if (dupe && want && typeof want.key === "string") {
          const wantOwner = (body["owner"] as { userKey?: unknown } | undefined)?.userKey ?? null;
          const haveOwner = dupe.owner?.userKey ?? null;
          const sameObject = dupe.archive !== null && dupe.archive.key === want.key && dupe.archive.sha256 === want.sha256;
          const divergent: string[] = [];
          if (!sameObject || wantOwner !== haveOwner) divergent.push("archive/owner");
          // Compare against the row's persisted config egress (like the native row), not
          // only a top-level field: an aliased backend holds the source's own row.
          const haveEgress = dupe.egress ?? (dupe as { config?: { egress?: unknown } }).config?.egress ?? null;
          if (JSON.stringify(haveEgress) !== JSON.stringify(body["egress"] ?? null)) divergent.push("egress");
          if (dupe.imageDigest !== undefined && body["imageDigest"] !== undefined && dupe.imageDigest !== body["imageDigest"]) divergent.push("imageDigest");
          if (divergent.length === 0) return sendOrDrop(200, { id, state: "archived" });
          return sendOrDrop(409, { error: { code: "conflict", message: `already exists with different ${divergent.join(",")}` } });
        }
        // Digest equality BEFORE adoption: same tag, different bytes refuses cleanly.
        const wantDigest = body["imageDigest"];
        if (typeof wantDigest === "string") {
          const resolved = images.get(body["image"] as string) ?? wantDigest;
          if (resolved !== wantDigest) {
            return sendOrDrop(409, {
              error: {
                code: "image_mismatch",
                message: "image digest mismatch",
                details: { expected: wantDigest, actual: resolved },
              },
            });
          }
        }
        if (flags.strictImport && want && typeof want.key === "string") {
          const have = store.get(want.key);
          if (!have || have.sha256 !== want.sha256 || (typeof want.size === "number" && have.size !== want.size)) {
            return sendOrDrop(409, {
              error: {
                code: "archive_mismatch",
                message: "object mismatch",
                details: { kind: "archive", expected: want, actual: { present: have !== undefined, size: have?.size ?? null, sha256: have?.sha256 ?? null } },
              },
            });
          }
          const res = body["resources"] as { cpu?: unknown; memoryGB?: unknown; diskGB?: unknown } | undefined;
          rows.set(id, {
            state: "archived",
            revision: 1,
            stoppedAt: new Date().toISOString(),
            archive: { key: want.key, sha256: want.sha256 as string, size: typeof want.size === "number" ? want.size : (have?.size ?? 0) },
            hold: null,
            owner: (body["owner"] as { userKey: string } | undefined) ?? null,
            egress: (body["egress"] as { mode: string; hosts?: string[] } | undefined) ?? { mode: "allowlist", hosts: [] },
            imageDigest: body["imageDigest"] as string | undefined,
            // Persist the full import config so the manifest route serves it back
            // verbatim — this is what the target-manifest proof compares.
            config: {
              image: body["image"] as string,
              imageDigest: body["imageDigest"] as string,
              workdir: body["workdir"] as string,
              resources: (res ?? {}) as { cpu: number; memoryGB: number; diskGB: number },
              egress: (body["egress"] as { mode: string; hosts?: string[] } | undefined) ?? { mode: "allowlist", hosts: [] },
              archiveAfterMinutes: body["archiveAfterMinutes"] as number,
              idleTimeoutMinutes: body["idleTimeoutMinutes"] as number,
              labels: (body["labels"] as Record<string, string> | undefined) ?? {},
              owner: (body["owner"] as { userKey: string } | undefined) ?? null,
            },
          });
          // One-shot concurrent-mutation hook (tests): merged into the adopted row
          // AFTER adoption, BEFORE the response — the server's proof must catch it.
          // Tests plant complete replacement values (no partial merging performed here).
          const adoptedRow = rows.get(id)!;
          const mut = mutateAfterImport.get(id);
          if (mut) {
            mutateAfterImport.delete(id);
            Object.assign(adoptedRow, mut);
          }
          return sendOrDrop(200, { id, state: "archived" });
        }
        rows.set(id, {
          state: "archived",
          revision: 1,
          stoppedAt: new Date().toISOString(),
          archive: want && typeof want.key === "string" && typeof want.sha256 === "string"
            ? { key: want.key, sha256: want.sha256, size: typeof want.size === "number" ? want.size : 0 }
            : null,
          hold: null,
        });
        return sendOrDrop(200, { id, state: "archived" });
      });
    }
    const retireMatch = req.method === "POST" && url.match(/^\/v1\/sandboxes\/([^/]+)\/retire$/);
    if (retireMatch) {
      const id = decodeURIComponent(retireMatch[1]!);
      return readBody((body) => {
        if (dropRetire.delete(id)) {
          req.socket.destroy();
          return;
        }
        retirePosts.push({ id, body });
        const silent = retireThenDrop.delete(id);
        const row = rows.get(id);
        if (!row) return send(404, { error: { code: "not_found", message: "unknown" } });
        const holder = body["holder"];
        if (!row.hold || row.hold.holder !== holder) {
          return send(409, { error: { code: "sandbox_held", message: "retire by a different holder" } });
        }
        if (row.state !== "archived") {
          return send(409, { error: { code: "conflict", message: "only a fully archived source can be retired" } });
        }
        const expectedRevision = body["expectedRevision"];
        if (expectedRevision !== undefined && expectedRevision !== row.revision) {
          return send(409, { error: { code: "stale_revision", message: "moved" } });
        }
        const adopted = body["adoptedArchive"] as { key?: unknown; sha256?: unknown } | undefined;
        if (!row.archive || adopted?.key !== row.archive.key || adopted?.sha256 !== row.archive.sha256) {
          return send(409, {
            error: {
              code: "archive_mismatch",
              message: "adopted object differs",
              details: { kind: "archive", expected: adopted, actual: row.archive },
            },
          });
        }
        const archive = row.archive;
        rows.delete(id);
        if (silent) {
          req.socket.destroy();
          return;
        }
        return send(200, { retired: true, id, archive });
      });
    }
    const delMatch = req.method === "DELETE" && url.match(/^\/v1\/sandboxes\/([^/]+)$/);
    if (delMatch) {
      deletes.push(decodeURIComponent(delMatch[1]!));
      return send(200, {});
    }
    if (req.method === "POST" && /\/archive$/.test(url)) {
      archivePosts.push(url);
      return send(200, {});
    }
    return send(404, { error: { code: "not_found", message: "nope" } });
  });
  function infoBody(id: string, row: HostRow): unknown {
    return {
      id,
      labels: {},
      state: row.state,
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      image: "img",
      workdir: "/workspace",
      tier: row.state === "started" ? "hot" : "stopped",
      archiveAfterMinutes: 60,
      idleTimeoutMinutes: 15,
      resources: {},
      ceiling: {},
      revision: row.revision,
      runtimeGeneration: 1,
      stoppedAt: row.stoppedAt,
      archive: row.archive,
      hold: row.hold,
      ...(row.owner ? { owner: row.owner } : {}),
      ...(row.egress ? { egress: row.egress } : {}),
    };
  }
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    get hostId() {
      return hostId;
    },
    set hostId(v: string) {
      hostId = v;
    },
    close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
    rows,
    imports,
    bumpBeforeHold,
    bumpOnSecondInfoGet,
    resetInfoGets: () => infoGets.clear(),
    dropImport,
    adoptThenDrop,
    dropRetire,
    retireThenDrop,
    failInfo,
    retirePosts,
    mutateAfterImport,
    images,
    holdPuts,
    holdDeletes,
    deletes,
    archivePosts,
    store,
    get rev5() {
      return flags.rev5;
    },
    set rev5(v: boolean) {
      flags.rev5 = v;
    },
    get strictImport() {
      return flags.strictImport;
    },
    set strictImport(v: boolean) {
      flags.strictImport = v;
    },
  };
}

/**
 * Network-level alias: distinct URL, same backend. Forwards method + path + query +
 * auth header + body verbatim (streaming), preserving status codes.
 */
async function startAliasProxy(backend: string): Promise<{ url: string; close: () => Promise<void> }> {
  const { createServer, request } = await import("node:http");
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const target = new URL(req.url ?? "/", backend);
      const proxy = request(
        {
          hostname: target.hostname,
          port: target.port,
          path: target.pathname + target.search,
          method: req.method,
          headers: { ...req.headers, host: target.host },
        },
        (upstream) => {
          res.writeHead(upstream.statusCode ?? 502, upstream.headers as Record<string, string>);
          upstream.pipe(res);
        },
      );
      proxy.on("error", () => {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "bad_gateway", message: "alias proxy failed" } }));
      });
      proxy.end(body.length > 0 ? body : undefined);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("alias proxy listen failed");
  return {
    url: `http://127.0.0.1:${(address as AddressInfo).port}`,
    close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

describe("safe operator retirement, rev5 handshake (postgres)", {
  skip: databaseUrl ? false : "set PI_POD_TEST_DATABASE_URL",
}, () => {
  const orgId = uuidv7();
  const userId = uuidv7();
  const deps = { platformToken: "test-token" };
  let source: FakeHost;
  let target: FakeHost;

  // Registry rows are always bound to the fake's served native identity, mirroring the
  // operational convention (registry id == HOST_ID knob). Tests needing divergence set
  // fake.hostId explicitly afterwards (e.g. the alias test).
  async function registerHost(fake: FakeHost, id: string): Promise<SandboxHostRow> {
    await query(`INSERT INTO sandbox_hosts (id, url, status) VALUES ($1, $2, 'active')`, [id, fake.url]);
    fake.hostId = id;
    return { id, url: fake.url, status: "active", created_at: "", updated_at: "" };
  }

  function resolvedConfig(hostUrl: string, egressAllow: string[] = ["api.example.test"]): string {
    return JSON.stringify({
      config: {
        archiveAfterMinutes: 60,
        providers: { sandbox: { url: hostUrl } },
        egress: { mode: "allowlist", allow: egressAllow },
        resources: { cpu: 2, memoryGB: 4, diskGB: 20 },
      },
      workdir: "/workspace",
      image: { ref: "img" },
      retention: {
        idleTimeoutMinutes: 15,
        providerIdleTimeoutMinutes: 15,
        archiveTransition: { kind: "after-stop", maxDelayDays: 30 },
        effectiveArchiveAfterMinutes: 60,
        providerExpiryDocumented: true,
      },
    });
  }

  async function makePod(args: {
    hostUrl: string;
    providerState?: string;
    state?: string;
    sandboxId?: string | null;
    egressAllow?: string[];
  }): Promise<{ id: string; row: PodOnHost }> {
    const id = uuidv7();
    const sandboxId = args.sandboxId === null ? null : (args.sandboxId ?? `sb-${id}`);
    await query(
      `INSERT INTO pods (id, org_id, user_id, name, provider, provider_sandbox_id, state, provider_state,
                         provider_state_changed_at, resolved_config)
       VALUES ($1, $2, $3, 'retire fixture', 'sandbox', $4, $5, $6, now(), $7::jsonb)`,
      [id, orgId, userId, sandboxId, args.state ?? "active", args.providerState ?? "archived", resolvedConfig(args.hostUrl, args.egressAllow)],
    );
    const row = {
      id,
      org_id: orgId,
      name: "retire fixture",
      state: args.state ?? "active",
      provider_state: args.providerState ?? "archived",
      provider_sandbox_id: sandboxId,
      resolved_config: JSON.parse(resolvedConfig(args.hostUrl, args.egressAllow)),
    } as PodOnHost;
    return { id, row };
  }

  async function dbSandboxUrl(podId: string): Promise<string | null> {
    const rows = await query<{ url: string | null }>(
      `SELECT resolved_config -> 'config' -> 'providers' -> 'sandbox' ->> 'url' AS url FROM pods WHERE id = $1`,
      [podId],
    );
    return rows.rows[0]!.url;
  }

  function plantSource(id: string, over: Partial<HostRow> = {}): HostRow {
    const key = `${id}/upper-aaaa.tar.zst`;
    const row: HostRow = {
      state: "archived",
      revision: 3,
      stoppedAt: new Date(Date.now() - 48 * 3600_000).toISOString(),
      archive: { key, sha256: "aaaa", size: 400 * 1024 * 1024 },
      hold: null,
      config: {
        image: "img",
        imageDigest: "sha256:planted",
        workdir: "/workspace",
        resources: { cpu: 2, memoryGB: 4, diskGB: 20 },
        egress: { mode: "allowlist", hosts: ["api.example.test"] },
        archiveAfterMinutes: 60,
        idleTimeoutMinutes: 15,
        labels: {},
        owner: null,
      },
      ...over,
    };
    if (row.owner && row.config) row.config = { ...row.config, owner: row.owner };
    source.rows.set(id, row);
    source.store.set(key, { key, sha256: "aaaa", size: 400 * 1024 * 1024 });
    // Shared store: the target sees the same object until it adopts it.
    target.store.set(key, { key, sha256: "aaaa", size: 400 * 1024 * 1024 });
    return row;
  }

  before(async () => {
    initPool(databaseUrl!);
    source = await startFakeHost();
    target = await startFakeHost();
    await query("INSERT INTO organizations (id, name) VALUES ($1, 'retirement test')", [orgId]);
    await query("INSERT INTO users (id, email) VALUES ($1, $2)", [userId, `${userId}@example.test`]);
  });

  after(async () => {
    await source.close();
    await target.close();
    await query("DELETE FROM push_queue WHERE user_id = $1", [userId]).catch(() => {});
    await query("DELETE FROM pod_retention WHERE pod_id IN (SELECT id FROM pods WHERE org_id = $1)", [orgId]);
    await query("DELETE FROM pod_rehome_state WHERE pod_id IN (SELECT id FROM pods WHERE org_id = $1)", [orgId]).catch(() => {});
    await query("DELETE FROM pods WHERE org_id = $1", [orgId]);
    await query("DELETE FROM audit_log WHERE org_id = $1", [orgId]);
    await query("DELETE FROM sandbox_hosts");
    await query("DELETE FROM users WHERE id = $1", [userId]);
    await query("DELETE FROM organizations WHERE id = $1", [orgId]);
    await closePool();
  });

  beforeEach(async () => {
    await query("DELETE FROM push_queue WHERE user_id = $1", [userId]).catch(() => {});
    await query("DELETE FROM pod_retention WHERE pod_id IN (SELECT id FROM pods WHERE org_id = $1)", [orgId]);
    await query("DELETE FROM pod_rehome_state WHERE pod_id IN (SELECT id FROM pods WHERE org_id = $1)", [orgId]).catch(() => {});
    await query("DELETE FROM pods WHERE org_id = $1", [orgId]);
    await query("DELETE FROM audit_log WHERE org_id = $1", [orgId]);
    await query("DELETE FROM sandbox_hosts");
    for (const h of [source, target]) {
      h.rows.clear();
      h.store.clear();
      h.imports.length = 0;
      h.holdPuts.length = 0;
      h.holdDeletes.length = 0;
      h.deletes.length = 0;
      h.archivePosts.length = 0;
      h.bumpBeforeHold.clear();
      h.hostId = "test";
      h.bumpOnSecondInfoGet.clear();
      h.resetInfoGets();
      h.mutateAfterImport.clear();
      h.dropImport.clear();
      h.dropRetire.clear();
      h.retireThenDrop.clear();
      h.failInfo.clear();
      h.retirePosts.length = 0;
      h.images.clear();
      h.rev5 = true;
      h.strictImport = true;
    }
  });

  it("holds, verifies, imports the exact object, proves adoption, repoints, keeps the hold", async () => {
    const host = await registerHost(source, "src-a");
    await registerHost(target, "dst-a");
    plantSource("sb-m", { owner: { userKey: "u_owner1" } });
    const { id } = await makePod({ hostUrl: source.url, sandboxId: "sb-m" });
    assert.equal(host.id, "src-a");
    const result = await guardedRehome(deps, "src-a", {
      approved: true,
      quiescenceAttested: true,
      minQuietSecs: 0,
      actorId: null,
    });
    assert.equal(result.skipped.length, 0);
    assert.equal(result.moved.length, 1);
    assert.equal(await dbSandboxUrl(id), target.url);
    // Fence was taken with revision CAS.
    assert.equal(source.holdPuts.length, 1);
    assert.equal((source.holdPuts[0]!.body as { expectedRevision: number }).expectedRevision, 3);
    // Import carries the EXACT object + verbatim manifest config, never env/secrets.
    assert.equal(target.imports.length, 1);
    const body = target.imports[0]!.body;
    assert.deepEqual(body["archive"], { key: "sb-m/upper-aaaa.tar.zst", sha256: "aaaa", size: 400 * 1024 * 1024 });
    assert.equal(body["imageDigest"], "sha256:planted", "digest proof sent verbatim");
    assert.equal(body["archiveAfterMinutes"], 60, "manifest archive timer preserved");
    assert.equal(body["idleTimeoutMinutes"], 15, "manifest idle preserved");
    assert.deepEqual(body["resources"], { cpu: 2, memoryGB: 4, diskGB: 20 }, "manifest ceiling preserved");
    assert.deepEqual(body["owner"], { userKey: "u_owner1" }, "recorded owner forwarded");
    const egress = body["egress"] as { mode: string; hosts?: string[] };
    assert.deepEqual(egress, { mode: "allowlist", hosts: ["api.example.test"] }, "egress verbatim, never opened");
    assert.ok(!("env" in body), "import must never carry environment/secrets");
    assert.ok(!JSON.stringify(body).includes("sk-"), "no secret material in the import body");
    // Atomic retire consumed the fenced source row; the shared object stays.
    assert.equal(result.moved[0]!.retired, true);
    assert.equal(source.rows.has("sb-m"), false, "source row retired");
    assert.equal(source.holdDeletes.length, 0, "retire consumes the hold, never releases it");
    assert.equal(source.deletes.length + target.deletes.length, 0, "no source cleanup");
    assert.equal(source.archivePosts.length + target.archivePosts.length, 0, "rehome never archives");
    const audits = await query<{ detail: Record<string, unknown> }>(
      `SELECT detail FROM audit_log WHERE org_id = $1 AND action = 'pod.rehomed'`,
      [orgId],
    );
    assert.equal(audits.rows.length, 1);
    assert.equal((audits.rows[0]!.detail as { archiveKey: string }).archiveKey, "sb-m/upper-aaaa.tar.zst");
  });

  it("refuses digest divergence on import and keeps the fence (no auto-release)", async () => {
    await registerHost(source, "src-dg");
    await registerHost(target, "dst-dg");
    plantSource("sb-dg");
    // Same tag, different bytes on the target: the workspace was built against the source.
    target.images.set("img", "sha256:other");
    const { id } = await makePod({ hostUrl: source.url, sandboxId: "sb-dg" });
    const result = await guardedRehome(deps, "src-dg", {
      approved: true,
      quiescenceAttested: true,
      minQuietSecs: 0,
      actorId: null,
    });
    assert.equal(result.moved.length, 0);
    assert.match(result.skipped[0]!.reason, /image_mismatch|exact object/i);
    assert.equal(await dbSandboxUrl(id), source.url);
    // Even a definitive refusal keeps the fence: a pre-existing same-holder hold can
    // already represent a prior adoption, and holders do not serialize operators.
    // Recovery is proof-gated manual release, never automatic.
    assert.ok(source.rows.get("sb-dg")!.hold, "fence stands after refusal");
    assert.equal(source.holdDeletes.length, 0, "no automatic release, ever");
  });

  it("reports retire-pending on ambiguous retire without unmoving", async () => {
    await registerHost(source, "src-rt");
    await registerHost(target, "dst-rt");
    plantSource("sb-rt");
    const { id } = await makePod({ hostUrl: source.url, sandboxId: "sb-rt" });
    source.dropRetire.add("sb-rt");
    const result = await guardedRehome(deps, "src-rt", {
      approved: true,
      quiescenceAttested: true,
      minQuietSecs: 0,
      actorId: null,
    });
    // Pointer committed, source cleanup unknown: honest pending, never assumed.
    assert.equal(result.moved.length, 1);
    assert.equal(result.moved[0]!.retired, false);
    assert.match(result.moved[0]!.retireDetail, /ambiguous|retry/i);
    assert.equal(await dbSandboxUrl(id), target.url, "committed repoint stands");
    assert.ok(source.rows.get("sb-rt")!.hold, "fence stands for reconcile");
    // Explicit recovery completes it: same holder, re-derived adopted object.
    const { retireSourceRow } = await import("../src/server/pods/sandbox-retirement.js");
    const recovered = await retireSourceRow(deps, {
      source: { id: "src-rt", url: source.url, status: "active", created_at: "", updated_at: "" },
      podId: id,
      holder: `rehome:${id}`,
    });
    assert.equal(recovered.retired, true);
    assert.equal(source.rows.has("sb-rt"), false);
  });

  it("refuses retire while the pointer still names the source, even with stage evidence", async () => {
    await registerHost(source, "src-ab");
    await registerHost(target, "dst-ab");
    // Prior attempt adopted, then crashed before repoint: pointer on source, stage says
    // imported, target verifiably adopted. Retiring now would delete the only routed
    // row and strand the pod on a 404 — refuse so the move is retried to commit first.
    plantSource("sb-ab2");
    const { id } = await makePod({ hostUrl: source.url, sandboxId: "sb-ab2" });
    const client = new SandboxClient(source.url, "test-token");
    await client.json("PUT", "/v1/sandboxes/sb-ab2/hold", { holder: `rehome:${id}`, expectedRevision: 3 });
    const key = "sb-ab2/upper-aaaa.tar.zst";
    target.store.set(key, { key, sha256: "aaaa", size: 400 * 1024 * 1024 });
    const tclient = new SandboxClient(target.url, "test-token");
    await tclient.json("POST", "/v1/sandboxes/import", {
      id: "sb-ab2",
      image: "img",
      workdir: "/workspace",
      archive: { key, sha256: "aaaa", size: 400 * 1024 * 1024 },
    });
    await query(
      `INSERT INTO pod_rehome_state (pod_id, holder, stage, target_url, source_url, archive_key)
       VALUES ($1, $2, 'imported', $3, $4, $5)`,
      [id, `rehome:${id}`, target.url, source.url, key],
    );
    const { retireSourceRow } = await import("../src/server/pods/sandbox-retirement.js");
    const refused = await retireSourceRow(deps, {
      source: { id: "src-ab", url: source.url, status: "active", created_at: "", updated_at: "" },
      podId: id,
      holder: `rehome:${id}`,
    });
    assert.equal(refused.retired, false);
    assert.match(refused.detail, /pointer still names the source|commit the pointer first/i);
    assert.equal(await dbSandboxUrl(id), source.url, "pointer unchanged");
    assert.ok(source.rows.has("sb-ab2"), "source row never retired");
    assert.ok(source.rows.get("sb-ab2")!.hold, "fence stands");
    assert.equal(source.deletes.length, 0, "no deletes anywhere");
    // Recovery is a guarded retry (exact replay → idempotent 200 → repoint → retire),
    // covered by the idempotent-retry test — never a direct retire while routed here.
  });

  it("refuses when both registry URLs route to the same native (alias), retiring nothing", async () => {
    // Distinct registry URLs, ONE backend: the target entry is a network-level alias
    // for the source (stale DNS, misconfig). The aliased target replays the source's
    // own exact data through every content check — only the identity binding catches
    // it. Without it, the move would repoint to the alias and retire the ONLY source
    // row: total loss masquerading as success.
    await registerHost(source, "src-alias");
    const proxy = await startAliasProxy(source.url);
    try {
      await query(`INSERT INTO sandbox_hosts (id, url, status) VALUES ('dst-alias', $1, 'active')`, [
        proxy.url,
      ]);
      plantSource("sb-al");
      const { id } = await makePod({ hostUrl: source.url, sandboxId: "sb-al" });
      const result = await guardedRehome(deps, "src-alias", {
        approved: true,
        quiescenceAttested: true,
        minQuietSecs: 0,
        actorId: null,
      });
      assert.equal(result.moved.length, 0);
      assert.match(result.skipped[0]!.reason, /alias|host .*expected|identity/i);
      assert.equal(await dbSandboxUrl(id), source.url, "no repoint to the alias");
      assert.ok(source.rows.has("sb-al"), "source row never retired");
      assert.equal(source.deletes.length, 0, "no deletes anywhere");
    } finally {
      await proxy.close();
    }
  });

  it("keeps the hold when import is ambiguous, never enabling two writers", async () => {
    await registerHost(source, "src-a2");
    await registerHost(target, "dst-a2");
    plantSource("sb-amb");
    const { id } = await makePod({ hostUrl: source.url, sandboxId: "sb-amb" });
    target.dropImport.add("sb-amb");
    const result = await guardedRehome(deps, "src-a2", {
      approved: true,
      quiescenceAttested: true,
      minQuietSecs: 0,
      actorId: null,
    });
    assert.equal(result.moved.length, 0);
    assert.match(result.skipped[0]!.reason, /fenced|reconcile/i);
    assert.equal(await dbSandboxUrl(id), source.url);
    // Fence stands: no release on the ambiguous path, no deletes anywhere.
    assert.ok(source.rows.get("sb-amb")!.hold, "source stays fenced");
    assert.equal(source.holdDeletes.length, 0);
    assert.equal(source.deletes.length + target.deletes.length, 0);
  });

  it("refuses incomplete ceilings rather than normalizing to maximums", async () => {
    await registerHost(source, "src-r");
    await registerHost(target, "dst-r");
    // A manifest whose persisted ceiling is partial: adopting it would normalize the
    // omissions to host maximums, so the move refuses before fencing anything.
    plantSource("sb-part", {
      config: {
        image: "img",
        imageDigest: "sha256:planted",
        workdir: "/workspace",
        resources: { cpu: 2 } as never,
        egress: { mode: "allowlist", hosts: [] },
        archiveAfterMinutes: 60,
        idleTimeoutMinutes: 15,
        labels: {},
        owner: null,
      },
    });
    const { id } = await makePod({ hostUrl: source.url, sandboxId: "sb-part" });
    const result = await guardedRehome(deps, "src-r", {
      approved: true,
      quiescenceAttested: true,
      minQuietSecs: 0,
      actorId: null,
    });
    assert.equal(result.moved.length, 0);
    assert.match(result.skipped[0]!.reason, /incomplete|maximums/i);
    assert.equal(await dbSandboxUrl(id), source.url);
    assert.equal(target.imports.length, 0, "no import with a partial ceiling");
  });

  it("skips pre-manifest hosts without touching them", async () => {
    await registerHost(source, "src-b");
    await registerHost(target, "dst-b");
    source.rev5 = false;
    plantSource("sb-old");
    const { id } = await makePod({ hostUrl: source.url, sandboxId: "sb-old" });
    const result = await guardedRehome(deps, "src-b", {
      approved: true,
      quiescenceAttested: true,
      minQuietSecs: 0,
      actorId: null,
    });
    assert.equal(result.moved.length, 0);
    assert.match(result.skipped[0]!.reason, /fence|manifest|hold/i);
    assert.equal(await dbSandboxUrl(id), source.url);
    assert.equal(target.imports.length, 0, "no import without the fence");
  });

  it("skips on stale hold revision and on failed store verification", async () => {
    await registerHost(source, "src-c");
    await registerHost(target, "dst-c");
    // Stale: source moves between the pre-check GET and the hold CAS.
    plantSource("sb-stale", { revision: 3 });
    const stale = await makePod({ hostUrl: source.url, sandboxId: "sb-stale" });
    source.bumpBeforeHold.add("sb-stale");
    const r1 = await guardedRehome(deps, "src-c", {
      approved: true,
      quiescenceAttested: true,
      minQuietSecs: 0,
      actorId: null,
    });
    assert.equal(r1.moved.length, 0);
    assert.equal(await dbSandboxUrl(stale.id), source.url);
    // Unverified object: store drops the key after the hold lands.
    plantSource("sb-unver");
    const unver = await makePod({ hostUrl: source.url, sandboxId: "sb-unver" });
    source.store.delete("sb-unver/upper-aaaa.tar.zst");
    const r2 = await guardedRehome(deps, "src-c", {
      approved: true,
      quiescenceAttested: true,
      minQuietSecs: 0,
      actorId: null,
    });
    const mine = r2.skipped.find((s) => s.pod === unver.id);
    assert.ok(mine, "unverified object skips");
    assert.match(mine.reason, /verification|matches|store/i);
  });

  it("keeps the hold on abort and reconciles idempotently on retry", async () => {
    await registerHost(source, "src-d");
    await registerHost(target, "dst-d");
    plantSource("sb-ab");
    // Target store lacks the object entirely: exact import 409s.
    target.store.clear();
    const { id } = await makePod({ hostUrl: source.url, sandboxId: "sb-ab" });
    const r1 = await guardedRehome(deps, "src-d", {
      approved: true,
      quiescenceAttested: true,
      minQuietSecs: 0,
      actorId: null,
    });
    assert.equal(r1.moved.length, 0);
    assert.equal(await dbSandboxUrl(id), source.url);
    // Abort keeps the fence (target never started): the retry re-uses the same holder.
    assert.equal(source.holdDeletes.length, 0, "no automatic release, ever");
    assert.ok(source.rows.get("sb-ab")!.hold, "fence stands for reconcile");
    // Heal the store and retry with the same holder: idempotent completion.
    target.store.set("sb-ab/upper-aaaa.tar.zst", { key: "sb-ab/upper-aaaa.tar.zst", sha256: "aaaa", size: 400 * 1024 * 1024 });
    const r2 = await guardedRehome(deps, "src-d", {
      approved: true,
      quiescenceAttested: true,
      minQuietSecs: 0,
      actorId: null,
    });
    assert.equal(r2.moved.length, 1);
    assert.equal(await dbSandboxUrl(id), target.url);
  });

  it("refuses repoint when the target store cannot serve the exact object", async () => {
    await registerHost(source, "src-e");
    await registerHost(target, "dst-e");
    plantSource("sb-k");
    // The target store holds only a diverged object: exact import must 409, and no
    // repoint may happen onto anything but the source's verified key.
    target.store.delete("sb-k/upper-aaaa.tar.zst");
    target.store.set("sb-k/upper-bbbb.tar.zst", { key: "sb-k/upper-bbbb.tar.zst", sha256: "bbbb", size: 1 });
    const { id } = await makePod({ hostUrl: source.url, sandboxId: "sb-k" });
    const result = await guardedRehome(deps, "src-e", {
      approved: true,
      quiescenceAttested: true,
      minQuietSecs: 0,
      actorId: null,
    });
    assert.equal(result.moved.length, 0);
    assert.ok(
      result.skipped.some((s) => /mismatch|different|adoption/i.test(s.reason)),
      JSON.stringify(result.skipped),
    );
    assert.equal(await dbSandboxUrl(id), source.url, "no repoint onto a diverged object");
  });

  it("refuses post-adopt owner divergence with the fence held", async () => {
    // Owner flip after adoption: the served manifest no longer equals the source one.
    await registerHost(source, "src-mo");
    await registerHost(target, "dst-mo");
    plantSource("sb-mo", { owner: { userKey: "u_owner1" } });
    target.mutateAfterImport.set("sb-mo", {
      config: {
        image: "img",
        imageDigest: "sha256:planted",
        workdir: "/workspace",
        resources: { cpu: 2, memoryGB: 4, diskGB: 20 },
        egress: { mode: "allowlist", hosts: ["api.example.test"] },
        archiveAfterMinutes: 60,
        idleTimeoutMinutes: 15,
        labels: {},
        owner: { userKey: "u_intruder" },
      },
    });
    const owned = await makePod({ hostUrl: source.url, sandboxId: "sb-mo" });
    const rOwned = await guardedRehome(deps, "src-mo", {
      approved: true,
      quiescenceAttested: true,
      minQuietSecs: 0,
      actorId: null,
    });
    assert.equal(rOwned.moved.length, 0);
    assert.match(rOwned.skipped[0]!.reason, /persisted config differs/i);
    assert.equal(await dbSandboxUrl(owned.id), source.url);
    assert.ok(source.rows.get("sb-mo")!.hold, "fence stands");
  });

  it("refuses post-adopt timer/ceiling/digest drift with the fence held", async () => {
    await registerHost(source, "src-md");
    await registerHost(target, "dst-md");
    plantSource("sb-md");
    const baseConfig = {
      image: "img",
      imageDigest: "sha256:planted",
      workdir: "/workspace",
      resources: { cpu: 2, memoryGB: 4, diskGB: 20 },
      egress: { mode: "allowlist", hosts: ["api.example.test"] },
      archiveAfterMinutes: 60,
      idleTimeoutMinutes: 15,
      labels: {},
      owner: null,
    };
    for (const [suffix, mutate] of [
      ["timers", { archiveAfterMinutes: 5 }],
      ["ceilings", { resources: { cpu: 8, memoryGB: 4, diskGB: 20 } }],
      ["digest", { imageDigest: "sha256:drifted" }],
    ] as const) {
      const id = `sb-md-${suffix}`;
      const key = `${id}/upper-aaaa.tar.zst`;
      source.rows.set(id, {
        state: "archived",
        revision: 3,
        stoppedAt: new Date(Date.now() - 48 * 3600_000).toISOString(),
        archive: { key, sha256: "aaaa", size: 400 * 1024 * 1024 },
        hold: null,
        config: { ...baseConfig },
      });
      source.store.set(key, { key, sha256: "aaaa", size: 400 * 1024 * 1024 });
      target.store.set(key, { key, sha256: "aaaa", size: 400 * 1024 * 1024 });
      target.mutateAfterImport.set(id, { config: { ...baseConfig, ...mutate } });
      const made = await makePod({ hostUrl: source.url, sandboxId: id });
      const result = await guardedRehome(deps, `src-md`, {
        approved: true,
        quiescenceAttested: true,
        minQuietSecs: 0,
        actorId: null,
      });
      void made;
      assert.equal(result.moved.length, 0, `drifted ${suffix} must not move`);
      assert.match(result.skipped[0]!.reason, /persisted config differs/i);
    }
    // Exact success still moves (control case for the equality gate above).
    plantSource("sb-md-ok");
    const okMade = await makePod({ hostUrl: source.url, sandboxId: "sb-md-ok" });
    const okResult = await guardedRehome(deps, "src-md", {
      approved: true,
      quiescenceAttested: true,
      minQuietSecs: 0,
      actorId: null,
    });
    assert.equal(okResult.moved.length, 1);
    assert.equal(okResult.moved[0]!.retired, true);
    assert.equal(await dbSandboxUrl(okMade.id), target.url);
  });

  it("fails closed on a legacy target without the manifest route", async () => {
    await registerHost(source, "src-lg");
    await registerHost(target, "dst-lg");
    plantSource("sb-lg");
    target.rev5 = false;
    const { id } = await makePod({ hostUrl: source.url, sandboxId: "sb-lg" });
    const result = await guardedRehome(deps, "src-lg", {
      approved: true,
      quiescenceAttested: true,
      minQuietSecs: 0,
      actorId: null,
    });
    assert.equal(result.moved.length, 0);
    assert.match(result.skipped[0]!.reason, /manifest/i);
    assert.equal(await dbSandboxUrl(id), source.url, "no repoint without manifest proof");
    // The source fence was taken and — with no target deletion anywhere — still stands.
    assert.ok(source.rows.get("sb-lg")!.hold, "fence stands");
    assert.equal(target.deletes.length, 0, "no target deletion on failure");
    assert.equal(source.deletes.length, 0, "no source deletion on failure");
  });

  it("skips on import conflict without GET recovery, then completes on exact retry", async () => {
    await registerHost(source, "src-pc");
    await registerHost(target, "dst-pc");
    plantSource("sb-pc");
    const key = "sb-pc/upper-aaaa.tar.zst";
    // Same key but a different owner: native 409s the replay as a divergent request.
    target.rows.set("sb-pc", {
      state: "archived",
      revision: 1,
      stoppedAt: new Date().toISOString(),
      archive: { key, sha256: "aaaa", size: 400 * 1024 * 1024 },
      hold: null,
      owner: { userKey: "u_other" },
      egress: { mode: "allowlist", hosts: ["api.example.test"] },
    });
    const { id } = await makePod({ hostUrl: source.url, sandboxId: "sb-pc" });
    // Import 409s AND the move still skips: only an exact retry's 200 proceeds, never
    // a GET-recovery that checks key/egress alone (owner/digest/ceiling/timers/labels
    // would be silently accepted). The fence stands for the retry.
    const result = await guardedRehome(deps, "src-pc", {
      approved: true,
      quiescenceAttested: true,
      minQuietSecs: 0,
      actorId: null,
    });
    assert.equal(result.moved.length, 0);
    assert.equal(await dbSandboxUrl(id), source.url);
    assert.ok(source.rows.get("sb-pc")!.hold, "fence stands");
    assert.equal(source.holdDeletes.length, 0, "no automatic release, ever");
    // Operator clears the foreign row (target-side abort-cleanup; object retained by
    // design), then the exact retry replays 200 idempotently and completes.
    target.rows.delete("sb-pc");
    const retry = await guardedRehome(deps, "src-pc", {
      approved: true,
      quiescenceAttested: true,
      minQuietSecs: 0,
      actorId: null,
    });
    assert.equal(retry.moved.length, 1);
    assert.equal(await dbSandboxUrl(id), target.url);
  });

  it("refuses same-key adoption with diverged egress (no silent first-wins)", async () => {
    await registerHost(source, "src-pd");
    await registerHost(target, "dst-pd");
    plantSource("sb-pd");
    const key = "sb-pd/upper-aaaa.tar.zst";
    // Same object, different policy (e.g. adopted by a drifted older attempt).
    target.rows.set("sb-pd", {
      state: "archived",
      revision: 1,
      stoppedAt: new Date().toISOString(),
      archive: { key, sha256: "aaaa", size: 400 * 1024 * 1024 },
      hold: null,
      egress: { mode: "allowlist", hosts: ["other.example.test"] },
    });
    const { id } = await makePod({ hostUrl: source.url, sandboxId: "sb-pd" });
    const result = await guardedRehome(deps, "src-pd", {
      approved: true,
      quiescenceAttested: true,
      minQuietSecs: 0,
      actorId: null,
    });
    assert.equal(result.moved.length, 0);
    assert.match(result.skipped[0]!.reason, /refused|unproven|fenced|reconcile/i);
    assert.equal(await dbSandboxUrl(id), source.url);
    assert.ok(source.rows.get("sb-pd")!.hold, "fence stands");
  });

  it("recovers an ambiguous-but-landed import via exact retry, not GET acceptance", async () => {
    await registerHost(source, "src-aq");
    await registerHost(target, "dst-aq");
    plantSource("sb-aq");
    const { id } = await makePod({ hostUrl: source.url, sandboxId: "sb-aq" });
    // Adopted, then the response is lost: the attempt aborts fenced anyway.
    target.adoptThenDrop.add("sb-aq");
    const first = await guardedRehome(deps, "src-aq", {
      approved: true,
      quiescenceAttested: true,
      minQuietSecs: 0,
      actorId: null,
    });
    assert.equal(first.moved.length, 0);
    assert.equal(await dbSandboxUrl(id), source.url);
    assert.ok(source.rows.get("sb-aq")!.hold, "fence stands");
    // Exact retry replays 200 idempotently and the move completes with proof.
    const retry = await guardedRehome(deps, "src-aq", {
      approved: true,
      quiescenceAttested: true,
      minQuietSecs: 0,
      actorId: null,
    });
    assert.equal(retry.moved.length, 1);
    assert.equal(retry.moved[0]!.retired, true);
    assert.equal(await dbSandboxUrl(id), target.url);
  });

  it("survives ambiguous adoption plus a pre-POST failure on retry without releasing", async () => {
    await registerHost(source, "src-pa");
    await registerHost(target, "dst-pa");
    plantSource("sb-pa");
    const { id } = await makePod({ hostUrl: source.url, sandboxId: "sb-pa" });
    // Attempt 1: response destroyed before processing (ambiguous outcome).
    target.dropImport.add("sb-pa");
    const r1 = await guardedRehome(deps, "src-pa", {
      approved: true,
      quiescenceAttested: true,
      minQuietSecs: 0,
      actorId: null,
    });
    assert.equal(r1.moved.length, 0);
    assert.equal(await dbSandboxUrl(id), source.url);
    // Attempt 2 fails BEFORE its import POST (target deregistered): the pre-existing
    // same-holder hold may already represent attempt 1's adoption — no release.
    await query(`DELETE FROM sandbox_hosts WHERE id = 'dst-pa'`);
    const r2 = await guardedRehome(deps, "src-pa", {
      approved: true,
      quiescenceAttested: true,
      minQuietSecs: 0,
      actorId: null,
    });
    assert.equal(r2.moved.length, 0);
    assert.ok(source.rows.get("sb-pa")!.hold, "pre-existing hold survives a pre-POST failure");
    assert.equal(source.holdDeletes.length, 0, "no automatic release, ever");
  });

  it("serializes concurrent same-holder moves: exactly one wins", async () => {
    await registerHost(source, "src-cc");
    await registerHost(target, "dst-cc");
    plantSource("sb-cc");
    const { id } = await makePod({ hostUrl: source.url, sandboxId: "sb-cc" });
    const run = () =>
      guardedRehome(deps, "src-cc", {
        approved: true,
        quiescenceAttested: true,
        minQuietSecs: 0,
        actorId: null,
      });
    const [a, b] = await Promise.all([run(), run()]);
    assert.equal(a.moved.length + b.moved.length, 1, "exactly one concurrent move wins");
    assert.equal(await dbSandboxUrl(id), target.url);
    assert.equal(source.rows.has("sb-cc"), false, "source retired exactly once");
  });

  it("converges error→archived only on host confirmation, preserving logical state", async () => {
    const host = await registerHost(source, "src-f");
    source.rows.set("sb-x", {
      state: "archived",
      revision: 4,
      stoppedAt: new Date(Date.now() - 3600_000).toISOString(),
      archive: { key: "sb-x/upper-aaaa.tar.zst", sha256: "aaaa", size: 1 },
      hold: null,
    });
    source.store.set("sb-x/upper-aaaa.tar.zst", { key: "sb-x/upper-aaaa.tar.zst", sha256: "aaaa", size: 1 });
    const { row } = await makePod({ hostUrl: source.url, providerState: "error", state: "archived", sandboxId: "sb-x" });
    const expected = await readReconcileExpected(row.id);
    assert.ok(expected, "expected identity readable");
    const result = await reconcileProviderArchived(deps, { host, pod: row, actorId: null, expected: expected! });
    assert.equal(result.converged, true);
    const db = await query<{ provider_state: string; state: string }>(
      `SELECT provider_state, state FROM pods WHERE id = $1`,
      [row.id],
    );
    assert.equal(db.rows[0]!.provider_state, "archived");
    assert.equal(db.rows[0]!.state, "archived", "logical hidden state preserved");
    // No-release rule: the fence stays even on success, fenced under the SAME holder
    // the guarded rehome re-PUTs idempotently; guidance routes there explicitly.
    assert.equal(source.rows.get("sb-x")!.hold?.holder, `rehome:${row.id}`);
    assert.equal(source.holdDeletes.length, 0, "no release attempted, ever");
    assert.match(result.detail, /guarded rehome/i);
  });

  for (const existing of [null, "idle_stop"]) {
    it(`error→archived convergence ${existing ? "preserves an existing" : "coalesces a NULL"} last_stop_cause inside the audited transaction`, async () => {
      const host = await registerHost(source, existing ? "src-cause-keep" : "src-cause-fill");
      const sid = existing ? "sb-cause-keep" : "sb-cause-fill";
      source.rows.set(sid, {
        state: "archived",
        revision: 2,
        stoppedAt: new Date(Date.now() - 3600_000).toISOString(),
        archive: { key: `${sid}/upper-aaaa.tar.zst`, sha256: "aaaa", size: 1 },
        hold: null,
      });
      source.store.set(`${sid}/upper-aaaa.tar.zst`, { key: `${sid}/upper-aaaa.tar.zst`, sha256: "aaaa", size: 1 });
      const { row } = await makePod({ hostUrl: source.url, providerState: "error", state: "archived", sandboxId: sid });
      await query(`UPDATE pods SET last_stop_cause = $2 WHERE id = $1`, [row.id, existing]);
      const before = await query<{ c: string | null; rc: string; st: string }>(
        `SELECT last_stop_cause AS c, md5(resolved_config::text) AS rc, state AS st FROM pods WHERE id = $1`,
        [row.id],
      );
      const expected = await readReconcileExpected(row.id);
      const result = await reconcileProviderArchived(deps, { host, pod: row, actorId: null, expected: expected! });
      assert.equal(result.converged, true);
      const after = await query<{ c: string | null; rc: string; st: string; ps: string; reason: string | null }>(
        `SELECT last_stop_cause AS c, md5(resolved_config::text) AS rc, state AS st, provider_state AS ps, state_reason AS reason FROM pods WHERE id = $1`,
        [row.id],
      );
      assert.equal(after.rows[0]!.ps, "archived");
      assert.equal(after.rows[0]!.c, existing ?? "provider_archived", "cause preserved verbatim or NULL coalesced to provider_archived");
      assert.equal(after.rows[0]!.rc, before.rows[0]!.rc, "config untouched");
      assert.equal(after.rows[0]!.st, before.rows[0]!.st, "logical state untouched");
      assert.equal(after.rows[0]!.reason, null);
      const audits = await query<{ detail: Record<string, unknown> }>(
        `SELECT detail FROM audit_log WHERE target_id = $1 AND action = 'pod.provider_reconciled'`,
        [row.id],
      );
      assert.equal(audits.rows.length, 1);
      assert.equal(audits.rows[0]!.detail["lastStopCause"], "preserved-or-provider_archived");
      assert.equal(source.holdDeletes.length, 0, "no release attempted, ever");
    });
  }

  it("hands a fenced reconciliation straight into guarded rehome (shared holder)", async () => {
    const host = await registerHost(source, "src-h");
    await registerHost(target, "dst-h");
    const key = "sb-h/upper-aaaa.tar.zst";
    plantSource("sb-h");
    target.store.set(key, { key, sha256: "aaaa", size: 400 * 1024 * 1024 });
    const { row, id } = await makePod({ hostUrl: source.url, providerState: "error", state: "archived", sandboxId: "sb-h" });
    const reconciled = await reconcileProviderArchived(deps, {
      host,
      pod: row,
      actorId: null,
      expected: (await readReconcileExpected(row.id))!,
    });
    assert.equal(reconciled.converged, true);
    // Guarded rehome proceeds under the same fence (same-holder re-PUT is idempotent)
    // and completes the move + atomic retire.
    const moved = await guardedRehome(deps, "src-h", {
      approved: true,
      quiescenceAttested: true,
      minQuietSecs: 0,
      actorId: null,
    });
    assert.equal(moved.moved.length, 1);
    assert.equal(moved.moved[0]!.retired, true);
    assert.equal(await dbSandboxUrl(id), target.url);
  });

  it("refuses on stale pointer/SID/state without touching the row", async () => {
    const host = await registerHost(source, "src-s");
    source.rows.set("sb-stale-row", {
      state: "archived",
      revision: 4,
      stoppedAt: new Date(Date.now() - 3600_000).toISOString(),
      archive: { key: "sb-stale-row/upper-aaaa.tar.zst", sha256: "aaaa", size: 1 },
      hold: null,
    });
    source.store.set("sb-stale-row/upper-aaaa.tar.zst", { key: "sb-stale-row/upper-aaaa.tar.zst", sha256: "aaaa", size: 1 });
    const made = await makePod({ hostUrl: source.url, providerState: "error", sandboxId: "sb-stale-row" });
    const expected = (await readReconcileExpected(made.id))!;
    // Stale pointer: the frozen URL moved to another host after the caller read it.
    // (Every mutation bumps updated_at, like all real server writes do.)
    await registerHost(target, "src-s2");
    await query(
      `UPDATE pods SET resolved_config = jsonb_set(resolved_config, '{config,providers,sandbox,url}', to_jsonb($2::text), true),
         updated_at = now() WHERE id = $1`,
      [made.id, target.url],
    );
    const stalePointer = await reconcileProviderArchived(deps, { host, pod: made.row, actorId: null, expected });
    assert.equal(stalePointer.converged, false);
    assert.match(stalePointer.detail, /stale pointer\/SID\/state|caller snapshot disagrees|row changed/i);
    // Stale SID: the sandbox id was rebound after the caller read it.
    await query(`UPDATE pods SET provider_sandbox_id = 'sb-rebound', resolved_config = jsonb_set(resolved_config, '{config,providers,sandbox,url}', to_jsonb($2::text), true), updated_at = now() WHERE id = $1`, [
      made.id,
      source.url,
    ]);
    const staleSid = await reconcileProviderArchived(deps, { host, pod: made.row, actorId: null, expected });
    assert.equal(staleSid.converged, false);
    // Stale state: something else already converged or moved the row.
    await query(`UPDATE pods SET provider_state = 'stopped', provider_sandbox_id = 'sb-stale-row', updated_at = now() WHERE id = $1`, [made.id]);
    const staleStateRow = { ...made.row, provider_state: "error" } as PodOnHost;
    const staleState = await reconcileProviderArchived(deps, { host, pod: staleStateRow, actorId: null, expected });
    assert.equal(staleState.converged, false);
    assert.match(staleState.detail, /stale pointer\/SID\/state|row changed/i);
  });

  it("refuses a same-millisecond timestamp forgery (exact text, not JS Dates)", async () => {
    const host = await registerHost(source, "src-ms");
    source.rows.set("sb-ms", {
      state: "archived",
      revision: 4,
      stoppedAt: new Date(Date.now() - 3600_000).toISOString(),
      archive: { key: "sb-ms/upper-aaaa.tar.zst", sha256: "aaaa", size: 1 },
      hold: null,
    });
    source.store.set("sb-ms/upper-aaaa.tar.zst", { key: "sb-ms/upper-aaaa.tar.zst", sha256: "aaaa", size: 1 });
    const made = await makePod({ hostUrl: source.url, providerState: "error", sandboxId: "sb-ms" });
    const expected = (await readReconcileExpected(made.id))!;
    // Forge the SAME millisecond with a different microsecond. The stored text may
    // already be trimmed to milliseconds (trailing zeros are not rendered), so pad
    // explicitly instead of assuming extra digits exist: a JS Date comparison would
    // call these equal and converge; exact text must refuse.
    const forgedText = new Date(expected.updatedAt).toISOString().replace(/Z$/, "001Z");
    assert.notEqual(forgedText, expected.updatedAt, "forge must differ as exact text");
    await query(`UPDATE pods SET updated_at = $2::timestamptz WHERE id = $1`, [made.id, forgedText]);
    const forged = await reconcileProviderArchived(deps, { host, pod: made.row, actorId: null, expected });
    assert.equal(forged.converged, false);
    assert.match(forged.detail, /row changed|stale/i);
    const db = await query<{ provider_state: string }>(`SELECT provider_state FROM pods WHERE id = $1`, [made.id]);
    assert.equal(db.rows[0]!.provider_state, "error");
    assert.equal(source.holdPuts.length, 0, "refused before fencing anything");
  });

  it("lets exactly one concurrent reconcile win (barrier race)", async () => {
    const host = await registerHost(source, "src-br");
    source.rows.set("sb-br", {
      state: "archived",
      revision: 4,
      stoppedAt: new Date(Date.now() - 3600_000).toISOString(),
      archive: { key: "sb-br/upper-aaaa.tar.zst", sha256: "aaaa", size: 1 },
      hold: null,
    });
    source.store.set("sb-br/upper-aaaa.tar.zst", { key: "sb-br/upper-aaaa.tar.zst", sha256: "aaaa", size: 1 });
    const made = await makePod({ hostUrl: source.url, providerState: "error", sandboxId: "sb-br" });
    const expected = (await readReconcileExpected(made.id))!;
    const run = () =>
      reconcileProviderArchived(deps, { host, pod: made.row, actorId: null, expected });
    const [a, b] = await Promise.all([run(), run()]);
    const wins = [a, b].filter((r) => r.converged);
    assert.equal(wins.length, 1, `exactly one wins: ${JSON.stringify([a.detail, b.detail])}`);
    const db = await query<{ provider_state: string }>(`SELECT provider_state FROM pods WHERE id = $1`, [made.id]);
    assert.equal(db.rows[0]!.provider_state, "archived");
  });

  it("refuses already-archived rows and keeps any fence (rehome, never release)", async () => {
    const host = await registerHost(source, "src-cl");
    source.rows.set("sb-cl", {
      state: "archived",
      revision: 4,
      stoppedAt: new Date(Date.now() - 3600_000).toISOString(),
      archive: { key: "sb-cl/upper-aaaa.tar.zst", sha256: "aaaa", size: 1 },
      hold: null,
    });
    source.store.set("sb-cl/upper-aaaa.tar.zst", { key: "sb-cl/upper-aaaa.tar.zst", sha256: "aaaa", size: 1 });
    const made = await makePod({ hostUrl: source.url, providerState: "error", sandboxId: "sb-cl" });
    // Simulate prior convergence: PG already archived, native still fenced by us.
    await query(`UPDATE pods SET provider_state = 'archived', updated_at = now() WHERE id = $1`, [made.id]);
    const holder = `rehome:${made.id}`;
    const client = new SandboxClient(source.url, "test-token");
    await client.json("PUT", "/v1/sandboxes/sb-cl/hold", { holder, expectedRevision: 4 });
    const archivedRow = { ...made.row, provider_state: "archived" } as PodOnHost;
    const result = await reconcileProviderArchived(deps, {
      host,
      pod: archivedRow,
      actorId: null,
      expected: (await readReconcileExpected(made.id))!,
    });
    assert.equal(result.converged, false);
    assert.match(result.detail, /already archived|guarded rehome/i);
    assert.equal(source.rows.get("sb-cl")!.hold?.holder, holder, "fence retained");
    assert.equal(source.holdDeletes.length, 0, "no release attempted");
  });

  it("refuses to fence on hosts without the hold API", async () => {
    const host = await registerHost(source, "src-old");
    source.rev5 = false;
    source.rows.set("sb-old", {
      state: "archived",
      revision: 4,
      stoppedAt: new Date(Date.now() - 3600_000).toISOString(),
      archive: { key: "sb-old/upper-aaaa.tar.zst", sha256: "aaaa", size: 1 },
      hold: null,
    });
    source.store.set("sb-old/upper-aaaa.tar.zst", { key: "sb-old/upper-aaaa.tar.zst", sha256: "aaaa", size: 1 });
    const made = await makePod({ hostUrl: source.url, providerState: "error", sandboxId: "sb-old" });
    const result = await reconcileProviderArchived(deps, {
      host,
      pod: made.row,
      actorId: null,
      expected: (await readReconcileExpected(made.id))!,
    });
    assert.equal(result.converged, false);
    assert.match(result.detail, /fence refused|lacks the hold/i);
    const db = await query<{ provider_state: string }>(`SELECT provider_state FROM pods WHERE id = $1`, [made.id]);
    assert.equal(db.rows[0]!.provider_state, "error", "unfenced convergence is no longer offered");
  });

  it("refuses a wrong selected host holding the same SID (zero holds/updates)", async () => {
    // Both hosts know the SID as archived (e.g. the target adopted it earlier), but the
    // pod is routed at the source. Passing the TARGET host must refuse before ANY
    // native I/O — otherwise the target gets fenced while the source-routed row is
    // rewritten on its testimony, without ever fencing the actual source.
    const srcHost = await registerHost(source, "src-wh");
    await registerHost(target, "dst-wh");
    void srcHost;
    const key = "sb-wh/upper-aaaa.tar.zst";
    for (const h of [source, target]) {
      h.rows.set("sb-wh", {
        state: "archived",
        revision: 4,
        stoppedAt: new Date(Date.now() - 3600_000).toISOString(),
        archive: { key, sha256: "aaaa", size: 1 },
        hold: null,
      });
      h.store.set(key, { key, sha256: "aaaa", size: 1 });
    }
    const made = await makePod({ hostUrl: source.url, providerState: "error", sandboxId: "sb-wh" });
    const expected = (await readReconcileExpected(made.id))!;
    const wrongHost = await query<SandboxHostRow>(`SELECT * FROM sandbox_hosts WHERE id = 'dst-wh'`);
    const result = await reconcileProviderArchived(deps, {
      host: wrongHost.rows[0]!,
      pod: made.row,
      actorId: null,
      expected,
    });
    assert.equal(result.converged, false);
    assert.match(result.detail, /does not serve the expected source URL|re-select the source host/i);
    assert.equal(target.holdPuts.length, 0, "target never fenced");
    assert.equal(source.holdPuts.length, 0, "source never fenced");
    const db = await query<{ provider_state: string }>(`SELECT provider_state FROM pods WHERE id = $1`, [made.id]);
    assert.equal(db.rows[0]!.provider_state, "error", "row untouched");
  });

  it("refuses non-sandbox provider rows despite a sandbox URL in config", async () => {
    // An unrelated provider's error row must not converge through the native handler
    // merely because resolved_config includes a sandbox URL.
    const host = await registerHost(source, "src-ns");
    void host;
    const id = uuidv7();
    await query(
      `INSERT INTO pods (id, org_id, user_id, name, provider, provider_sandbox_id, state, provider_state,
                         provider_state_changed_at, resolved_config)
       VALUES ($1, $2, $3, 'retire fixture', 'host', 'sb-ns', 'active', 'error', now(), $4::jsonb)`,
      [id, orgId, userId, resolvedConfig(source.url)],
    );
    assert.equal(await readReconcileExpected(id), null, "no identity for non-sandbox rows");
    const podRows = await query<PodOnHost>(`SELECT id, org_id, name, state, provider_state, provider_sandbox_id, resolved_config FROM pods WHERE id = $1`, [id]);
    const result = await reconcileProviderArchived(deps, {
      host: { id: "src-ns", url: source.url, status: "active", created_at: "", updated_at: "" },
      pod: podRows.rows[0]!,
      actorId: null,
      expected: { providerSandboxId: "sb-ns", sourceUrl: source.url, updatedAt: new Date().toISOString() },
    });
    assert.equal(result.converged, false);
    const db = await query<{ provider_state: string }>(`SELECT provider_state FROM pods WHERE id = $1`, [id]);
    assert.equal(db.rows[0]!.provider_state, "error", "row untouched");
  });

  it("rolls back on audit failure: no state change without its trail", async () => {
    const host = await registerHost(source, "src-a");
    source.rows.set("sb-audit", {
      state: "archived",
      revision: 4,
      stoppedAt: new Date(Date.now() - 3600_000).toISOString(),
      archive: { key: "sb-audit/upper-aaaa.tar.zst", sha256: "aaaa", size: 1 },
      hold: null,
    });
    source.store.set("sb-audit/upper-aaaa.tar.zst", { key: "sb-audit/upper-aaaa.tar.zst", sha256: "aaaa", size: 1 });
    const made = await makePod({ hostUrl: source.url, providerState: "error", sandboxId: "sb-audit" });
    const expected = (await readReconcileExpected(made.id))!;
    // Nonexistent actor violates the audit FK: the tx must roll the state change back.
    const bogusActor = uuidv7();
    const result = await reconcileProviderArchived(deps, { host, pod: made.row, actorId: bogusActor, expected });
    assert.equal(result.converged, false);
    const db = await query<{ provider_state: string }>(`SELECT provider_state FROM pods WHERE id = $1`, [made.id]);
    assert.equal(db.rows[0]!.provider_state, "error", "state change rolled back with the audit");
    const audits = await query(`SELECT id FROM audit_log WHERE target_id = $1 AND action = 'pod.provider_reconciled'`, [made.id]);
    assert.equal(audits.rows.length, 0, "no trail, no convergence");
  });

  it("refuses when the host moves between the dual proofs", async () => {
    const host = await registerHost(source, "src-i");
    source.rows.set("sb-flap", {
      state: "archived",
      revision: 4,
      stoppedAt: new Date(Date.now() - 3600_000).toISOString(),
      archive: { key: "sb-flap/upper-aaaa.tar.zst", sha256: "aaaa", size: 1 },
      hold: null,
    });
    source.store.set("sb-flap/upper-aaaa.tar.zst", { key: "sb-flap/upper-aaaa.tar.zst", sha256: "aaaa", size: 1 });
    source.bumpOnSecondInfoGet.add("sb-flap");
    const made = await makePod({ hostUrl: source.url, providerState: "error", sandboxId: "sb-flap" });
    const expected = (await readReconcileExpected(made.id))!;
    const result = await reconcileProviderArchived(deps, { host, pod: made.row, actorId: null, expected });
    assert.equal(result.converged, false);
    assert.match(result.detail, /between reads|quiescent/i);
    const db = await query<{ provider_state: string }>(`SELECT provider_state FROM pods WHERE id = $1`, [made.id]);
    assert.equal(db.rows[0]!.provider_state, "error");
  });

  it("refuses when the fenced manifest names another host (aliased registry row)", async () => {
    const host = await registerHost(source, "src-al");
    source.rows.set("sb-al2", {
      state: "archived",
      revision: 4,
      stoppedAt: new Date(Date.now() - 3600_000).toISOString(),
      archive: { key: "sb-al2/upper-aaaa.tar.zst", sha256: "aaaa", size: 1 },
      hold: null,
    });
    source.store.set("sb-al2/upper-aaaa.tar.zst", { key: "sb-al2/upper-aaaa.tar.zst", sha256: "aaaa", size: 1 });
    source.store.set("sb-al2/upper-aaaa.tar.zst", { key: "sb-al2/upper-aaaa.tar.zst", sha256: "aaaa", size: 1 });
    const made = await makePod({ hostUrl: source.url, providerState: "error", sandboxId: "sb-al2" });
    // The backend answers under a different identity than the registry row claims:
    // converging here would launder another host's truth under our name.
    source.hostId = "impostor";
    const result = await reconcileProviderArchived(deps, {
      host,
      pod: made.row,
      actorId: null,
      expected: (await readReconcileExpected(made.id))!,
    });
    assert.equal(result.converged, false);
    assert.match(result.detail, /expected src-al|served under host/i);
    const db = await query<{ provider_state: string }>(`SELECT provider_state FROM pods WHERE id = $1`, [made.id]);
    assert.equal(db.rows[0]!.provider_state, "error");
  });

  it("refuses reconciliation when the host disagrees or the row is out of scope", async () => {
    const host = await registerHost(source, "src-g");
    source.rows.set("sb-live", { state: "started", revision: 9, stoppedAt: null, archive: null, hold: null });
    const live = await makePod({ hostUrl: source.url, providerState: "error", sandboxId: "sb-live" });
    const liveExpected = (await readReconcileExpected(live.id))!;
    assert.equal((await reconcileProviderArchived(deps, { host, pod: live.row, actorId: null, expected: liveExpected })).converged, false);
    assert.equal((await query<{ provider_state: string }>(`SELECT provider_state FROM pods WHERE id = $1`, [live.id])).rows[0]!.provider_state, "error");

    const stopped = await makePod({ hostUrl: source.url, providerState: "stopped", sandboxId: "sb-other" });
    const stoppedExpected = (await readReconcileExpected(stopped.id))!;
    assert.equal((await reconcileProviderArchived(deps, { host, pod: stopped.row, actorId: null, expected: stoppedExpected })).converged, false);

    const ghost = await makePod({ hostUrl: source.url, providerState: "error", sandboxId: "sb-ghost" });
    const ghostExpected = (await readReconcileExpected(ghost.id))!;
    const res = await reconcileProviderArchived(deps, { host, pod: ghost.row, actorId: null, expected: ghostExpected });
    assert.equal(res.converged, false);
    assert.equal(source.deletes.length + target.deletes.length, 0, "reconciliation never deletes");
  });

  it("holds fresh-transitioned rows out of the window and refuses without attestation", async () => {
    await registerHost(source, "src-h");
    await registerHost(target, "dst-h");
    plantSource("sb-q");
    const { id } = await makePod({ hostUrl: source.url, sandboxId: "sb-q" });
    const held = await guardedRehome(deps, "src-h", {
      approved: true,
      quiescenceAttested: true,
      minQuietSecs: 3600,
      actorId: null,
    });
    assert.equal(held.moved.length, 0);
    assert.match(held.skipped[0]!.reason, /too fresh/);
    assert.equal(await dbSandboxUrl(id), source.url);
    await assert.rejects(
      guardedRehome(deps, "src-h", { approved: true, quiescenceAttested: false, minQuietSecs: 0, actorId: null }),
      /quiescence/,
    );
    await assert.rejects(
      guardedRehome(deps, "src-h", { approved: false, quiescenceAttested: true, minQuietSecs: 0, actorId: null }),
      /approval/,
    );
  });

  it("server manual hold-release is disabled entirely (fail closed with guidance)", async () => {
    await registerHost(source, "src-i");
    plantSource("sb-rel");
    const { id } = await makePod({ hostUrl: source.url, sandboxId: "sb-rel" });
    const host = { id: "src-i", url: source.url, status: "active", created_at: "", updated_at: "" } as const;
    const { releasePodHold } = await import("../src/server/pods/sandbox-retirement.js");
    // Take a hold directly; even with a matching holder and no recorded import, the
    // server refuses — stage reads can be missing and target GETs ambiguous, and a
    // wrong release recreates the two-writer window. Host-side break-glass stays native.
    const client = new SandboxClient(source.url, "test-token");
    await client.json("PUT", "/v1/sandboxes/sb-rel/hold", { holder: `rehome:${id}`, expectedRevision: 3 });
    const refused = await releasePodHold(
      deps,
      { source: { ...host }, podId: id, holder: `rehome:${id}`, targetUrl: target.url },
    );
    assert.equal(refused.released, false);
    assert.match(refused.detail, /disabled/i);
    assert.ok(source.rows.get("sb-rel")!.hold, "fence untouched by the refused release");
    assert.equal(source.holdDeletes.length, 0);
  });

  it("refuses manual release once the pointer left the source (retire-source instead)", async () => {
    await registerHost(source, "src-j");
    await registerHost(target, "dst-j");
    plantSource("sb-rp");
    const { id } = await makePod({ hostUrl: source.url, sandboxId: "sb-rp" });
    // Simulate a committed repoint (pointer now names the target) with the fence intact.
    await query(`UPDATE pods SET resolved_config = jsonb_set(resolved_config, '{config,providers,sandbox,url}', to_jsonb($2::text), true) WHERE id = $1`, [
      id,
      target.url,
    ]);
    const { releasePodHold } = await import("../src/server/pods/sandbox-retirement.js");
    const refused = await releasePodHold(
      deps,
      { source: { id: "src-j", url: source.url, status: "active", created_at: "", updated_at: "" }, podId: id, holder: `rehome:${id}` },
    );
    assert.equal(refused.released, false);
    assert.match(refused.detail, /retire-source/i);
  });

  it("serializes concurrent holders and always unlocks (two-connection barrier)", async () => {
    const { withPodMoveLock } = await import("../src/server/pods/sandbox-retirement.js");
    const podId = uuidv7();
    const order: string[] = [];
    let aHolds = false;
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const first = withPodMoveLock(podId, async () => {
      order.push("a-in");
      aHolds = true;
      await sleep(80);
      order.push("a-out");
    });
    // Wait until the first holder is inside, proving the second blocks (not merely runs later).
    for (let i = 0; i < 100 && !aHolds; i++) await sleep(10);
    assert.equal(aHolds, true, "first holder acquired");
    let secondEntered = false;
    const second = withPodMoveLock(podId, async () => {
      secondEntered = true;
      order.push("b-in");
    });
    await sleep(20);
    assert.equal(secondEntered, false, "second holder blocks while the first holds");
    await first;
    await second;
    assert.deepEqual(order, ["a-in", "a-out", "b-in"]);
    // Throwing still unlocks: the next holder must not hang (would deadlock on leak).
    await assert.rejects(withPodMoveLock(podId, async () => {
      throw new Error("boom");
    }), /boom/);
    await withPodMoveLock(podId, async () => {
      order.push("c-in");
    });
    assert.deepEqual(order, ["a-in", "a-out", "b-in", "c-in"]);
  });

  it("converges moved pointer + absent source via audit + live target proof (no POST)", async () => {
    await registerHost(source, "src-gn");
    await registerHost(target, "dst-gn");
    // Source row already gone (e.g. retired by a prior attempt); nothing fenced left.
    // The committed audit names the adopted object; the target still serves it verified.
    const key = "sb-gn/upper-aaaa.tar.zst";
    target.store.set(key, { key, sha256: "aaaa", size: 400 * 1024 * 1024 });
    target.rows.set("sb-gn", {
      state: "archived",
      revision: 1,
      stoppedAt: new Date().toISOString(),
      archive: { key, sha256: "aaaa", size: 400 * 1024 * 1024 },
      hold: null,
    });
    const { id } = await makePod({ hostUrl: target.url, sandboxId: "sb-gn" });
    await query(
      `INSERT INTO audit_log (id, org_id, actor_id, action, target_type, target_id, detail, created_at)
       VALUES (gen_random_uuid(), $1, NULL, 'pod.rehomed', 'pod', $2, $3, now())`,
      [orgId, id, JSON.stringify({ archiveKey: key, archiveSha256: "aaaa" })],
    );
    const { retireSourceRow } = await import("../src/server/pods/sandbox-retirement.js");
    const done = await retireSourceRow(deps, {
      source: { id: "src-gn", url: source.url, status: "active", created_at: "", updated_at: "" },
      podId: id,
      holder: `rehome:${id}`,
    });
    assert.equal(done.retired, true);
    assert.match(done.detail, /already gone|confirmed/i);
    assert.equal(source.retirePosts.length, 0, "converged with zero retire POSTs");
  });

  it("refuses gone-convergence without an audit trail or with a diverged target", async () => {
    await registerHost(source, "src-g2");
    await registerHost(target, "dst-g2");
    const key = "sb-g2/upper-aaaa.tar.zst";
    target.store.set(key, { key, sha256: "aaaa", size: 400 * 1024 * 1024 });
    target.rows.set("sb-g2", {
      state: "archived",
      revision: 1,
      stoppedAt: new Date().toISOString(),
      archive: { key, sha256: "aaaa", size: 400 * 1024 * 1024 },
      hold: null,
    });
    // No audit row: nothing proves THIS pod adopted that object.
    const noAudit = await makePod({ hostUrl: target.url, sandboxId: "sb-g2" });
    const { retireSourceRow } = await import("../src/server/pods/sandbox-retirement.js");
    const refused = await retireSourceRow(deps, {
      source: { id: "src-g2", url: source.url, status: "active", created_at: "", updated_at: "" },
      podId: noAudit.id,
      holder: `rehome:${noAudit.id}`,
    });
    assert.equal(refused.retired, false);
    // Audit names a DIFFERENT object than the target serves: refuse.
    const { id } = await makePod({ hostUrl: target.url, sandboxId: "sb-g2b" });
    target.store.set("sb-g2b/upper-aaaa.tar.zst", { key: "sb-g2b/upper-aaaa.tar.zst", sha256: "aaaa", size: 1 });
    target.rows.set("sb-g2b", {
      state: "archived",
      revision: 1,
      stoppedAt: new Date().toISOString(),
      archive: { key: "sb-g2b/upper-aaaa.tar.zst", sha256: "aaaa", size: 1 },
      hold: null,
    });
    await query(
      `INSERT INTO audit_log (id, org_id, actor_id, action, target_type, target_id, detail, created_at)
       VALUES (gen_random_uuid(), $1, NULL, 'pod.rehomed', 'pod', $2, $3, now())`,
      [orgId, id, JSON.stringify({ archiveKey: "sb-g2b/upper-OTHER.tar.zst", archiveSha256: "zzzz" })],
    );
    const diverged = await retireSourceRow(deps, {
      source: { id: "src-g2", url: source.url, status: "active", created_at: "", updated_at: "" },
      podId: id,
      holder: `rehome:${id}`,
    });
    assert.equal(diverged.retired, false);
  });

  it("treats unreadable source presence as UNKNOWN on retire recovery", async () => {
    await registerHost(source, "src-gu");
    await registerHost(target, "dst-gu");
    plantSource("sb-gu");
    const { id } = await makePod({ hostUrl: target.url, sandboxId: "sb-gu" });
    // Pointer moved, but the source GET fails: absence unconfirmed, never assumed.
    source.failInfo.add("sb-gu");
    const { retireSourceRow } = await import("../src/server/pods/sandbox-retirement.js");
    const unknown = await retireSourceRow(deps, {
      source: { id: "src-gu", url: source.url, status: "active", created_at: "", updated_at: "" },
      podId: id,
      holder: `rehome:${id}`,
    });
    assert.equal(unknown.retired, false);
    assert.match(unknown.detail, /unknown|unreadable/i);
  });

  it("recovers a lost retire response through an explicit retry (no duplicate delete)", async () => {
    await registerHost(source, "src-lr");
    await registerHost(target, "dst-lr");
    plantSource("sb-lr");
    const { id } = await makePod({ hostUrl: source.url, sandboxId: "sb-lr" });
    // Full move, but the retire response is lost AFTER applying: row gone server-side.
    source.retireThenDrop.add("sb-lr");
    const moved = await guardedRehome(deps, "src-lr", {
      approved: true,
      quiescenceAttested: true,
      minQuietSecs: 0,
      actorId: null,
    });
    assert.equal(moved.moved.length, 1);
    assert.equal(moved.moved[0]!.retired, false, "ambiguous retire stays pending");
    assert.equal(source.rows.has("sb-lr"), false, "retire applied despite the lost response");
    // Explicit retry converges via confirmed absence + intact adoption — one row, one
    // delete total (the retry POSTs nothing: GET proves gone first... unless it retries
    // the POST when presence is uncertain; here absence is explicit so no second POST).
    const postsBefore = source.retirePosts.length;
    const { retireSourceRow } = await import("../src/server/pods/sandbox-retirement.js");
    const done = await retireSourceRow(deps, {
      source: { id: "src-lr", url: source.url, status: "active", created_at: "", updated_at: "" },
      podId: id,
      holder: `rehome:${id}`,
    });
    assert.equal(done.retired, true);
    assert.match(done.detail, /already gone/i);
    assert.equal(source.retirePosts.length, postsBefore, "no duplicate retire POST");
  });

  it("documents the production entrypoint (dist/fleet.js, never dist/main.js)", () => {
    const cli = readFileSync(new URL("../src/server/pods/sandboxfleet-cli.ts", import.meta.url), "utf8");
    assert.match(cli, /node dist\/fleet\.js/);
    assert.match(cli, /Never `node dist\/main\.js fleet/);
  });
});
