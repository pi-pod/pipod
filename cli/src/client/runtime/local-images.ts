/**
 * src/client/runtime/local-images.ts — local image attachments for remote prompts.
 *
 * The TUI runs on this machine while the agent runs in the pod. A prompt that names a
 * host-side image — a clipboard paste (pi writes host /tmp and inserts the path), a
 * drag-dropped file, an `@screenshot.png` mention, a typed relative path — would otherwise
 * cross the wire as bare text pointing at a file the pod cannot see, and the pod-side
 * `read` of that path fails. This module finds those references, reads and processes the
 * bytes locally with pi's own image pipeline, and returns them as inline `ImageContent`
 * for the existing `prompt` / `steer` / `follow_up` RPC `images` field. No new RPC method,
 * no gateway change: the semantic protocol already carries images verbatim.
 *
 * Bounds mirror the gateway (`stream-fanout.ts validatePromptImages`) so a prompt this
 * module builds is never rejected server-side: at most {@link MAX_PROMPT_IMAGES} images
 * per prompt *including* already-attached ones the caller passes in, at most
 * {@link MAX_IMAGE_BASE64_CHARS} base64 chars per image (8 MiB decoded), and at most
 * {@link MAX_PROMPT_IMAGES_TOTAL_BASE64_CHARS} base64 chars total. Anything over budget is
 * left as plain text with an `[Image omitted: …]` marker and a user-visible warning — a
 * rejected prompt sends nothing at all, so degrading to text is strictly more useful.
 *
 * Only paths that resolve to a regular local file with an image suffix (or an `@` mention
 * of one) are read — never directories, devices, or wildcards. Reads are bounded: one
 * open, one stat, one capped read, so a file that grows between calls cannot blow up the
 * host. Anything that does not resolve locally is left byte-identical so pod-side `@`
 * references and pod paths keep working.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  convertToPng,
  formatDimensionNote,
  resizeImage,
} from "@earendil-works/pi-coding-agent";
import { debug } from "../../log.js";
import type { ImageContent } from "../rpc.js";

/** Suffixes this module will consider. Detection is by content sniff, not by suffix. */
const IMAGE_SUFFIXES = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);
/** Inline provider images: anything else (bmp, undecodable) gets one PNG conversion attempt. */
const INLINE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/**
 * At most this many local images ride one prompt, *including* images the caller already
 * attached (extension-supplied parts). Matches the gateway's MAX_PROMPT_IMAGES.
 */
export const MAX_PROMPT_IMAGES = 8;
/** Max base64 chars per sent image (8 MiB decoded). Matches the gateway's per-image cap. */
export const MAX_IMAGE_BASE64_CHARS = 11_184_812;
/**
 * Max base64 chars across every image on one prompt (32 MiB, ~24 MiB decoded). Matches
 * the gateway's total cap; the C-frame base64-expands the RPC JSON again, so this is what
 * keeps the turn under the 64 MiB transport line limit.
 */
export const MAX_PROMPT_IMAGES_TOTAL_BASE64_CHARS = 32 * 1024 * 1024;
/**
 * Raw on-disk read bound per image. Well above what the pipeline emits (pi resizes to
 * ~4.5 MB), purely a host-side DoS cap so a huge file never fully loads into memory.
 */
export const MAX_IMAGE_FILE_BYTES = 24 * 1024 * 1024;
/** Same path sanity cap as the `@` file-listing channel. */
export const MAX_IMAGE_PATH_CHARS = 1024;

export interface PreparedPromptImages {
  /** Original text plus one `<file name="…">` marker line per attached/omitted image. */
  text: string;
  /** Inline attachments for the RPC `images` field; undefined when nothing attached. */
  images: ImageContent[] | undefined;
  /** Absolute host paths that became inline attachments, in prompt order. */
  attached: string[];
  /** References that named a real local file but could not be attached. */
  omitted: Array<{ path: string; message: string }>;
}

export interface PreparePromptImagesOptions {
  /** Host working directory bare relative paths resolve against. */
  cwd: string;
  /** Warn the user about detected-but-unusable images; silent otherwise. */
  notify?: ((message: string, type: "info" | "warning" | "error") => void) | undefined;
  /**
   * Images the caller already attached (e.g. extension-supplied parts sent alongside the
   * prompt). They share the per-prompt count/total budget: scanning stops before the
   * combined turn could exceed what the gateway accepts, so the prompt is never rejected
   * wholesale for an oversized `images` array.
   */
  existingImages?: ImageContent[] | undefined;
}

