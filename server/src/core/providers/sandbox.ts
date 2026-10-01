/**
 * src/core/providers/sandbox.ts — the self-hosted sandbox service adapter entry point.
 * The wire client stays under `sandbox/` so core only sees the provider contract (D4).
 */
export {
  DEFAULT_ARCHIVE_MAX_DELAY_DAYS,
  DEFAULT_SANDBOX_IMAGE_MIRROR,
  SANDBOX_CAPABILITIES,
  SandboxServiceAdapter,
  SandboxServiceProvider,
  buildSandboxKeepaliveScript,
  createSandboxProvider,
  deriveSandboxActivityToken,
  resolveSandboxImageMirror,
  resolveSandboxServiceUrl,
  sandboxMirrorRef,
} from "./sandbox/index.js";
export { SandboxApiError, SandboxClient, SandboxWsError } from "./sandbox/client.js";
