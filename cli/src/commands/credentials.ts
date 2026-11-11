import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { execFile, spawn } from "node:child_process";
import type { AccountClient, CredentialStatus } from "../account/api.js";
import { requireAccountClient } from "../account/client.js";
import { runCredentialLogin } from "../account/credential-login.js";
import { installedPiPackage } from "../client/piversion.js";
import type {
  RemoteAuthEvent,
  RemoteAuthInteraction,
  RemoteAuthPrompt,
} from "../client/runtime/auth-bridge.js";
import { CancelledError, PiPodError } from "../errors.js";
import { info, out, warn } from "../log.js";
import { confirm, isInteractive, promptSecret } from "../prompt.js";
import { registerSecret } from "../redact.js";

export interface CredentialsFlags {
  home?: string | undefined;
  yes?: boolean;
  client?: AccountClient;
  /** Test/TUI seam; the command-line default is a small stdin/stderr interaction. */
  interaction?: RemoteAuthInteraction;
  /** Test seam for `--from-pi`; the default runs the bundled pi's `auth print-api-key`. */
  localKeySource?: (providerId: string) => Promise<string>;
  /** Test seam for the bulk sweep; the default runs the bundled pi's `auth check`. */
  localAuthCheck?: (providerId: string) => Promise<LocalAuthCheck>;
}

function clientFor(flags: CredentialsFlags): AccountClient {
  return flags.client ?? requireAccountClient({ home: flags.home });
}

export async function runCredentials(args: string[], flags: CredentialsFlags = {}): Promise<number> {
  const [action = "list", ...rest] = args;
  switch (action) {
    case "list":
      rejectExtra(rest, "usage: pipod credentials [list]");
      return listCredentials(clientFor(flags));
    case "connect":
    case "reconnect":
      // A bare `connect` (at most `--yes`) means every provider, not a usage error.
      return rest.every((arg) => arg === "--yes" || arg === "-y")
        ? bulkConnect(rest, flags)
        : connectCredential(rest, flags, { reconnect: action === "reconnect" });
    case "test":
      return testCredential(rest, clientFor(flags));
    case "remove":
    case "rm":
      return removeCredential(rest, flags);
    case "share":
      return shareCredential(rest, clientFor(flags));
    case "unshare":
      return unshareCredential(rest, clientFor(flags));
    default:
      throw new PiPodError(`unknown \`pipod credentials\` action "${action}"`, {
        hint: "actions: list (default), connect [<provider>] [--api-key [--from-pi]] (no provider connects every connectable provider), reconnect <provider>, test <provider>, remove <provider> [--yes], share <provider> --with <email>, unshare <provider> --with <email>",
      });
  }
}

async function listCredentials(client: AccountClient): Promise<number> {
  const result = await client.modelCredentials();
  const overridden = result.overriddenShares ?? [];
  if (result.credentials.length === 0 && overridden.length === 0) {
    info("no account model-provider credentials are saved");
  }
  for (const credential of result.credentials) out(formatStatus(credential));
  for (const credential of overridden) out(`${formatStatus(credential)}  (not used: you have your own)`);

  // A provider served by someone else's credential can still take your own.
  const own = new Set(result.credentials.filter((c) => c.source !== "shared").map((c) => c.providerId));
  const connectable = result.providers
    .filter((provider) => provider.brokerSupported && !own.has(provider.id))
    .map((provider) => provider.id);
  info(`Connectable: ${connectable.length > 0 ? connectable.join(", ") : "none"}`);
  return 0;
}

const CONNECT_USAGE = "usage: pipod credentials connect <provider> [--api-key [--from-pi]]";

async function connectCredential(
  args: string[],
  flags: CredentialsFlags,
  opts: { reconnect: boolean },
): Promise<number> {
  let providerId: string | undefined;
  let apiKey = false;
  let fromPi = false;
  for (const arg of args) {
    if (arg === "--api-key") apiKey = true;
    else if (arg === "--from-pi") fromPi = true;
    else if (arg.startsWith("-")) throw new PiPodError(`unknown pipod credentials option "${arg}"`);
    else if (providerId === undefined) providerId = arg;
    else throw new PiPodError(`unexpected argument "${arg}"`, { hint: CONNECT_USAGE });
  }
  if (!providerId) throw new PiPodError(CONNECT_USAGE);
  // OAuth grants are machine-bound and never importable; --from-pi always means an API key.
  if (fromPi) apiKey = true;
  // `connect` on a shared provider gives you your own, which then serves your pods; `reconnect`
  // means the credential you use now, and a shared one is its owner's to reconnect.
  if (opts.reconnect) {
    const shared = await sharedCredentialServing(clientFor(flags), providerId);
    if (shared) {
      throw new PiPodError(`${providerId} is shared with you by ${shared.sharedBy}; only they can reconnect it`, {
        hint: `\`pipod credentials connect ${providerId}\` connects your own, which your pods then use instead`,
      });
    }
  }

  const terminal = flags.interaction ? null : terminalInteraction();
  try {
    const status = await connectOne(
      clientFor(flags),
      { providerId, authType: apiKey ? "api_key" : "oauth", importKey: fromPi },
      flags.interaction ?? terminal!.interaction,
      flags,
    );
    info(`connected ${providerId} (${status.type}, ${status.state})`);
    return 0;
  } finally {
    terminal?.dispose();
  }
}

