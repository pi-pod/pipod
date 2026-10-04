/**
 * src/manual.ts — the pipod manual, and every help text the CLI prints from it.
 *
 * `man/*.md` is the one source. The build renders each page to a man page (`man pipod`,
 * `man pipod-config`); this module prints the same text, so `pipod help` works where `man`
 * does not (a git-checkout install, a minimal container, Windows) and nothing can drift.
 *
 * The layout this module relies on, in `man/pipod.1.md`:
 *   - `### pipod <command>` under `## COMMANDS` is one command's entry, and it opens with a
 *     fenced block: that block alone is `pipod <command> --help`.
 *   - `## SYNOPSIS` opens the same way: its block is `pipod --help`.
 *   - Any other `## HEADING` is a topic, `pipod help heading`.
 * A further page `man/pipod-<topic>.<section>.md` is the topic `<topic>`, printed whole.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { EXIT, PiPodError } from "./errors.js";
import { packageRoot } from "./image.js";

const MAIN_PAGE = "pipod.1.md";
const FENCE = "```";

/** `pipod --help` (no command) or `pipod <command> --help`: the entry's opening block. */
export function usage(command: string | null): string {
  const entry = command === null ? section(mainPage(), 2, "SYNOPSIS") : commandEntry(command);
  if (entry === null) throw new PiPodError(`the pipod manual has no entry for ${command}`);
  const block = openingBlock(entry);
  const more = command !== null && hasMoreThanBlock(entry) ? `\nMore: pipod help ${command}\n` : "";
  return `${block}${more}`;
}

/** `pipod help <name>`: a command's whole entry, a topic, or a whole page, as plain text. */
export function manualEntry(name: string): string {
  const entry = commandEntry(name) ?? topicSection(name) ?? topicPage(name);
  if (entry === null) {
    throw new PiPodError(`no manual entry for "${name}"`, {
      hint: "`pipod help` lists the commands and topics",
      exitCode: EXIT.USAGE,
    });
  }
  return plainText(entry);
}

function commandEntry(command: string): string | null {
  const commands = section(mainPage(), 2, "COMMANDS");
  return commands === null ? null : section(commands, 3, `pipod ${command}`);
}

function topicSection(topic: string): string | null {
  return /^[a-z]+$/.test(topic) ? section(mainPage(), 2, topic.toUpperCase()) : null;
}

/** `config` → the whole `pipod-config.5.md`, whatever its section number. */
function topicPage(topic: string): string | null {
  const prefix = `pipod-${topic}.`;
  const file = fs.readdirSync(manDir()).find(
    (name) => name.startsWith(prefix) && /^\d+\.md$/.test(name.slice(prefix.length)),
  );
  return file === undefined ? null : read(path.join(manDir(), file));
}

/**
 * The text from a `#`-level heading up to the next heading at that level or above, or null.
 * Headings inside fenced blocks are text, not structure.
 */
function section(markdown: string, level: number, title: string): string | null {
  const lines = markdown.split("\n");
  const heading = `${"#".repeat(level)} ${title}`;
  let start = -1;
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith(FENCE)) fenced = !fenced;
    if (fenced) continue;
    if (start < 0) {
      if (line === heading) start = i;
      continue;
    }
    const depth = /^(#+) /.exec(line)?.[1]?.length;
    if (depth !== undefined && depth <= level) return `${lines.slice(start, i).join("\n").trimEnd()}\n`;
  }
  return start < 0 ? null : `${lines.slice(start).join("\n").trimEnd()}\n`;
}

function openingBlock(entry: string): string {
  const lines = entry.split("\n");
  const open = lines.findIndex((line) => line.startsWith(FENCE));
  const close = lines.findIndex((line, i) => i > open && line.startsWith(FENCE));
  if (open < 0 || close < 0) throw new PiPodError("a pipod manual entry does not open with a usage block");
  return `${lines.slice(open + 1, close).join("\n")}\n`;
}

function hasMoreThanBlock(entry: string): boolean {
  const lines = entry.split("\n");
  const fences = lines.flatMap((line, i) => (line.startsWith(FENCE) ? [i] : []));
  return lines.slice((fences[1] ?? lines.length) + 1).some((line) => line.trim() !== "");
}

/**
 * Markdown as a terminal shows it: heading marks and fences dropped, fenced lines indented,
 * like a man page without the typesetting. Inline marks stay — they are readable as written.
 */
function plainText(markdown: string): string {
  const out: string[] = [];
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (line.startsWith(FENCE)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) out.push(line === "" ? "" : `    ${line}`);
    else out.push(line.replace(/^#+ /, ""));
  }
  return `${out.join("\n").trimEnd()}\n`;
}

function mainPage(): string {
  return read(path.join(manDir(), MAIN_PAGE));
}

function manDir(): string {
  return path.join(packageRoot(), "man");
}

function read(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (cause) {
    throw new PiPodError(`the pipod manual is missing from this install (${file})`, {
      hint: "reinstall pipod: `npm install -g @pipod/cli`, or `npm run build` in a checkout",
      cause,
    });
  }
}