/**
 * Scan prompt text for local image references and attach what resolves.
 *
 * Never throws: every filesystem or image-pipeline failure degrades to leaving the text
 * untouched (or appending an omit note when the file provably exists locally). Callers
 * send `result.text` with `[...(existing ?? []), ...(result.images ?? [])]` on the
 * existing prompt path.
 */
export async function preparePromptImages(
  text: string,
  opts: PreparePromptImagesOptions,
): Promise<PreparedPromptImages> {
  const candidates = collectImageCandidates(text);
  const attached: string[] = [];
  const omitted: Array<{ path: string; message: string }> = [];
  const images: ImageContent[] = [];
  const markers: string[] = [];
  const seen = new Set<string>();

  const existing = opts.existingImages ?? [];
  let totalBase64Chars = 0;
  for (const image of existing) {
    if (typeof image?.data === "string") totalBase64Chars += image.data.length;
  }
  let slotsLeft = MAX_PROMPT_IMAGES - existing.length;
  const overBudgetAlready =
    existing.length > MAX_PROMPT_IMAGES || totalBase64Chars > MAX_PROMPT_IMAGES_TOTAL_BASE64_CHARS;
  if (overBudgetAlready && candidates.length > 0) {
    opts.notify?.(
      `prompt already carries ${existing.length} attached image${existing.length === 1 ? "" : "s"}; local file references were left as text so the turn stays within the image budget`,
      "warning",
    );
  }

  for (const candidate of candidates) {
    const absPath = resolveCandidate(candidate, opts.cwd);
    if (!absPath || seen.has(absPath)) continue;
    seen.add(absPath);
    if (overBudgetAlready || slotsLeft <= 0) {
      omitted.push({ path: absPath, message: `more than ${MAX_PROMPT_IMAGES} images in one prompt` });
      continue;
    }
    const outcome = await attachImage(absPath);
    if (outcome.kind === "missing") continue; // A pod-side path: leave the text alone.
    if (outcome.kind === "omitted") {
      omitted.push({ path: absPath, message: outcome.message });
      markers.push(`<file name="${markerName(absPath)}">${outcome.message}</file>`);
      continue;
    }
    if (outcome.image.data.length > MAX_IMAGE_BASE64_CHARS) {
      const message = "[Image omitted: the processed image exceeds the 8 MiB per-image limit.]";
      omitted.push({ path: absPath, message });
      markers.push(`<file name="${markerName(absPath)}">${message}</file>`);
      continue;
    }
    if (totalBase64Chars + outcome.image.data.length > MAX_PROMPT_IMAGES_TOTAL_BASE64_CHARS) {
      const message = "[Image omitted: attaching it would exceed the total image budget for one prompt.]";
      omitted.push({ path: absPath, message });
      markers.push(`<file name="${markerName(absPath)}">${message}</file>`);
      continue;
    }
    totalBase64Chars += outcome.image.data.length;
    slotsLeft -= 1;
    images.push(outcome.image);
    attached.push(absPath);
    markers.push(
      `<file name="${markerName(absPath)}">${outcome.hints.length > 0 ? outcome.hints.join("\n") : ""}</file>`,
    );
  }

  for (const skipped of omitted) {
    debug(`local image not attached (${skipped.path}): ${skipped.message}`);
  }
  if (omitted.length > 0) {
    const names = omitted.map((entry) => path.basename(entry.path)).join(", ");
    opts.notify?.(
      `could not attach local image${omitted.length === 1 ? "" : "s"} (${names}); the prompt was sent with text references only`,
      "warning",
    );
  }
  return {
    text: markers.length > 0 ? `${text}\n${markers.join("\n")}` : text,
    images: images.length > 0 ? images : undefined,
    attached,
    omitted,
  };
}

type AttachOutcome =
  | { kind: "missing" }
  | { kind: "omitted"; message: string }
  | { kind: "attached"; image: ImageContent; hints: string[] };

/**
 * One open, one stat, one bounded read: a file that grows (or is swapped) mid-call can at
 * most cost MAX_IMAGE_FILE_BYTES + 1 of memory, and the sniff runs on the bytes actually
 * read rather than on a second open that could see a different file.
 */
