import type { TuiMode } from "../client/headless.js";
import { PiPodError } from "../errors.js";
import type { PiLaunchOverrides } from "./api.js";
import {
  MAX_RESOURCES_PER_KIND,
  PI_RESOURCE_CLI_FLAGS,
  PI_RESOURCE_FLAGS,
  parseResourcePath,
  type PiResourceKey,
} from "./launch-resources.js";

const ACCOUNT_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Which `piOverrides` resource array a CLI spelling after `--` collects into. */
function resourceKeyFor(flag: string): PiResourceKey | undefined {
  for (const [key, spellings] of Object.entries(PI_RESOURCE_CLI_FLAGS) as Array<[PiResourceKey, readonly string[]]>) {
    if (spellings.includes(flag)) return key;
  }
  return undefined;
}

/** Split a `--flag=value` token; null for anything else (plain `--flag` needs no split). */
function splitInlineValue(arg: string): { flag: string; value: string } | null {
  if (!arg.startsWith("--")) return null;
  const equals = arg.indexOf("=");
  if (equals < 0) return null;
  return { flag: arg.slice(0, equals), value: arg.slice(equals + 1) };
}

/** Parse server-side model/resource overrides plus the local-only TUI layout override. */
export function parseAccountLaunchPiArgs(piArgs: string[]): {
  prompt: string | undefined;
  piOverrides: PiLaunchOverrides | undefined;
  extraArgs: string[];
  tuiMode?: TuiMode;
} {
  const positionals: string[] = [];
  const extraArgs: string[] = [];
  const piOverrides: PiLaunchOverrides = {};
  let tuiMode: TuiMode | undefined;
  let rejecting = false;

  const takeResource = (key: PiResourceKey, flag: string, inline: string | undefined, index: { i: number }): void => {
    let value = inline;
    if (value === undefined) {
      value = piArgs[++index.i];
      if (value === undefined) {
        throw new PiPodError(`${flag} requires a path`, {
          hint: "name a file or directory inside the pod, for example: pipod -- --skill /workspace/skills/review",
        });
      }
    }
    const paths = (piOverrides[key] ??= []);
    if (paths.length >= MAX_RESOURCES_PER_KIND) {
      throw new PiPodError(`${flag} accepts at most ${MAX_RESOURCES_PER_KIND} paths per launch`, {
        hint: "bundle rarely-changed resources into configuration instead of the launch request",
      });
    }
    paths.push(parseResourcePath(flag, value));
  };

  const cursor = { i: 0 };
  for (; cursor.i < piArgs.length; cursor.i++) {
    const arg = piArgs[cursor.i]!;
    if (!rejecting && arg === "--") {
      positionals.push(...piArgs.slice(cursor.i + 1));
      break;
    }
    // Resource flags accept `--flag value` and `--flag=value`; model/thinking/tui-mode
    // keep Pi's exact space-separated spelling, as before.
    const inline = !rejecting ? splitInlineValue(arg) : null;
    const resourceFlag = inline ? inline.flag : arg;
    const key = !rejecting ? resourceKeyFor(resourceFlag) : undefined;
    if (key) {
      takeResource(key, resourceFlag, inline?.value, cursor);
      continue;
    }
    if (!rejecting && (arg === "--model" || arg === "--thinking" || arg === "--tui-mode")) {
      const flag = arg;
      const value = piArgs[++cursor.i];
      if (value === undefined || value.length === 0 || value.trim() !== value || value.startsWith("-")) {
        throw new PiPodError(`${flag} requires a non-empty value that does not start with "-"`);
      }
      if (flag === "--model") {
        piOverrides.model = value;
      } else if (flag === "--thinking") {
        if (!ACCOUNT_THINKING_LEVELS.includes(value as (typeof ACCOUNT_THINKING_LEVELS)[number])) {
          throw new PiPodError(
            `invalid thinking level ${JSON.stringify(value)}; use ${ACCOUNT_THINKING_LEVELS.join(", ")}`,
          );
        }
        piOverrides.thinking = value as PiLaunchOverrides["thinking"];
      } else {
        if (value !== "regular" && value !== "fullscreen") {
          throw new PiPodError(`invalid TUI mode ${JSON.stringify(value)}; use regular or fullscreen`);
        }
        tuiMode = value;
      }
      continue;
    }
    if (!rejecting && arg.startsWith("-")) rejecting = true;
    if (rejecting) extraArgs.push(arg);
    else positionals.push(arg);
  }

  return {
    prompt: positionals.length > 0 ? positionals.join(" ") : undefined,
    piOverrides: Object.keys(piOverrides).length > 0 ? piOverrides : undefined,
    extraArgs,
    ...(tuiMode ? { tuiMode } : {}),
  };
}

/** Positional words become the startup prompt; --tui-mode is a local UI-only attach option. */
export function splitPiArgs(piArgs: string[]): {
  prompt: string | undefined;
  extraArgs: string[];
  tuiMode?: TuiMode;
} {
  const parsed = parseAccountLaunchPiArgs(piArgs);
  const managedArgs: string[] = [];
  if (parsed.piOverrides?.model) managedArgs.push("--model", parsed.piOverrides.model);
  if (parsed.piOverrides?.thinking) managedArgs.push("--thinking", parsed.piOverrides.thinking);
  // Launch-only resources are re-emitted canonically rather than dropped: attach refuses
  // every per-launch Pi option it cannot honor, and a silently swallowed --skill that never
  // loads would read as success.
  if (parsed.piOverrides) {
    for (const [key, paths] of Object.entries(parsed.piOverrides) as Array<[keyof PiLaunchOverrides, unknown]>) {
      if (key === "model" || key === "thinking") continue;
      const flag = PI_RESOURCE_FLAGS[key as PiResourceKey];
      if (!flag || !Array.isArray(paths)) continue;
      for (const path of paths) managedArgs.push(flag, path);
    }
  }
  return {
    prompt: parsed.prompt,
    extraArgs: [...managedArgs, ...parsed.extraArgs],
    ...(parsed.tuiMode ? { tuiMode: parsed.tuiMode } : {}),
  };
}
