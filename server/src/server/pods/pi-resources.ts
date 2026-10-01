/**
 * src/server/pods/pi-resources.ts — per-launch Pi resources (extensions, skills, prompt
 * templates).
 *
 * A launch can already choose the model and the thinking level for the pod it is about to
 * create. These are the same kind of choice for the three resource kinds Pi loads by path:
 * `--extension`, `--skill` and `--prompt-template`. The wire carries nothing but paths, the
 * server adds them to the pod's argv with Pi's own flags, and nothing here knows what any
 * particular file does — an orchestrator's worker extension, a house style skill and a prompt template pack
 * all travel the same way.
 *
 * **Paths are pod-local.** They name files or directories on the machine that will run the
 * pod, not on the workstation that typed the launch. For a co-located child that machine is
 * its host pod, which is exactly the filesystem a supervisor shares with its workers; for an
 * ordinary pod it is the sandbox, where an init script or a bundle put the file. Nothing is
 * uploaded from the caller: this is a *selection*, like `--model`, not a file transfer.
 *
 * **Added, never replacing, never re-read.** Resources configured in `pi.args` by an org
 * bundle, a template or the user's own config are left exactly as they are — this module
 * never inspects, reorders, or validates a single configured token. Pi owns the meaning of
 * what is already there: package names, relative paths, options an extension registered, and
 * possibly a `--` after which everything is an initial message. That last one is why the
 * requested pairs go *first*, ahead of the configured list: a flag added after somebody's `--`
 * would not be a flag at all, it would be two words typed at the agent, and the pod would come
 * up "successfully" without the resource it was launched for. Going first needs no knowledge
 * of what follows. The pairs land in `config.pi.args`, which is persisted in `resolved_config`,
 * so every later Pi start for that pod — gateway cold start after a stop, reattach — rebuilds
 * the same argv. A selection that only survived first boot would quietly drop the extension
 * the pod was launched for the first time its machine bounced.
 *
 * **What is requested is also recorded** (`ResolvedConfigReport.piResources`), because "which
 * paths did this launch ask for" is not a question an argument list can answer afterwards
 * without guessing at Pi's parser. The recorded list is what the readability check probes, so
 * the check is exact: only explicitly requested resources, on every start, forever.
 *
 * **Not an argv passthrough.** Only these three flags, only with values that are absolute
 * normalized POSIX paths. A launch cannot reach Pi's `--api-key`, `--mode`, or anything else
 * that would change how the server-owned session behaves.
 */
import { z } from "zod";
import type { PiConfig } from "../../core/config.js";

/** Long enough for any real path (Linux PATH_MAX), short enough to bound a launch body. */
export const MAX_PI_RESOURCE_PATH = 4096;
/** Per kind. A launch that wants more resources than this wants a bundle or an init script. */
export const MAX_PI_RESOURCES_PER_KIND = 64;

export type PiResourceField = "extensions" | "skills" | "promptTemplates";

export interface PiResourceKind {
  /** The `piOverrides` field that carries these paths. */
  field: PiResourceField;
  /** The flag this server adds to `pi.args`; also how a message names the resource. */
  flag: string;
}

export const PI_RESOURCE_KINDS: readonly PiResourceKind[] = [
  { field: "extensions", flag: "--extension" },
  { field: "skills", flag: "--skill" },
  { field: "promptTemplates", flag: "--prompt-template" },
];

/** Paths only: the same shape on the wire, in the launch record, and in the probe. */
export type PiResourceOverrides = Partial<Record<PiResourceField, string[]>>;

/** One requested resource, resolved to the flag the pod's argv actually carries. */
export interface PiResourceEntry {
  flag: string;
  path: string;
  kind: PiResourceField;
}

/**
 * The resources this launch asked for, in request order, or null when it asked for none.
 *
 * Repeats within the request collapse — that is the caller's own list, so an exact match in it
 * cannot be a coincidence. Nothing else is deduplicated: a path that some configured argument
 * *also* mentions is still added, because deciding otherwise would mean parsing arguments
 * whose grammar belongs to Pi (and to whatever options its extensions register), and the cost
 * of guessing wrong is a resource the pod was launched for silently not being loaded. A
 * duplicate costs nothing in comparison — Pi keys these by path and loads each one once.
 */
export function normalizePiResources(
  resources: PiResourceOverrides | null | undefined,
): PiResourceOverrides | null {
  if (!resources) return null;
  const normalized: PiResourceOverrides = {};
  for (const kind of PI_RESOURCE_KINDS) {
    const requested = resources[kind.field];
    if (!requested || requested.length === 0) continue;
    const unique = requested.filter((path, index) => requested.indexOf(path) === index);
    normalized[kind.field] = unique;
  }
  return Object.keys(normalized).length > 0 ? normalized : null;
}

/** Flat, ordered view of a recorded resource set: what to add to argv, and what to probe. */
export function piResourceEntries(
  resources: PiResourceOverrides | null | undefined,
): PiResourceEntry[] {
  if (!resources) return [];
  return PI_RESOURCE_KINDS.flatMap((kind) =>
    (resources[kind.field] ?? []).map((path) => ({ flag: kind.flag, path, kind: kind.field })),
  );
}

/**
 * Add the requested resources to the pod's Pi arguments, ahead of the configured ones.
 *
 * Purely additive: the configured list is carried through untouched, in its own order, and
 * nothing in it is read. Leading position is the only position that is correct without reading
 * it — an option list can end in `--` and a prompt, and appending there would spell the
 * request into the first message instead of asking for anything. Model and thinking keep the
 * ordinary `buildPiArgv` composition (they are values, not accumulating flags, so where they
 * sit relative to these pairs cannot change what Pi does).
 */
