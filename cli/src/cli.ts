#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { AccountClient } from "./account/api.js";
import { requireAccountClient } from "./account/client.js";
import { runAccountDoctor } from "./account/doctor.js";
import { runAccountJobs } from "./account/jobs.js";
import { runAccountLaunch } from "./account/launch.js";
import { runBillingCommand } from "./account/billing-cli.js";
import { runLogin, runLogout, runOpenAccount, runOpenOrgAdmin, runWhoami } from "./account/login.js";
import {
  runAccountAttach,
  runAccountFork,
  runAccountGc,
  runAccountList,
  runAccountPodAction,
  runAccountRename,
  runAccountSend,
  runAccountStop,
  type AccountPodFlags,
} from "./account/pods.js";
import { runAccountReceive } from "./account/receive.js";
import { bundledPiVersion } from "./client/piversion.js";
import { runCredentials } from "./commands/credentials.js";
import { runSecrets } from "./commands/secrets.js";
import { runTemplates } from "./commands/templates.js";
import { runDiff } from "./commands/layers.js";
import { runPull } from "./commands/pull.js";
import { runPush } from "./commands/push.js";
import { runSettings } from "./commands/settings.js";
import { findConfigPath } from "./config.js";
import { CancelledError, EXIT, PiPodError, isPiPodError } from "./errors.js";
import { launcherVersion } from "./image.js";
import {
  color,
  error,
  hint as printHint,
  info,
  isVerbose,
  out,
  plain,
  setVerbose,
  warn,
} from "./log.js";
import { manualEntry, usage } from "./manual.js";
import { printInitResult, scaffold } from "./scaffold.js";
import { runUpdate } from "./update.js";
import { displayPath, ensureUserConfig } from "./userconfig.js";

export const VERSION = launcherVersion();

const SUBCOMMANDS = [
  "init",
  "login",
  "logout",
  "whoami",
  "account",
  "org-admin",
  "gc",
  "doctor",
  "attach",
  "list",
  "stop",
  "rename",
  "fork",
  "send",
  "receive",
  "archive",
  "restore",
  "jobs",
  "credentials",
  "secrets",
  "templates",
  "push",
  "pull",
  "diff",
  "settings",
  "billing",
  "update",
] as const;

type Subcommand = (typeof SUBCOMMANDS)[number];

export const SIGNED_OUT_COMMANDS = new Set<Subcommand>(["login", "whoami", "init", "doctor", "update"]);

const ALIASES: Record<string, Subcommand> = {
  a: "attach",
  ls: "list",
};

export interface GlobalFlags {
  /** `--on <pod|self>`: co-locate the launch on an existing pod's machine. */
  on?: string;
  reuse?: boolean;
  /** `--no-seed`: leave a fresh pod's workspace empty. */
  seed?: boolean;
  dryRun: boolean;
  verbose: boolean;
  help: boolean;
  version: boolean;
  all: boolean;
  yes: boolean;
  destroy: boolean;
  quiet: boolean;
  archived: boolean;
  template?: string;
  /** `archive --idle <duration>`: only pods whose last activity is older than this. */
  idle?: string;
  project?: boolean;
  force: boolean;
  server?: string;
  org?: string;
  jobsOrg?: boolean;
  token?: string;
  session?: string;
  issuer?: string;
  device?: boolean;
}

export interface ParsedArgs {
  subcommand: Subcommand | null;
  subcommandArgs: string[];
  flags: GlobalFlags;
  piArgs: string[];
  seenFlags: Set<string>;
  /** `pipod help <name>`: the manual entry to print, a command (aliases resolved) or a topic. */
  helpEntry?: string;
}

