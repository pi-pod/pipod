/**
 * src/cidr.ts — IPv4 prefix arithmetic and minimal aggregation (§11.1).
 *
 * Providers that enforce egress by CIDR may cap how many entries they accept. A hostname
 * allowlist routinely resolves past a small cap (CDN-hosted endpoints alone contribute a
 * dozen addresses), so the choice is between refusing to run and enforcing a
 * slightly coarser policy.
 *
 * Aggregation is how we keep the policy as tight as the provider permits: repeatedly merge
 * the two prefixes whose combined covering range adds the fewest extra addresses, until the
 * set fits. That is strictly better than the alternatives — dropping entries would break
 * connectivity silently, and giving up would push users to `mode: "open"`, which allows
 * everything.
 *
 * The widening is never silent: callers report exactly what was merged, and a merge that
 * would grow beyond `MAX_AGGREGATION_PREFIX_BITS` is refused outright rather than quietly
 * approximating "allow the internet".
 */

/** Refuse to produce a prefix shorter than this — /8 is already 16.7M addresses. */
export const MAX_AGGREGATION_PREFIX_BITS = 8;

/** Warn when an aggregated prefix is broader than this. */
export const WIDE_PREFIX_BITS = 16;

export interface Ipv4Range {
  /** Inclusive, as unsigned 32-bit integers. */
  lo: number;
  hi: number;
}

export function ipv4ToInt(addr: string): number {
  const parts = addr.split(".");
  if (parts.length !== 4) throw new Error(`not an IPv4 address: ${addr}`);
  let value = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) {
      throw new Error(`not an IPv4 address: ${addr}`);
    }
    value = (value * 256 + octet) >>> 0;
  }
  return value >>> 0;
}

export function intToIpv4(value: number): string {
  const v = value >>> 0;
  return [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join(".");
}

/** Parse `a.b.c.d` or `a.b.c.d/len` into an inclusive range. */
export function parseIpv4Cidr(entry: string): Ipv4Range {
  const [addr, bits] = entry.split("/");
  const base = ipv4ToInt(addr ?? "");
  const len = bits === undefined ? 32 : Number(bits);
  if (!Number.isInteger(len) || len < 0 || len > 32) throw new Error(`invalid prefix length: ${entry}`);
  const size = len === 0 ? 0x100000000 : 2 ** (32 - len);
  const lo = (base & maskFor(len)) >>> 0;
  return { lo, hi: (lo + size - 1) >>> 0 };
}

function maskFor(len: number): number {
  return len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0;
}

/** Smallest single CIDR that covers the whole range. */
export function coveringCidr(range: Ipv4Range): string {
  let len = 32;
  while (len > 0) {
    const mask = maskFor(len);
    if (((range.lo & mask) >>> 0) === ((range.hi & mask) >>> 0)) break;
    len -= 1;
  }
  return `${intToIpv4((range.lo & maskFor(len)) >>> 0)}/${len}`;
}

export function prefixLength(cidr: string): number {
  const bits = cidr.split("/")[1];
  return bits === undefined ? 32 : Number(bits);
}

/** Number of addresses a range spans. */
export function rangeSize(range: Ipv4Range): number {
  return range.hi - range.lo + 1;
}

export interface AggregationResult {
  /** The resulting CIDRs, at most `maxEntries` of them. */
  cidrs: string[];
  /** True when any merging was required. */
  aggregated: boolean;
  /** Prefixes broader than WIDE_PREFIX_BITS, for reporting. */
  widePrefixes: string[];
}

/**
 * Reduce `cidrs` to at most `maxEntries` prefixes, merging the cheapest pairs first.
 *
 * @throws when the only way to fit would be a prefix broader than
 *         `MAX_AGGREGATION_PREFIX_BITS` — at that point the "allowlist" would be a fiction
 *         and the user should decide explicitly (trim the list, or opt into open egress).
 */
export function aggregateIpv4(cidrs: string[], maxEntries: number): AggregationResult {
  if (maxEntries < 1) throw new Error("maxEntries must be at least 1");

  // Normalize to ranges and settle: merging costs nothing in precision here and often gets
  // us under the cap on its own.
  let ranges = settle(cidrs.map(parseIpv4Cidr));

  let aggregated = ranges.length !== cidrs.length;

  while (ranges.length > maxEntries) {
    // Cheapest merge = the adjacent pair whose covering prefix adds the fewest addresses.
    let bestIndex = 0;
    let bestCost = Number.POSITIVE_INFINITY;
    for (let i = 0; i < ranges.length - 1; i++) {
      const merged = coveringRange(ranges[i]!, ranges[i + 1]!);
      const cost = rangeSize(merged) - rangeSize(ranges[i]!) - rangeSize(ranges[i + 1]!);
      if (cost < bestCost) {
        bestCost = cost;
        bestIndex = i;
      }
    }

    const merged = coveringRange(ranges[bestIndex]!, ranges[bestIndex + 1]!);
    const mergedCidr = coveringCidr(merged);
    if (prefixLength(mergedCidr) < MAX_AGGREGATION_PREFIX_BITS) {
      throw new Error(
        `cannot fit the allow set into ${maxEntries} entries without allowing ${mergedCidr}, ` +
          `which is too broad to call an allowlist`,
      );
    }

    ranges.splice(bestIndex, 2, merged);
    ranges = settle(ranges);
    aggregated = true;
  }

  const result = ranges.map(coveringCidr);
  return {
    cidrs: result,
    aggregated,
    widePrefixes: result.filter((c) => prefixLength(c) < WIDE_PREFIX_BITS),
  };
}

/**
 * Fixpoint of "widen each range to the CIDR that will actually be emitted, then merge
 * overlaps".
 *
 * The widening matters: a range like 104.16.0.0–104.16.9.255 is emitted as 104.16.0.0/20,
 * which covers up to 104.16.15.255 — and therefore subsumes entries that plain range
 * coalescing left alone. Without this pass the output carries redundant CIDRs that consume
 * scarce allowlist slots for no added reach.
 */
function settle(ranges: Ipv4Range[]): Ipv4Range[] {
  let current = coalesce(ranges);
  for (;;) {
    const widened = coalesce(current.map((r) => parseIpv4Cidr(coveringCidr(r))));
    if (widened.length === current.length && widened.every((r, i) => r.lo === current[i]!.lo && r.hi === current[i]!.hi)) {
      return widened;
    }
    current = widened;
  }
}

function coveringRange(a: Ipv4Range, b: Ipv4Range): Ipv4Range {
  const lo = Math.min(a.lo, b.lo);
  const hi = Math.max(a.hi, b.hi);
  // The covering *prefix* may reach further than the union of the two ranges.
  const cidr = coveringCidr({ lo, hi });
  return parseIpv4Cidr(cidr);
}

/** Merge overlapping or directly adjacent ranges. Assumes sorted input. */
function coalesce(ranges: Ipv4Range[]): Ipv4Range[] {
  const out: Ipv4Range[] = [];
  for (const range of [...ranges].sort((a, b) => a.lo - b.lo || a.hi - b.hi)) {
    const last = out[out.length - 1];
    if (last && range.lo <= last.hi + 1) {
      last.hi = Math.max(last.hi, range.hi);
      continue;
    }
    out.push({ ...range });
  }
  return out;
}
