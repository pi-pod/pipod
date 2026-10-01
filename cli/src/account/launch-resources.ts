/**
 * src/account/launch-resources.ts — per-launch Pi resources (`piOverrides` arrays).
 *
 * A launch may add Pi resources — extensions, skills, prompt templates — to the pod's
 * configured set for that launch only. The CLI spells them exactly as Pi does after `--`
 * (`-e/--extension PATH`, `--skill PATH`, `--prompt-template PATH`, each repeatable);
 * the request carries bare path lists. The server places their flag/path pairs before
 * the untouched configured `pi.args`, so an existing `--` cannot swallow new options.
 *
 * Every path names a file or directory *inside the pod* as an absolute POSIX path. It is
 * never stat'ed on this machine: the workstation that launches and the pod that boots are
 * different filesystems, so a local readability check would both lie and leak. Validation
 * here is purely lexical — the per-launch API's shape, bounds, and normalization.
 * Existing Pi configuration retains Pi's own path/package semantics; these request fields
 * use absolute paths, allow spaces and arbitrary names, and reject ambiguous spelling.
 */
import { PiPodError } from "../errors.js";
import type { PiLaunchOverrides } from "./api.js";

/** Longest single resource path a launch request carries. */
export const MAX_RESOURCE_PATH_LENGTH = 4096;

/** Bound per-request resource selection; large stable sets can use existing bundles. */
export const MAX_RESOURCES_PER_KIND = 64;

export type PiResourceKey = "extensions" | "skills" | "promptTemplates";

/** Every resource array the resolve echo must confirm, in canonical order. */
export const PI_RESOURCE_KEYS: readonly PiResourceKey[] = ["extensions", "skills", "promptTemplates"];

/** The Pi flag each resource array uses, in canonical (long) spelling. */
export const PI_RESOURCE_FLAGS: Record<PiResourceKey, string> = {
  extensions: "--extension",
  skills: "--skill",
  promptTemplates: "--prompt-template",
};

/** The CLI spellings each resource array is collected from after `--` (`-e` is Pi's own alias). */
export const PI_RESOURCE_CLI_FLAGS: Record<PiResourceKey, readonly string[]> = {
  extensions: ["--extension", "-e"],
  skills: ["--skill"],
  promptTemplates: ["--prompt-template"],
};

const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * Validate one pod-local resource path lexically. Returns the path unchanged — it is stored
 * and echoed verbatim so the resolve confirmation compares exactly what was requested.
 */
export function parseResourcePath(flag: string, value: string): string {
  if (value === "") {
    throw new PiPodError(`${flag} requires a path`, {
      hint: "name a file or directory inside the pod, for example: pipod -- --skill /workspace/skills/review",
    });
  }
  if (value.length > MAX_RESOURCE_PATH_LENGTH) {
    throw new PiPodError(`${flag} path is longer than ${MAX_RESOURCE_PATH_LENGTH} characters`, {
      hint: "name the resource by its pod-absolute path, without a redundant prefix",
    });
  }
  if (!value.startsWith("/")) {
    throw new PiPodError(`${flag} ${JSON.stringify(value)} is not an absolute path`, {
      hint: "resource paths live on the pod, not this machine — pass the pod-absolute path, for example: pipod -- --skill /workspace/skills/review",
    });
  }
  if (CONTROL.test(value)) {
    throw new PiPodError(`${flag} path must not contain control characters`, {
      hint: "pass the pod-absolute path exactly as it appears on the pod",
    });
  }
  if (value.endsWith("/")) {
    throw new PiPodError(`${flag} ${JSON.stringify(value)} must not end with a slash`, {
      hint: "drop the trailing slash; files and directories are both accepted as written",
    });
  }
  const segments = value.split("/");
  const normalized = segments.every((segment, index) =>
    index === 0 ? segment === "" : segment !== "" && segment !== "." && segment !== "..",
  );
  if (!normalized) {
    throw new PiPodError(
      `${flag} ${JSON.stringify(value)} must be normalized: no empty, "." or ".." segments`,
      { hint: "pass the absolute path exactly as it appears on the pod" },
    );
  }
  return value;
}

/** True when two requested/echoed resource arrays agree exactly, order included. */
export function sameResourceList(requested: string[] | undefined, echoed: string[] | undefined): boolean {
  const want = requested ?? [];
  const got = echoed ?? [];
  return want.length === got.length && want.every((path, index) => got[index] === path);
}

/**
 * The canonical `--flag path` pairs for `piOverrides`, in `PI_RESOURCE_KEYS` order.
 * Empty arrays contribute nothing: they are an additive no-op, never a clearing.
 */
export function resourceArgsFor(overrides: PiLaunchOverrides): string[] {
  const args: string[] = [];
  for (const key of PI_RESOURCE_KEYS) {
    for (const path of overrides[key] ?? []) {
      args.push(PI_RESOURCE_FLAGS[key], path);
    }
  }
  return args;
}