const SELF_PARSING_SUBCOMMANDS = new Set<Subcommand>(["credentials", "secrets", "templates", "push", "pull", "diff", "settings", "billing"]);
const UNIVERSAL_FLAGS = new Set(["--verbose", "--version", "--help"]);
const FLAG_SCOPE: Record<string, ReadonlySet<string>> = {
  "--template": new Set(["launch", "list", "doctor", "fork", "archive"]),
  "--project": new Set(["jobs"]),
  "--on": new Set(["launch"]),
  "--reuse": new Set(["launch"]),
  "--no-seed": new Set(["launch"]),
  "--dry-run": new Set(["launch", "update", "fork", "archive"]),
  "--idle": new Set(["archive"]),
  "--session": new Set(["fork"]),
  "--all": new Set(["list", "archive", "restore"]),
  "--yes": new Set(["launch", "fork", "archive", "restore", "gc", "jobs", "credentials", "templates", "attach", "send", "receive", "push", "pull"]),
  "--delete": new Set(["gc"]),
  "--quiet": new Set(["list", "jobs"]),
  "--archived": new Set(["list"]),
  "--force": new Set(["init"]),
  "--server": new Set(["login"]),
  "--org": new Set(["login", "jobs"]),
  "--token": new Set(["login"]),
  "--issuer": new Set(["login"]),
  "--device": new Set(["login"]),
};

function resolveSubcommand(positional: string | undefined): Subcommand | null {
  if (positional === undefined) return null;
  const resolved = ALIASES[positional] ?? positional;
  return (SUBCOMMANDS as readonly string[]).includes(resolved) ? resolved as Subcommand : null;
}

export function checkFlagScope(subcommand: string | null, seenFlags: ReadonlySet<string>): string[] {
  const command = subcommand ?? "launch";
  const ignored: string[] = [];
  for (const flag of seenFlags) {
    if (UNIVERSAL_FLAGS.has(flag)) continue;
    const scope = FLAG_SCOPE[flag];
    if (!scope || scope.has(command)) continue;
    if (flag === "--dry-run") {
      throw new PiPodError(`--dry-run is not supported by \`pipod ${subcommand}\``, {
        hint: "nothing was done — remove the flag to run the command for real",
        exitCode: EXIT.USAGE,
      });
    }
    if (flag === "--on" && command === "fork") {
      throw new PiPodError("forking into a co-located pod is not supported yet", {
        hint: "fork without --on, or launch a plain co-located pod",
        exitCode: EXIT.USAGE,
      });
    }
    ignored.push(flag);
  }
  return ignored;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: GlobalFlags = {
    dryRun: false,
    verbose: false,
    help: false,
    version: false,
    all: false,
    yes: false,
    destroy: false,
    quiet: false,
    archived: false,
    force: false,
  };
  const positionals: string[] = [];
  const piArgs: string[] = [];
  const seenFlags = new Set<string>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      piArgs.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("-")) {
      positionals.push(arg);
      const command = positionals.length === 1 ? resolveSubcommand(arg) : null;
      if (command && SELF_PARSING_SUBCOMMANDS.has(command)) {
        const tail = argv.slice(i + 1);
        positionals.push(...tail.filter((entry) => entry !== "--help" && entry !== "-h"));
        if (tail.some((entry) => entry === "--help" || entry === "-h")) flags.help = true;
        break;
      }
      continue;
    }

    const equals = arg.indexOf("=");
    const name = equals >= 0 ? arg.slice(0, equals) : arg;
    const inlineValue = equals >= 0 ? arg.slice(equals + 1) : undefined;
    const takeValue = (): string => {
      if (inlineValue !== undefined) return inlineValue;
      const value = argv[++i];
      if (value === undefined) throw new PiPodError(`${name} requires a value`, { exitCode: EXIT.USAGE });
      return value;
    };
    const canonical = canonicalFlagName(name);
    seenFlags.add(canonical);

    switch (name) {
      case "--on": flags.on = takeValue(); break;
      case "--reuse": flags.reuse = true; break;
      case "--no-seed": flags.seed = false; break;
      case "--dry-run": flags.dryRun = true; break;
      case "--verbose":
      case "-v": flags.verbose = true; break;
      case "--version": flags.version = true; break;
      case "--help":
      case "-h": flags.help = true; break;
      case "--all":
      case "-a": flags.all = true; break;
      case "--yes":
      case "-y": flags.yes = true; break;
      case "--delete": flags.destroy = true; break;
      case "--quiet":
      case "-q": flags.quiet = true; break;
      case "--archived": flags.archived = true; break;
      case "--template": flags.template = takeValue(); break;
      case "--idle": flags.idle = takeValue(); break;
      case "--project": flags.project = true; break;
      case "--force": flags.force = true; break;
      case "--server": flags.server = takeValue(); break;
      case "--org":
        if (resolveSubcommand(positionals[0]) === "jobs") flags.jobsOrg = true;
        else flags.org = takeValue();
        break;
      case "--token": flags.token = takeValue(); break;
      case "--session": flags.session = takeValue(); break;
      case "--issuer": flags.issuer = takeValue(); break;
      case "--device": flags.device = true; break;
      default:
        throw new PiPodError(`unknown pi pod option "${name}"`, {
          hint: "pass Pi options after `--`, for example: pipod -- --model claude-opus",
          exitCode: EXIT.USAGE,
        });
    }
  }

  if (positionals[0] === "help") {
    // The name after `help` may be a topic as well as a command: only an alias is resolved.
    flags.help = true;
    seenFlags.add("--help");
    const name = positionals[1];
    return {
      subcommand: null,
      subcommandArgs: [],
      flags,
      piArgs,
      seenFlags,
      ...(name !== undefined ? { helpEntry: resolveSubcommand(name) ?? name } : {}),
    };
  }
  const subcommand = resolveSubcommand(positionals[0]);
  if (!subcommand && positionals.length > 0) {
    throw new PiPodError(`unknown pi pod command "${positionals[0]}"`, {
      hint: "pass all Pi arguments after `--`, for example: pipod -- \"review this change\"",
      exitCode: EXIT.USAGE,
    });
  }
  if (subcommand === "jobs" && flags.org !== undefined) {
    // `--org` before `jobs` parses login-style and takes a value; for jobs it is a
    // boolean that belongs after the action. Fail rather than silently scoping wrong.
    throw new PiPodError(`--org ${flags.org} does not apply here`, {
      hint: "for jobs it is a flag after the action: `pipod jobs push --org` (login takes `--org <alias>`)",
      exitCode: EXIT.USAGE,
    });
  }
  return {
    subcommand,
    subcommandArgs: subcommand ? positionals.slice(1) : [],
    flags,
    piArgs,
    seenFlags,
  };
}

