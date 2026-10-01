import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR } from "./config.js";
import { color, info, plain, warn } from "./log.js";

export interface InitOptions {
  projectRoot: string;
  force: boolean;
}

export function configTemplate(): string {
  return `{
  // .pi-pod/config.json — optional server-side launch overrides for this project.
  //
  // The server merges organization defaults, an optional selected template, then this
  // project source before push/bootstrap stores it in a template. Uncomment only settings this project
  // must choose for everyone instead of inheriting the org/template default.

  // "resources": { "cpu": 4, "memoryGB": 8, "diskGB": 10 },
  // "initTimeoutSeconds": 1200,
  // "pi": { "model": "openai-codex/gpt-5.6-sol", "thinking": "high" },
  // "template": "web-dev"
  //
  // Project file paths are conventional, not configured: secrets in .pi-pod/env,
  // setup in .pi-pod/init.sh, image baking in .pi-pod/bake.sh.
}
`;
}

export const ENV_EXAMPLE_TEMPLATE = `# .pi-pod/env.example — committed examples of secrets this project may need.
# Uncomment only the names this project requires. An explicit KEY= is a deliberate blank.
# ANTHROPIC_API_KEY=
# GH_TOKEN=
`;

export const ENV_TEMPLATE = `# .pi-pod/env — highest-precedence project secrets. Never commit this file.
# Values may be op://vault/item/field references, resolved at launch. Uncomment only keys
# this project supplies; an explicit KEY= deliberately overrides lower scopes with a blank.
# ANTHROPIC_API_KEY=
# GH_TOKEN=
`;

export const INIT_SCRIPT_TEMPLATE = `#!/usr/bin/env bash
# .pi-pod/init.sh — runs after organization and selected-template init, before pi starts.
# The workspace starts empty. Populate it here; keep this idempotent and non-interactive.
set -euo pipefail

# Example:
# git clone https://github.com/example/project.git .
# npm ci

echo "init complete"
`;

export interface InitResult {
  created: string[];
  skipped: string[];
  gitignoreUpdated: boolean;
  envCreated: boolean;
}

export function scaffold(opts: InitOptions): InitResult {
  const dir = path.join(opts.projectRoot, CONFIG_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const files: Array<{ name: string; contents: string; mode?: number }> = [
    { name: "config.json", contents: configTemplate() },
    { name: "env.example", contents: ENV_EXAMPLE_TEMPLATE },
    { name: "init.sh", contents: INIT_SCRIPT_TEMPLATE, mode: 0o755 },
  ];
  const created: string[] = [];
  const skipped: string[] = [];
  for (const file of files) {
    const target = path.join(dir, file.name);
    if (fs.existsSync(target) && !opts.force) {
      skipped.push(path.join(CONFIG_DIR, file.name));
      continue;
    }
    fs.writeFileSync(target, file.contents, file.mode ? { mode: file.mode } : undefined);
    if (file.mode) fs.chmodSync(target, file.mode);
    created.push(path.join(CONFIG_DIR, file.name));
  }

  const gitignoreUpdated = ensureGitignoreEntry(opts.projectRoot, `${CONFIG_DIR}/env`);
  const envPath = path.join(dir, "env");
  const envCreated = !fs.existsSync(envPath);
  if (envCreated) {
    fs.writeFileSync(envPath, ENV_TEMPLATE, { mode: 0o600 });
    fs.chmodSync(envPath, 0o600);
    created.push(path.join(CONFIG_DIR, "env"));
  }
  return { created, skipped, gitignoreUpdated, envCreated };
}

export function ensureGitignoreEntry(projectRoot: string, entry: string): boolean {
  const gitignorePath = path.join(projectRoot, ".gitignore");
  const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, "utf8") : "";
  const alreadyPresent = existing
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => line === entry || line === `/${entry}`);
  if (alreadyPresent) return false;
  const prefix = existing === "" || existing.endsWith("\n") ? "" : "\n";
  fs.appendFileSync(gitignorePath, `${prefix}\n# pi pod secrets — never commit\n${entry}\n`);
  return true;
}

export function printInitResult(result: InitResult, projectRoot: string): void {
  for (const file of result.created) info(`created ${color.bold(file)}`);
  for (const file of result.skipped) warn(`${file} already exists — left untouched (use --force to overwrite)`);
  if (!result.envCreated) warn(`${CONFIG_DIR}/env already exists — left untouched (your keys are safe)`);
  if (result.gitignoreUpdated) info(`added ${color.bold(`${CONFIG_DIR}/env`)} to .gitignore`);

  const steps = [
    [`edit ${CONFIG_DIR}/config.json and init.sh`, "what this project's pods get"],
    [`edit ${CONFIG_DIR}/env`, "this project's own keys"],
    ["pipod", `launch a pod for ${path.basename(projectRoot)}; the first launch offers to keep these in a template`],
  ].map(([command, why]) => `${command!.padEnd(40)} ${color.dim(`# ${why}`)}`);
  plain("");
  plain("Next steps:");
  steps.forEach((step, index) => plain(`  ${index + 1}. ${step}`));
  plain("");
}
