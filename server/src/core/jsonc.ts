/**
 * src/jsonc.ts — minimal JSONC support (§4.1): comments and trailing commas.
 *
 * The annotated config example in the spec must be valid as written, so config.json is
 * parsed as JSONC. This strips comments and trailing commas with a real tokenizer (string
 * literals and escapes are respected, so a `//` inside a value is left alone) and then
 * hands the result to JSON.parse. Whitespace is preserved in place of stripped text so
 * that parse-error offsets still point at the right line.
 */

export function stripJsonComments(input: string): string {
  const out: string[] = [];
  let i = 0;
  const n = input.length;

  // Byte offsets of commas that may turn out to be trailing.
  const pendingCommas: number[] = [];
  let lastComma = -1;

  const push = (s: string) => out.push(s);
  const blank = (s: string) => push(s.replace(/[^\n\r]/g, " "));

  while (i < n) {
    const ch = input[i]!;

    if (ch === '"') {
      // String literal — copy verbatim, honoring escapes.
      let j = i + 1;
      while (j < n) {
        const c = input[j]!;
        if (c === "\\") {
          j += 2;
          continue;
        }
        if (c === '"') {
          j += 1;
          break;
        }
        j += 1;
      }
      push(input.slice(i, j));
      lastComma = -1;
      i = j;
      continue;
    }

    if (ch === "/" && input[i + 1] === "/") {
      let j = i;
      while (j < n && input[j] !== "\n" && input[j] !== "\r") j += 1;
      blank(input.slice(i, j));
      i = j;
      continue;
    }

    if (ch === "/" && input[i + 1] === "*") {
      let j = i + 2;
      while (j < n && !(input[j] === "*" && input[j + 1] === "/")) j += 1;
      j = Math.min(j + 2, n);
      blank(input.slice(i, j));
      i = j;
      continue;
    }

    if (ch === ",") {
      lastComma = out.length;
      pendingCommas.push(out.length);
      push(",");
      i += 1;
      continue;
    }

    if (ch === "}" || ch === "]") {
      // Any comma seen since the last significant token was a trailing comma.
      if (lastComma >= 0) out[lastComma] = " ";
      lastComma = -1;
      push(ch);
      i += 1;
      continue;
    }

    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      push(ch);
      i += 1;
      continue;
    }

    lastComma = -1;
    push(ch);
    i += 1;
  }

  return out.join("");
}

export class JsoncParseError extends Error {
  readonly filePath: string | undefined;
  constructor(message: string, filePath?: string) {
    super(message);
    this.name = "JsoncParseError";
    this.filePath = filePath;
  }
}

export function parseJsonc(text: string, filePath?: string): unknown {
  const stripped = stripJsonComments(text);
  try {
    return JSON.parse(stripped);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new JsoncParseError(
      `${filePath ? `${filePath}: ` : ""}invalid JSON/JSONC: ${msg}`,
      filePath,
    );
  }
}
