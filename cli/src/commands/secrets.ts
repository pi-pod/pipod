/**
 * src/commands/secrets.ts — `pipod secrets` (§7).
 *
 * The listing is the point of this command: it answers "what does the pod see, and who set
 * it", including the layers that lost. Writes always name their scope as a positional, so
 * there is no default scope to guess wrong about.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { AccountClient } from "../account/api.js";
import { requireAccountClient } from "../account/client.js";
import {
  readHostConfig,
  readSecretResolverLayers,
  resolveLaunchTemplateRef,
  resolveTemplate,
  takeClientOnlyKeys,
} from "../account/launch.js";
import { findConfigPath } from "../config.js";
import { parseDotenv } from "../dotenv.js";
import { parseJsonc } from "../jsonc.js";
import { PiPodError } from "../errors.js";
import { color, info, out, warn } from "../log.js";
import { isProviderCredentialVar } from "../providers/registry.js";
import { isInteractive, promptSecret } from "../prompt.js";
import { mergeSecretResolver, resolveSecretRefs } from "../secret-refs.js";
import {
  collectSecrets,
  defaultSyncEnvPath,
  isServerScope,
  removeFromDotenv,
  resolveScopeTarget,
  SECRET_SCOPES,
  upsertDotenv,
  type SecretScope,
} from "../secrets.js";
import { legacyUserEnvWarning } from "../userconfig.js";

export interface SecretsFlags {
  home?: string | undefined;
  yes?: boolean;
  client?: AccountClient;
}

function clientFor(flags: SecretsFlags): AccountClient {
  return flags.client ?? requireAccountClient({ home: flags.home });
}

export async function runSecrets(args: string[], flags: SecretsFlags, cwd = process.cwd()): Promise<number> {
  const rest0 = args.filter((arg) => arg !== "-y" && arg !== "--yes");
  const effective: SecretsFlags = { ...flags };
  const [action = "list", ...rest] = rest0;
  switch (action) {
    case "list":
      rejectUnknownOptions(rest);
      return listCmd(effective, cwd);
    case "set":
      rejectUnknownOptions(rest);
      return setCmd(rest, effective, cwd);
    case "rm":
    case "remove":
    case "unset":
      rejectUnknownOptions(rest);
      return rmCmd(rest, effective, cwd);
    case "sync":
      return syncCmd(rest, effective, cwd);
    default:
      // A bare `pipod secrets <scope>` is a plausible typo for a filtered listing; say so
      // rather than treating an unknown word as a subcommand.
      throw new PiPodError(`unknown \`pipod secrets\` action "${action}"`, {
        hint: "actions: list (default), set <scope> <NAME>, rm <scope> <NAME>, sync <scope>",
      });
  }
}

function rejectUnknownOptions(args: string[]): void {
  const unknownOption = args.find((arg) => arg.startsWith("-"));
  if (unknownOption) throw new PiPodError(`unknown pi pod option "${unknownOption}"`);
}

/** Which template applies here comes from the same resolve the launch uses, not a guess. */
async function templateForRepo(
  client: AccountClient,
  flags: SecretsFlags,
  cwd: string,
): Promise<{ id: string; name: string } | null> {
  const configPath = findConfigPath(cwd, { home: flags.home });
  const projectRaw = configPath
    ? (parseJsonc(fs.readFileSync(configPath, "utf8"), configPath) as Record<string, unknown>)
    : {};
  const projectTaken = takeClientOnlyKeys(projectRaw);
  const hostTaken = takeClientOnlyKeys(readHostConfig(flags.home));
  const ref = resolveLaunchTemplateRef({}, {
    project: projectTaken.template,
    machine: hostTaken.template,
  });
  if (!ref) return null;
  try {
    const found = await resolveTemplate(client, ref);
    return { id: found.id, name: found.name };
  } catch {
    return null;
  }
}

