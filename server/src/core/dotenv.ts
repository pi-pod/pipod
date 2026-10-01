/**
 * src/dotenv.ts — env file parser (§4.2).
 *
 * Standard dotenv format, parsed on the host. Comments, blank lines and `export KEY=value`
 * prefixes are supported. There is deliberately no variable expansion and no command
 * substitution: values are literal strings, because these are secrets headed for a third
 * party's control plane and surprising transformations are the last thing anyone wants.
 */

export interface DotenvEntry {
  key: string;
  value: string;
  /** 1-based line number, for diagnostics. */
  line: number;
}

export interface DotenvParseResult {
  values: Record<string, string>;
  entries: DotenvEntry[];
  /** Lines that were neither blank, comment, nor KEY=value. */
  malformed: Array<{ line: number; text: string }>;
}

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function parseDotenv(text: string): DotenvParseResult {
  const values: Record<string, string> = {};
  const entries: DotenvEntry[] = [];
  const malformed: Array<{ line: number; text: string }> = [];

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const lineNo = i + 1;
    const trimmed = raw.trim();

    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const withoutExport = trimmed.startsWith("export ")
      ? trimmed.slice("export ".length).trim()
      : trimmed;

    const eq = withoutExport.indexOf("=");
    if (eq <= 0) {
      malformed.push({ line: lineNo, text: raw });
      continue;
    }

    const key = withoutExport.slice(0, eq).trim();
    if (!KEY_RE.test(key)) {
      malformed.push({ line: lineNo, text: raw });
      continue;
    }

    const value = parseValue(withoutExport.slice(eq + 1));
    values[key] = value;
    entries.push({ key, value, line: lineNo });
  }

  return { values, entries, malformed };
}

/**
 * Values may be single-quoted, double-quoted, or bare. Quoted values keep everything inside
 * the quotes verbatim (so `=` and `#` are safe); double-quoted values additionally honor
 * `\n`, `\r`, `\t` and escaped quotes, which is what people expect when pasting a PEM key.
 * Bare values are trimmed and lose an unquoted trailing `# comment`.
 */
function parseValue(rawValue: string): string {
  const v = rawValue.trim();
  if (v === "") return "";

  const quote = v[0];
  if (quote === '"' || quote === "'") {
    const closing = findClosingQuote(v, quote);
    if (closing > 0) {
      const inner = v.slice(1, closing);
      return quote === '"' ? unescapeDoubleQuoted(inner) : inner;
    }
    // Unterminated quote: treat the remainder literally rather than throwing away a secret.
    return v.slice(1);
  }

  const hashIdx = findBareComment(v);
  return (hashIdx >= 0 ? v.slice(0, hashIdx) : v).trim();
}

function findClosingQuote(v: string, quote: string): number {
  for (let i = 1; i < v.length; i++) {
    if (v[i] === "\\" && quote === '"') {
      i += 1;
      continue;
    }
    if (v[i] === quote) return i;
  }
  return -1;
}

function unescapeDoubleQuoted(s: string): string {
  return s.replace(/\\([nrt"'\\$])/g, (_m, c: string) => {
    switch (c) {
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      default:
        return c;
    }
  });
}

/** A `#` only starts a comment when preceded by whitespace (so `pass#word` survives). */
function findBareComment(v: string): number {
  for (let i = 0; i < v.length; i++) {
    if (v[i] === "#" && i > 0 && /\s/.test(v[i - 1]!)) return i;
  }
  return -1;
}

/**
 * `env.example` is the committed contract: every key in `env` should appear (valueless) in
 * `env.example` (§4.2). Returns keys present in one file but not the other.
 */
export function diffEnvKeys(
  envKeys: string[],
  exampleKeys: string[],
): { undocumented: string[]; missing: string[] } {
  const exampleSet = new Set(exampleKeys);
  const envSet = new Set(envKeys);
  return {
    undocumented: envKeys.filter((k) => !exampleSet.has(k)),
    missing: exampleKeys.filter((k) => !envSet.has(k)),
  };
}