interface ConnectPlan {
  providerId: string;
  authType: "api_key" | "oauth";
  /** Answer the login's secret prompt from local pi instead of asking the user. */
  importKey: boolean;
}

/** One provider's connect, shared by the single-provider command and the bulk sweep. */
async function connectOne(
  client: AccountClient,
  plan: ConnectPlan,
  base: RemoteAuthInteraction,
  flags: CredentialsFlags,
): Promise<CredentialStatus> {
  let interaction = base;
  if (plan.importKey) {
    const source = flags.localKeySource ?? ((provider: string) => readLocalPiApiKey(provider, flags.home));
    const key = (await source(plan.providerId)).trim();
    if (!key) {
      throw new PiPodError(`local pi has no ${plan.providerId} API key`, {
        hint: `run \`pi\` and use /login to store one, or rerun without --from-pi to enter the key directly`,
      });
    }
    registerSecret(key);
    info(`importing your local pi ${plan.providerId} API key into account custody`);
    interaction = withImportedKey(base, key);
  }
  return runCredentialLogin({
    client,
    providerId: plan.providerId,
    authType: plan.authType,
    interaction,
  });
}

interface SkippedProvider {
  providerId: string;
  reason: string;
}

/**
 * `connect` with no provider: give every broker-supported provider an account credential,
 * importing the API keys local pi already resolves and running a fresh login for the rest.
 */
async function bulkConnect(args: string[], flags: CredentialsFlags): Promise<number> {
  const yes = flags.yes === true || args.some((arg) => arg === "--yes" || arg === "-y");
  const client = clientFor(flags);
  const { credentials, providers } = await client.modelCredentials();
  const stored = new Map(credentials.map((credential) => [credential.providerId, credential]));
  const connectable = providers.filter((provider) => provider.brokerSupported);
  const candidates = connectable.filter((provider) => stored.get(provider.id)?.state !== "ready");
  if (candidates.length === 0) {
    info("all connectable providers already have account credentials");
    return 0;
  }

  const check = flags.localAuthCheck ?? ((provider: string) => checkLocalPiAuth(provider, flags.home));
  const planned: ConnectPlan[] = [];
  const skipped: SkippedProvider[] = connectable
    .filter((provider) => stored.get(provider.id)?.state === "ready")
    .map((provider) => {
      const sharedBy = stored.get(provider.id)?.sharedBy;
      return { providerId: provider.id, reason: sharedBy ? `shared by ${sharedBy}` : "already connected" };
    });
  for (const provider of candidates) {
    const local = await check(provider.id);
    if (local.status === "invalid") {
      warn(`local pi could not check ${provider.id}${local.reason ? `: ${local.reason}` : ""}`);
      skipped.push({ providerId: provider.id, reason: "local check failed" });
    } else if (local.status !== "ready") {
      skipped.push({ providerId: provider.id, reason: "not configured in local pi" });
    } else if (local.authType === "api_key" && provider.apiKey) {
      planned.push({ providerId: provider.id, authType: "api_key", importKey: true });
    } else if (provider.oauth) {
      // Local OAuth cannot be copied, and an api-key-only local grant is useless to a
      // broker that wants OAuth: either way a fresh account login is the way to a credential.
      planned.push({ providerId: provider.id, authType: "oauth", importKey: false });
    } else {
      skipped.push({ providerId: provider.id, reason: "no supported login" });
    }
  }

  for (const plan of planned) {
    info(`  ${plan.providerId}: ${plan.importKey ? "import API key from local pi" : "fresh OAuth login"}`);
  }
  for (const skip of skipped) info(`  ${skip.providerId}: skipped — ${skip.reason}`);
  if (planned.length === 0) {
    info("nothing to connect");
    return 0;
  }

  // Refuse before a ticket exists rather than stranding a half-done sweep at a dead prompt.
  if (planned.some((plan) => plan.authType === "oauth") && !flags.interaction && !isInteractive()) {
    throw new PiPodError("an OAuth sign-in needs a terminal", {
      hint: "rerun `pipod credentials connect` in a terminal, or connect the API-key providers one at a time with `pipod credentials connect <provider> --api-key --from-pi`",
    });
  }
  const approved = await confirm(`connect ${planned.length} provider credential(s)?`, {
    nonInteractiveDefault: false,
    assumeYes: yes,
  });
  if (!approved) throw new CancelledError("Credential connect cancelled");

  const terminal = flags.interaction ? null : terminalInteraction();
  const base = flags.interaction ?? terminal!.interaction;
  const connected: string[] = [];
  const failed: string[] = [];
  try {
    for (const plan of planned) {
      try {
        const status = await connectOne(client, plan, base, flags);
        info(`connected ${plan.providerId} (${status.type}, ${status.state})`);
        connected.push(plan.providerId);
      } catch (error) {
        if (error instanceof CancelledError) throw error;
        warn(`${plan.providerId}: ${error instanceof Error ? error.message : String(error)}`);
        failed.push(plan.providerId);
      }
    }
  } finally {
    terminal?.dispose();
  }

  info(`connected: ${connected.join(", ") || "none"}`);
  if (skipped.length > 0) {
    info(`skipped: ${skipped.map((skip) => `${skip.providerId} (${skip.reason})`).join(", ")}`);
  }
  if (failed.length > 0) warn(`failed: ${failed.join(", ")}`);
  return failed.length > 0 ? 1 : 0;
}

