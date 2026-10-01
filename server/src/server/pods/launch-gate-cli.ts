import { query } from "../db/index.js";
import { LAUNCH_RECOVERY_PROTOCOL_VERSION, readLaunchControl, transitionLaunchControl } from "./launch-control.js";

function arg(rest: string[], name: string): string | null {
  const index = rest.indexOf(`--${name}`);
  if (index < 0) return null;
  const value = rest[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

function requireValue(value: string | null, name: string): string {
  if (!value) throw new Error(`launch-gate requires --${name}`);
  return value;
}

/** Operator-only global cutover gate. No host API calls are made by this command. */
export async function runLaunchGateCommand(rest: string[], extraStatus?: () => Promise<string[]>): Promise<void> {
  const [action] = rest;
  if (action === "status") {
    const [control, phases, extra, unaccounted] = await Promise.all([
      readLaunchControl(),
      query<{ phase: string; count: string }>(
        `SELECT phase, count(*)::text AS count FROM pod_create_attempts GROUP BY phase ORDER BY phase`,
      ),
      extraStatus?.() ?? Promise.resolve([]),
      query<{ count: string }>(
        `SELECT count(*)::text AS count FROM pods AS p
          WHERE p.state='active' AND p.provider IN ('sandbox','host') AND p.provider_sandbox_id IS NULL
            AND p.provider_state IN ('preparing_image','provisioning','starting','error','gone')
            AND NOT EXISTS (SELECT 1 FROM pod_create_attempts AS a WHERE a.pod_id=p.id
              AND a.phase IN ('prepared','dispatching','unknown','sandbox_known',
                'initialization_interrupted','legacy_unresolved','delete_pending'))`,
      ),
    ]);
    console.log(`mode=${control.mode} epoch=${control.epoch} requiredProtocol=${control.required_protocol}`);
    console.log(`cutover=${control.cutover_id} changedAt=${control.changed_at} actor=${control.actor} reason=${control.reason_code}`);
    console.log([...extra, `unaccountedLegacyLaunchRows=${unaccounted.rows[0]?.count ?? "0"}`].join(" "));
    for (const row of phases.rows) console.log(`attempts.${row.phase}=${row.count}`);
    return;
  }
  if (action !== "open" && action !== "hold") {
    throw new Error("usage: fleet launch-gate status | open|hold [--expect-epoch N] --actor ID --reason CODE");
  }
  const observed = arg(rest, "expect-epoch") === null ? await readLaunchControl() : null;
  const expectedEpoch = Number(arg(rest, "expect-epoch") ?? observed?.epoch);
  if (!Number.isSafeInteger(expectedEpoch) || expectedEpoch < 1) {
    throw new Error("launch-gate --expect-epoch must be a positive integer");
  }
  const actor = requireValue(arg(rest, "actor") ?? process.env["PIPOD_GATE_ACTOR"] ?? null, "actor");
  const reasonCode = requireValue(arg(rest, "reason") ?? null, "reason");
  const sourceSha = action === "open"
    ? requireValue(arg(rest, "source-sha") ?? process.env["PIPOD_GATE_SOURCE_SHA"] ?? null, "source-sha")
    : (arg(rest, "source-sha") ?? process.env["PIPOD_GATE_SOURCE_SHA"] ?? null);
  if (action === "open" && !/^[0-9a-f]{40}$/.test(sourceSha ?? "")) {
    throw new Error("launch-gate open requires a verified 40-character source SHA");
  }
  const state = await transitionLaunchControl({
    mode: action === "hold" ? "held" : "open",
    expectedEpoch,
    protocolVersion: LAUNCH_RECOVERY_PROTOCOL_VERSION,
    sourceSha,
    actor,
    reasonCode,
  });
  console.log(`mode=${state.mode} epoch=${state.epoch} changedAt=${state.changed_at}`);
}
