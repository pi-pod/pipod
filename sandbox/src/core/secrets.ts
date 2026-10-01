import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Host-local secret for idempotency fingerprints (§6.5).
 *
 * The master API token rotates; a fingerprint keyed by it would turn every legitimate
 * post-rotation retry into a spurious `idempotency_conflict`. This key lives only on the
 * state volume (mode 0600, outside the SQLite file so DR snapshots never carry it) and is
 * created once. Its short id is prefixed to every fingerprint so a key that was lost and
 * regenerated makes old fingerprints *explicitly* incomparable instead of silently equal.
 */
export interface HostSecret {
  /** First 8 hex chars of sha256(key); never the key. */
  keyId: string;
  key: Buffer;
}

export const HOST_SECRET_FILE = "idempotency.key";

export function loadOrCreateHostSecret(dir: string): HostSecret {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, HOST_SECRET_FILE);
  let key: Buffer;
  try {
    key = Buffer.from(fs.readFileSync(file, "utf8").trim(), "hex");
    if (key.length !== 32) throw new Error("bad length");
  } catch {
    key = randomBytes(32);
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, key.toString("hex"), { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  }
  fs.chmodSync(file, 0o600);
  return { keyId: createHash("sha256").update(key).digest("hex").slice(0, 8), key };
}

/** In-memory secret for tests and embedders; never persisted. */
export function ephemeralHostSecret(): HostSecret {
  const key = randomBytes(32);
  return { keyId: createHash("sha256").update(key).digest("hex").slice(0, 8), key };
}