async function listCmd(flags: SecretsFlags, cwd: string): Promise<number> {
  const client = clientFor(flags);
  const template = await templateForRepo(client, flags, cwd);
  const { rows, layers } = await collectSecrets({ cwd, home: flags.home, client, template });

  const legacy = legacyUserEnvWarning(flags.home);
  if (legacy) warn(legacy);

  info(`secrets visible to pods launched here (${client.serverUrl})`);
  for (const layer of layers) {
    const state = layer.reachable ? `${layer.count}` : color.yellow("no access");
    info(`  ${layer.scope.padEnd(9)} ${String(state).padStart(3)}  ${layer.source}`);
  }

  if (rows.length === 0) {
    info("no secrets in any layer that applies here");
    return 0;
  }

  out("");
  out(`${"NAME".padEnd(28)} ${"WINS FROM".padEnd(10)} SOURCE`);
  for (const row of rows) {
    const shadow =
      row.shadowed.length > 0
        ? color.dim(`  (shadows ${row.shadowed.map((s) => s.scope).join(", ")})`)
        : "";
    out(`${row.name.padEnd(28)} ${row.winner.scope.padEnd(10)} ${row.winner.source}${shadow}`);
  }

  const report = await client.resolve(template ? { templateId: template.id } : {}).catch(() => null);
  if (report) {
    const credential = report.credential;
    out("");
    info(
      credential.available
        ? `provider credential ${credential.envVar}: available (${credential.source}) — held by the server`
        : `provider credential ${credential.envVar}: ${color.yellow("missing")} — the server cannot provision until it is set`,
    );
  }
  return 0;
}

/** Reads naturally in a sentence, unlike the column label the listing uses. */
function describeTarget(target: { scope: string; label: string }): string {
  if (target.scope === "org") return "the org scope — every member's pods";
  if (target.scope === "user") return "your user scope — your pods on every device";
  return `the ${target.label} scope`;
}

/**
 * Secret values never travel as CLI arguments: `ps`, shell history, and hosted-command logs
 * all capture argv. The name rides the command line; the value arrives on stdin (piped) or
 * through a hidden interactive prompt. `NAME=value` is refused outright rather than
 * deprecated — this interface is pre-release and argv exposure is not worth a grace period.
 */
export const secretsTestHooks: { readPipedStdin: () => string } = {
  // Test/reset hook (mirrors core/redact.ts): the suite has no TTY to pipe through, so it
  // substitutes this reader instead of inheriting a real fd 0.
  readPipedStdin: () => fs.readFileSync(0, "utf8"),
};

/** `NAME` with the value piped on stdin, or via hidden prompt at a terminal. */
async function readValue(name: string, scopeLabel: string): Promise<{ name: string; value: string }> {
  if (name.includes("=")) {
    throw new PiPodError(`pipod secrets set no longer accepts NAME=value — argv is visible to other processes`, {
      hint: `use the hidden prompt, or stdin: pipod secrets set ${scopeLabel} ${name.split("=")[0]} < /path/to/protected-value-file`,
    });
  }

  if (!process.stdin.isTTY) {
    const piped = secretsTestHooks.readPipedStdin().replace(/\n$/, "");
    if (!piped) throw new PiPodError(`no value for ${name} on stdin`);
    return { name, value: piped };
  }
  if (!isInteractive()) throw new PiPodError(`no value for ${name}`, { hint: `use stdin: pipod secrets set ${scopeLabel} ${name} < /path/to/protected-value-file` });
  const value = await promptSecret(`value for ${name} (${scopeLabel}), input hidden: `);
  if (!value) throw new PiPodError(`no value for ${name} — nothing was written`);
  return { name, value };
}

