import type { PiPodConfig } from "../config.js";
import type { AccountClient, ResolveReport } from "./api.js";
import type { SeedCredential, WorkspaceSeedPlan } from "./workspace-seed.js";

export interface AccountLaunchPlan {
  /** Local display/workspace identity only; it never travels in the launch body. */
  projectName?: string;
  templateId?: string;
  templateScope?: "user" | "org";
  /** True only when resolve included projectConfig for the one-time bootstrap preview. */
  bootstrapPreview: boolean;
  /** Server-resolved pod config plus machine-only client preferences. */
  config: PiPodConfig;
  projectRoot: string | null;
  warnings: string[];
  resolve: ResolveReport;
  /** How a source-less launch receives a workspace after provisioning. */
  workspaceSeed?: WorkspaceSeedPlan;
  /**
   * The verified git credential a credentialed clone forwards, kept beside the plan rather
   * than inside it so nothing that prints or serializes the plan can leak it. Absent on
   * dry runs, which never read credentials.
   */
  workspaceSeedCredential?: SeedCredential;
  /** The host directory this launch seeds from, or null when nothing is seeded. */
  seedRoot?: string | null;
}

export interface AccountLaunchFlags {
  yes: boolean;
  on?: string | undefined;
  reuse?: boolean;
  dryRun?: boolean;
  home?: string | undefined;
  template?: string | undefined;
  forkFrom?: { podId: string; sessionPath?: string };
  /** `--no-seed`: leave a fresh pod's workspace empty instead of seeding it from the launch directory. */
  seed?: boolean;
}

export interface RunAccountLaunchOptions {
  client: AccountClient;
  flags: AccountLaunchFlags;
  piArgs: string[];
  home?: string | undefined;
  cwd?: string;
}
