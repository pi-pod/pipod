import { TURN_MARKER_PATH } from "./agentd.js";

export const WORK_MARKER_COMPACTION_FAILSAFE_MS = 2 * 60 * 1000;

/**
 * Module-scope source composed into the generated extension for raw remote-TUI Pi, which does
 * not run behind the RPC agentd. `agent_end` deliberately does not clear: retry or automatic
 * compaction may follow.
 */
export function buildWorkMarkerSource(
  compactionFailsafeMs: number = WORK_MARKER_COMPACTION_FAILSAFE_MS,
  markerPath: string = TURN_MARKER_PATH,
): string {
  return `import * as piPodMarkerFs from "node:fs";
const PI_POD_TURN_MARKER = ${JSON.stringify(markerPath)};
const PI_POD_COMPACTION_FAILSAFE_MS = ${compactionFailsafeMs};

function installPiPodWorkMarker(pi) {
  let agentActive = false;
  let compactionActive = false;
  let backgroundAgents = 0;
  let compactionTimer = null;

  const sync = () => {
    if (agentActive || compactionActive || backgroundAgents > 0) {
      try { piPodMarkerFs.writeFileSync(PI_POD_TURN_MARKER, String(process.pid)); } catch {}
    } else {
      clear();
    }
  };
  const clear = () => {
    try {
      if (piPodMarkerFs.readFileSync(PI_POD_TURN_MARKER, "utf8").trim() === String(process.pid)) {
        piPodMarkerFs.unlinkSync(PI_POD_TURN_MARKER);
      }
    } catch {}
  };
  const endCompaction = () => {
    compactionActive = false;
    if (compactionTimer) clearTimeout(compactionTimer);
    compactionTimer = null;
    sync();
  };
  const beginCompaction = (event) => {
    compactionActive = true;
    if (compactionTimer) clearTimeout(compactionTimer);
    compactionTimer = setTimeout(endCompaction, PI_POD_COMPACTION_FAILSAFE_MS);
    compactionTimer.unref?.();
    event.signal?.addEventListener?.("abort", endCompaction, { once: true });
    sync();
  };

  pi.on("agent_start", () => { agentActive = true; sync(); });
  pi.on("agent_settled", () => { agentActive = false; endCompaction(); });
  pi.on("session_before_compact", beginCompaction);
  pi.on("session_compact", endCompaction);
  pi.on("session_shutdown", () => {
    agentActive = false;
    backgroundAgents = 0;
    endCompaction();
    clear();
  });
  const onBgStart = () => { backgroundAgents += 1; sync(); };
  const onBgEnd = () => { backgroundAgents = Math.max(0, backgroundAgents - 1); sync(); };
  pi.events?.on?.("subagents:started", onBgStart);
  pi.events?.on?.("subagents:completed", onBgEnd);
  pi.events?.on?.("subagents:failed", onBgEnd);
  process.once("exit", clear);
}
`;
}

/** Standalone form retained for focused executable tests. Production composes the source above. */
export function buildWorkMarkerExtension(
  compactionFailsafeMs: number = WORK_MARKER_COMPACTION_FAILSAFE_MS,
  markerPath: string = TURN_MARKER_PATH,
): string {
  return `// pi-pod work marker — generated; keeps silent remote-TUI work alive
${buildWorkMarkerSource(compactionFailsafeMs, markerPath)}
export default function piPodWorkMarker(pi) {
  installPiPodWorkMarker(pi);
}
`;
}
