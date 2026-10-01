/**
 * src/podnames.ts — host-side pod display-name registry (§5.4, §9).
 *
 * Session names are mirrored onto the provider label `pi-pod/name` so `pi-pod list` can show
 * them and `pi-pod attach <name>` can find them. That works when the provider can update labels
 * after creation. Where provider metadata is create-only, mutable labels live in a sidecar file
 * *inside* the sandbox and `list()` only merges it for running pods — a stopped
 * pod's name vanishes from the table even though rename wrote it.
 *
 * The host registry is the durable half of the same mirror: every rename and every in-session
 * `/name` (or auto-name) also lands here under `~/.pi-pod/pod-names.json`, and `listPods`
 * overlays it when the provider has no name. Live provider labels still win when present, so a
 * running session that just renamed itself is what the table shows.
 *
 * This file is machine-local on purpose. Names are a personal index of *your* pods, not a repo
 * contract, and another machine listing the same provider account without this file simply
 * falls back to whatever the provider still carries.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { hostHome } from "./hostconfig.js";
import { LABEL_NAME, sanitizeLabelValue } from "./labels.js";
import type { SandboxInfo } from "./providers/types.js";
import { USER_CONFIG_DIR } from "./userconfig.js";

/** Filename under `~/.pi-pod/`. Not secrets; mode 644 is fine. */
export const POD_NAMES_FILE = "pod-names.json";

interface PodNamesFile {
  version: 1;
  /** Sanitized display names, keyed by provider pod id. */
  names: Record<string, string>;
}

/** Test seam — absolute path to the registry file. Defaults to `~/.pi-pod/pod-names.json`. */
export function podNamesPath(home: string | null = hostHome()): string | null {
  if (!home) return null;
  return path.join(home, USER_CONFIG_DIR, POD_NAMES_FILE);
}

function emptyFile(): PodNamesFile {
  return { version: 1, names: {} };
}

/**
 * Read the registry. Missing/corrupt files are empty rather than fatal: a bad cache must not
 * take down `pi-pod list`.
 */
export function readPodNames(home: string | null = hostHome()): PodNamesFile {
  const file = podNamesPath(home);
  if (!file || !fs.existsSync(file)) return emptyFile();
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<PodNamesFile>;
    if (raw && raw.version === 1 && raw.names && typeof raw.names === "object") {
      const names: Record<string, string> = {};
      for (const [id, name] of Object.entries(raw.names)) {
        if (typeof id === "string" && typeof name === "string" && name.trim() !== "") {
          names[id] = name;
        }
      }
      return { version: 1, names };
    }
  } catch {
    // fall through to empty
  }
  return emptyFile();
}

/**
 * Remember a pod's display name on the host. Best-effort: a full disk or missing home must not
 * fail the rename that already succeeded on the provider.
 */
export function rememberPodName(
  podId: string,
  name: string,
  home: string | null = hostHome(),
): string | null {
  const file = podNamesPath(home);
  if (!file) return null;
  const stored = sanitizeLabelValue(name.trim());
  if (stored === "") return null;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const current = readPodNames(home);
    if (current.names[podId] === stored) return stored;
    current.names[podId] = stored;
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(current, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, file);
    return stored;
  } catch {
    return null;
  }
}

/** Drop a pod id from the registry (e.g. after `gc --delete`). Best-effort. */
export function forgetPodName(podId: string, home: string | null = hostHome()): void {
  const file = podNamesPath(home);
  if (!file || !fs.existsSync(file)) return;
  try {
    const current = readPodNames(home);
    if (!(podId in current.names)) return;
    delete current.names[podId];
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(current, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, file);
  } catch {
    // ignore
  }
}

/**
 * Overlay host-remembered names onto pods the provider listed without one.
 *
 * Live provider labels win: a running pod whose session just renamed itself is authoritative.
 * When the provider has a name we also refresh the host cache, so a name that only ever lived
 * in a running sidecar is not lost the moment the pod stops.
 */
export function applyHostPodNames(
  pods: SandboxInfo[],
  home: string | null = hostHome(),
): SandboxInfo[] {
  if (pods.length === 0) return pods;
  const registry = readPodNames(home);
  let dirty = false;

  const out = pods.map((pod) => {
    const live = pod.labels[LABEL_NAME];
    if (live && live.trim() !== "") {
      if (registry.names[pod.id] !== live) {
        registry.names[pod.id] = live;
        dirty = true;
      }
      return pod;
    }
    const remembered = registry.names[pod.id];
    if (!remembered) return pod;
    return {
      ...pod,
      labels: { ...pod.labels, [LABEL_NAME]: remembered },
    };
  });

  if (dirty) {
    const file = podNamesPath(home);
    if (file) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
        fs.renameSync(tmp, file);
      } catch {
        // best-effort cache refresh
      }
    }
  }

  return out;
}
