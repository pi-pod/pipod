/**
 * src/preflight.ts — phase 0 (§6): everything that can fail before a pod exists.
 *
 * Preflight resolves the whole session plan and returns it; `doctor` runs the same checks in
 * report mode (§5). The rule is that anything which would leave a half-provisioned pod
 * behind, or run the session on the wrong code, is caught here.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR, type LoadedConfig, type PiPodConfig } from "./config.js";
import { parseDotenv, diffEnvKeys } from "./dotenv.js";
import { PiPodError, CancelledError } from "./errors.js";
import { effectiveArchiveAfterMinutes } from "./lifecycle.js";
import {
  allowsHost,
  buildEffectivePolicy,
  describePolicy,
  missingEndpointHints,
  resolveForProvider,
  PI_AUTH_HOST,
  type EffectivePolicy,
  type ResolvedEntry,
} from "./egress.js";
import { bundledPiVersion, isNewerVersion, latestPiVersion, supportsCredentialPrint } from "./client/piversion.js";
import {
  EMPTY_HOST_CONFIG_PLAN,
  checkModelCredentials,
  collectHostProviderEnv,
  hostHome,
  hostPiAuthPath,
  planHostConfig,
  readHostPackages,
  readPiAuthOAuthProviders,
  readPiAuthProviders,
  piAuthPrintBearerCommand,
  piAuthProbeModel,
  readProjectPackages,
  type HostConfigPlan,
} from "./hostconfig.js";
import {
  loadProviderRegistry,
  providerFacts,
  withPackageProviders,
  type ProviderRegistry,
} from "./piregistry.js";
import { RESERVED_ENV_NAMES } from "./labels.js";
import { color, debug, warn } from "./log.js";
import { confirm, isInteractive } from "./prompt.js";
import { registerSecrets } from "./redact.js";
import { supportsImageBuild } from "./providers/types.js";
import type { EgressPolicy, SandboxProvider } from "./providers/types.js";
import { displayPath, userEnvPath, type ConfigProvenanceEntry } from "./userconfig.js";

export interface PreflightOptions {
  loaded: LoadedConfig;
  provider: SandboxProvider;
  /** Skip prompts (used by `doctor`, which reports rather than acts). */
  assumeYes?: boolean;
  /** `doctor` collects findings instead of throwing on soft failures. */
  reportOnly?: boolean;
  /**
   * Whether the host's pi OAuth credential may be uploaded (§7.4) — true unless
   * `--no-copy-pi-auth`. Part of the egress derivation because it is an authentication
   * choice: it decides whether pi has a model credential at all, exactly as a key in the env
   * file does, and the allow set has to follow either way.
   *
   * Permission, not instruction: preflight still checks that the credential exists, and a
   * host that never logged pi in simply contributes nothing.
   */
  copyPiAuth?: boolean;
  /**
   * Test seam for host OAuth refresh probes. A parameter so tests need no real Pi or real
   * credential; skipped entirely in `reportOnly`, where a network round-trip is out of place.
   */
  probeCredentialPrint?: (command: string, home: string) => Promise<boolean>;
  /**
   * Whether provider API keys exported in the host's shell may travel (§7.7) — true unless
   * `--no-copy-pi-env`. Only names pi recognizes as provider credentials, never the
   * environment at large.
   */
  copyPiEnv?: boolean;
  /**
   * The host environment to read those from. Defaults to `process.env`; a parameter so tests
   * need not mutate the real one.
   */
  hostEnv?: Record<string, string | undefined>;
  /**
   * Whether the host's pi settings may travel (§7.5) — true unless `--no-copy-pi-config`.
   * The committed `pi.hostConfig` stays authoritative: this can only take away, so a repo
   * that opted out does not get opted back in by a default.
   */
  copyPiConfig?: boolean;
  /** Host home directory. Defaults to $HOME; a parameter so tests need no real one. */
  home?: string | undefined;
  /**
   * What to do when the configured image does not exist yet. The launch path passes
   * `"report"` so it can build it (§12) — with a derived tag, a missing image means "not
   * built yet", not "misconfigured".
   */
  onMissingImage?: "error" | "report";
  /**
   * Composed bake script this launch will bake into a managed image. Empty/absent means none.
   */
  bakeScript?: string;
  /**
   * Composed bake script to run live in the pod (custom pin, or a reused disk whose image
   * does not carry the current script). Empty/absent means none.
   */
  liveBakeScript?: string;
  /**
   * Optional sink that receives findings as they are produced. `doctor` passes one so that a
   * check which throws outright (a bad env file, say) does not discard everything
   * learned before it — seeing every problem at once is the whole point of doctor.
   */
  sink?: Finding[];
}

