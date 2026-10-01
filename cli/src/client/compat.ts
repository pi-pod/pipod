import { PiPodError } from "../errors.js";
import { warn } from "../log.js";
import { PREVIOUS_SHIM_VERSION, SHIM_LOG_PATH, SHIM_VERSION } from "../shim/agentd.js";
import { POD_EXTENSION_VERSION } from "../shim/pi-pod-ext.js";
import { bundledPiVersion, comparePiVersions, describeVersionSkew } from "./piversion.js";
import { FRAME_PROTO_VERSION, type ShimHello } from "./protocol.js";

/** Oldest generated extension this launcher can attach to. */
export const MIN_EXTENSION_VERSION = 4;

export const RECOVERY_FLAP_LIMIT = 3;
export const RECOVERY_FLAP_WINDOW_MS = 60_000;

export function shimCompatibilityWarning(shimVersion: string): string | null {
  if (shimVersion !== PREVIOUS_SHIM_VERSION) return null;
  return (
    `the pod runs previous shim ${shimVersion}; this pi pod uses shim ${SHIM_VERSION} — ` +
    "continuing in compatibility mode, but newer shim features are unavailable until Pi restarts"
  );
}

export function extensionCompatibilityWarning(extensionVersion: number | undefined): string | null {
  if (extensionVersion === undefined || extensionVersion < MIN_EXTENSION_VERSION) return null;
  if (extensionVersion === POD_EXTENSION_VERSION) return null;
  return (
    `the pod runs extension ${extensionVersion}; this pi pod uses extension ${POD_EXTENSION_VERSION} — ` +
    "continuing, but launcher and extension behavior may differ until Pi restarts"
  );
}

/** Validate every handshake field except Pi's version, which readiness may repair. */
export function verifyHelloEnvelope(hello: ShimHello, session: { close(): void }): void {
  if (hello.proto !== FRAME_PROTO_VERSION) {
    session.close();
    throw new PiPodError(
      `the pod shim speaks frame protocol ${hello.proto}; this pi pod speaks ${FRAME_PROTO_VERSION}`,
      { hint: "exit the existing Pi session or wait for automatic idle retention, then attach again" },
    );
  }
  if (hello.shimVersion !== SHIM_VERSION && hello.shimVersion !== PREVIOUS_SHIM_VERSION) {
    session.close();
    throw new PiPodError(
      `pod shim version skew: pod has ${hello.shimVersion}; this pi pod supports ${PREVIOUS_SHIM_VERSION} or ${SHIM_VERSION}`,
      { hint: "exit the existing Pi session or wait for automatic idle retention, then attach again" },
    );
  }
  if (!hello.piRunning) {
    session.close();
    throw new PiPodError("the pod shim could not start pi", { hint: `check the shim log in the pod: ${SHIM_LOG_PATH}` });
  }

  if (hello.extensionVersion === undefined || hello.extensionVersion < MIN_EXTENSION_VERSION) {
    session.close();
    const podVersion =
      hello.extensionVersion === undefined ? "an unversioned extension" : `extension ${hello.extensionVersion}`;
    throw new PiPodError(`the pod runs ${podVersion}; this pi pod requires extension ${MIN_EXTENSION_VERSION} or newer`, {
      hint: "exit the existing Pi session or wait for automatic idle retention, then attach again",
    });
  }
  const extensionWarning = extensionCompatibilityWarning(hello.extensionVersion);
  if (extensionWarning) warn(extensionWarning);
  const compatibilityWarning = shimCompatibilityWarning(hello.shimVersion);
  if (compatibilityWarning) warn(compatibilityWarning);
}

/** Runtime boundary: only the launcher's exact installed Pi may reach InteractiveMode/RPC prompts. */
export function verifyHello(hello: ShimHello, session: { close(): void }): void {
  verifyHelloEnvelope(hello, session);
  const bundled = bundledPiVersion();
  if (hello.piVersion === bundled) return;

  session.close();
  const comparison = comparePiVersions(hello.piVersion, bundled);
  const base = describeVersionSkew(hello.piVersion, bundled);
  if (comparison !== null && comparison > 0) {
    throw new PiPodError("pi version skew: the pod runs a newer pi than this launcher", {
      hint: `${base} — run \`pipod update\`, then attach again; pi pod will not downgrade the pod`,
    });
  }
  throw new PiPodError("pi version skew between this launcher and the pod", {
    hint:
      comparison === null
        ? `${base} — the reported version is unknown or malformed, so the session is refused`
        : `${base} — the session is refused until the pod is updated automatically`,
  });
}