export function applyPiResourceOverrides(
  config: { pi: Pick<PiConfig, "args"> },
  resources: PiResourceOverrides | null | undefined,
): void {
  const entries = piResourceEntries(normalizePiResources(resources));
  if (entries.length === 0) return;
  const additions = entries.flatMap((entry) => [entry.flag, entry.path]);
  // Already there, in front, in this exact order: planning can run more than once for one
  // pod, and a second copy would be noise. This compares the tokens this call would write
  // against the same number of leading tokens — it reads nothing else and interprets nothing,
  // so a match means the argv is already the argv this call wants.
  const leading = config.pi.args.slice(0, additions.length);
  if (additions.every((token, index) => leading[index] === token)) return;
  config.pi.args = [...additions, ...config.pi.args];
}

/**
 * Exit 3 and the offending path on the first resource that is not there. A directory has to be
 * traversable as well as readable: Pi loads a skill or template *directory* by listing it.
 */
const PI_RESOURCE_PROBE_SCRIPT =
  'for p in "$@"; do ' +
  'if [ -d "$p" ]; then [ -r "$p" ] && [ -x "$p" ] || { echo "$p"; exit 3; }; ' +
  'elif [ -f "$p" ]; then [ -r "$p" ] || { echo "$p"; exit 3; }; ' +
  'else echo "$p"; exit 3; fi; done';

export function piResourceProbeArgv(paths: readonly string[]): string[] {
  return ["bash", "-c", PI_RESOURCE_PROBE_SCRIPT, "pi-pod-resource-probe", ...paths];
}

/**
 * Refuse to start Pi when a resource this launch explicitly asked for is not readable where
 * the pod runs.
 *
 * A pod launched *for* a capability that is not on disk is not the agent it was asked to be,
 * and nothing downstream will say so. Pi carries on without a skill or prompt template it
 * cannot find — reasonable for a session a human is watching, invisible for a pod nobody is
 * looking at — and an extension it cannot load is a diagnostic on Pi's terms, which across
 * versions has meant both a warning and an exit the pod would only ever report as a supervisor
 * that did not connect. Rather than depend on which, the request is treated as a requirement:
 * a resource that is not there fails the launch, with the path in the message.
 *
 * Only the recorded request is probed. Whatever else the pod's arguments carry is configured
 * behaviour whose meaning is Pi's — package names, relative paths, resources some bundle set
 * up long ago — and none of it acquires a new way to fail here.
 *
 * The check runs on the machine that will open the files, which is the only place that can
 * answer: for a co-located child that is its host, and a launch aimed at a named host is typed
 * on a third machine entirely. A launch that requested nothing makes no call at all.
 */
export async function assertPiResourcesReadable(
  exec: (argv: string[]) => Promise<{ exitCode: number; output?: string }>,
  resources: PiResourceOverrides | null | undefined,
): Promise<void> {
  const entries = piResourceEntries(resources);
  if (entries.length === 0) return;
  const paths = entries.map((entry) => entry.path).filter((path, index, all) => all.indexOf(path) === index);
  const probe = await exec(piResourceProbeArgv(paths));
  if (probe.exitCode === 0) return;
  const reported = (probe.output ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .pop();
  const failed = entries.find((entry) => entry.path === reported);
  const named = failed
    ? `${failed.flag} ${failed.path}`
    : entries.map((entry) => `${entry.flag} ${entry.path}`).join(", ");
  throw new Error(
    `the Pi resource ${named} is not readable on the machine that runs this pod: the pod would ` +
      "start without a resource its launch asked for, so startup is refused instead — these " +
      "paths are pod-local, so create the file or directory there (an init script, a bundle, or " +
      "the host pod for a co-located pod) and launch again",
  );
}

/**
 * Pod-local absolute path, validated only for the per-launch fields.
 *
 * Ordinary characters — spaces included — are fine: every consumer passes the value as an argv
 * element, and the exec path shell-quotes each element (`core/providers/util.ts`). Control
 * characters are refused because they cannot survive a log line honestly, and unnormalized
 * spellings (`.`, `..`, empty segments, a trailing slash) because one directory with several
 * spellings is one probe that can disagree with itself. Nothing here constrains the *name*:
 * any file or directory Pi can load is a legitimate resource.
 */
function piResourcePathSchema(field: string): z.ZodType<string> {
  return z
    .string()
    .min(2, `${field} entries must be absolute pod-local paths`)
    .max(MAX_PI_RESOURCE_PATH, `${field} entries must be at most ${MAX_PI_RESOURCE_PATH} characters`)
    .refine((value) => value.startsWith("/"), {
      message: `${field} entries must be absolute pod-local paths (they name files on the machine that runs the pod)`,
    })
    .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), {
      message: `${field} entries must not contain control characters`,
    })
    .refine(
      (value) =>
        !value.endsWith("/") &&
        value
          .split("/")
          .every((segment, index) =>
            index === 0 ? segment === "" : segment !== "" && segment !== "." && segment !== "..",
          ),
      {
        message: `${field} entries must be normalized: no trailing slash, no empty, "." or ".." segments`,
      },
    );
}

/**
 * The resource fields of `piOverrides`. An omitted or empty array is an additive no-op, so a
 * client may always send the shape it has.
 */
export const PI_RESOURCE_OVERRIDE_FIELDS = Object.fromEntries(
  PI_RESOURCE_KINDS.map((kind) => [
    kind.field,
    z
      .array(piResourcePathSchema(kind.field))
      .max(MAX_PI_RESOURCES_PER_KIND, `${kind.field} accepts at most ${MAX_PI_RESOURCES_PER_KIND} entries`)
      .optional(),
  ]),
) as Record<PiResourceField, z.ZodOptional<z.ZodArray<z.ZodType<string>>>>;