export interface SessionPlan {
  config: PiPodConfig;
  projectRoot: string;
  /** Null when this project has no `.pi-pod/` and the machine-wide config is the whole story. */
  configPath: string | null;
  /** Project identity: config `name`, or the project directory's basename. */
  project: string;
  /** Absolute path of the workspace inside the pod — starts empty; init scripts populate it. */
  workdir: string;
  /** Secrets from the env file (never logged; registered with the redactor). */
  env: Record<string, string>;
  envKeys: string[];
  envFileExists: boolean;
  /**
   * Secrets from the machine-wide `~/.pi-pod/env`, applied *under* `env` so a repo's own file
   * always wins. Never logged; registered with the redactor.
   */
  userEnv: Record<string, string>;
  userEnvKeys: string[];
  /**
   * Provider API keys picked up from the host's own shell (§7.7), applied *under* both env
   * files so the more deliberately written layer always wins. Never logged; redacted.
   */
  hostEnv: Record<string, string>;
  /** `NAME` → the provider it authenticates, for the plan printout. */
  hostEnvProviders: Record<string, string>;
  /** Where the provider facts came from, so a wrong answer can be traced (§7.7). */
  registry: ProviderRegistry;
  /** Provider ids with an entry in the carried `auth.json`. */
  piAuthProviders: string[];
  egress: {
    effective: EffectivePolicy;
    policy: EgressPolicy;
    resolved: ResolvedEntry[];
    description: string;
  };
  /** What of the host's `~/.pi/agent` travels into the pod (§7.5). */
  hostConfig: HostConfigPlan;
  /**
   * The host home directory preflight actually resolved, so the upload reads the same tree the
   * decision was made about. Without it the credential uploads fall back to `$HOME` and can
   * disagree with a preflight that was handed an explicit home — the resolution says "carry
   * it", the upload looks somewhere else, and the pod comes up unauthenticated with nothing
   * having reported a problem.
   */
  hostHomePath: string | null;
  /**
   * Resolved: the OAuth credential will be uploaded (§7.4). Permission *and* a file that
   * exists — decided here so the allow set, the plan printout and the upload cannot disagree
   * about whether pi arrives authenticated.
   */
  copyPiAuth: boolean;
  /** True when `config.image` does not exist on the provider yet. */
  imageMissing: boolean;
  /**
   * How the bake script runs this launch. Absent when there is no meaningful bake script.
   * `baked` — already in the image (or will be, if the image is about to be built).
   * `live` — run in the pod before init (custom pin, or a reused disk that predates it).
   */
  bake?: { mode: "baked" | "live"; script: string };
  warnings: string[];
  /** Which layer supplied each explicitly-configured leaf value (later layers win). */
  provenance: ConfigProvenanceEntry[];
}

export interface Finding {
  /** `skip` marks a check that deliberately did not run — neutral, neither passed nor failed. */
  level: "ok" | "warn" | "error" | "skip";
  message: string;
  hint?: string;
}

export interface PreflightResult {
  plan: SessionPlan;
  findings: Finding[];
}

