import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { payloadAad, wrapAad, type EncryptionContext } from "./context.js";

/**
 * Envelope encryption (spec §7, secure-secrets plan Phase 2): one random 32-byte
 * data key (DEK) per value, AES-256-GCM for payload encryption and DEK wrapping,
 * with the record's trusted identity bound into both layers as AEAD additional
 * authenticated data. The KEK provider stays pluggable so custody can move to a
 * cloud KMS without touching the stored format; `keyId` names the KEK version
 * for rotation.
 *
 * Envelope versions:
 * - v1 (legacy): `[u16be wrappedLen][wrapped DEK][sealed value]`, no AAD. Readable
 *   through a narrowly bounded legacy path so migration tooling can decrypt old
 *   rows. NOTHING writes v1 anymore — `encryptSecret` has no legacy mode.
 * - v2 (current): `[0x02][u16be wrappedLen][wrapped DEK][sealed value]`, payload
 *   sealed with `payloadAad(context)`, DEK wrapped with `wrapAad(context, keyId)`.
 *   Only the wrapper binds the KEK id, so KEK rotation (rewrap) never needs
 *   payload re-encryption.
 *
 * Safety rules: failures are strictly typed (`SecretCryptoError` subclasses) and
 * carry no key material, plaintext, ciphertext bytes, or record identity — only
 * the failure class. Transient DEK buffers are zeroed in `finally`. (JS string
 * plaintext erasure is not claimed: strings are immutable and GC-managed.)
 */
export interface KekProvider {
  readonly keyId: string;
  /** Raw wrap/unwrap without context binding: used ONLY by the bounded v1 reader. */
  wrap(dataKey: Buffer): Buffer;
  unwrap(wrapped: Buffer, keyId: string): Buffer;
  /** Context-bound wrap/unwrap: the only wrapping operations v2 envelopes use. */
  wrapWithAad(dataKey: Buffer, aad: Buffer): Buffer;
  unwrapWithAad(wrapped: Buffer, keyId: string, aad: Buffer): Buffer;
  /** True when this provider can unwrap for `keyId` — startup inventory and maintenance. */
  hasKey(keyId: string): boolean;
}

/** KEKs are AES-256 keys: exactly 32 bytes, carried through the environment as base64. */
export const KEK_BYTES = 32;

/** Envelope format versions. */
export const ENCRYPTION_VERSION_V1 = 1;
export const ENCRYPTION_VERSION_V2 = 2;

const V2_MARKER = 0x02;
const DEK_BYTES = 32;
const GCM_NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;
/** AES-GCM seal of a 32-byte DEK is always exactly this long. */
const WRAPPED_DEK_BYTES = GCM_NONCE_BYTES + GCM_TAG_BYTES + DEK_BYTES;
/** Smallest possible sealed payload: nonce + tag + zero body bytes. */
const MIN_SEALED_BYTES = GCM_NONCE_BYTES + GCM_TAG_BYTES;
/** Largest plaintext accepted for a v2 write; bounds DB-row abuse (values cap at 64 KiB). */
const MAX_V2_PLAINTEXT_BYTES = 1024 * 1024;
const MAX_V2_ENVELOPE_BYTES =
  1 + 2 + WRAPPED_DEK_BYTES + MIN_SEALED_BYTES + MAX_V2_PLAINTEXT_BYTES;

/** Base class for every crypto-boundary failure. Never carries secret material. */
export class SecretCryptoError extends Error {
  override readonly name: string = "SecretCryptoError";
}

/** Envelope framing is corrupt, truncated, or out of bounds. */
export class MalformedEnvelopeError extends SecretCryptoError {
  override readonly name = "MalformedEnvelopeError";
}

/** Version number is unknown, or a v1 row reached an operation that requires v2. */
export class UnsupportedVersionError extends SecretCryptoError {
  override readonly name = "UnsupportedVersionError";
}

/** No configured KEK can unwrap for the stored key id. */
export class UnknownKekError extends SecretCryptoError {
  override readonly name = "UnknownKekError";
}

/**
 * Authentication or decryption failed: wrong key, tampered bytes, or a ciphertext
 * transplanted into a different record context. One generic message on purpose —
 * distinguishing these cases would oracle-ize the failure for a DB writer.
 */
export class DecryptionFailedError extends SecretCryptoError {
  override readonly name = "DecryptionFailedError";
}

