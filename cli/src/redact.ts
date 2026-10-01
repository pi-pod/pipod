/**
 * src/redact.ts — secret-aware log redaction (§7.3).
 *
 * Every value originating from the env file is registered here; the logger runs all output
 * through `redact()`. The conformance suite (§14) asserts that no registered value ever
 * appears in captured logs.
 */

/** Values short enough to appear coincidentally are not worth redacting (and would mangle output). */
const MIN_REDACTABLE_LENGTH = 4;

const secrets = new Set<string>();

export function registerSecret(value: string | undefined | null): void {
  if (!value) return;
  const v = String(value);
  if (v.length < MIN_REDACTABLE_LENGTH) return;
  secrets.add(v);
}

export function registerSecrets(values: Record<string, string>): void {
  for (const v of Object.values(values)) registerSecret(v);
}

/** Test/reset hook. */
export function clearSecrets(): void {
  secrets.clear();
}

export function registeredSecretCount(): number {
  return secrets.size;
}

/**
 * Replace every registered secret with `[redacted]`. Longest-first so that a secret which
 * contains another secret as a substring is not partially revealed.
 */
export function redact(input: string): string {
  if (secrets.size === 0) return input;
  let out = input;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (out.includes(secret)) out = out.split(secret).join("[redacted]");
  }
  return out;
}

export function redactBytes(input: Uint8Array): Uint8Array {
  if (secrets.size === 0) return input;
  const text = Buffer.from(input).toString("utf8");
  const cleaned = redact(text);
  return cleaned === text ? input : Buffer.from(cleaned, "utf8");
}

/** Redact an arbitrary structure for debug dumps. Keys are preserved, values scrubbed. */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redact(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactDeep(v);
    return out as unknown as T;
  }
  return value;
}