async function setCmd(args: string[], flags: SecretsFlags, cwd: string): Promise<number> {
  const [scopeToken, spec, extra] = args;
  if (!scopeToken || !spec || extra !== undefined) {
    throw new PiPodError("usage: pipod secrets set <scope> <NAME>", {
      hint: `scopes, lowest precedence first: ${SECRET_SCOPES.join(", ")}`,
    });
  }
  const client = clientFor(flags);
  const target = await resolveScopeTarget(scopeToken, { client, cwd, home: flags.home });
  const { name, value } = await readValue(spec, scopeToken);

  if (target.scope === "template" && isProviderCredentialVar(name)) {
    throw new PiPodError(`${name} is a provider credential and can never be stored as a template pod secret`, {
      hint: "provider credentials belong in server or organization control-plane custody",
    });
  }

  if (isServerScope(target.scope)) {
    const resolved = await resolveSecretRefs({ [name]: value }, resolverConfig(cwd, flags.home), {
      home: flags.home,
    });
    await client.putSecret(target.scope, target.id, name, resolved[name]!);
    info(`stored ${name} in ${describeTarget(target)}`);
  } else {
    const outcome = upsertDotenv(target.id, name, value);
    info(`${outcome === "created" ? "added" : "updated"} ${name} in ${target.label}`);
  }
  await warnIfShadowed(name, target.scope, flags, cwd, client);
  return 0;
}

async function rmCmd(args: string[], flags: SecretsFlags, cwd: string): Promise<number> {
  const [scopeToken, name] = args;
  if (!scopeToken || !name) {
    throw new PiPodError("usage: pipod secrets rm <scope> <NAME>", {
      hint: `scopes, lowest precedence first: ${SECRET_SCOPES.join(", ")}`,
    });
  }
  const client = clientFor(flags);
  const target = await resolveScopeTarget(scopeToken, { client, cwd, home: flags.home });

  if (isServerScope(target.scope)) {
    await client.deleteSecret(target.scope, target.id, name);
    info(`removed ${name} from ${describeTarget(target)}`);
    return 0;
  }
  if (!removeFromDotenv(target.id, name)) {
    warn(`${name} was not set in ${target.label} — nothing to remove`);
    return 1;
  }
  info(`removed ${name} from ${target.label}`);
  return 0;
}

/**
 * Writing a value that something else overrides is the exact confusion this command exists
 * to prevent, so it is called out at the moment it happens rather than left to be discovered
 * in a running pod.
 */
async function warnIfShadowed(
  name: string,
  scope: SecretScope,
  flags: SecretsFlags,
  cwd: string,
  client: AccountClient,
): Promise<void> {
  const template = await templateForRepo(client, flags, cwd);
  const { rows } = await collectSecrets({ cwd, home: flags.home, client, template });
  const row = rows.find((r) => r.name === name);
  if (!row || row.winner.scope === scope) return;
  warn(`pods here still see ${name} from the ${row.winner.scope} layer (${row.winner.source}), which outranks ${scope}`);
}

function resolverConfig(cwd: string, home?: string) {
  const layers = readSecretResolverLayers({ cwd, home });
  return mergeSecretResolver(layers.machine, layers.project);
}

interface SyncOpts {
  scopeToken: string;
  file?: string;
  prune: boolean;
  dryRun: boolean;
}

function parseSyncArgs(args: string[]): SyncOpts {
  let scopeToken: string | undefined;
  let file: string | undefined;
  let prune = false;
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--file") {
      const value = args[++i];
      if (value === undefined) throw new PiPodError("--file needs a path");
      file = value;
    } else if (arg.startsWith("--file=")) {
      file = arg.slice("--file=".length);
      if (!file) throw new PiPodError("--file needs a path");
    } else if (arg === "--prune") {
      prune = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg.startsWith("-")) {
      throw new PiPodError(`unknown pi pod option "${arg}"`, {
        hint: "usage: pipod secrets sync <org|user|template/<name>> [--file <path>] [--prune] [--dry-run]",
      });
    } else if (scopeToken === undefined) {
      scopeToken = arg;
    } else {
      throw new PiPodError(`unexpected argument "${arg}"`, {
        hint: "usage: pipod secrets sync <org|user|template/<name>> [--file <path>] [--prune] [--dry-run]",
      });
    }
  }
  if (!scopeToken) {
    throw new PiPodError("usage: pipod secrets sync <org|user|template/<name>> [--file <path>] [--prune] [--dry-run]", {
      hint: "default file: ~/.pi-pod/secrets/<scope>.env",
    });
  }
  return { scopeToken, file, prune, dryRun };
}