function canonicalFlagName(name: string): string {
  switch (name) {
    case "-v": return "--verbose";
    case "-h": return "--help";
    case "-a": return "--all";
    case "-y": return "--yes";
    case "-q": return "--quiet";
    default: return name;
  }
}

export async function main(argv: string[]): Promise<number> {
  const { subcommand, subcommandArgs, flags, piArgs, seenFlags, helpEntry } = parseArgs(argv);
  setVerbose(flags.verbose);
  if (flags.help) {
    if (helpEntry !== undefined) process.stdout.write(manualEntry(helpEntry));
    else if (subcommand) process.stdout.write(usage(subcommand));
    else process.stdout.write(`pipod ${VERSION} — run pi sessions in server-managed pods\n\n${usage(null)}`);
    return EXIT.OK;
  }
  for (const flag of checkFlagScope(subcommand, seenFlags)) {
    warn(`${flag} has no effect with \`pipod ${subcommand}\` — ignoring it`);
  }
  announceUserConfig();
  if (flags.version) return printVersion();

  switch (subcommand) {
    case "init":
      return runInit(flags);
    case "login":
      return runLogin({ server: flags.server, org: flags.org, token: flags.token, issuer: flags.issuer, device: flags.device });
    case "whoami":
      return runWhoami({});
    case "logout":
      return runLogout({});
    case "doctor":
      return runAccountDoctor({
        template: flags.template,
      });
    case "update":
      await runUpdate({ dryRun: flags.dryRun });
      return EXIT.OK;
  }

  const account = requireAccountClient();
  switch (subcommand) {
    case "account":
      return runOpenAccount({});
    case "org-admin":
      return runOpenOrgAdmin({});
    case "billing":
      return runBillingCommand(account, subcommandArgs);
    case "gc":
      return runAccountGc(account, { ...podFlagsOf(flags), destroy: flags.destroy });
    case "attach":
      return runAccountAttach(account, subcommandArgs, piArgs, { yes: flags.yes });
    case "list":
      return runAccountList(account, podFlagsOf(flags), subcommandArgs[0]);
    case "stop":
      return runAccountStop(account, subcommandArgs, podFlagsOf(flags));
    case "rename":
      return runAccountRename(account, subcommandArgs);
    case "fork":
      return runAccountFork(account, subcommandArgs, {
        yes: flags.yes,
        dryRun: flags.dryRun,
        template: flags.template,
        session: flags.session,
        on: flags.on,
      }, piArgs);
    case "send":
      return runAccountSend(account, subcommandArgs, { yes: flags.yes });
    case "receive":
      return runAccountReceive(account, subcommandArgs, { yes: flags.yes });
    case "archive":
      return runAccountPodAction(account, subcommandArgs, podFlagsOf(flags), "archive");
    case "restore":
      return runAccountPodAction(account, subcommandArgs, podFlagsOf(flags), "restore");
    case "jobs":
      return runAccountJobs(account, subcommandArgs, {
        quiet: flags.quiet,
        yes: flags.yes,
        project: flags.project,
        org: flags.jobsOrg,
      });
    case "credentials":
      return runCredentials(subcommandArgs, { client: account, yes: flags.yes });
    case "secrets":
      return runSecrets(subcommandArgs, { client: account, yes: flags.yes });
    case "templates":
      return runTemplates(subcommandArgs, { client: account, yes: flags.yes });
    case "push":
      return runPush(subcommandArgs, { client: account, yes: flags.yes });
    case "pull":
      return runPull(subcommandArgs, { client: account, yes: flags.yes });
    case "diff":
      return runDiff(subcommandArgs, { client: account });
    case "settings":
      return runSettings(subcommandArgs, { client: account });
    default:
      return runAccountLaunch({
        client: account,
        flags: {
          yes: flags.yes,
          on: flags.on,
          reuse: flags.reuse,
          seed: flags.seed,
          dryRun: flags.dryRun,
          template: flags.template,
        },
        piArgs,
      });
  }
}

