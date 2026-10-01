export const BUSY_ACTIVITY_REFRESH_MS = 20_000;
export const WORK_LEASE_SECONDS = 90;

export type WorkLeaseMode = "preserve" | "extend" | "clear";

/** The pod-side carrier is explicit so a future WebSocket channel cannot silently diverge. */
export type PodTrafficCarrier = "provider_pty" | "provider_websocket";

/**
 * Machine traffic is evidence that a channel is alive, not that a detached pod is in use.
 * Carrier-independent policy keeps bootstrap/replay chatter from moving either idle clock.
 */
export function shouldRenewTrafficActivity(args: {
  carrier: PodTrafficCarrier;
  clientCount: number;
  workActive: boolean;
}): boolean {
  return args.clientCount > 0 || args.workActive;
}

/** Detached idle sessions are re-probed on attach; periodic probes would prevent provider idle-stop. */
export function sessionNeedsChannelProbe(clientCount: number, workActive: boolean): boolean {
  return shouldRenewTrafficActivity({ carrier: "provider_pty", clientCount, workActive });
}

export interface WorkState {
  agentActive: boolean;
  compactionActive: boolean;
  /**
   * In-process / shim-visible background agents. B0: `get_state` has no running-agent
   * count, and pi-subagents only emits `pi.events` (`subagents:started|completed|failed`)
   * — extension-local. The shim reports this via a `background_work` control frame.
   */
  backgroundAgents: number;

}

export function emptyWorkState(): WorkState {
  return { agentActive: false, compactionActive: false, backgroundAgents: 0 };

}

export function workStateFromSnapshot(snapshot: unknown): WorkState {
  if (typeof snapshot !== "object" || snapshot === null) return emptyWorkState();
  const state = snapshot as { isStreaming?: unknown; isCompacting?: unknown; backgroundAgents?: unknown };
  const backgroundAgents =
    typeof state.backgroundAgents === "number" && state.backgroundAgents > 0
      ? Math.floor(state.backgroundAgents)
      : 0;
  return {
    agentActive: state.isStreaming === true,
    compactionActive: state.isCompacting === true,
    backgroundAgents,
  };

}

/** Apply Pi's semantic work boundaries. `agent_end` deliberately is not a settle boundary. */
export function applyWorkEvent(state: WorkState, kind: string): boolean {
  switch (kind) {
    case "agent_start":
      state.agentActive = true;
      return true;
    case "agent_settled":
      state.agentActive = false;
      return true;
    case "compaction_start":
      state.compactionActive = true;
      return true;
    case "compaction_end":
      state.compactionActive = false;
      return true;
    case "subagents:started":
    case "background_work_start":
      state.backgroundAgents += 1;
      return true;
    case "subagents:completed":
    case "subagents:failed":
    case "background_work_end":
      state.backgroundAgents = Math.max(0, state.backgroundAgents - 1);
      return true;
    default:
      return false;
  }

}

export function isWorkActive(state: WorkState): boolean {
  return state.agentActive || state.compactionActive || state.backgroundAgents > 0;

}

/**
 * Serial activity-renewal queue for one gateway-held Pi session.
 *
 * Traffic is throttled, semantic transitions are immediate, and a busy session receives a
 * sustained provider + database lease. Work state is read when each queued renewal executes so
 * a settle event that races a slow refresh always gets a trailing lease-clear operation.
 */
export class SessionActivityLease {
  readonly state = emptyWorkState();
  private tail: Promise<void> = Promise.resolve();
  private lastQueuedAt = 0;
  private eventRevision = 0;
  private explicitWork = 0;
  private stopped = false;

  constructor(
    private readonly refresh: (mode: WorkLeaseMode) => Promise<void>,
    private readonly now: () => number = Date.now,
    private readonly refreshIntervalMs = BUSY_ACTIVITY_REFRESH_MS,
  ) {}

  noteTraffic(): Promise<void> {
    if (this.stopped) return this.tail;
    const now = this.now();
    if (now - this.lastQueuedAt < this.refreshIntervalMs) return this.tail;
    this.lastQueuedAt = now;
    return this.enqueue("preserve");
  }

  /** Protect prompt dispatch before the corresponding agent_start event reaches the gateway. */
  grantDispatchLease(): Promise<void> {
    if (this.stopped) return this.tail;
    this.lastQueuedAt = this.now();
    return this.enqueue("extend");
  }

  applyEvent(kind: string): Promise<void> {
    if (this.stopped || !applyWorkEvent(this.state, kind)) return this.tail;
    this.eventRevision += 1;
    this.lastQueuedAt = this.now();
    return this.enqueue(this.busy() ? "extend" : "clear");
  }

  /** Shim-visible background work: an absolute count, not an event increment. */
  setBackgroundAgents(count: number): Promise<void> {
    if (this.stopped) return this.tail;
    const next = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
    if (this.state.backgroundAgents === next) return this.tail;
    this.state.backgroundAgents = next;
    this.eventRevision += 1;
    this.lastQueuedAt = this.now();
    return this.enqueue(this.busy() ? "extend" : "clear");
  }

  snapshotRevision(): number {
    return this.eventRevision;
  }

  seed(snapshot: unknown, expectedRevision: number = this.eventRevision): Promise<void> {
    // Event frames may follow the get_state response in the same transport chunk. Never let
    // that older snapshot overwrite a semantic transition already observed by the listener.
    if (this.stopped || expectedRevision !== this.eventRevision) return this.tail;
    const seeded = workStateFromSnapshot(snapshot);
    this.state.agentActive = seeded.agentActive;
    this.state.compactionActive = seeded.compactionActive;
    this.state.backgroundAgents = seeded.backgroundAgents;
    if (!this.busy()) return this.tail;
    this.lastQueuedAt = this.now();
    return this.enqueue("extend");
  }

  /** Sustain commands such as explicit compaction/bash until their RPC response completes. */
  async beginExplicitWork(): Promise<() => Promise<void>> {
    if (this.stopped) return async () => this.tail;
    this.explicitWork += 1;
    this.lastQueuedAt = this.now();
    try {
      await this.enqueue("extend");
    } catch (error) {
      this.explicitWork -= 1;
      void this.enqueue(this.busy() ? "extend" : "clear").catch(() => {});
      throw error;
    }
    let released = false;
    return () => {
      if (released) return this.tail;
      released = true;
      this.explicitWork = Math.max(0, this.explicitWork - 1);
      return this.enqueue(this.busy() ? "extend" : "clear");
    };
  }

  heartbeat(): Promise<void> {
    if (this.stopped || !this.busy()) return this.tail;
    this.lastQueuedAt = this.now();
    return this.enqueue("extend");
  }

  hasWork(): boolean {
    return this.busy();
  }

  /** Pi refuses new prompts during an agent turn or compaction, not background jobs. */
  blocksPrompt(): boolean {
    return this.state.agentActive || this.state.compactionActive;
  }

  stop(): void {
    this.stopped = true;
  }

  drain(): Promise<void> {
    return this.tail;
  }

  private busy(): boolean {
    return this.explicitWork > 0 || isWorkActive(this.state);
  }

  private enqueue(requestedMode: WorkLeaseMode): Promise<void> {
    const run = this.tail.then(() =>
      this.refresh(this.busy() ? "extend" : requestedMode),
    );
    // Keep the queue usable after a transient provider/database failure while returning the real
    // rejection to the caller that requested this particular renewal.
    this.tail = run.catch(() => undefined);
    return run;
  }
}