async function attachImage(absPath: string): Promise<AttachOutcome> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    try {
      handle = await fs.promises.open(absPath, "r");
    } catch {
      return { kind: "missing" };
    }
    const stat = await handle.stat().catch(() => null);
    if (!stat || !stat.isFile()) return { kind: "missing" };
    if (stat.size === 0) {
      return { kind: "omitted", message: "[Image omitted: the file is empty.]" };
    }
    if (stat.size > MAX_IMAGE_FILE_BYTES) {
      return {
        kind: "omitted",
        message: `[Image omitted: the file exceeds the ${Math.floor(MAX_IMAGE_FILE_BYTES / (1024 * 1024))} MB per-image limit.]`,
      };
    }
    // Cap the read one byte past the limit so growth between stat and read is detected
    // rather than loaded.
    const cap = Math.min(stat.size, MAX_IMAGE_FILE_BYTES) + 1;
    const buffer = Buffer.alloc(cap);
    const { bytesRead } = await handle.read(buffer, 0, cap, 0).catch(() => ({ bytesRead: -1 }));
    if (bytesRead < 0) {
      return { kind: "omitted", message: "[Image omitted: the file could not be read.]" };
    }
    if (bytesRead > MAX_IMAGE_FILE_BYTES) {
      return {
        kind: "omitted",
        message: `[Image omitted: the file exceeds the ${Math.floor(MAX_IMAGE_FILE_BYTES / (1024 * 1024))} MB per-image limit.]`,
      };
    }
    const bytes = buffer.subarray(0, bytesRead);
    if (bytes.length === 0) {
      return { kind: "omitted", message: "[Image omitted: the file is empty.]" };
    }
    return await processImageBytes(bytes);
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * The suffix only nominates; this sniff decides — the same rule as pi's own @file
 * attachments. Magic bytes only (pi's mime.ts semantics: JPEG, still PNG, GIF, WebP go
 * inline; BMP and anything else gets one PNG conversion attempt first).
 */
function sniffImageMimeType(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return bytes[3] === 0xf7 ? null : "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return isAnimatedPng(bytes) ? null : "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return "image/bmp";
  }
  return null;
}

/** Animated PNGs are not inline-eligible (pi declines them at the sniff too). */
function isAnimatedPng(bytes: Uint8Array): boolean {
  let offset = 8;
  const readU32BE = (at: number): number =>
    (bytes[at] ?? 0) * 0x1000000 +
    ((bytes[at + 1] ?? 0) << 16) +
    ((bytes[at + 2] ?? 0) << 8) +
    (bytes[at + 3] ?? 0);
  const asciiAt = (at: number, text: string): boolean => {
    for (let i = 0; i < text.length; i++) {
      if ((bytes[at + i] ?? -1) !== text.charCodeAt(i)) return false;
    }
    return true;
  };
  while (offset + 8 <= bytes.length) {
    const chunkLength = readU32BE(offset);
    const chunkType = offset + 4;
    if (asciiAt(chunkType, "acTL")) return true;
    if (asciiAt(chunkType, "IDAT")) return false;
    const next = offset + 8 + chunkLength + 4;
    if (next <= offset || next > bytes.length) return false;
    offset = next;
  }
  return false;
}

async function processImageBytes(bytes: Uint8Array): Promise<AttachOutcome> {
  const mimeType = sniffImageMimeType(bytes);
  try {
    if (mimeType && INLINE_MIME_TYPES.has(mimeType)) {
      const resized = await resizeImage(bytes, mimeType);
      if (!resized) {
        return { kind: "omitted", message: "[Image omitted: could not be resized below the inline image size limit.]" };
      }
      const hints: string[] = [];
      const note = formatDimensionNote(resized);
      if (note) hints.push(note);
      return { kind: "attached", image: { type: "image", data: resized.data, mimeType: resized.mimeType }, hints };
    }
    // bmp, animated PNG, and anything the sniff declines: one PNG conversion attempt
    // through the same backend pi's read tool uses, then the standard resize.
    const converted = await convertToPng(Buffer.from(bytes).toString("base64"), mimeType ?? "image/png");
    if (!converted) {
      return { kind: "omitted", message: "[Image omitted: could not be converted to a supported inline image format.]" };
    }
    const resized = await resizeImage(new Uint8Array(Buffer.from(converted.data, "base64")), converted.mimeType);
    if (!resized) {
      return { kind: "omitted", message: "[Image omitted: could not be resized below the inline image size limit.]" };
    }
    const hints = [
      mimeType && mimeType !== converted.mimeType
        ? `[Image converted from ${mimeType} to ${converted.mimeType}.]`
        : "[Image converted to image/png.]",
    ];
    const note = formatDimensionNote(resized);
    if (note) hints.push(note);
    return { kind: "attached", image: { type: "image", data: resized.data, mimeType: resized.mimeType }, hints };
  } catch (error) {
    return {
      kind: "omitted",
      message: `[Image omitted: image processing failed (${error instanceof Error ? error.message : String(error)}).]`,
    };
  }
}