function podFlagsOf(flags: GlobalFlags): AccountPodFlags {
  return {
    all: flags.all,
    quiet: flags.quiet,
    archived: flags.archived,
    yes: flags.yes,
    template: flags.template,
    idle: flags.idle,
    dryRun: flags.dryRun,
  };
}

function announceUserConfig(): void {
  const result = ensureUserConfig();
  for (const file of result.created) info(`created ${color.bold(displayPath(file))}, this machine's pi pod preferences`);
}

function runInit(flags: GlobalFlags): number {
  const cwd = process.cwd();
  const existing = findConfigPath(cwd);
  if (existing !== null && path.dirname(path.dirname(existing)) !== fs.realpathSync(cwd)) {
    info(`note: ${color.bold(displayPath(existing))} defines an enclosing project; this scaffold shadows it here`);
  }
  const result = scaffold({ projectRoot: cwd, force: flags.force });
  printInitResult(result, cwd);
  return EXIT.OK;
}

function printVersion(): number {
  out(`pipod ${VERSION}`);
  out(`node ${process.versions.node}`);
  out(`pi ${bundledPiVersion()}`);
  return EXIT.OK;
}

export function reportError(errorValue: unknown): number {
  if (errorValue instanceof CancelledError) {
    error(errorValue.message);
    return errorValue.exitCode;
  }
  if (isPiPodError(errorValue)) {
    error(errorValue.message);
    if (errorValue.hint) printHint(errorValue.hint);
    if (isVerbose() && errorValue.cause) plain(String(errorValue.cause));
    return errorValue.exitCode;
  }
  error(errorValue instanceof Error ? errorValue.message : String(errorValue));
  if (errorValue instanceof Error && errorValue.stack) plain(color.dim(errorValue.stack));
  return EXIT.FAILURE;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  ["cli.js", "cli.ts", "pipod", "pi-pod", "pp"].includes(path.basename(process.argv[1]));

if (invokedDirectly) {
  // `pipod list | head` closes the pipe early; the reader has what it wanted.
  for (const stream of [process.stdout, process.stderr]) {
    stream.on("error", (failure: NodeJS.ErrnoException) => {
      if (failure.code === "EPIPE") process.exit(process.exitCode ?? 0);
      throw failure;
    });
  }
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((failure) => { process.exitCode = reportError(failure); });
}