export async function preflight(opts: PreflightOptions): Promise<PreflightResult> {
  const findings: Finding[] = [];
  const warnings: string[] = [];
  const { config, projectRoot, configPath } = opts.loaded;

  const record = (f: Finding) => {
    findings.push(f);
    opts.sink?.push(f);
    if (f.level === "warn") warnings.push(f.message);
  };

  for (const w of opts.loaded.warnings) record({ level: "warn", message: `config: ${w}` });

  // Asked now so the registry round-trip overlaps the checks below rather than adding to
  // them; the answer is awaited in the image section, where it is about. Never rejects — an
  // unreachable registry just means no freshness finding this run.
  const latestPi = latestPiVersion();

  // --- provider registry (§7.7) -------------------------------------------
  // Loaded first: which env vars authenticate what, and which endpoints they reach, is an
  // input to nearly every check below. Taken from the host's own pi when it can be reached,
  // so the answer tracks pi rather than whatever this launcher was last taught.
  //
  // Then extended with the providers this pod's *packages* register, which pi's own answer
  // cannot include — an extension registers its provider at runtime, inside a pi that is not
  // running here (§7.7). Done at the top rather than beside the package list further down,
  // because the very first thing keyed on the registry is which shell keys travel, and a
  // provider missing from the table at that moment loses its credential for the whole run.
  //
  // The package list is read the same cheap way the image tag reads it, from the same two
  // files planHostConfig will read again — a peek, not a second source of truth.
  const hostConfigSelection = {
    ...config.pi.hostConfig,
    settings: config.pi.hostConfig.settings && opts.copyPiConfig !== false,
  };
  const podPackages = [
    ...readHostPackages(hostConfigSelection, opts.home),
    ...readProjectPackages(projectRoot),
  ];
  const registry = withPackageProviders(await loadProviderRegistry(), podPackages);
  debug(`provider facts from ${registry.source} (${Object.keys(registry.providers).length} providers)`);

  // --- project -------------------------------------------------------------
  // No version-control inspection: the pod workspace starts empty and init scripts own its
  // contents, so the only project fact preflight needs is which directory the contract is in.
  const project = config.name ?? path.basename(projectRoot);
  record({ level: "ok", message: `project: ${project} (${projectRoot})` });

  // --- provider auth (§10) -------------------------------------------------
  try {
    await opts.provider.checkAuth();
    record({ level: "ok", message: `provider auth: ${opts.provider.name}` });
  } catch (e) {
    const err = e instanceof PiPodError ? e : new PiPodError(String(e));
    if (opts.reportOnly) {
      record({ level: "error", message: err.message, ...(err.hint ? { hint: err.hint } : {}) });
    } else {
      throw err;
    }
  }

  // --- env file: gitignore hard stop (§4) ----------------------------------
  const envRelPath = config.envFile;
  const envAbsPath = path.join(projectRoot, envRelPath);
  const envFileExists = fs.existsSync(envAbsPath);

  // The check applies whether or not the file exists yet: the .gitignore entry is the
  // structural protection, and finding out it is missing only once a secret is sitting
  // there is the failure this guards against. A plain-text scan rather than `git
  // check-ignore`: pi-pod runs no version-control tool, so this is advisory — it catches
  // the common case (a scaffolded project whose .gitignore lost its entry) without claiming
  // git's own answer.
  //
  // It does not apply to a project that has no `.pi-pod/` at all — running from the
  // machine-wide config alone. There is no project-relative secrets file to protect there, and
  // demanding a .gitignore line for a path nobody is going to create would make "pi-pod works
  // anywhere" false for exactly the directories it was meant for.
  const projectHasContract = configPath !== null || envFileExists;
  if (!projectHasContract) {
    record({
      level: "ok",
      message: `no ${CONFIG_DIR}/ in this directory — running from ~/.pi-pod alone`,
      hint: "`pi-pod init` adds a project contract (its own egress policy, init script and secrets)",
    });
  } else if (!envFilePlausiblyIgnored(projectRoot, envRelPath)) {
    record({
      level: "warn",
      message: `${envRelPath} does not appear in a .gitignore`,
      hint: `if this project is version-controlled, add this line to .gitignore so the secrets file cannot be committed:\n\n    ${envRelPath}\n`,
    });
  } else {
    record({ level: "ok", message: `${envRelPath} is covered by .gitignore` });
  }

  // --- machine-wide env file (~/.pi-pod/env) -------------------------------
  // Read before the repo's, and outranked by it, exactly as the config layers are. Keys here
  // reach every pod this machine launches, which is why they are named on every run.
  const userEnvAbsPath = hostHome(opts.home) ? userEnvPath(opts.home) : null;
  let userEnv: Record<string, string> = {};
  if (userEnvAbsPath && fs.existsSync(userEnvAbsPath)) {
    const displayed = displayPath(userEnvAbsPath, opts.home);
    const parsed = parseDotenv(fs.readFileSync(userEnvAbsPath, "utf8"));
    userEnv = parsed.values;
    registerSecrets(userEnv);

    for (const m of parsed.malformed) {
      record({ level: "warn", message: `${displayed}:${m.line}: ignored unparseable line` });
    }
    if ((fs.statSync(userEnvAbsPath).mode & 0o077) !== 0) {
      record({
        level: "warn",
        message: `${displayed} is group/world-readable`,
        hint: `chmod 600 ${userEnvAbsPath}`,
      });
    }

    checkEnvFileNames({
      env: userEnv,
      label: displayed,
      provider: opts.provider,
      record,
      reportOnly: opts.reportOnly === true,
      // The same key, one layer up, reaches pods for *every* repo rather than one — so the
      // warning has a larger number to report, not a different rule.
      providerCredHint:
        `redundant: pi-pod injects your shell's key into every pod for the keepalive,\n` +
        `and a copy here silently outranks the shell value. Remove it unless every pod on\n` +
        `this machine really should use a different key than your shell's.`,
    });

    if (Object.keys(userEnv).length > 0) {
      record({
        level: "warn",
        message: `carrying ${Object.keys(userEnv).length} secret(s) from ${displayed} into the pod: ${Object.keys(userEnv).join(", ")}`,
        hint: `these apply to every repo on this machine; anything in ${envRelPath} wins over them`,
      });
    }
  }

  // --- env file parse (§4.2) ----------------------------------------------
  let env: Record<string, string> = {};
  if (envFileExists) {
    const stat = fs.statSync(envAbsPath);
    if ((stat.mode & 0o077) !== 0) {
      record({
        level: "warn",
        message: `${envRelPath} is group/world-readable`,
        hint: `chmod 600 ${envRelPath}`,
      });
    }
    const parsed = parseDotenv(fs.readFileSync(envAbsPath, "utf8"));
    env = parsed.values;
    registerSecrets(env);

    for (const m of parsed.malformed) {
      record({ level: "warn", message: `${envRelPath}:${m.line}: ignored unparseable line` });
    }

    checkEnvFileNames({
      env,
      label: envRelPath,
      provider: opts.provider,
      record,
      reportOnly: opts.reportOnly === true,
      providerCredHint:
        `redundant: pi-pod injects your shell's key into every pod for the keepalive.\n` +
        `A value here outranks the shell's — keep it only if this repo's pods need a\n` +
        `different key, and prefer one scoped to sandboxes over one that can publish images.`,
    });

    // env.example is the committed contract (§4.2).
    const examplePath = path.join(path.dirname(envAbsPath), "env.example");
    if (fs.existsSync(examplePath)) {
      const example = parseDotenv(fs.readFileSync(examplePath, "utf8"));
      const { undocumented } = diffEnvKeys(Object.keys(env), Object.keys(example.values));
      if (undocumented.length > 0) {
        record({
          level: "warn",
          message: `keys in ${envRelPath} not documented in env.example: ${undocumented.join(", ")}`,
          hint: "add them (valueless) to .pi-pod/env.example so the contract stays readable",
        });
      }
    }
    record({ level: "ok", message: `${envRelPath}: ${Object.keys(env).length} variable(s)` });
  } else if (Object.keys(userEnv).length === 0) {
    record({
      level: "warn",
      message: `${envRelPath} not found — the session will start with no secrets`,
      hint: `create it from .pi-pod/env.example if pi needs an API key, put keys every repo needs in ~/.pi-pod/env, or configure auth another way`,
    });
  }

  /** The secrets the pod will hold from files: machine-wide first, this repo's on top. */
  const fileEnv = layerEnv(userEnv, env);

  // --- host provider API keys (§7.7) --------------------------------------
  // pi's third resolution step. On the host, `export OPENAI_API_KEY=…` is an ordinary way to
  // authenticate pi; without this it did not survive the trip, and the key had to be written a
  // second time into the env file to reach the pod.
  //
  // Only names pi calls provider credentials, never the environment at large. The pod
  // provider's own key is excluded from this filtered pickup and added explicitly below —
  // it travels on different grounds (the keepalive, §8), not as a model credential, and
  // `--no-copy-pi-env` must not switch it off.
  const hostEnvSelection = opts.copyPiEnv === false
    ? { values: {}, providers: {} }
    : collectHostProviderEnv({
        registry,
        env: opts.hostEnv ?? process.env,
        envFileKeys: Object.keys(fileEnv),
        excluded: [...(opts.provider.credentialEnvNames ?? []), ...RESERVED_ENV_NAMES],
      });
  const hostEnv = hostEnvSelection.values;

  // --- pod provider credential (§8) ---------------------------------------
  // Always injected: the in-pod keepalive authenticates its activity refresh with it, which
  // is what lets a detached pod live exactly as long as its running work. The env files still
  // outrank this ambient value, so a repo that needs a differently-scoped key writes one
  // there. The cost is stated in §15: every pod now holds an org-scoped credential — except
  // on the sandbox provider, whose adapter swaps in a per-sandbox activity token before
  // any env crosses the wire.
  for (const name of opts.provider.credentialEnvNames ?? []) {
    const value = (opts.hostEnv ?? process.env)[name];
    if (value) {
      hostEnv[name] = value;
      hostEnvSelection.providers[name] = `${opts.provider.name} pod control, for the keepalive`;
    }
  }

  const hostEnvKeys = Object.keys(hostEnv);
  registerSecrets(hostEnv);

  if (hostEnvKeys.length > 0) {
    // By name, every run, values never printed: these are secrets leaving the machine, and the
    // user did not write them down anywhere pi-pod can point at the way it can point at a file.
    record({
      level: "warn",
      message: `carrying ${hostEnvKeys.length} provider key(s) from your shell into the pod: ${hostEnvKeys
        .map((k) => `$${k} (${hostEnvSelection.providers[k]})`)
        .join(", ")}`,
      hint:
        `--no-copy-pi-env omits model-provider keys; the ${opts.provider.name} pod-control key still travels for the keepalive; ` +
        `anything in ${envRelPath} wins over shell values`,
    });
  }

  /** What the pod will actually have. The env files outrank the ambient host value. */
  const effectiveEnvKeys = [...new Set([...hostEnvKeys, ...Object.keys(fileEnv)])];

  // The workspace the pod starts with: the configured workdir, empty. Whatever should be in
  // it — a checkout, fetched artifacts, nothing — is the init scripts' business (§4.3).
  const workdir = config.workdir;

  // --- host pi auth (§7.4) -------------------------------------------------
  // Resolved before egress for the same reason the settings are: whether pi arrives holding a
  // credential decides which endpoint must be reachable. Uploading is the default, so this is
  // now a question about the *host* — a machine that never logged pi in contributes nothing,
  // and saying so is not a failure. It only ever was one while the flag meant "I insist".
  const hostHomePath = hostHome(opts.home);
  const copyPiAuthAllowed = opts.copyPiAuth !== false;
  const authPath = hostHomePath ? hostPiAuthPath(hostHomePath) : null;
  const copyPiAuth = copyPiAuthAllowed && authPath !== null && fs.existsSync(authPath);
  // Which providers that file actually covers — keys only, never a value (§7.7). This is what
  // lets a subscription provider like `openai-codex` be reported as authenticated instead of
  // guessed at from endpoint shapes it does not have.
  const piAuthProviders = copyPiAuth && hostHomePath ? readPiAuthProviders(hostHomePath) : [];

  if (copyPiAuth) {
    // Still announced every run, default or not: this puts OAuth credentials on third-party
    // pod disk, and a thing that becomes silent is a thing nobody reconsiders.
    record({
      level: "warn",
      message: "carrying host pi OAuth credentials (~/.pi/agent/auth.json) into the pod",
      hint:
        "access tokens travel; OAuth refresh tokens stay on the host, which renews the pod's copies " +
        "(§7.4). Pass --no-copy-pi-auth to leave the whole file on the host and rely on keys in .pi-pod/env",
    });
  } else if (copyPiAuthAllowed && authPath !== null) {
    debug(`${authPath} not found — the pod will rely on keys from the env file`);
  }

  // --- host pi config (§7.5) ----------------------------------------------
  // Ahead of the egress block on purpose: the model these settings select decides which
  // endpoint has to be in the allow set, and that is a decision, not a report.
  //
  // The flag can only subtract. `pi.hostConfig` is committed and reviewable, so a repo that
  // turned this off must stay off — a CLI default that quietly reinstated it would make the
  // file a suggestion. Resolved at the top of preflight, because the provider registry needs
  // the package list this selection decides.
  const selection = hostConfigSelection;

  let hostConfig: HostConfigPlan = EMPTY_HOST_CONFIG_PLAN;
  try {
    hostConfig = planHostConfig({
      selection,
      home: opts.home,
      registry,
      // Read from the working tree, not the clone: `.pi/settings.json` is routinely untracked,
      // so waiting for it to arrive with the repo means waiting forever (§7.5).
      projectPackages: readProjectPackages(projectRoot),
    });
  } catch (e) {
    const err = e instanceof PiPodError ? e : new PiPodError(String(e));
    if (opts.reportOnly) {
      record({ level: "error", message: err.message, ...(err.hint ? { hint: err.hint } : {}) });
    } else {
      throw err;
    }
  }

  if (hostConfig.requested) {
    for (const w of hostConfig.warnings) record({ level: "warn", message: `pi.hostConfig: ${w}` });
    if (hostConfig.uploads.length > 0) {
      record({
        level: "ok",
        message: `pi.hostConfig: carrying ${hostConfig.items.join(", ")} from ~/.pi/agent`,
      });
    }
    if (hostConfig.droppedKeys.length > 0) {
      record({
        level: "warn",
        message: `pi.hostConfig: dropped host-coupled settings keys: ${hostConfig.droppedKeys.join(", ")}`,
        hint:
          "these describe the host rather than a preference, and would not work in the pod " +
          '(packages can be kept with "packages": true)',
      });
    }
  }


  // --- host OAuth refresh (§7.4) --------------------------------------------
  // The pod's copy of auth.json is sanitized — access tokens travel, refresh tokens never
  // leave the host (they rotate on use; two environments holding one revoke each other).
  // Before the copy is taken, each OAuth entry is refreshed *on the host* through pi's own
  // print command, which proves the grant alive and mints the pod's first fresh token in the
  // same act. A grant that cannot print is expired or revoked: the pod still gets the
  // sanitized file (a host re-login heals the next launch), but the user hears about it here,
  // next to every other credential decision, rather than as a dead model mid-session.
  const piAuthOAuthProviders = copyPiAuth && hostHomePath ? readPiAuthOAuthProviders(hostHomePath) : [];
  if (piAuthOAuthProviders.length > 0 && !opts.reportOnly && supportsCredentialPrint(bundledPiVersion())) {
    const failures = await refreshHostOAuthGrants(hostHomePath ?? "", {
      hostModel: hostConfig.model?.model ? { provider: hostConfig.model.provider, model: hostConfig.model.model } : null,
      providers: piAuthOAuthProviders,
      probe: opts.probeCredentialPrint,
    });
    if (failures.length > 0) {
      record({
        level: "warn",
        message: `host pi login(s) cannot mint fresh tokens: ${failures.join(", ")}`,
        hint:
          "the grant is expired or revoked — run /login in pi for these providers, then relaunch. " +
          "The pod still gets the remaining access tokens, which expire under it.",
      });
    } else {
      record({
        level: "ok",
        message:
          `host OAuth grant(s) refreshed for the pod (${piAuthOAuthProviders.join(", ")}) — ` +
          "access tokens travel; refresh tokens never leave the host",
      });
    }
  }

  if (hostConfig.model) {
    const check = checkModelCredentials(hostConfig.model, {
      envKeys: effectiveEnvKeys,
      copyPiAuth,
      piAuthProviders,
      envFile: config.envFile,
    });
    record({ level: check.level, message: check.message, ...(check.hint ? { hint: check.hint } : {}) });
    if (!check.ok && !opts.reportOnly) {
      throw new PiPodError(check.message, ...(check.hint ? [{ hint: check.hint }] : []));
    }
  }

  // --- egress policy (§11.1, D5) ------------------------------------------
  //
  // The providers the carried settings let pi select, with the endpoints each needs. A pod is
  // handed the host's credentials by default (§7.4, §7.7); handing it a credential while its
  // endpoint stays blocked produces the one failure that reads as a broken login rather than
  // as a firewall, which is exactly what §7.5 reconciles the model choice to avoid.
  //
  // Unknown providers contribute nothing rather than a guess, and a provider whose hosts the
  // config already covers (a `*.anthropic.com` wildcard, say) is dropped by buildEffectivePolicy
  // rather than spending an entry against the provider's cap.
  const providerEndpoints = hostConfig.providers
    .map((provider) => ({ provider, endpoints: providerFacts(registry, provider)?.endpoints ?? [] }))
    .filter((entry) => entry.endpoints.length > 0);

  const effective = buildEffectivePolicy(config.egress, {
    envKeys: effectiveEnvKeys,
    // A `*_BASE_URL` exported on the host points the pod at a gateway just as one in the env
    // file does, so it has to reach the allow set the same way. The file still wins.
    baseUrlValues: { ...hostEnv, ...fileEnv },
    providerEndpoints,
    podProviderApi: opts.provider.keepaliveApiHost
      ? { name: opts.provider.name, host: opts.provider.keepaliveApiHost }
      : null,
  });

  // `"builtins": false` declines the keepalive host along with everything else derived, and
  // the result deserves its own line: the pod still launches, the watcher still starts, and
  // every refresh it attempts is silently blocked — a detached pod then idle-stops mid-task,
  // which reads as a provider bug and never as a firewall.
  if (
    effective.mode === "allowlist" &&
    opts.provider.keepaliveApiHost &&
    !allowsHost(effective.entries.map((e) => e.host), opts.provider.keepaliveApiHost)
  ) {
    record({
      level: "warn",
      message: `the allow set blocks ${opts.provider.keepaliveApiHost}, so the in-pod keepalive cannot vouch for running work`,
      hint: `a detached pod will idle-stop after ${config.idleTimeoutMinutes} min even mid-task; add "${opts.provider.keepaliveApiHost}" to egress.allow`,
    });
  }

  // The allow set is whatever the config says, so the launcher's job is no longer to guess at
  // it but to notice when it looks wrong. Every check below is advisory and names the exact
  // line to add: the failure they exist to prevent is a pod that boots perfectly and then
  // cannot reach a model, which reads as a bad key or an outage and never as a firewall.
  if (effective.mode === "allowlist") {
    const allowed = effective.entries.map((e) => e.host);

    for (const hint of missingEndpointHints(effectiveEnvKeys, allowed, registry)) {
      const from = Object.hasOwn(env, hint.envKey) ? config.envFile : "your shell";
      record({
        level: "warn",
        message: `egress: ${from} carries ${hint.envKey}, but ${hint.host} is not in the allow set`,
        hint: `add "${hint.host}" to egress.allow in .pi-pod/config.json, or remove the key if the pod does not need it`,
      });
    }

    // Same gap through a different door: pi's own settings can select a provider that no key
    // in the env file names, so the credential check above would pass while the endpoint stays
    // blocked. An unrecognized provider contributes nothing rather than a guess.
    if (hostConfig.model) {
      for (const endpoint of hostConfig.model.endpoints) {
        if (allowsHost(allowed, endpoint)) continue;
        record({
          level: "warn",
          message: `egress: pi is configured for provider "${hostConfig.model.provider}", but ${endpoint} is not in the allow set`,
          hint: `add "${endpoint}" to egress.allow in .pi-pod/config.json`,
        });
      }
    }

    // `--copy-pi-auth` uploads a credential rather than setting an env var, so nothing above
    // sees it (§7.4).
    if (copyPiAuth && !allowsHost(allowed, PI_AUTH_HOST)) {
      record({
        level: "warn",
        message: `egress: --copy-pi-auth uploads pi credentials for ${PI_AUTH_HOST}, which is not in the allow set`,
        hint: `add "${PI_AUTH_HOST}" to egress.allow in .pi-pod/config.json`,
      });
    }
  }

  let policy: EgressPolicy;
  let resolved: ResolvedEntry[] = [];
  let egressResolutionFailed = false;
  try {
    const resolution = await resolveForProvider(effective, opts.provider.capabilities.egressEnforcement, {
      addressFamily: opts.provider.capabilities.egressAddressFamily,
      maxEntries: opts.provider.capabilities.egressMaxEntries,
    });
    policy = resolution.policy;
    resolved = resolution.resolved;
    for (const w of resolution.warnings) record({ level: "warn", message: `egress: ${w}` });
  } catch (e) {
    if (opts.reportOnly && e instanceof PiPodError) {
      record({ level: "error", message: e.message, ...(e.hint ? { hint: e.hint } : {}) });
      policy = { mode: "open" };
      egressResolutionFailed = true;
    } else {
      throw e;
    }
  }

  if (!egressResolutionFailed) {
    record({
      level: "ok",
      message:
        policy.mode === "open"
          ? `egress: open — network policy left to the sandbox provider` +
            (config.egress.mode === "open" ? " (default)" : " (provider cannot enforce allowlist)")
          : `egress: allowlist, ${effective.entries.length} host(s) → ${policy.hosts.length} ${opts.provider.capabilities.egressEnforcement === "cidr" ? "CIDR(s)" : "domain(s)"}`,
    });
  }

  // --- image (§12) ---------------------------------------------------------
  const image = await opts.provider.resolveImage(config.image).catch((e) => {
    if (opts.reportOnly) {
      record({ level: "error", message: `image lookup failed: ${e instanceof Error ? e.message : String(e)}` });
      return null;
    }
    throw e;
  });
  const imageMissing = !image;
  if (!image) {
    const message = `image "${config.image}" not found in the ${opts.provider.name} org`;
    // "run `pi-pod image build`" is wrong advice on a provider that cannot build one: the user
    // would follow it only to be told the same thing a second time.
    const hint = supportsImageBuild(opts.provider)
      ? "run `pi-pod image build` to build and publish it"
      : `${opts.provider.name} cannot build images — publish one with that provider's own tooling ` +
        'and set "image" in .pi-pod/config.json to it';
    if (opts.onMissingImage === "report") {
      record({ level: "warn", message: `${message} — it will be built now` });
    } else if (opts.reportOnly) {
      record({ level: "error", message, hint });
    } else {
      throw new PiPodError(message, { hint });
    }
  } else {
    record({ level: "ok", message: `image: ${image.ref}${image.state ? ` (${image.state})` : ""}` });
  }
  // --- pi freshness (§10) ----------------------------------------------------
  // Newly built pods carry the pi this launcher bundles. Existing pods may report an older pi
  // and continue with a handshake warning (§4.3), so the latest-pi check is advisory here too:
  // tell the user how to update without preventing a session or its automatic image build.
  const latest = await latestPi;
  if (latest !== null && isNewerVersion(latest, bundledPiVersion())) {
    record({
      level: "warn",
      message:
        `pi ${latest} is the latest release, but this launcher bundles pi ${bundledPiVersion()} ` +
        "— pods run the bundled one",
      hint: "run `pi-pod update`; the next launch derives a new image tag and builds it",
    });
  }

  // --- capability warnings (§3.2) ------------------------------------------
  for (const f of capabilityFindings(opts.provider, config)) record(f);

  const plan: SessionPlan = {
    config,
    projectRoot,
    configPath,
    project,
    workdir,
    env,
    envKeys: Object.keys(env),
    envFileExists,
    userEnv,
    userEnvKeys: Object.keys(userEnv),
    hostEnv,
    hostEnvProviders: hostEnvSelection.providers,
    registry,
    piAuthProviders,
    egress: { effective, policy, resolved, description: describePolicy(policy) },
    hostConfig,
    hostHomePath,
    copyPiAuth,
    imageMissing,
    ...(opts.liveBakeScript
      ? { bake: { mode: "live" as const, script: opts.liveBakeScript } }
      : opts.bakeScript
        ? { bake: { mode: "baked" as const, script: opts.bakeScript } }
        : {}),
    warnings,
    provenance: opts.loaded.provenance ?? [],
  };

  return { plan, findings };
}

