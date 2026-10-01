import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR, findConfigPath } from "../config.js";
import { parseDotenv } from "../dotenv.js";
import { EXIT, PiPodError } from "../errors.js";
import { hint, info, warn } from "../log.js";
import { checkSecretResolver, hasSecretRefs, mergeSecretResolver } from "../secret-refs.js";
import { userSecretsDir } from "../userconfig.js";
import { accountClientOrNull } from "./client.js";
import { formatSettingsChain, planAccountLaunch, readSecretResolverLayers } from "./launch.js";
import { projectTemplateStaleness, userLayerStaleness } from "./bundle-bootstrap.js";
import { describeWorkspaceSeed } from "./workspace-seed.js";

export interface AccountDoctorFlags {
  home?: string | undefined;
  template?: string | undefined;
}

export async function runAccountDoctor(flags: AccountDoctorFlags, cwd = process.cwd()): Promise<number> {
  let client;
  try {
    client = accountClientOrNull({ home: flags.home });
  } catch (error) {
    warn(`auth: ${error instanceof Error ? error.message : String(error)}`);
    hint("sign in with `pipod login`");
    return EXIT.FAILURE;
  }
  if (!client) {
    warn("auth: not signed in");
    hint("sign in with `pipod login`");
    return EXIT.FAILURE;
  }

  let failed = false;
  if (await checkSecretRefs(flags, cwd)) failed = true;

  try {
    const version = await client.serverVersion();
    info(`server: reachable at ${client.serverUrl} (version ${version?.version ?? "not reported"})`);
    if (client.isPodToken) {
      info("auth: valid pod-scoped server token");
      info("org: inherited from the parent pod token");
    } else {
      const me = await client.me();
      const orgName = me.organization?.name ?? me.organization?.alias ?? client.orgId;
      info(`auth: valid for ${me.user.email ?? me.user.id}`);
      if (!me.currentOrgId) {
        warn("org: none in this access token — membership is pending in Zitadel");
        failed = true;
      } else if ((me.permissions ?? []).length === 0) {
        warn(`org: ${orgName} (no API roles yet — grant a role bundle in Zitadel)`);
      } else {
        info(`org: ${orgName}`);
      }
    }
  } catch (error) {
    warn(`server/auth: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT.FAILURE;
  }

  try {
    const plan = await planAccountLaunch(
      client,
      {
        yes: true,
        dryRun: true,
        template: flags.template,
        home: flags.home,
      },
      cwd,
    );
    const resolved = plan.resolve;
    if (plan.projectRoot && plan.templateId) {
      const stale = await projectTemplateStaleness({ client, cwd, home: flags.home });
      if (stale) warn(stale);
    }
    const userStale = await userLayerStaleness({ client, home: flags.home });
    if (userStale) warn(userStale);
    info(`layers: ${formatSettingsChain(plan)}`);
    if (plan.bootstrapPreview) {
      info("project config: bootstrap preview only; launches use it after it is pushed to a template");
    }
    info(`resolve: provider ${resolved.provider}; image ${resolved.image}; egress ${resolved.egress.mode}`);
    if (resolved.credential.available) {
      info(`credential: ${resolved.credential.envVar} available (${resolved.credential.source})`);
    } else {
      warn(`credential: ${resolved.credential.envVar} is missing on the server`);
      failed = true;
    }
    for (const clamp of resolved.clamps) {
      warn(`org policy: ${clamp.path} → ${JSON.stringify(clamp.to)} (${clamp.reason})`);
    }
    reportWorkspaceSeed(plan.workspaceSeed);
    const seen = new Set<string>();
    for (const warning of [...plan.warnings, ...resolved.warnings]) {
      if (seen.has(warning)) continue;
      seen.add(warning);
      warn(warning);
    }
  } catch (error) {
    failed = true;
    if (error instanceof PiPodError) {
      warn(`resolve: ${error.message}`);
      if (error.hint) hint(error.hint);
    } else {
      warn(`resolve: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (!failed) info("account checks passed");
  return failed ? EXIT.FAILURE : EXIT.OK;
}

/**
 * Name the seed root and the clone-or-archive decision a launch from here would make. Doctor
 * plans as a dry run, so this probes git locally and anonymously but never reads or forwards
 * credentials — a private remote is reported as "would clone if credentials work".
 */
function reportWorkspaceSeed(seed: AccountLaunchPlanSeed): void {
  if (!seed) return;
  switch (seed.kind) {
    case "none":
      info(`workspace seed: none (${seed.reason})`);
      return;
    case "copy":
      info(`workspace seed: project ${seed.root} is copied into a fresh pod (${seed.reason})`);
      return;
    case "clone":
    case "archive":
      info(`workspace seed root: ${seed.root}${seed.subdir ? ` (launching from ${seed.subdir}/)` : ""}`);
      info(`workspace seed: ${describeWorkspaceSeed(seed)}`);
      if (seed.kind === "clone" && seed.access === "credential") {
        hint(`the remote is private: a launch reads git credentials for ${seed.host} and asks before forwarding them; declining sends an archive`);
      }
  }
}

type AccountLaunchPlanSeed = Awaited<ReturnType<typeof planAccountLaunch>>["workspaceSeed"];

/** When an applicable env file holds `op://` refs, confirm `op` (and tokenCommand) work. */
async function checkSecretRefs(flags: AccountDoctorFlags, cwd: string): Promise<boolean> {
  const files: string[] = [];
  const dir = userSecretsDir(flags.home);
  if (dir && fs.existsSync(dir)) {
    for (const entry of fs.readdirSync(dir)) {
      if (entry.endsWith(".env")) files.push(path.join(dir, entry));
    }
  }
  const configPath = findConfigPath(cwd, { home: flags.home });
  if (configPath) {
    const projectRoot =
      path.basename(path.dirname(configPath)) === CONFIG_DIR
        ? path.dirname(path.dirname(configPath))
        : cwd;
    files.push(path.join(projectRoot, CONFIG_DIR, "env"));
  }
  const values: Record<string, string> = {};
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    Object.assign(values, parseDotenv(fs.readFileSync(file, "utf8")).values);
  }
  if (!hasSecretRefs(values)) return false;

  const layers = readSecretResolverLayers({ cwd, home: flags.home });
  try {
    await checkSecretResolver(mergeSecretResolver(layers.machine, layers.project), { home: flags.home });
    info("secret refs: 1Password CLI available");
    return false;
  } catch (error) {
    warn(`secret refs: ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof PiPodError && error.hint) hint(error.hint);
    return true;
  }
}
