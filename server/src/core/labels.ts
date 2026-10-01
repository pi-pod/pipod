/**
 * src/labels.ts — pod labels (§9) and the injected `PI_POD_*` env markers (§7.3).
 *
 * Labels are provider-neutral in core; each adapter maps them to its native
 * metadata/tagging. The markers let the launcher-generated extension report on the session
 * without holding any provider credential.
 */
import * as os from "node:os";

export const MANAGED_BY_KEY = "managed-by";
export const MANAGED_BY_VALUE = "pi-pod";
export const LABEL_PROJECT = "pi-pod/project";
export const LABEL_HOST_USER = "pi-pod/host-user";
export const LABEL_CREATED = "pi-pod/created";
/**
 * Where the workspace lives inside the pod.
 *
 * `pi-pod attach` runs in a later process that never saw this session's plan, and the pod
 * is the only thing that outlived it — so the few facts needed to walk back in are stored on
 * the pod rather than reconstructed from config that may have changed since.
 */
export const LABEL_WORKDIR = "pi-pod/workdir";
/** Provider PTY session id, so a reconnect rejoins the running pi instead of starting a second. */
export const LABEL_PTY = "pi-pod/pty";
/**
 * Mirror of the pi session's own name (§5.4), so `pi-pod list` can show it and
 * `pi-pod attach <name>` can find it without opening a session.
 *
 * A sanitized echo, not the name of record: the display name lives in the pod's session file,
 * which is what `/name` writes and what a resumed session reads back.
 */
export const LABEL_NAME = "pi-pod/name";
/** Host has a value-free environment source recipe for this pod. */
export const LABEL_ENV_RECIPE = "pi-pod/env-recipe";
/**
 * How the session drives pi: absent/"rpc" is the shim wire, "tui" is the remote-TUI
 * passthrough (§5.7), the default on a terminal — `--no-remote-tui` chooses the wire.
 * Recorded so `pi-pod attach` rejoins a pod in the mode its session is running —
 * a raw PTY holds a full-screen pi, and speaking frames at it would only corrupt its screen.
 */
export const LABEL_UI = "pi-pod/ui";

/**
 * Reserved env names the launcher sets itself and refuses from the env file (§7.3).
 * A collision is a hard failure rather than a silent overwrite: if the repo believes it
 * controls `TERM` or `PI_POD`, something is wrong with the mental model.
 *
 * `PI_POD_SANDBOX`/`PI_POD_SANDBOX_ID` are the pre-rename spelling of the first two. They remain
 * reserved and injected for scripts and already-running sessions created by older launchers; new
 * generated extensions prefer `PI_POD`/`PI_POD_ID`.
 */
export const RESERVED_ENV_NAMES = [
  "PI_POD",
  "PI_POD_ID",
  "PI_POD_SANDBOX",
  "PI_POD_SANDBOX_ID",
  "PI_POD_PROVIDER",
  "PI_POD_PROJECT",
  "PI_POD_REPO",
  "PI_POD_IMAGE",
  "PI_POD_CREATED",
  "PI_POD_EGRESS",
  "IS_SANDBOX",
  "TERM",
  "COLORTERM",
] as const;

export function hostUser(): string {
  return (
    process.env["PI_POD_HOST_USER"] ??
    process.env["USER"] ??
    process.env["USERNAME"] ??
    safeOsUser() ??
    "unknown"
  );
}

function safeOsUser(): string | null {
  try {
    return os.userInfo().username;
  } catch {
    return null;
  }
}

/** Label values must survive provider-side constraints; keep them boring. */
export function sanitizeLabelValue(value: string): string {
  return value.replace(/[^A-Za-z0-9_./-]/g, "-").slice(0, 63);
}

/**
 * This host user as it appears *on a pod* — the only spelling a label query can match.
 *
 * `buildLabels` stores the sanitized form, so anything going looking for this user's pods has
 * to sanitize too. A name the sanitizer rewrites — a `DOMAIN\user` arriving via `USERNAME`, an
 * address in `PI_POD_HOST_USER`, anything past 63 characters — would otherwise be filtered
 * against a value no pod has ever carried, and every listing would come back empty while the
 * pods sat there. Use `hostUser()` for what you print and this for what you match on.
 */
export function hostUserLabel(): string {
  return sanitizeLabelValue(hostUser());
}

export interface BuildLabelsInput {
  project: string;
  createdAtMs: number;
  /** Workspace root inside the pod, for `pi-pod attach` (§8). */
  workdir: string;
  extra?: Record<string, string>;
}

export function buildLabels(input: BuildLabelsInput): Record<string, string> {
  const createdSec = Math.floor(input.createdAtMs / 1000);
  return {
    ...(input.extra ?? {}),
    [MANAGED_BY_KEY]: MANAGED_BY_VALUE,
    [LABEL_PROJECT]: sanitizeLabelValue(input.project),
    [LABEL_HOST_USER]: sanitizeLabelValue(hostUser()),
    [LABEL_CREATED]: String(createdSec),
    [LABEL_WORKDIR]: sanitizeLabelValue(input.workdir),
  };
}

/** Recorded after the PTY opens, since the session id does not exist before then (§8). */
export function ptySessionLabel(sessionId: string): Record<string, string> {
  return { [LABEL_PTY]: sanitizeLabelValue(sessionId) };
}

/** Recorded whenever the session renames itself, so a listing outside the session sees it (§9). */
export function sessionNameLabel(name: string): Record<string, string> {
  return { [LABEL_NAME]: sanitizeLabelValue(name) };
}


export interface MarkerInput {
  provider: string;
  project: string;
  image: string;
  createdAtMs: number;
  egress: string;
  term?: string | undefined;
  colorterm?: string | undefined;
}

/**
 * Markers known at creation time. `PI_POD_ID` is not among them — the id does not exist until
 * `create()` returns — so it is injected into every exec/PTY environment afterwards (see
 * `runtimeMarkers`).
 */
export function creationMarkers(input: MarkerInput): Record<string, string> {
  const markers: Record<string, string> = {
    PI_POD: "1",
    // See RESERVED_ENV_NAMES: the extension lives in the image, so the old spelling has to keep
    // arriving until every image predating the rename has been rebuilt.
    PI_POD_SANDBOX: "1",
    PI_POD_PROVIDER: input.provider,
    PI_POD_PROJECT: input.project,
    PI_POD_IMAGE: input.image,
    PI_POD_CREATED: String(Math.floor(input.createdAtMs / 1000)),
    PI_POD_EGRESS: input.egress,
    // Not a pi-pod marker — a statement of fact that one specific consumer requires. The
    // Claude Code CLI, which `claude-bridge` runs as a subprocess (§7.6), refuses
    // bypassPermissions outright when `getuid() === 0` unless this is set. Pods run as root,
    // so without it every bridge call exits 1 with a message about sudo, which reads as a
    // pi-pod bug and is nowhere near the credential the user just carried in. The claim it
    // makes is true here in a way it is not on a laptop: this *is* a disposable pod.
    IS_SANDBOX: "1",
  };
  // TERM propagation (§8): TUI rendering should match the host terminal.
  if (input.term) markers["TERM"] = input.term;
  if (input.colorterm) markers["COLORTERM"] = input.colorterm;
  return markers;
}

export function runtimeMarkers(podId: string): Record<string, string> {
  return { PI_POD_ID: podId, PI_POD_SANDBOX_ID: podId };
}
