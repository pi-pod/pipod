import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";

/** Also bounds trust across restarts; repeated restarts cannot postpone content verification. */
export const IMAGE_VERIFICATION_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface LayerVerification {
  version: 1;
  diffDigest: string;
  blobDigest: string;
  mediaType: string;
  /** Digest of the extracted tree, not the OCI tar's diff_id. */
  content: string;
  fingerprint: string;
  uncompressedBytes: number;
  verifiedAt: number;
}

/**
 * Host-only evidence left by a complete blob → diff_id → extracted-tree verification.
 * This is a disposable cache, not authority: a missing, old or malformed receipt is a miss.
 * The caller still verifies the compressed blob and compares the live tree fingerprint.
 * Version the namespace when changing the tree digest/fingerprint algorithms.
 */
export class LayerVerificationCache {
  private readonly directory: string;

  constructor(stateDir: string) {
    this.directory = path.join(stateDir, "images", "verifications-v1");
  }

  private location(digest: string): string {
    if (!/^[a-z0-9_+.-]+:[a-f0-9]+$/.test(digest)) throw new Error(`invalid OCI digest: ${digest}`);
    return path.join(this.directory, `${digest.replace(":", "-")}.json`);
  }

  async read(digest: string): Promise<LayerVerification | null> {
    const receipt = await this.load(digest);
    if (receipt === null) return null;
    const age = Date.now() - receipt.verifiedAt;
    return age >= 0 && age < IMAGE_VERIFICATION_INTERVAL_MS ? receipt : null;
  }

  private async load(digest: string): Promise<LayerVerification | null> {
    let receipt: LayerVerification;
    try {
      receipt = JSON.parse(await readFile(this.location(digest), "utf8")) as LayerVerification;
    } catch (error) {
      if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (receipt?.version !== 1 || receipt.diffDigest !== digest ||
        typeof receipt.blobDigest !== "string" || typeof receipt.mediaType !== "string" ||
        !/^[a-f0-9]{64}$/.test(receipt.content) || !/^[a-f0-9]{64}$/.test(receipt.fingerprint) ||
        !Number.isSafeInteger(receipt.uncompressedBytes) || receipt.uncompressedBytes < 0 ||
        !Number.isFinite(receipt.verifiedAt)) return null;
    return receipt;
  }

  async write(receipt: LayerVerification): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const destination = this.location(receipt.diffDigest);
    const temporary = `${destination}.tmp-${randomUUID()}`;
    try {
      await writeFile(temporary, `${JSON.stringify(receipt)}\n`, { mode: 0o600, flag: "wx" });
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  /** Renew only after scrub compared the actual contents to this same evidence. */
  async refresh(digest: string, content: string, fingerprint: string): Promise<void> {
    const receipt = await this.load(digest);
    if (receipt?.content === content && receipt.fingerprint === fingerprint) {
      await this.write({ ...receipt, verifiedAt: Date.now() });
    }
  }

  async forget(digest: string): Promise<void> {
    await rm(this.location(digest), { force: true });
  }
}