/**
 * Best-effort answer to "would git ignore this path?", from `.gitignore` text alone.
 *
 * Checks the project root's `.gitignore` and the env file's own directory's (`.pi-pod/`)
 * for a line that covers the path — the exact relative path, the basename, or a parent
 * directory. Not gitignore semantics (no negations, no globs beyond `*`); callers treat a
 * miss as advisory, never as proof.
 */
export function envFilePlausiblyIgnored(projectRoot: string, relPath: string): boolean {
  const posixRel = relPath.split(path.sep).join("/");
  const base = path.posix.basename(posixRel);
  const dir = path.posix.dirname(posixRel);
  const candidates = [
    path.join(projectRoot, ".gitignore"),
    ...(dir !== "." ? [path.join(projectRoot, dir, ".gitignore")] : []),
  ];
  const covers = (rawLine: string, target: string): boolean => {
    let line = rawLine.trim();
    if (line === "" || line.startsWith("#")) return false;
    if (line.startsWith("/")) line = line.slice(1);
    if (line.endsWith("/")) line = line.slice(0, -1);
    if (line === "*" ) return true;
    if (line === target || line === base) return true;
    // A listed parent directory covers everything under it.
    if (target.startsWith(`${line}/`)) return true;
    // One trailing-star form, the only glob common in scaffolds: "dir/*" or "env*".
    if (line.endsWith("*") && target.startsWith(line.slice(0, -1))) return true;
    return false;
  };
  for (const file of candidates) {
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    // The nested file matches against paths relative to its own directory.
    const target = file === candidates[0] ? posixRel : base;
    if (text.split(/\r?\n/).some((line) => covers(line, target))) return true;
  }
  return false;
}

