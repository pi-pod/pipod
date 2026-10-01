/**
 * src/wire-codec.ts — one canonical base64url-JSON codec for client-side wire payloads.
 *
 * Several bridges (remote UI, auth bridge, pod-extension bridge) all need the same encode,
 * decode-with-size-cap, and canonical round-trip verification. Keeping one copy means the
 * alphabet, the strictness of the round-trip check, and the UTF-8 JSON parse rules cannot
 * drift between them. Each caller still owns its size cap, domain validation, and how a
 * failure is reported.
 */

export function encodeWireJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export type DecodeWireJsonFailure =
  | "empty"
  | "oversized"
  | "alphabet"
  | "non_canonical"
  | "invalid_utf8_json";

export type DecodeWireJsonResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: DecodeWireJsonFailure };

export function decodeWireJson(encoded: string, maxBytes: number): DecodeWireJsonResult {
  if (encoded.length === 0) return { ok: false, reason: "empty" };
  if (Buffer.byteLength(encoded, "utf8") > maxBytes) return { ok: false, reason: "oversized" };
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return { ok: false, reason: "alphabet" };
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.toString("base64url") !== encoded) return { ok: false, reason: "non_canonical" };
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    return { ok: true, value };
  } catch {
    return { ok: false, reason: "invalid_utf8_json" };
  }
}

export function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
