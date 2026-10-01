import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { FrameChannel, RemoteRpcClient } from "../../core/client/rpc.js";
import type { Sandbox } from "../../core/providers/types.js";
import type { PodRow } from "../pods/service.js";
import type { SessionActivityLease } from "./activity.js";
import type { PiStartupCrash } from "./session-state.js";
import type { WsSink } from "./stream-fanout.js";

export interface ActiveSession {
  sessionId: string;
  pod: PodRow;
  sandbox: Sandbox;
  /** Active outbound-WS pod carrier. */
  channel: FrameChannel;
  rpc: RemoteRpcClient;
  /** Suppresses the lifecycle invalidation emitted synchronously by an intentional WS rebind. */
  transportRebinding: boolean;
  seq: number;
  clients: Set<WsSink>;
  /** Latest render and outstanding long-poll request per remote extension surface. */
  remoteUiSurfaces: Map<string, { frame?: AgentSessionEvent; input?: AgentSessionEvent }>;
  /** Latest value for each loader-level control, kept outside the bounded surface cache. */
  remoteUiControls: Map<string, AgentSessionEvent>;
  /** A remote component is interactive from one websocket at a time. */
  remoteUiOwners: Map<string, WsSink>;
  /** Newest in-flight assistant message snapshot; superseded by the durable message_end. */
  streamingUpdate: AgentSessionEvent | null;
  /** Newest in-flight output per tool call; superseded by the durable tool_execution_end. */
  toolExecutionUpdates: Map<string, AgentSessionEvent>;
  persistQueue: Promise<void>;
  /** Serializes model/thinking mutations and catalog reads before they reach a client. */
  modelCatalogQueue: Promise<void>;
  /** Serializes mutable pod-name mirrors in the same order pi emitted them. */
  nameMirrorQueue: Promise<void>;
  activity: SessionActivityLease;
  /** Exact scheduled run whose prompt is currently executing in this fresh session. */
  scheduledRunId: string | null;
  /** When this session's pi was spawned (or its PTY readopted) — the startup-crash clock. */
  startedAt: number;
  /** False when the PTY was readopted: its pi predates this session, so its death is not a startup crash. */
  freshSpawn: boolean;
  /** Filled at end-of-session when pi died at startup; read by in-flight client attaches. */
  startupCrash: PiStartupCrash | null;
  closed: boolean;
  /** Set when the durable INSERT fails twice; later persists reject without consuming a seq. */
  persistFailed: boolean;
  /** How many pi_stderr frames were stored this session, and how many were dropped after the cap. */
  stderrPersisted: number;
  stderrDropped: number;
  /** Highest shim journal seq this gateway has decoded (live events + accounted gaps). */
  lastDecodedShimSeq: number;
  /** Coalesced get_state probe; cleared on failure so a replacement session can start one. */
  readyProbe: Promise<unknown> | null;
  /** Last session file mirrored to the pod row; dedupes the durable write, not a cache of truth. */
  piSessionFile: string | null;
  /** Accumulated bash stdout per request id for a client that attaches mid-command. */
  bashSnapshots: Map<string, string>;
  /** In-flight auxiliary completions by caller id; aborted on cancel/detach/session end. */
  auxInFlight: Map<string, { controller: AbortController; sink: WsSink; wireId: string }>;
}