/** Decode one base64 KEK, refusing anything that is not exactly 32 bytes. */
export function decodeKek(kekBase64: string, _keyId: string): Buffer {
  // Buffer.from's permissive decoder silently accepts whitespace and junk. Keys
  // must use the same canonical encoding at every entry point, including the CLI.
  if (!/^[A-Za-z0-9+/]{43}=$/.test(kekBase64)) {
    throw new SecretCryptoError("KEK must be 32 bytes (canonical base64)");
  }
  const buf = Buffer.from(kekBase64, "base64");
  if (buf.length !== KEK_BYTES || buf.toString("base64") !== kekBase64 || buf.every((byte) => byte === 0)) {
    buf.fill(0);
    throw new SecretCryptoError("KEK must be a non-placeholder 32-byte canonical base64 key");
  }
  return buf;
}

/**
 * KEK held in server env/config — the no-external-dependency default (spec §7).
 *
 * Custody: the key material lives only in the server's env file (0600, root-owned)
 * and in this process's memory. Never log it, never put it in an error message, never
 * return it from an API.
 *
 * Rotation, without re-encrypting the tables: move the current pair into `previous`, set the
 * new key/id as current, restart. Reads keep working because every ciphertext is stored with
 * the id of the KEK that wrapped it. New writes use the current id; untouched rows
 * change only through the maintenance migrate/rewrap commands, never lazy reads.
 * Drop a version from `previous` only after zero live references, full verification,
 * restore rehearsal, and accounting for historical backup keys.
 */
export class EnvKekProvider implements KekProvider {
  private keys: Map<string, Buffer>;
  constructor(
    public readonly keyId: string,
    kekBase64: string,
    /** Older KEK versions still able to unwrap, for rotation: id → base64 key. */
    previous: Record<string, string> = {},
  ) {
    // Current last: a stale entry that reuses the current id must never displace the key
    // that new writes are wrapped with.
    this.keys = new Map(Object.entries(previous).map(([id, b64]) => [id, decodeKek(b64, id)]));
    this.keys.set(keyId, decodeKek(kekBase64, keyId));
  }

  hasKey(keyId: string): boolean {
    return this.keys.has(keyId);
  }

  wrap(dataKey: Buffer): Buffer {
    return aesGcmSeal(this.keys.get(this.keyId)!, dataKey);
  }

  unwrap(wrapped: Buffer, keyId: string): Buffer {
    const kek = this.keys.get(keyId);
    if (!kek) throw new UnknownKekError("no configured KEK for stored key id");
    return aesGcmOpen(kek, wrapped);
  }

  wrapWithAad(dataKey: Buffer, aad: Buffer): Buffer {
    return aesGcmSeal(this.keys.get(this.keyId)!, dataKey, aad);
  }

  unwrapWithAad(wrapped: Buffer, keyId: string, aad: Buffer): Buffer {
    const kek = this.keys.get(keyId);
    if (!kek) throw new UnknownKekError("no configured KEK for stored key id");
    return aesGcmOpen(kek, wrapped, aad);
  }
}