/** Answer the login's first secret prompt with the imported key; everything else falls through. */
function withImportedKey(base: RemoteAuthInteraction, key: string): RemoteAuthInteraction {
  let used = false;
  return {
    ...base,
    prompt: (prompt) => {
      if (prompt.type === "secret" && !used) {
        used = true;
        return Promise.resolve(key);
      }
      return base.prompt(prompt);
    },
  };
}

/**
 * The key local pi would actually use — the bundled pi resolves auth.json `!command` and
 * `$ENV` references, so a raw auth.json copy would ship a reference that means nothing in a pod.
 */
export async function readLocalPiApiKey(providerId: string, home?: string): Promise<string> {
  const pi = installedPiPackage();
  const cli = path.join(pi.root, pi.bin);
  return new Promise<string>((resolve, reject) => {
    execFile(
      process.execPath,
      [cli, "auth", "print-api-key", "--provider", providerId],
      {
        timeout: 30_000,
        maxBuffer: 64 * 1024,
        env: { ...process.env, ...(home ? { HOME: home } : {}) },
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new PiPodError(`local pi could not print a ${providerId} API key`, {
              hint: (stderr || error.message).trim().split("\n").at(-1),
            }),
          );
        } else {
          resolve(stdout);
        }
      },
    );
  });
}

export interface LocalAuthCheck {
  status: "ready" | "not_ready" | "invalid";
  authType?: "api_key" | "oauth";
  reason?: string;
}

/** What local pi itself says about a provider, resolving env-backed keys the same way it would. */
export async function checkLocalPiAuth(providerId: string, home?: string): Promise<LocalAuthCheck> {
  const pi = installedPiPackage();
  const cli = path.join(pi.root, pi.bin);
  return new Promise<LocalAuthCheck>((resolve) => {
    execFile(
      process.execPath,
      [cli, "auth", "check", "--provider", providerId, "--json", "--no-refresh"],
      {
        timeout: 30_000,
        maxBuffer: 64 * 1024,
        env: { ...process.env, ...(home ? { HOME: home } : {}) },
      },
      (error, stdout, stderr) => {
        // pi exits nonzero for every non-ready answer, so the JSON is the result, not the code.
        // One unreadable provider is reported as invalid so it cannot sink the whole sweep.
        resolve(
          parseLocalAuthCheck(stdout) ?? {
            status: "invalid",
            reason: (stderr || error?.message || "no JSON output").trim().split("\n").at(-1),
          },
        );
      },
    );
  });
}

function parseLocalAuthCheck(stdout: string): LocalAuthCheck | null {
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const status = record["status"];
  if (status !== "ready" && status !== "not_ready" && status !== "invalid") return null;
  return {
    status,
    ...(record["authType"] === "api_key" || record["authType"] === "oauth" ? { authType: record["authType"] } : {}),
    ...(typeof record["reason"] === "string" ? { reason: record["reason"] } : {}),
  };
}

