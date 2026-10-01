import { PiPodError } from "../errors.js";
import { info, warn } from "../log.js";
import { isProviderCredentialVar } from "../providers/registry.js";
import { confirm } from "../prompt.js";
import type { AccountClient } from "../account/api.js";
import { compileBundleSource, diffBundle, type EnvSnapshot } from "../account/bundle-source.js";
import { syncEnvSecrets, writeTemplateSnapshot } from "./templates.js";
import {
  fetchRemoteLayer,
  localLabel,
  parseLayerArgs,
  printDiff,
  sourceKindOf,
  type LayerFlags,
} from "./layers.js";

export type PushFlags = LayerFlags;

/** `pipod push [layer]`: replace a server bundle with its local source, whole. */
export async function runPush(args: string[], flags: PushFlags): Promise<number> {
  const cwd = flags.cwd ?? process.cwd();
  const parsed = parseLayerArgs("push", args, { cwd, home: flags.home });
  const source = await compileBundleSource({ source: sourceKindOf(parsed.layer), cwd, home: flags.home, dir: parsed.dir });
  for (const warning of source.warnings) warn(warning);
  const remote = await fetchRemoteLayer(flags.client, parsed.layer, source);
  const local = localLabel(parsed.layer, { home: flags.home, dir: parsed.dir });
  const diff = diffBundle(source, remote.bundle, remote.secretNames);
  printDiff(`${local} → ${remote.label}`, diff.lines);
  const assumeYes = parsed.yes || flags.yes === true;
  if (!(await confirm("apply this bundle replacement?", { nonInteractiveDefault: false, assumeYes }))) return 1;

  if (remote.scope === "template") {
    const template = remote.template!;
    const updated = await writeTemplateSnapshot(() => flags.client.updateTemplate(template.id, {
      // The diff above was computed against this version; refuse to clobber a newer one.
      ...(template.version !== undefined ? { expectedVersion: template.version } : {}),
      config: source.config,
      initScript: source.initScript,
      bakeScript: source.bakeScript,
      piSettings: source.piFiles,
    }));
    info(`pushed ${local} to template ${updated.name}`);
    await syncEnvSecrets(flags.client, updated, source.env, { withSecrets: parsed.withSecrets, reportStale: true });
    return 0;
  }

  if (remote.version === undefined) throw new PiPodError(`${remote.label} has no version to compare-and-swap against`);
  const body = {
    config: source.config,
    version: remote.version,
    initScript: source.initScript,
    bakeScript: source.bakeScript,
    piFiles: source.piFiles,
  };
  const written = remote.scope === "user"
    ? await flags.client.putUserSettings(body)
    : await flags.client.putOrgSettings(body);
  info(`pushed ${local} to ${remote.scope} settings v${written.version}`);
  await syncSettingsSecrets(flags.client, remote.scope, remote.scopeId, source.env, {
    withSecrets: parsed.withSecrets,
    reportStale: true,
  });
  return 0;
}

async function syncSettingsSecrets(
  client: AccountClient,
  scope: "user" | "org",
  scopeId: string,
  env: EnvSnapshot,
  opts: { withSecrets: boolean; reportStale: boolean },
): Promise<void> {
  const names = Object.keys(env).filter((name) => {
    if (!isProviderCredentialVar(name)) return true;
    warn(`${name} is a provider credential and never travels in a settings bundle`);
    return false;
  });
  if (names.length === 0) return;
  const consented = opts.withSecrets || await confirm(
    `upload ${names.length} env value(s) as ${scope} secrets (${names.join(", ")})?`,
    { nonInteractiveDefault: false },
  );
  if (!consented) {
    warn(`did not upload secret values: ${names.join(", ")}`);
    return;
  }
  for (const name of names) await client.putSecret(scope, scopeId, name, env[name]!.value);
  info(`uploaded ${names.length} ${scope} secret(s): ${names.join(", ")}`);
  if (opts.reportStale) {
    const listed = await client.listSecrets(scope, scopeId).catch(() => null);
    const stale = listed?.secrets.map((entry) => entry.name).filter((name) => !(name in env)) ?? [];
    if (stale.length > 0) warn(`${scope} secrets no longer in this source: ${stale.join(", ")}`);
  }
}
