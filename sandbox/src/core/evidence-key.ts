import fs from "node:fs";
import path from "node:path";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";

/**
 * Host evidence identity for the signed usage feed (isolated small profile).
 *
 * The runtime already authenticates the *control* channel with its bearer token.
 * That token must never sign evidence: token disclosure would then grant
 * evidence-forging authority. This key is a second, independent identity whose
 * public half the admitted server pins on the host record. It lives under the
 * host state volume, outside pod mounts and archives, and is only read by the
 * root runtime process.
 *
 * A signature proves the enrolled runtime reported these bytes. It does not
 * prove the vendor consumed a particular image, and it is not remote
 * attestation; see docs/isolated-small-profile.md.
 */
export const EVIDENCE_DOMAIN = "pi-pod/runtime-evidence-v1\n";
export const EVIDENCE_KEY_ID = /^[0-9a-f]{64}$/;
export const OUTBOX_INCARNATION = /^[0-9a-f-]{36}$/;

export interface EvidenceEnvelope {
  schema: "pi-pod-usage-evidence-v1";
  keyId: string;
  publicKey: string;
  endpoint: "usage-snapshot" | "usage-events";
  nonce: string | null;
  request: Record<string, string | number | null>;
  hostId: string;
  outboxIncarnation: string;
  issuedAt: string;
  recordsDigest: string;
  signature: string;
}

export class EvidenceKey {
  private constructor(
    private readonly key: KeyObject,
    readonly keyId: string,
    readonly publicKey: string,
  ) {}

  /** Load the persisted key, or create one on first use. Root-private, never in a pod. */
  static loadOrCreate(stateDir: string): EvidenceKey {
    const directory = path.join(stateDir, "evidence");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const directoryInfo = fs.statSync(directory);
    if (directoryInfo.uid !== process.getuid?.() || (directoryInfo.mode & 0o077) !== 0) {
      throw new Error("evidence directory must be private to the runtime user");
    }
    const keyPath = path.join(directory, "evidence.key");
    let pem: Buffer;
    if (!fs.existsSync(keyPath)) {
      const { privateKey } = generateKeyPairSync("ed25519");
      const created = privateKey.export({ type: "pkcs8", format: "pem" }) as Buffer;
      const fd = fs.openSync(keyPath, "wx", 0o600);
      try {
        fs.writeFileSync(fd, created);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      pem = created;
    } else {
      const fd = fs.openSync(keyPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const info = fs.fstatSync(fd);
        if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
          throw new Error("evidence key must be private to the runtime user");
        }
        pem = fs.readFileSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
    const key = createPrivateKey(pem);
    if (key.asymmetricKeyType !== "ed25519") throw new Error("evidence key must be Ed25519");
    const publicKey = createPublicKey(key).export({ type: "spki", format: "pem" }).toString();
    return new EvidenceKey(key, createHash("sha256").update(publicKey).digest("hex"), publicKey);
  }

  /** Domain-separated detached signature over the canonical envelope payload. */
  sign(payload: string): string {
    return sign(null, Buffer.from(EVIDENCE_DOMAIN + payload), this.key).toString("base64");
  }

  /** Build the response envelope: request identity plus a digest of the returned records. */
  envelope(input: {
    endpoint: EvidenceEnvelope["endpoint"];
    nonce: string | null;
    request: Record<string, string | number | null>;
    hostId: string;
    outboxIncarnation: string;
    records: unknown;
  }): EvidenceEnvelope {
    const issuedAt = new Date().toISOString();
    const recordsDigest = createHash("sha256")
      .update(JSON.stringify(input.records) ?? "null")
      .digest("hex");
    const fields = [
      "pi-pod-usage-evidence-v1",
      this.keyId,
      input.endpoint,
      input.nonce ?? "",
      JSON.stringify(input.request),
      input.hostId,
      input.outboxIncarnation,
      issuedAt,
      recordsDigest,
    ].join("\n");
    return {
      schema: "pi-pod-usage-evidence-v1",
      keyId: this.keyId,
      publicKey: this.publicKey,
      endpoint: input.endpoint,
      nonce: input.nonce,
      request: input.request,
      hostId: input.hostId,
      outboxIncarnation: input.outboxIncarnation,
      issuedAt,
      recordsDigest,
      signature: this.sign(fields),
    };
  }
}
