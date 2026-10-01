/**
 * src/account/launch.ts — the account-mode launch path (account-mode-spec §5).
 *
 * The server resolves built-in/org/template/user/policy bundles. Local project files are
 * push sources; only a template id and invocation flags travel when a pod is launched.
 */

export type {
  AccountLaunchFlags,
  AccountLaunchPlan,
  RunAccountLaunchOptions,
} from "./launch-types.js";
export {
  currentProjectName,
  currentProjectTemplateRef,
  machineClientConfig,
  localConfigView,
  readHostConfig,
  readSecretResolverLayers,
  resolveLaunchTemplateRef,
  takeClientOnlyKeys,
} from "./launch-overlays.js";
export {
  planAccountLaunch,
  resolveTemplate,
  resolveTemplateId,
} from "./launch-preflight.js";
export {
  LAUNCH_BLIP_GRACE_MS,
  PROVISION_BLIP_GRACE_MS,
  READINESS_LONG_POLL_MS,
  launchRidingOutBlips,
  podReadySummary,
  printLaunchReport,
  watchProvisioning,
} from "./launch-provision.js";
export { parseAccountLaunchPiArgs, splitPiArgs } from "./launch-args.js";
export { formatSettingsChain, runAccountLaunch } from "./launch-handoff.js";