/**
 * Layer one env file over another — except that a blank value does not shadow a real one.
 *
 * `KEY=` with nothing after it is what every dotenv template in the world looks like, this
 * project's own scaffold included. Treating it as an override would mean that scaffolding a
 * repo, and then not filling in a key you had already put in `~/.pi-pod/env`, silently replaced
 * a working credential with an empty string — a pod that boots and cannot reach a model, which
 * reads as a bad key and never as a placeholder.
 *
 * The precedent is already in the codebase: `collectHostProviderEnv` skips an exported variable
 * whose value is blank, on the same reasoning. Unsetting a lower layer is not offered, because
 * nothing has ever asked for it and the placeholder case is constant.
 */
export function layerEnv(
  base: Record<string, string>,
  override: Record<string, string>,
): Record<string, string> {
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value.trim() === "" && (out[key] ?? "").trim() !== "") continue;
    out[key] = value;
  }
  return out;
}

/**
 * The two name-based checks every secrets file gets, whichever layer it is (§7.3).
 *
 * Shared rather than duplicated because the rules are the same and only the blast radius
 * differs: a reserved name is a hard failure in either file, and a provider credential is a
 * warning in either — refusing it outright only ever taught people to work around it, and the
 * thing worth saying is what the key can reach, which is what the caller's hint supplies.
 */
