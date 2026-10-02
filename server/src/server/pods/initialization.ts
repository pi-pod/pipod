import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { PiPodConfig } from "../../core/config.js";
import { bakeDigest } from "../../core/image.js";
import { InitScriptFailure, runInitScript } from "../../core/initscript.js";
import type { Sandbox } from "../../core/providers/types.js";
import { query } from "../db/index.js";
import type { InitScope, ResolvedConfigReport } from "./types.js";

export function isEffectivelyEmptyInitScript(script: string): boolean {
  const stripped = script
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .join("\n");
  return stripped.length === 0;
}

/** Only side-effect-light commands are safe to combine without obscuring failure attribution. */
export function isBatchableInitScript(script: string): boolean {
  const commands = script
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  return (
    commands.length > 0 &&
    commands.every((line) => /^(?::|true|echo|printf)(?:\s|$)/.test(line))
  );
}

/** The per-step init runner shared by fresh provisioning and pod reuse. */
export async function runPodInitSteps(args: {
  podId: string;
  sandbox: Sandbox;
  initSteps: Array<{ scope: InitScope; script: string }>;
  /** Composed bake script to run live before the init steps; null when baked in or absent. */
  bakeScript?: string | null;
  config: PiPodConfig;
  report: ResolvedConfigReport;
  execEnv: Record<string, string>;
  /** The sandbox's own environment (secrets, the pod token): redacted from script output. */
  sandboxEnv?: Record<string, string>;
  egressRestricted: boolean;
  timings: Record<string, number>;
}): Promise<void> {
  const { report, config } = args;
  if (args.bakeScript) {
    // Deliberately not execEnv and not the workdir: an image build has no secrets and no
    // workspace, so the live run gets neither either — a bake script that depends on them
    // must fail here too, not only once the baked image exists. runInitScript itself adds
    // the CI/DEBIAN_FRONTEND vars the Dockerfile bake step sets.
    const bakeStartedAt = Date.now();
    report.bake ??= { digest: bakeDigest(args.bakeScript), mode: "live", status: "pending" };
    report.bake.status = "running";
    delete report.bake.outputTail;
    await persistReport(args.podId, report);
    const bakePath = writeTempInitScript(args.bakeScript);
    try {
      const bake = await runInitScript({
        sandbox: args.sandbox,
        hostPath: bakePath,
        workdir: "/root",
        timeoutSeconds: config.initTimeoutSeconds,
        onFailure: config.initOnFailure === "continue" ? "continue" : "abort",
        env: {},
        inherited: args.sandboxEnv,
        egressRestricted: args.egressRestricted,
      });
      const failed = bake.ran && bake.exitCode !== 0;
      report.bake.status = failed ? `failed (exit ${bake.exitCode})` : "ok";
      if (failed && bake.outputTail) report.bake.outputTail = bake.outputTail;
      else delete report.bake.outputTail;
      if (failed) {
        report.warnings.push(
          `bake script exited with code ${bake.exitCode}; continuing (initOnFailure)`,
        );
      }
      await persistReport(args.podId, report);
    } catch (e) {
      report.bake.status = "failed";
      if (e instanceof InitScriptFailure && e.outputTail) report.bake.outputTail = e.outputTail;
      await persistReport(args.podId, report);
      throw new Error(`bake script failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      fs.rmSync(path.dirname(bakePath), { recursive: true, force: true });
      args.timings["bake"] = Date.now() - bakeStartedAt;
    }
  }
  const initStartedAt = Date.now();
  for (let i = 0; i < args.initSteps.length; i += 1) {
    const step = args.initSteps[i]!;
    const label =
      step.scope === "template" || step.scope === "project"
        ? `${step.scope} init script`
        : `${step.scope} default init script`;
    if (isEffectivelyEmptyInitScript(step.script)) {
      report.initSteps![i] = { scope: step.scope, status: "skipped" };
      continue;
    }
    if (isBatchableInitScript(step.script) && isBatchableInitScript(args.initSteps[i + 1]?.script ?? "")) {
      const batch = [step];
      while (isBatchableInitScript(args.initSteps[i + batch.length]?.script ?? "")) {
        batch.push(args.initSteps[i + batch.length]!);
      }
      const batchPath = writeTempInitScript(
        batch
          .map(
            (entry) =>
              `{\n${entry.script}\n}\ncode=$?\nif [ "$code" -ne 0 ]; then exit "$code"; fi`,
          )
          .join("\n"),
      );
      for (const [offset, entry] of batch.entries()) {
        report.initSteps![i + offset] = { scope: entry.scope, status: "running" };
      }
      await persistReport(args.podId, report);
      try {
        const init = await runInitScript({
          sandbox: args.sandbox,
          hostPath: batchPath,
          workdir: report.workdir,
          timeoutSeconds: config.initTimeoutSeconds,
          onFailure: config.initOnFailure === "continue" ? "continue" : "abort",
          env: args.execEnv,
          inherited: args.sandboxEnv,
        egressRestricted: args.egressRestricted,
        });
        const failed = init.ran && init.exitCode !== 0;
        for (const [offset, entry] of batch.entries()) {
          report.initSteps![i + offset] = {
            scope: entry.scope,
            status: failed ? `failed (batched exit ${init.exitCode})` : "ok",
            ...(failed && init.outputTail ? { outputTail: init.outputTail } : {}),
          };
        }
        if (failed) {
          report.warnings.push(
            `${batch.length} batched init scripts exited with code ${init.exitCode}; continuing (initOnFailure)`,
          );
        }
        await persistReport(args.podId, report);
      } catch (e) {
        for (const [offset, entry] of batch.entries()) {
          report.initSteps![i + offset] = {
            scope: entry.scope,
            status: "failed",
            ...(e instanceof InitScriptFailure && e.outputTail ? { outputTail: e.outputTail } : {}),
          };
        }
        await persistReport(args.podId, report);
        throw new Error(`batched init scripts failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        fs.rmSync(path.dirname(batchPath), { recursive: true, force: true });
      }
      i += batch.length - 1;
      continue;
    }
    const hostPath = writeTempInitScript(step.script);
    report.initSteps![i] = { scope: step.scope, status: "running" };
    await persistReport(args.podId, report);
    try {
      const init = await runInitScript({
        sandbox: args.sandbox,
        hostPath,
        workdir: report.workdir,
        timeoutSeconds: config.initTimeoutSeconds,
        onFailure: config.initOnFailure === "continue" ? "continue" : "abort",
        env: args.execEnv,
        inherited: args.sandboxEnv,
        egressRestricted: args.egressRestricted,
      });
      const failed = init.ran && init.exitCode !== 0;
      report.initSteps![i] = {
        scope: step.scope,
        status: !init.ran ? "skipped" : failed ? `failed (exit ${init.exitCode})` : "ok",
        ...(failed && init.outputTail ? { outputTail: init.outputTail } : {}),
      };
      if (failed) {
        report.warnings.push(`${label} exited with code ${init.exitCode}; continuing (initOnFailure)`);
      }
      // Merge Running->Done persists for consecutive steps to save DB round trips.
      const nextIsPending =
        i + 1 < args.initSteps.length && !isEffectivelyEmptyInitScript(args.initSteps[i + 1]!.script);
      if (!nextIsPending) await persistReport(args.podId, report);
    } catch (e) {
      report.initSteps![i] = {
        scope: step.scope,
        status: "failed",
        ...(e instanceof InitScriptFailure && e.outputTail ? { outputTail: e.outputTail } : {}),
      };
      await persistReport(args.podId, report);
      throw new Error(`${label} failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      fs.rmSync(path.dirname(hostPath), { recursive: true, force: true });
    }
  }
  // Persist once if all remaining steps were skipped or batched.
  await persistReport(args.podId, report).catch(() => {});
  if (args.initSteps.length > 0) args.timings["init"] = Date.now() - initStartedAt;
}
export async function persistReport(podId: string, report: ResolvedConfigReport): Promise<void> {
  await query("UPDATE pods SET resolved_config = $2, updated_at = now() WHERE id = $1", [
    podId,
    JSON.stringify(report),
  ]).catch(() => {});
}


/** runInitScript reads from the host filesystem; templates store text, so bridge via tmp. */
function writeTempInitScript(script: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pod-init-"));
  const hostPath = path.join(dir, "init.sh");
  fs.writeFileSync(hostPath, script, { mode: 0o700 });
  return hostPath;
}
