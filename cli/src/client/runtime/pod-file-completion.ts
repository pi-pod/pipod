/**
 * src/client/runtime/pod-file-completion.ts — `@` completion against the pod's workspace.
 *
 * The launcher embeds pi's own `InteractiveMode`, so pi-tui's `CombinedAutocompleteProvider`
 * resolves `@` by walking `basePath` — the *host's* cwd — with the host's `fd`. Every path
 * the agent can act on lives in the pod, so those suggestions name files that need not
 * exist there. This wraps the provider pi built (`ui.addAutocompleteProvider`) and answers
 * the `@` case from the pod instead, leaving `/` commands and their argument completions to
 * the provider underneath.
 *
 * Prefix parsing and completion-value construction mirror pi-tui's own private helpers: the
 * wrapper has to agree with the `applyCompletion` it delegates back to, byte for byte.
 */
import { fuzzyFilter } from "@earendil-works/pi-tui";

export type FileListEntry = { path: string; dir: boolean };

export type FileListData = {
  entries: FileListEntry[];
  /** False when a pod-side cap cut the walk short, or when the pod could not answer at all. */
  complete: boolean;
};

/**
 * What an old pod, a timeout, or a malformed reply all yield: no suggestions. Never the
 * host's own files — a wrong path that looks right is worse than no completion.
 */
export const FILE_LIST_UNAVAILABLE: FileListData = { entries: [], complete: false };

/** The slice of pi-tui's AutocompleteProvider this wrapper has to satisfy. */
export interface AutocompleteItem {
  value: string;
  label: string;
  description?: string;
}

export interface AutocompleteSuggestions {
  items: AutocompleteItem[];
  prefix: string;
}

export interface AutocompleteProviderLike {
  triggerCharacters?: string[];
  getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null>;
  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number };
  shouldTriggerFileCompletion?(lines: string[], cursorLine: number, cursorCol: number): boolean;
}

/** pi-tui's own token delimiters (autocomplete.js): a token starts after one of these. */
const PATH_DELIMITERS = new Set([" ", "\t", '"', "'", "="]);
/** How many suggestions pi-tui shows for `@`; matching it keeps the list the same size. */
const MAX_SUGGESTIONS = 20;

function findLastDelimiter(text: string): number {
  for (let i = text.length - 1; i >= 0; i -= 1) {
    if (PATH_DELIMITERS.has(text[i] ?? "")) return i;
  }
  return -1;
}

function findUnclosedQuoteStart(text: string): number | null {
  let inQuotes = false;
  let quoteStart = -1;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '"') {
      inQuotes = !inQuotes;
      if (inQuotes) quoteStart = i;
    }
  }
  return inQuotes ? quoteStart : null;
}

function isTokenStart(text: string, index: number): boolean {
  return index === 0 || PATH_DELIMITERS.has(text[index - 1] ?? "");
}

/** The `@…` token under the cursor, or null when the cursor is not in one. */
export function extractAtPrefix(text: string): string | null {
  const quoteStart = findUnclosedQuoteStart(text);
  if (quoteStart !== null) {
    if (quoteStart > 0 && text[quoteStart - 1] === "@") {
      return isTokenStart(text, quoteStart - 1) ? text.slice(quoteStart - 1) : null;
    }
    // An unclosed quote that is not an `@` attachment belongs to the base provider.
    return null;
  }
  const lastDelimiterIndex = findLastDelimiter(text);
  const tokenStart = lastDelimiterIndex === -1 ? 0 : lastDelimiterIndex + 1;
  return text[tokenStart] === "@" ? text.slice(tokenStart) : null;
}

function buildCompletionValue(path: string, isQuotedPrefix: boolean): string {
  return isQuotedPrefix || path.includes(" ") ? `@"${path}"` : `@${path}`;
}

function basename(path: string): string {
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  const cut = trimmed.lastIndexOf("/");
  return cut === -1 ? trimmed : trimmed.slice(cut + 1);
}

export function podFileSuggestions(prefix: string, listing: FileListData): AutocompleteItem[] {
  const isQuotedPrefix = prefix.startsWith('@"');
  const rawPrefix = prefix.slice(isQuotedPrefix ? 2 : 1);
  return fuzzyFilter(listing.entries, rawPrefix, (entry) => entry.path)
    .slice(0, MAX_SUGGESTIONS)
    .map((entry) => ({
      value: buildCompletionValue(entry.path, isQuotedPrefix),
      // applyCompletion keys the "keep completing into this directory" behaviour off the
      // label's trailing slash, so it has to survive here.
      label: basename(entry.path) + (entry.dir ? "/" : ""),
      description: entry.path,
    }));
}

/**
 * Wrap the provider pi built so `@` resolves in the pod. Everything else — slash commands,
 * their argument completions, bare path completion, `applyCompletion` — stays with `base`.
 */
export function wrapWithPodFiles(
  base: AutocompleteProviderLike,
  listFiles: (query: string) => Promise<FileListData>,
): AutocompleteProviderLike {
  return {
    ...(base.triggerCharacters ? { triggerCharacters: base.triggerCharacters } : {}),

    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const textBeforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
      const prefix = extractAtPrefix(textBeforeCursor);
      if (prefix === null) return base.getSuggestions(lines, cursorLine, cursorCol, options);

      const isQuotedPrefix = prefix.startsWith('@"');
      const listing = await listFiles(prefix.slice(isQuotedPrefix ? 2 : 1));
      if (options.signal.aborted) return null;
      const items = podFileSuggestions(prefix, listing);
      return items.length > 0 ? { items, prefix } : null;
    },

    applyCompletion: (lines, cursorLine, cursorCol, item, prefix) =>
      base.applyCompletion(lines, cursorLine, cursorCol, item, prefix),

    ...(base.shouldTriggerFileCompletion
      ? {
          shouldTriggerFileCompletion: (lines: string[], cursorLine: number, cursorCol: number) =>
            base.shouldTriggerFileCompletion!(lines, cursorLine, cursorCol),
        }
      : {}),
  };
}