function checkEnvFileNames(opts: {
  env: Record<string, string>;
  /** How the file is named in messages: a repo-relative path, or `~/.pi-pod/env`. */
  label: string;
  provider: SandboxProvider;
  record: (f: Finding) => void;
  reportOnly: boolean;
  providerCredHint: string;
}): void {
  const collisions = Object.keys(opts.env).filter((k) =>
    (RESERVED_ENV_NAMES as readonly string[]).includes(k),
  );
  if (collisions.length > 0) {
    const message = `${opts.label} sets reserved variable(s): ${collisions.join(", ")}`;
    const hint = `these are set by pi-pod itself; remove them from ${opts.label}`;
    if (opts.reportOnly) opts.record({ level: "error", message, hint });
    else throw new PiPodError(message, { hint });
  }

  const providerCreds = (opts.provider.credentialEnvNames ?? []).filter((name) =>
    Object.hasOwn(opts.env, name),
  );
  if (providerCreds.length > 0) {
    opts.record({
      level: "warn",
      message: `${opts.label} carries ${opts.provider.name} provider credential(s): ${providerCreds.join(", ")}`,
      hint: opts.providerCredHint,
    });
  }
}

/** §3.2 — every capability gap is stated, never silently absorbed. */
export function capabilityFindings(
  provider: SandboxProvider,
  configured: Pick<PiPodConfig, "archiveAfterMinutes" | "idleTimeoutMinutes" | "resources"> &
    Partial<Pick<PiPodConfig, "egress">> = {
    archiveAfterMinutes: 0,
    idleTimeoutMinutes: 0,
    resources: { cpu: 0, memoryGB: 0, diskGB: 0 },
  },
): Finding[] {
  const c = provider.capabilities;
  const findings: Finding[] = [];

  if (!c.reportsLastActivity) {
    findings.push({
      level: "warn",
      message: `${provider.name} does not report when a pod was last used — a bare \`pi-pod gc\` cannot tell an abandoned pod from a busy one, so it sweeps nothing`,
      hint:
        "reclaim pods by name instead: `pi-pod list` then `pi-pod gc <pod-id>`.\n" +
        "`pi-pod list` still orders by creation time, which answers a narrower question.",
    });
  }

  if (!c.serverSideArchive) {
    findings.push({
      level: "warn",
      message: `${provider.name} cannot archive long-stopped pods — archiveAfterMinutes is not enforced, and a forgotten pod holds its disk indefinitely`,
      hint: "schedule `pi-pod gc --yes` (e.g. a cron entry) so a crashed launcher cannot leak pods",
    });
  }
  // Not an "absent capability" but a quiet ceiling: the provider stores what it is given and
  // enforces something smaller, so the config would read as authoritative while the pod
  // archived weeks early. Core clamps; this is the part that says so.
  const effectiveArchive = effectiveArchiveAfterMinutes(provider, configured.archiveAfterMinutes);
  if (effectiveArchive !== null && configured.archiveAfterMinutes > effectiveArchive) {
    findings.push({
      level: "warn",
      message:
        `archiveAfterMinutes is ${configured.archiveAfterMinutes}, but ${provider.name} caps the archive ` +
        `window at ${effectiveArchive} minutes — pods will be archived after ${effectiveArchive}`,
      hint: `set "archiveAfterMinutes": ${effectiveArchive} so the config matches what happens`,
    });
  }
  if (!c.ptyReattach) {
    findings.push({
      level: "warn",
      message: `${provider.name} PTY sessions do not survive client disconnect — detaching ends the pi process`,
      hint: "on this provider, push your work before leaving a session",
    });
  }
  if (c.idleAutoStop === "none") {
    findings.push({
      level: "warn",
      message: `${provider.name} cannot stop idle pods — idleTimeoutMinutes is not enforced`,
      hint:
        "a detached pod keeps running (and billing) indefinitely, and never becomes " +
        "eligible for archival; run `pi-pod gc` to reclaim pods you are finished with",
    });
  } else if (c.idleAutoStopMaxMinutes !== undefined) {
    if (configured.idleTimeoutMinutes === 0) {
      findings.push({
        level: "warn",
        message:
          `${provider.name} cannot disable its sandbox timeout — idleTimeoutMinutes 0 becomes ` +
          `${c.idleAutoStopMaxMinutes} minutes`,
        hint: "the timeout pauses rather than deletes the pod; set the effective value explicitly so config matches behavior",
      });
    } else if (configured.idleTimeoutMinutes > c.idleAutoStopMaxMinutes) {
      findings.push({
        level: "warn",
        message:
          `idleTimeoutMinutes is ${configured.idleTimeoutMinutes}, but ${provider.name} caps it at ` +
          `${c.idleAutoStopMaxMinutes} minutes`,
        hint: `set "idleTimeoutMinutes": ${c.idleAutoStopMaxMinutes} so config matches behavior`,
      });
    }
  }
  if ((c.unsupportedResourceSizing?.length ?? 0) > 0) {
    const fields = c.unsupportedResourceSizing!;
    const values = fields.map((field) => `${field}=${configured.resources[field]}`).join(", ");
    findings.push({
      level: "warn",
      message: `${provider.name} cannot apply configured ${values} — the provider account or plan controls those fields`,
      hint: "they are omitted from image tags and builds rather than being reported as applied",
    });
  }
  // Only an allowlist naming hosts has anything to resolve; open egress filters nothing.
  if (c.egressEnforcement === "cidr" && configured.egress?.mode === "allowlist" && configured.egress.allow.length > 0) {
    findings.push({
      level: "warn",
      message: `${provider.name} enforces egress by CIDR — hostnames are resolved at creation time and enforcement is coarser than the hostname list implies`,
    });
  }
  if (c.workdirSurvivesStop === false) {
    findings.push({
      level: "error",
      message: `${provider.name} cannot preserve the workdir across stop/start`,
      hint: "choose a provider with durable workdir storage; pi-pod will not reconstruct mutable work by re-running init",
    });
  }
  return findings;
}