/**
 * What goes in the `name` of the `<file>` marker: the basename, XML-escaped. The marker is
 * a label for a turn whose bytes already ride the `images` field — the pod can never open
 * the host path, so sending the full path would only leak the host's directory layout
 * into the persisted transcript.
 */
function markerName(absPath: string): string {
  return escapeXml(path.basename(absPath));
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Expand `~`, resolve against the host cwd, and reject non-paths. */
function resolveCandidate(candidate: string, cwd: string): string | null {
  if (candidate.length === 0 || candidate.length > MAX_IMAGE_PATH_CHARS) return null;
  if (candidate.includes("\0") || candidate.includes("\n")) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(candidate)) return null; // URL, not a file.
  if (/^data:/i.test(candidate)) return null;
  let expanded = candidate;
  if (expanded === "~" || expanded.startsWith("~/")) {
    expanded = path.join(os.homedir(), expanded.slice(1));
  }
  const absPath = path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(cwd, expanded);
  return absPath;
}

/**
 * Candidate spans in prompt order: `@path` mentions first-class (they name pod *or* local
 * files; only local hits attach), then quoted paths, then bare tokens. A span must carry
 * an image suffix to nominate — content sniffing, not the suffix, makes the decision.
 *
 * Bare absolute paths stay eligible on purpose: that is exactly what clipboard pastes and
 * drag-drops insert (pi writes the image under the host /tmp and puts the bare path in
 * the editor). Prose-shaped tokens stay out — only `@` mentions name a file on purpose.
 */
/**
 * Pure, synchronous pre-scan: candidate path spans in prompt order. Exported so the
 * prompt hot path can skip the filesystem entirely when there is nothing to attach —
 * imageless prompts then transmit exactly as before.
 */
export function collectImageCandidates(text: string): string[] {
  const candidates: string[] = [];
  const push = (raw: string, explicit: boolean): void => {
    const cleaned = cleanSpan(raw, explicit);
    if (cleaned && hasImageSuffix(cleaned)) candidates.push(cleaned);
  };

  for (const match of text.matchAll(/(^|[\s(\[{])@("[^"\n]+"|'[^'\n]+'|[^\s"'`()[\]{}<>|;!?*]+)/g)) {
    // An `@path` mention is an explicit file reference, so even a bare name
    // resolves against the host cwd — unlike prose tokens.
    push(match[2]!, true);
  }
  for (const match of text.matchAll(/"([^"\n]+)"|'([^'\n]+)'/g)) {
    push(match[1] ?? match[2]!, false);
  }
  for (const match of text.matchAll(/[^\s"'`()[\]{}<>|;]+/g)) {
    push(match[0]!, false);
  }
  return candidates;
}

function cleanSpan(raw: string, explicit: boolean): string | null {
  let span = raw.trim();
  if (span.startsWith("@")) span = span.slice(1);
  if (
    (span.startsWith('"') && span.endsWith('"') && span.length >= 2) ||
    (span.startsWith("'") && span.endsWith("'") && span.length >= 2)
  ) {
    span = span.slice(1, -1);
  }
  if (span.toLowerCase().startsWith("file://")) span = span.slice("file://".length);
  // Pasted prose leaves punctuation on the path: "see (shot.png)," names shot.png.
  span = span.replace(/^[(\[{<]+/, "").replace(/[)\]}>.,;:!?]+$/, "");
  if (span.length === 0 || span.length > MAX_IMAGE_PATH_CHARS) return null;
  // Bare tokens need a path shape — absolute, ~/-, ./-, ../-led, or containing a slash —
  // so prose like "a.png" as a version string does not stat the world. Explicit `@`
  // mentions skip this: the user named a file on purpose.
  if (!explicit && !path.isAbsolute(span) && !span.startsWith("~") && !span.startsWith("./") && !span.startsWith("../") && !span.includes("/")) {
    return null;
  }
  return span;
}

function hasImageSuffix(span: string): boolean {
  const dot = span.lastIndexOf(".");
  if (dot < 0) return false;
  return IMAGE_SUFFIXES.has(span.slice(dot + 1).toLowerCase());
}
