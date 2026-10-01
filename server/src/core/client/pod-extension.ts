/** Upload and argv wiring for the one launcher-generated extension each Pi process loads. */
import { DEFAULT_CONFIG, type SessionNaming } from "../config.js";
import { launcherVersion } from "../image.js";
import { POD_DOCS_DIR, uploadPodDocs } from "../poddocs.js";
import type { Sandbox } from "../providers/types.js";
import { POD_EXT_PATH, buildPiPodExtension } from "../shim/pi-pod-ext.js";

export interface UploadPodExtensionOptions {
  mode: "rpc" | "tui";
  sessionNaming?: SessionNaming;
  localEcho?: boolean;
}

/**
 * Upload the generated extension and its version-matched documentation. The extension varies by
 * mode, but its delivery boundary does not: every fresh Pi process receives this path once.
 */
export async function uploadPodExtension(
  sandbox: Sandbox,
  opts: UploadPodExtensionOptions,
  destPath: string = POD_EXT_PATH,
): Promise<void> {
  const docFiles = await uploadPodDocs(sandbox);
  await sandbox.uploadFile(
    destPath,
    new TextEncoder().encode(
      buildPiPodExtension({
        mode: opts.mode,
        sessionNaming: opts.sessionNaming ?? DEFAULT_CONFIG.pi.sessionNaming,
        ...(opts.mode === "tui" && opts.localEcho === true ? { localEcho: true } : {}),
        ...(docFiles.length > 0
          ? { docs: { dir: POD_DOCS_DIR, files: docFiles, version: launcherVersion() } }
          : {}),
      }),
    ),
  );
}

/** Add the generated extension exactly once, preserving all caller-supplied Pi arguments. */
export function withPodExtension(piArgv: string[], extPath: string = POD_EXT_PATH): string[] {
  if (piArgv.includes(extPath)) return [...piArgv];
  const [command, ...rest] = piArgv;
  return [command!, "-e", extPath, ...rest];
}