async function testCredential(args: string[], client: AccountClient): Promise<number> {
  rejectProviderArgs(args, "usage: pipod credentials test <provider>");
  const providerId = args[0]!;
  const { status } = await client.testModelCredential(providerId);
  out(formatStatus(status));
  if (status.state === "ready") return 0;
  info(
    status.sharedBy
      ? `${status.sharedBy} can reconnect it; \`pipod credentials connect ${providerId}\` connects your own instead`
      : `\`pipod credentials reconnect ${providerId}\` signs in again`,
  );
  return 1;
}

async function removeCredential(args: string[], flags: CredentialsFlags): Promise<number> {
  let providerId: string | undefined;
  let yes = flags.yes === true;
  for (const arg of args) {
    if (arg === "--yes" || arg === "-y") yes = true;
    else if (arg.startsWith("-")) throw new PiPodError(`unknown pipod credentials option "${arg}"`);
    else if (providerId === undefined) providerId = arg;
    else throw new PiPodError(`unexpected argument "${arg}"`, { hint: "usage: pipod credentials remove <provider> [--yes]" });
  }
  if (!providerId) throw new PiPodError("usage: pipod credentials remove <provider> [--yes]");
  const client = clientFor(flags);
  const listing = await client.modelCredentials();
  const serving = listing.credentials.find((credential) => credential.providerId === providerId);
  if (serving?.sharedBy) {
    throw new PiPodError(`${providerId} is shared with you by ${serving.sharedBy}; only they can remove it`, {
      hint: `\`pipod credentials connect ${providerId}\` connects your own, which your pods then use instead`,
    });
  }
  // Removing your own falls back to the credential someone shares with you, if anyone does.
  const fallback = listing.overriddenShares?.find((credential) => credential.providerId === providerId)?.sharedBy;
  if (!yes && !isInteractive()) {
    throw new PiPodError(`refusing to remove the saved ${providerId} sign-in without a terminal`, {
      hint: `rerun with \`pipod credentials remove ${providerId} --yes\``,
    });
  }
  const approved = await confirm(
    fallback
      ? `Remove your saved ${providerId} sign-in? Pods switch to the one ${fallback} shares with you.`
      : `Remove the saved ${providerId} sign-in? Pods stop using it.`,
    { nonInteractiveDefault: false, assumeYes: yes },
  );
  if (!approved) throw new CancelledError("Credential removal cancelled");
  await client.deleteModelCredential(providerId);
  info(
    fallback
      ? `removed your saved ${providerId} sign-in; pods now use the one ${fallback} shares with you`
      : `removed the saved ${providerId} sign-in; pods stop using it`,
  );
  info(`${providerId} still accepts it until you revoke it there; do that if a pod may have exposed it`);
  return 0;
}

/** The credential serving your pods for `providerId` when it is someone else's, else null. */
async function sharedCredentialServing(
  client: AccountClient,
  providerId: string,
): Promise<{ sharedBy: string } | null> {
  const { credentials } = await client.modelCredentials();
  const sharedBy = credentials.find((credential) => credential.providerId === providerId)?.sharedBy;
  return sharedBy ? { sharedBy } : null;
}

const SHARE_USAGE = "usage: pipod credentials share <provider> --with <email>";
const UNSHARE_USAGE = "usage: pipod credentials unshare <provider> --with <email>";

function parseShareArgs(args: string[], usage: string): { providerId: string; email: string } {
  let providerId: string | undefined;
  let email: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--with") email = args[++i];
    else if (arg.startsWith("--with=")) email = arg.slice("--with=".length);
    else if (arg.startsWith("-")) throw new PiPodError(`unknown pipod credentials option "${arg}"`, { hint: usage });
    else if (providerId === undefined) providerId = arg;
    else throw new PiPodError(`unexpected argument "${arg}"`, { hint: usage });
  }
  if (!providerId || !email) throw new PiPodError(usage);
  return { providerId, email };
}

/** A server from before credential sharing has no share routes at all. */
function sharingUnsupported(error: unknown): unknown {
  if (error instanceof PiPodError && error.status === 404 && error.code === undefined) {
    return new PiPodError("this pi pod server does not support credential sharing", {
      hint: "it needs a newer pi pod server; ask whoever runs it to update",
    });
  }
  return error;
}

