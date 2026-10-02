/**
 * src/secret-refs.ts — just-in-time 1Password references (`op://…`).
 *
 * A reference is a value that has not been fetched yet, never a value the server sees.
 * Resolution happens once, client-side, at the last moment before a value leaves the
 * process. Files keep storing `op://` URIs verbatim; a failed resolve fails the command
 * rather than forwarding the literal string as if it were the secret.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { PiPodError } from "./errors.js";
import { registerSecret, registerSecrets } from "./redact.js";

const execFileAsync = promisify(execFile);

const REF_RE = /^op:\/\//;
const OP_TIMEOUT_MS = 30_000;
const TOKEN_TIMEOUT_MS = 15_000;
const MAX_BUFFER = 10 * 1024 * 1024;

export function isSecretRef(value: string): boolean {
  return REF_RE.test(value);
}

export function hasSecretRefs(values: Record<string, string>): boolean {
  return Object.values(values).some(isSecretRef);
}

export interface SecretResolverConfig {
  type: "1password";
  tokenCommand?: string[];
}

export interface ResolveSecretRefsOptions {
  home?: string;
  /** Test hook: the `op` argv0, so suites do not have to mutate PATH. */
  opCommand?: string;
}

/** Pull a `secretResolver` object out of a config layer, or null when the layer never set one. */
export function parseSecretResolver(raw: unknown, label = "secretResolver"): SecretResolverConfig | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new PiPodError(`${label} must be an object`, {
      hint: 'example: { "type": "1password", "tokenCommand": ["op", "whoami", "--format", "json"] }',
    });
  }
  const obj = raw as Record<string, unknown>;
  if (obj["type"] !== "1password") {
    throw new PiPodError(
      obj["type"] === undefined
        ? `${label}.type is required`
        : `${label}.type must be "1password"`,
      {
        hint:
          typeof obj["type"] === "string"
            ? `unknown resolver type "${obj["type"]}" — only "1password" is implemented`
            : 'set type to "1password"',
      },
    );
  }
  let tokenCommand: string[] | undefined;
  if (obj["tokenCommand"] !== undefined) {
    const cmd = obj["tokenCommand"];
    if (
      !Array.isArray(cmd) ||
      cmd.length === 0 ||
      !cmd.every((part) => typeof part === "string" && part.length > 0)
    ) {
      throw new PiPodError(`${label}.tokenCommand must be a non-empty array of strings`);
    }
    tokenCommand = cmd as string[];
  }
  return tokenCommand ? { type: "1password", tokenCommand } : { type: "1password" };
}

/**
 * Project (or org directory) over machine for `type`, but only the machine layer may name
 * a `tokenCommand`: the other layer arrives with a cloned repository or a pulled bundle,
 * and must not choose what runs on this workstation.
 */
export function mergeSecretResolver(
  machine: SecretResolverConfig | null,
  project: SecretResolverConfig | null,
): SecretResolverConfig | null {
  if (project?.tokenCommand) {
    throw new PiPodError("secretResolver.tokenCommand is only read from this machine's config", {
      hint: "remove it from the project or org config; set it in your pipod user config instead",
    });
  }
  if (!project) return machine;
  return machine?.tokenCommand
    ? { type: project.type, tokenCommand: machine.tokenCommand }
    : { type: project.type };
}

/**
 * Resolves every `op://` value in one `op inject` subprocess; literals pass through.
 * No refs → the input object is returned unchanged and nothing is spawned.
 */
export async function resolveSecretRefs(
  values: Record<string, string>,
  config: SecretResolverConfig | null,
  opts: ResolveSecretRefsOptions = {},
): Promise<Record<string, string>> {
  const refs: Record<string, string> = {};
  const literals: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (isSecretRef(value)) refs[key] = value;
    else literals[key] = value;
  }
  if (Object.keys(refs).length === 0) return values;

  const token = config?.tokenCommand
    ? await runTokenCommand(config.tokenCommand, opts.home)
    : undefined;
  const resolved = await injectRefs(refs, { token, home: opts.home, opCommand: opts.opCommand });
  const missing = Object.keys(refs).filter((key) => typeof resolved[key] !== "string");
  if (missing.length > 0) {
    throw new PiPodError(`1Password did not return ${missing.join(", ")}`, {
      hint: "the reference may have been renamed or the vault is not shared with this token",
    });
  }
  const unresolved = Object.entries(refs)
    .filter(([key]) => isSecretRef(resolved[key]!))
    .map(([key]) => key);
  if (unresolved.length > 0) {
    throw new PiPodError(`1Password left ${unresolved.join(", ")} unresolved`, {
      hint: "token expired or vault access revoked? check `op whoami` / `systemd-creds decrypt`",
    });
  }

  const out: Record<string, string> = { ...literals };
  for (const key of Object.keys(refs)) out[key] = resolved[key]!;
  registerSecrets(out);
  return out;
}

