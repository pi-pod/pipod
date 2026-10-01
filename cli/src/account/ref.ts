import { PiPodError } from "../errors.js";

const FULL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX = /^[0-9a-f]+$/i;
const DISPLAY_TAIL_LENGTH = 10;
const MIN_REF_LENGTH = 4;

/** A complete UUID names one resource outright, so callers can fetch it instead of listing. */
export function isFullUuid(value: string): boolean {
  return FULL_UUID.test(value);
}

/** Stable, copyable reference derived from the random tail of a pod or job UUID. */
export function displayRef(id: string, kind: "pod" | "job"): string {
  const tail = id.replaceAll("-", "").slice(-DISPLAY_TAIL_LENGTH).toLowerCase();
  return `${kind === "pod" ? "p" : "j"}-${tail}`;
}

/** Match full UUIDs, prefixed tail refs, and legacy bare leading prefixes. */
export function matchesRef(id: string, ref: string): boolean {
  const normalizedId = id.toLowerCase();
  const normalizedRef = ref.toLowerCase();
  if (FULL_UUID.test(normalizedRef)) return normalizedId === normalizedRef;

  const prefixed = /^[pj]-(.*)$/i.exec(normalizedRef);
  if (prefixed) {
    const tail = prefixed[1]!;
    assertUsableHexRef(ref, tail);
    return normalizedId.replaceAll("-", "").endsWith(tail);
  }

  if (!HEX.test(normalizedRef)) return false;
  assertUsableHexRef(ref, normalizedRef);
  return normalizedId.startsWith(normalizedRef) || normalizedId.replaceAll("-", "").endsWith(normalizedRef);
}

function assertUsableHexRef(ref: string, hex: string): void {
  if (!HEX.test(hex)) {
    throw new PiPodError(`invalid short ref "${ref}"`, {
      hint: "short refs contain only hexadecimal characters",
    });
  }
  if (hex.length < MIN_REF_LENGTH) {
    throw new PiPodError(`short ref "${ref}" is too short`, {
      hint: `use at least ${MIN_REF_LENGTH} hexadecimal characters`,
    });
  }
}