/** Used by `doctor` and by the unpushed-work warning to keep messages consistent. */
export function summarizeFindings(findings: Finding[]): { errors: number; warnings: number } {
  return {
    errors: findings.filter((f) => f.level === "error").length,
    warnings: findings.filter((f) => f.level === "warn").length,
  };
}

export function printFindings(findings: Finding[]): void {
  for (const f of findings) {
    const mark =
      f.level === "ok"
        ? color.green("ok  ")
        : f.level === "skip"
          ? color.dim("skip")
          : f.level === "warn"
            ? color.yellow("warn")
            : color.red("fail");
    process.stderr.write(`  ${mark}  ${f.message}\n`);
    if (f.hint) {
      for (const line of f.hint.split("\n")) process.stderr.write(`        ${color.dim(line)}\n`);
    }
  }
}

/** Shared by preflight and doctor so the warning text cannot drift. */
export function warnUnusedConfig(config: PiPodConfig, providerName: string): void {
  const foreign = Object.keys(config.providers).filter((n) => n !== providerName);
  if (foreign.length > 0) {
    debug(`ignoring provider config blocks for: ${foreign.join(", ")}`);
  }
}

/**
 * Renew every OAuth grant in the host's `auth.json` through pi's own print command — the
 * same act that proves the grant alive, refreshing and persisting through pi's locked path
 * when the stored token is inside the print command's minimum validity (§7.4). Shared by
 * preflight (first mint, reported), the auth sync (quiet renewal while a session runs) and
 * account-mode upload (the server broker's grant must arrive fresh).
 *
 * Returns the providers whose grant did not print — expired, revoked, or unreachable. They
 * are carried (or uploaded) anyway; the caller decides how loud to be about it.
 */