/**
 * Confirm the machinery a refs file needs: `op` on PATH, and `tokenCommand` exits 0
 * when one is configured. Does not resolve any secret.
 */
export async function checkSecretResolver(
  config: SecretResolverConfig | null,
  opts: ResolveSecretRefsOptions = {},
): Promise<void> {
  try {
    await runOp(["--version"], { home: opts.home, opCommand: opts.opCommand });
  } catch (error) {
    throw commandFailure("1Password CLI (`op`) failed", error, {
      hint: "install 1Password CLI (`op`) or remove op:// references",
    });
  }
  if (config?.tokenCommand) await runTokenCommand(config.tokenCommand, opts.home);
}

async function runTokenCommand(command: string[], home?: string): Promise<string> {
  const [file, ...args] = command;
  if (!file) {
    throw new PiPodError("secretResolver.tokenCommand must be a non-empty array of strings");
  }
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(file, args, {
      encoding: "utf8",
      timeout: TOKEN_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      env: processEnv({ home }),
    }));
  } catch (error) {
    throw commandFailure("secretResolver.tokenCommand failed", error, {
      hint: "token expired or vault access revoked? check `op whoami` / `systemd-creds decrypt`",
    });
  }
  const token = stdout.trim();
  if (!token) {
    throw new PiPodError("secretResolver.tokenCommand produced no token", {
      hint: "token expired or vault access revoked? check `op whoami` / `systemd-creds decrypt`",
    });
  }
  registerSecret(token);
  return token;
}

async function injectRefs(
  refs: Record<string, string>,
  opts: { token?: string; home?: string; opCommand?: string },
): Promise<Record<string, string>> {
  const env = processEnv({ home: opts.home, token: opts.token });
  // `op inject` races an empty stdin when the child starts before the pipe is
  // written; --in-file is the reliable delivery. The file holds references only.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pipod-op-"));
  const templateFile = path.join(tmpDir, "template.json");
  let stdout: string;
  try {
    fs.writeFileSync(templateFile, JSON.stringify(refs), { mode: 0o600 });
    ({ stdout } = await runOp(["inject", "--in-file", templateFile], {
      env,
      opCommand: opts.opCommand,
    }));
  } catch (error) {
    throw commandFailure("1Password CLI (`op inject`) failed", error, {
      hint: "token expired or vault access revoked? check `op whoami` / `systemd-creds decrypt`",
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === "string") out[key] = value;
      }
      return out;
    }
  } catch {
    // `op inject` string-replaces and can emit invalid JSON when a secret contains
    // quotes or newlines. Fall back to one `op read` per ref so those values still resolve.
  }
  return readRefsIndividually(refs, env, opts.opCommand);
}

async function readRefsIndividually(
  refs: Record<string, string>,
  env: NodeJS.ProcessEnv,
  opCommand?: string,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [key, ref] of Object.entries(refs)) {
    let stdout: string;
    try {
      ({ stdout } = await runOp(["read", ref], { env, opCommand }));
    } catch (error) {
      throw commandFailure(`1Password CLI (\`op read\`) failed for ${key}`, error, {
        hint: "token expired or vault access revoked? check `op whoami` / `systemd-creds decrypt`",
      });
    }
    // `op read` terminates stdout with a newline that is not part of the secret.
    out[key] = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
  }
  return out;
}

function processEnv(opts: { home?: string; token?: string }): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env["OP_CONNECT_HOST"];
  delete env["OP_CONNECT_TOKEN"];
  if (opts.home) env["HOME"] = opts.home;
  if (opts.token) env["OP_SERVICE_ACCOUNT_TOKEN"] = opts.token;
  return env;
}

async function runOp(
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; input?: string; home?: string; opCommand?: string },
): Promise<{ stdout: string; stderr: string }> {
  const file = opts.opCommand ?? "op";
  const env = opts.env ?? processEnv({ home: opts.home });
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      { encoding: "utf8", timeout: OP_TIMEOUT_MS, maxBuffer: MAX_BUFFER, env },
      (error, stdout, stderr) => {
        if (error) {
          const wrapped = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
          wrapped.stdout = stdout;
          wrapped.stderr = stderr;
          reject(wrapped);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
    else child.stdin?.end();
  });
}

function commandFailure(
  message: string,
  error: unknown,
  opts: { hint: string },
): PiPodError {
  const err = error as NodeJS.ErrnoException & { stderr?: string };
  if (err.code === "ENOENT") {
    return new PiPodError("1Password CLI (`op`) not found on PATH", {
      hint: "install 1Password CLI (`op`) or remove op:// references",
      cause: error,
    });
  }
  const detail = firstLine(err.stderr) || (error instanceof Error ? error.message : String(error));
  return new PiPodError(`${message}: ${detail}`, { hint: opts.hint, cause: error });
}

function firstLine(text: string | undefined): string {
  if (!text) return "";
  return text.trim().split(/\r?\n/)[0] ?? "";
}
