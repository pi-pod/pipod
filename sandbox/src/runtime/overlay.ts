import * as fs from "node:fs";
import type { Logger } from "../log.js";
import { run, runOk } from "./exec.js";

export interface OverlayLayout {
  merged: string;
  upper: string;
  work: string;
  /** Image layer dirs, lowest first — the order the mount option must reverse. */
  lowers: string[];
  /**
   * Keep the upper expressible as an OCI layer: no directory redirects, which have no OCI
   * form. Renaming a directory from the image then fails with EXDEV and tools copy it
   * instead, as across filesystems. Otherwise the kernel's default applies.
   */
  portableUpper?: boolean;
}

export function isMounted(target: string): boolean {
  const real = fs.realpathSync(target);
  return fs
    .readFileSync("/proc/self/mounts", "utf8")
    .split("\n")
    .some((line) => line.split(" ")[1] === real.replace(/ /g, "\\040"));
}

export async function mountOverlay(layout: OverlayLayout, log: Pick<Logger, "error">): Promise<void> {
  for (const dir of [layout.merged, layout.upper, layout.work]) fs.mkdirSync(dir, { recursive: true });
  if (isMounted(layout.merged)) return;
  if (layout.lowers.length === 0) throw new Error("overlay needs at least one lower layer");
  // overlayfs reads lowerdir top-down; image layers are stored bottom-up.
  const lowerdir = [...layout.lowers].reverse().join(":");
  const args = [
    "-t",
    "overlay",
    "overlay",
    "-o",
    `lowerdir=${lowerdir},upperdir=${layout.upper},workdir=${layout.work},index=off,metacopy=off` +
      (layout.portableUpper ? ",redirect_dir=off" : ""),
    layout.merged,
  ];

  let result;
  try {
    result = await run("mount", args);
  } catch (err) {
    // The command is useful to operators but hostile to API/CLI readers when an image has
    // hundreds of layers, so it belongs only in the structured service log.
    log.error({ err, command: { file: "mount", args }, target: layout.merged }, "overlay mount failed");
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `overlay mount failed for ${layout.merged} (${layout.lowers.length} layers): ${reason}`,
      { cause: err },
    );
  }
  if (result.code === 0) return;

  const reason = result.stderr.trim() || result.stdout.trim() || `mount exited ${result.code}`;
  log.error(
    {
      command: { file: "mount", args },
      target: layout.merged,
      layerCount: layout.lowers.length,
      exitCode: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
    },
    "overlay mount failed",
  );
  throw new Error(`overlay mount failed for ${layout.merged} (${layout.lowers.length} layers): ${reason}`);
}

export async function unmountOverlay(merged: string): Promise<void> {
  if (!fs.existsSync(merged) || !isMounted(merged)) return;
  const r = await run("umount", [merged]);
  if (r.code !== 0) await runOk("umount", ["-l", merged]);
}

/** Shadow custody requires an observed ordinary unmount, never a lazy detach. */
export async function unmountOverlayVerified(merged:string):Promise<void>{
  if(!fs.existsSync(merged))return;
  if(isMounted(merged))await runOk("umount",[merged]);
  if(isMounted(merged))throw new Error(`overlay mount remains at ${merged}`);
}