async function shareCredential(args: string[], client: AccountClient): Promise<number> {
  const { providerId, email } = parseShareArgs(args, SHARE_USAGE);
  const shared = await client.shareModelCredential(providerId, email).catch((error: unknown) => {
    throw sharingUnsupported(error);
  });
  info(
    shared.created
      ? `shared your ${providerId} credential with ${shared.sharedWith}; their pods use it unless they connect their own`
      : `your ${providerId} credential was already shared with ${shared.sharedWith}`,
  );
  return 0;
}

async function unshareCredential(args: string[], client: AccountClient): Promise<number> {
  const { providerId, email } = parseShareArgs(args, UNSHARE_USAGE);
  await client.unshareModelCredential(providerId, email).catch((error: unknown) => {
    throw sharingUnsupported(error);
  });
  info(`${email} no longer gets your ${providerId} credential`);
  info("their running pods drop it at their next credential refresh, within about ten minutes");
  return 0;
}

function formatStatus(status: CredentialStatus): string {
  const expires = status.state === "ready" && status.expiresAt ? `  (expires ${status.expiresAt})` : "";
  const source = status.sharedBy
    ? `  shared by ${status.sharedBy}`
    : status.sharedWith?.length
      ? `  shared with ${status.sharedWith.join(", ")}`
      : "";
  return `${status.providerId}  ${status.state.replaceAll("_", " ")}${expires}${source}`;
}

function rejectExtra(args: string[], usage: string): void {
  if (args.length > 0) throw new PiPodError(usage);
}

function rejectProviderArgs(args: string[], usage: string): void {
  if (args.length !== 1 || args[0]!.startsWith("-")) throw new PiPodError(usage);
}

function terminalInteraction(): { interaction: RemoteAuthInteraction; dispose(): void } {
  const controller = new AbortController();
  const onInterrupt = (): void => controller.abort();
  let pipedAnswers: string[] | undefined;
  process.once("SIGINT", onInterrupt);
  return {
    interaction: {
      signal: controller.signal,
      prompt: (prompt) => {
        if (!process.stdin.isTTY && pipedAnswers === undefined) {
          pipedAnswers = fs.readFileSync(0, "utf8").split(/\r?\n/);
        }
        return promptOnStdin(prompt, controller.signal, pipedAnswers);
      },
      notify: notifyTerminal,
    },
    dispose: () => process.removeListener("SIGINT", onInterrupt),
  };
}

async function promptOnStdin(
  prompt: RemoteAuthPrompt,
  signal: AbortSignal,
  pipedAnswers?: string[],
): Promise<string> {
  if (prompt.type === "secret") {
    if (!isInteractive()) warn("secret input cannot be hidden because stdin is not a terminal");
    if (isInteractive()) return promptSecret(`${prompt.message}: `, signal);
  }
  if (!process.stdin.isTTY) {
    if (signal.aborted) throw new CancelledError("Credential login cancelled");
    return (pipedAnswers?.shift() ?? "").trim();
  }

  if (prompt.type === "select") {
    for (const [index, option] of (prompt.options ?? []).entries()) {
      info(`  ${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`);
    }
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(`${prompt.message}${prompt.placeholder ? ` (${prompt.placeholder})` : ""}: `, { signal });
    const trimmed = answer.trim();
    if (prompt.type !== "select") return trimmed;
    const index = Number(trimmed);
    if (Number.isInteger(index) && index >= 1 && index <= (prompt.options?.length ?? 0)) {
      return prompt.options![index - 1]!.id;
    }
    return trimmed;
  } catch (error) {
    // A Ctrl-C keystroke reaches readline as a byte, so its AbortError can arrive before
    // the SIGINT that aborts the signal — both mean the same answer.
    if (signal.aborted || (error as { name?: string })?.name === "AbortError") {
      throw new CancelledError("Credential login cancelled");
    }
    throw error;
  } finally {
    rl.close();
  }
}

function notifyTerminal(event: RemoteAuthEvent): void {
  switch (event.type) {
    case "info":
      info(event.message);
      for (const link of event.links ?? []) info(`  ${link.label ? `${link.label}: ` : ""}${link.url}`);
      return;
    case "progress":
      info(event.message);
      return;
    case "auth_url":
      if (event.instructions) info(event.instructions);
      info(event.url);
      openBrowser(event.url);
      return;
    case "device_code":
      info(`Open ${event.verificationUri}`);
      info(`User code: ${event.userCode}`);
      openBrowser(event.verificationUri);
  }
}

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "linux" ? "xdg-open" : null;
  if (!command) return;
  try {
    const child = spawn(command, [url], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // The URL has already been printed; browser opening is only a convenience.
  }
}
