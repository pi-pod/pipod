import * as fs from "node:fs";
import { info, warn } from "../log.js";
import { confirm } from "../prompt.js";
import {
  compileBundleSource,
  diffBundle,
  orgSourceDir,
  writeBundleSource,
  type CompiledBundleSource,
} from "../account/bundle-source.js";
import { displayPath } from "../userconfig.js";
import {
  fetchRemoteLayer,
  localLabel,
  parseLayerArgs,
  printDiff,
  sourceKindOf,
  type LayerFlags,
} from "./layers.js";

export type PullFlags = LayerFlags;

/** `pipod pull [layer]`: write the server bundle into the layer's local files. */
export async function runPull(args: string[], flags: PullFlags): Promise<number> {
  const cwd = flags.cwd ?? process.cwd();
  const parsed = parseLayerArgs("pull", args, { cwd, home: flags.home });
  const kind = sourceKindOf(parsed.layer);
  let source: CompiledBundleSource;
  let firstPull = false;
  if (kind === "org-dir" && !fs.existsSync(orgSourceDir({ dir: parsed.dir, home: flags.home }))) {
    // A first `pull org` has nothing local yet; diff against an empty source and create the dir.
    firstPull = true;
    source = {
      kind, config: {}, initScript: "", bakeScript: "", piFiles: {}, env: {}, warnings: [],
      name: "org settings", templateRef: null, projectRoot: null,
      root: orgSourceDir({ dir: parsed.dir, home: flags.home }), configPath: "",
    };
  } else {
    source = await compileBundleSource({ source: kind, cwd, home: flags.home, includeEnv: false, dir: parsed.dir });
  }
  for (const warning of source.warnings) warn(warning);
  const remote = await fetchRemoteLayer(flags.client, parsed.layer, source);
  const local = localLabel(parsed.layer, { home: flags.home, dir: parsed.dir });
  // The diff reads local → remote; pull applies the reverse, so swap the sides for the preview.
  const diff = diffBundle(
    { config: remote.bundle.config, initScript: remote.bundle.initScript, bakeScript: remote.bundle.bakeScript, piFiles: remote.bundle.piFiles, env: {} },
    source,
  );
  printDiff(`${remote.label} → ${local}`, diff.lines);
  if (remote.secretNames.length > 0) {
    info(`${remote.scope} secrets stay on the server (values are write-only): ${remote.secretNames.join(", ")}`);
  }
  if (!diff.changed && !firstPull) {
    info(`${local} is already up to date with ${remote.label}`);
    return 0;
  }
  const assumeYes = parsed.yes || flags.yes === true;
  if (!(await confirm("apply these local changes?", { nonInteractiveDefault: false, assumeYes }))) return 1;
  const result = writeBundleSource({ kind, bundle: remote.bundle, cwd, home: flags.home, dir: parsed.dir });
  for (const warning of result.warnings) warn(warning);
  const root = displayPath(result.root, flags.home);
  info(`pulled ${remote.label} into ${root}: ${result.written.length} written, ${result.removed.length} removed`);
  for (const file of result.written) info(`  wrote ${file}`);
  for (const file of result.removed) info(`  removed ${file}`);
  return 0;
}
