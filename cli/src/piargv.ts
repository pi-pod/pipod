import type { PiConfig } from "./config.js";

export const PROJECT_TRUST_ARGS = new Set(["--approve", "-a", "--no-approve", "-na"]);

export function buildPiArgv(
  config: Pick<PiConfig, "command" | "args"> & Partial<Pick<PiConfig, "model" | "thinking">>,
  ...argGroups: string[][]
): string[] {
  const configuredSelection = [
    ...(config.model != null ? ["--model", config.model] : []),
    ...(config.thinking != null ? ["--thinking", config.thinking] : []),
  ];
  const args = [...config.args, ...configuredSelection, ...argGroups.flat()];
  const trustArgs = args.some((arg) => PROJECT_TRUST_ARGS.has(arg)) ? [] : ["--approve"];
  return [config.command, ...trustArgs, ...args];
}