async function syncCmd(args: string[], flags: SecretsFlags, cwd: string): Promise<number> {
  const opts = parseSyncArgs(args);
  const client = clientFor(flags);
  const target = await resolveScopeTarget(opts.scopeToken, { client, cwd, home: flags.home });
  if (!isServerScope(target.scope)) {
    throw new PiPodError("secrets sync only writes server scopes", {
      hint: "the project env file is resolved at launch — no sync needed",
    });
  }

  const file = opts.file
    ? path.resolve(cwd, opts.file)
    : defaultSyncEnvPath(opts.scopeToken, flags.home);
  if (!fs.existsSync(file)) {
    throw new PiPodError(`no secrets file at ${file}`, {
      hint: "create it (mode 600) with KEY=op://vault/item/field lines, or pass --file",
    });
  }

  const parsed = parseDotenv(fs.readFileSync(file, "utf8"));
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed.values)) {
    if (target.scope === "template" && isProviderCredentialVar(name)) {
      warn(`${name} is a provider credential and never travels in a template — the org key upload owns those`);
      continue;
    }
    values[name] = value;
  }
  const names = Object.keys(values);
  const inFile = new Set(Object.keys(parsed.values));

  const listed = await client.listSecrets(target.scope, target.id).catch(() => null);
  const stale = listed ? listed.secrets.map((secret) => secret.name).filter((name) => !inFile.has(name)) : [];

  if (opts.dryRun) {
    if (names.length === 0) info(`would set nothing on ${describeTarget(target)} from ${file}`);
    else info(`would set ${names.length} secret(s) on ${describeTarget(target)}: ${names.join(", ")}`);
    if (opts.prune && stale.length > 0) {
      info(`would prune ${stale.length} secret(s) not in the file: ${stale.join(", ")}`);
    } else if (stale.length > 0) {
      warn(staleWarning(stale, opts.scopeToken, file));
    }
    return 0;
  }

  const resolved = await resolveSecretRefs(values, resolverConfig(cwd, flags.home), { home: flags.home });
  const uploaded: string[] = [];
  for (const name of names) {
    const value = resolved[name] ?? "";
    if (value.trim() === "") {
      warn(`skip empty field: ${name}`);
      continue;
    }
    try {
      await client.putSecret(target.scope, target.id, name, value);
      uploaded.push(name);
      info(`stored ${name} in ${describeTarget(target)}`);
    } catch (error) {
      const remaining = names.filter((n) => !uploaded.includes(n) && n !== name);
      throw new PiPodError(
        `uploaded ${uploaded.length} of ${names.length} secrets; ${[name, ...remaining].join(", ")} did not make it: ` +
          (error instanceof Error ? error.message : String(error)),
        { hint: `the names already stored are fine — finish with pipod secrets sync ${opts.scopeToken}` },
      );
    }
  }

  if (stale.length > 0) {
    if (opts.prune) {
      for (const name of stale) {
        await client.deleteSecret(target.scope, target.id, name);
        info(`removed ${name} from ${describeTarget(target)}`);
      }
    } else {
      warn(staleWarning(stale, opts.scopeToken, file));
    }
  }
  return 0;
}

function staleWarning(stale: string[], scopeToken: string, file: string): string {
  return (
    `secrets on ${scopeToken} not in ${file}: ${stale.join(", ")} — ` +
    `rerun with --prune to delete them, or remove each with \`pipod secrets rm ${scopeToken} <NAME>\``
  );
}