export async function refreshHostOAuthGrants(
  home: string,
  opts: {
    hostModel: { provider: string; model: string } | null;
    /** Defaults to every OAuth provider in the host's auth.json. */
    providers?: string[];
    probe?: (command: string, home: string) => Promise<boolean>;
  },
): Promise<string[]> {
  const probe = opts.probe ?? probeCredentialPrint;
  const providers = opts.providers ?? readPiAuthOAuthProviders(home);
  const failures: string[] = [];
  await Promise.all(
    providers.map(async (provider) => {
      const model = piAuthProbeModel(provider, opts.hostModel);
      // Unknown providers travel sanitized but unprobed — guessing a model id for a
      // provider pi-pod does not know could fail a grant that is perfectly healthy.
      if (model === null) return;
      const ok = await probe(piAuthPrintBearerCommand(provider, model), home).catch(() => false);
      if (!ok) failures.push(provider);
    }),
  );
  return failures.sort();
}

/**
 * Run the bundled Pi credential print command against the host auth.json. A zero exit means
 * the OAuth grant was refreshed and persisted through Pi's normal locked path. Stdout is a
 * live credential, so it is discarded unread and never logged or returned.
 */
export async function probeCredentialPrint(command: string, home: string): Promise<boolean> {
  const argv = command.split(" ").slice(1); // the leading "pi" is the binary, not an argument
  try {
    // The package's exports map hides bin/, so resolve the entry module and walk to the CLI
    // beside it — the same trick piversion.ts uses for package.json.
    const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const cli = path.join(path.dirname(entry), "..", "dist", "cli.js");
    await new Promise<void>((resolve, reject) => {
      execFile(
        process.execPath,
        [cli, ...argv],
        {
          timeout: 30_000,
          maxBuffer: 64 * 1024,
          env: { ...process.env, ...(home ? { HOME: home } : {}) },
        },
        (error, _stdout, stderr) => {
          // _stdout is the credential. It stays unread on purpose.
          if (error) {
            debug(`credential probe failed: ${(stderr || error.message).trim().split("\n")[0]}`);
            reject(error);
          } else {
            resolve();
          }
        },
      );
    });
    return true;
  } catch {
    return false;
  }
}