function aesGcmSeal(key: Buffer, plaintext: Buffer, aad?: Buffer): Buffer {
  const iv = randomBytes(GCM_NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  if (aad) cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

function aesGcmOpen(key: Buffer, sealed: Buffer, aad?: Buffer): Buffer {
  if (sealed.length < MIN_SEALED_BYTES) {
    throw new MalformedEnvelopeError("sealed payload is truncated");
  }
  const iv = sealed.subarray(0, GCM_NONCE_BYTES);
  const tag = sealed.subarray(GCM_NONCE_BYTES, GCM_NONCE_BYTES + GCM_TAG_BYTES);
  const body = sealed.subarray(GCM_NONCE_BYTES + GCM_TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  if (aad) decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  // update() can produce an unauthenticated DEK before final() rejects the tag.
  // Erase those intermediate buffers on both success and failure; the returned
  // authenticated DEK is erased by its envelope caller's finally block.
  let opened: Buffer | undefined;
  let tail: Buffer | undefined;
  try {
    opened = decipher.update(body);
    tail = decipher.final();
    return Buffer.concat([opened, tail]);
  } finally {
    opened?.fill(0);
    tail?.fill(0);
  }
}

/** Split a framed envelope after its header; throws MalformedEnvelopeError on any mismatch. */
function splitEnvelope(
  ciphertext: Buffer,
  headerLength: number,
  wrappedLength: number,
): { wrapped: Buffer; sealed: Buffer } {
  if (ciphertext.length < headerLength + wrappedLength + MIN_SEALED_BYTES) {
    throw new MalformedEnvelopeError("envelope is truncated");
  }
  if (ciphertext.length > MAX_V2_ENVELOPE_BYTES) {
    throw new MalformedEnvelopeError("envelope exceeds the size bound");
  }
  return {
    wrapped: ciphertext.subarray(headerLength, headerLength + wrappedLength),
    sealed: ciphertext.subarray(headerLength + wrappedLength),
  };
}

/** Unwrap a v2 DEK, verifying the wrap AAD (context + stored KEK id). */
function openV2Dek(
  kek: KekProvider,
  wrapped: Buffer,
  storedKeyId: string,
  context: EncryptionContext,
): Buffer {
  if (wrapped.length !== WRAPPED_DEK_BYTES) {
    throw new MalformedEnvelopeError("v2 wrapped data key has an unexpected length");
  }
  let dataKey: Buffer;
  try {
    dataKey = kek.unwrapWithAad(wrapped, storedKeyId, wrapAad(context, storedKeyId));
  } catch (error) {
    if (error instanceof UnknownKekError || error instanceof MalformedEnvelopeError) throw error;
    throw new DecryptionFailedError("data-key authentication failed");
  }
  if (dataKey.length !== DEK_BYTES) {
    dataKey.fill(0);
    throw new DecryptionFailedError("data-key authentication failed");
  }
  return dataKey;
}

/** Decrypt a v2 payload, verifying the payload AAD (context). */
function openV2Payload(dataKey: Buffer, sealed: Buffer, context: EncryptionContext): string {
  try {
    return aesGcmOpen(dataKey, sealed, payloadAad(context)).toString("utf8");
  } catch (error) {
    if (error instanceof MalformedEnvelopeError) throw error;
    // GCM auth failures and tag/nonce errors all map to one fixed message: no
    // oracle, no echoed bytes.
    throw new DecryptionFailedError("secret payload authentication failed");
  }
}

/** Stored layout v2: [0x02][2-byte wrapped-key length][wrapped data key][sealed value]. */
export function encryptSecret(
  kek: KekProvider,
  value: string,
  context: EncryptionContext,
): { ciphertext: Buffer; keyId: string; encryptionVersion: 2 } {
  const plaintext = Buffer.from(value, "utf8");
  if (plaintext.length > MAX_V2_PLAINTEXT_BYTES) {
    throw new MalformedEnvelopeError("secret value exceeds the size bound");
  }
  const dataKey = randomBytes(DEK_BYTES);
  try {
    const wrapped = kek.wrapWithAad(dataKey, wrapAad(context, kek.keyId));
    if (wrapped.length !== WRAPPED_DEK_BYTES) {
      throw new SecretCryptoError("KEK wrap produced an unexpected length");
    }
    const sealed = aesGcmSeal(dataKey, plaintext, payloadAad(context));
    const header = Buffer.alloc(3);
    header[0] = V2_MARKER;
    header.writeUInt16BE(wrapped.length, 1);
    return {
      ciphertext: Buffer.concat([header, wrapped, sealed]),
      keyId: kek.keyId,
      encryptionVersion: ENCRYPTION_VERSION_V2,
    };
  } catch (error) {
    if (error instanceof SecretCryptoError) throw error;
    throw new SecretCryptoError("secret encryption failed");
  } finally {
    dataKey.fill(0);
    plaintext.fill(0);
  }
}

export function decryptSecret(
  kek: KekProvider,
  ciphertext: Buffer,
  keyId: string,
  context: EncryptionContext,
  encryptionVersion: number,
): string {
  if (!Buffer.isBuffer(ciphertext)) {
    throw new MalformedEnvelopeError("ciphertext must be a Buffer");
  }
  if (encryptionVersion === ENCRYPTION_VERSION_V2) {
    return decryptV2(kek, ciphertext, keyId, context);
  }
  if (encryptionVersion === ENCRYPTION_VERSION_V1) {
    return decryptV1(kek, ciphertext, keyId);
  }
  throw new UnsupportedVersionError("unsupported encryption version");
}

function decryptV2(
  kek: KekProvider,
  ciphertext: Buffer,
  keyId: string,
  context: EncryptionContext,
): string {
  if (ciphertext.length < 3 || ciphertext[0] !== V2_MARKER) {
    throw new MalformedEnvelopeError("v2 envelope marker is missing");
  }
  const wrappedLength = ciphertext.readUInt16BE(1);
  if (wrappedLength !== WRAPPED_DEK_BYTES) {
    throw new MalformedEnvelopeError("v2 wrapped data key has an unexpected length");
  }
  const { wrapped, sealed } = splitEnvelope(ciphertext, 3, wrappedLength);
  const dataKey = openV2Dek(kek, wrapped, keyId, context);
  try {
    return openV2Payload(dataKey, sealed, context);
  } finally {
    dataKey.fill(0);
  }
}

/**
 * Narrowly bounded legacy (v1) reader for rows written before Phase 2. Layout:
 * `[u16be wrappedLen][wrapped DEK][sealed value]`, sealed without AAD. There is no
 * context binding to verify — that is exactly what v2 fixes — so this path checks
 * framing and size strictly and exists only for migration reads. It MUST NOT gain a
 * writer: `encryptSecret` always emits v2.
 */
function decryptV1(kek: KekProvider, ciphertext: Buffer, keyId: string): string {
  if (ciphertext.length < 2) throw new MalformedEnvelopeError("v1 envelope is truncated");
  const wrappedLength = ciphertext.readUInt16BE(0);
  if (wrappedLength !== WRAPPED_DEK_BYTES) {
    throw new MalformedEnvelopeError("v1 wrapped data key has an unexpected length");
  }
  if (ciphertext.length >= 3 && ciphertext[0] === V2_MARKER) {
    // A v2 envelope mislabeled v1 must never fall through into the unauthenticated
    // reader: reject loudly instead of decrypting without context binding.
    throw new MalformedEnvelopeError("envelope looks like v2 but was labeled v1");
  }
  const { wrapped, sealed } = splitEnvelope(ciphertext, 2, wrappedLength);
  let dataKey: Buffer;
  try {
    dataKey = kek.unwrap(wrapped, keyId);
  } catch (error) {
    if (error instanceof UnknownKekError || error instanceof MalformedEnvelopeError) throw error;
    throw new DecryptionFailedError("data-key authentication failed");
  }
  try {
    if (dataKey.length !== DEK_BYTES) {
      throw new DecryptionFailedError("data-key authentication failed");
    }
    try {
      return aesGcmOpen(dataKey, sealed).toString("utf8");
    } catch (error) {
      if (error instanceof MalformedEnvelopeError) throw error;
      throw new DecryptionFailedError("secret payload authentication failed");
    }
  } finally {
    dataKey.fill(0);
  }
}

/**
 * KEK rotation without payload re-encryption (v2 only): unwraps the DEK with the
 * stored key (verifying the old wrap AAD), FULLY decrypts the payload (verifying
 * the payload AAD, so a transplanted payload can never be laundered under a fresh
 * valid wrapper), then re-wraps the SAME DEK under the current KEK with the new
 * wrap AAD. The sealed payload bytes are preserved bit-for-bit.
 *
 * v1 input throws UnsupportedVersionError: legacy rows migrate via
 * decrypt-then-encrypt, which binds them to a context for the first time.
 */
export function rewrapSecret(
  kek: KekProvider,
  ciphertext: Buffer,
  keyId: string,
  context: EncryptionContext,
  encryptionVersion: number,
): { ciphertext: Buffer; keyId: string; encryptionVersion: 2 } {
  if (encryptionVersion !== ENCRYPTION_VERSION_V2) {
    throw new UnsupportedVersionError("rewrap requires a v2 envelope");
  }
  if (!Buffer.isBuffer(ciphertext)) {
    throw new MalformedEnvelopeError("ciphertext must be a Buffer");
  }
  if (ciphertext.length < 3 || ciphertext[0] !== V2_MARKER) {
    throw new MalformedEnvelopeError("v2 envelope marker is missing");
  }
  const wrappedLength = ciphertext.readUInt16BE(1);
  if (wrappedLength !== WRAPPED_DEK_BYTES) {
    throw new MalformedEnvelopeError("v2 wrapped data key has an unexpected length");
  }
  const { wrapped, sealed } = splitEnvelope(ciphertext, 3, wrappedLength);
  const dataKey = openV2Dek(kek, wrapped, keyId, context);
  try {
    // Authenticates the payload AAD; the plaintext itself is not retained.
    openV2Payload(dataKey, sealed, context);
    if (keyId === kek.keyId) return { ciphertext, keyId, encryptionVersion: ENCRYPTION_VERSION_V2 };
    const rewrapped = kek.wrapWithAad(dataKey, wrapAad(context, kek.keyId));
    if (rewrapped.length !== WRAPPED_DEK_BYTES) {
      throw new SecretCryptoError("KEK wrap produced an unexpected length");
    }
    const header = Buffer.alloc(3);
    header[0] = V2_MARKER;
    header.writeUInt16BE(rewrapped.length, 1);
    return {
      ciphertext: Buffer.concat([header, rewrapped, Buffer.from(sealed)]),
      keyId: kek.keyId,
      encryptionVersion: ENCRYPTION_VERSION_V2,
    };
  } catch (error) {
    if (error instanceof SecretCryptoError) throw error;
    throw new SecretCryptoError("secret rewrapping failed");
  } finally {
    dataKey.fill(0);
  }
}
