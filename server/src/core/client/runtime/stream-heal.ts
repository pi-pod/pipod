/**
 * Mid-stream reattach self-heal for InteractiveMode (§6.3).
 *
 * After reconnect/rebind, InteractiveMode clears its private `streamingComponent` and rebuilds
 * from completed session entries only. Live `message_update` / `message_end` events only paint
 * when that component already exists — and it is created solely on `message_start`. The
 * in-flight assistant generation never re-emits `message_start`, so without this adapter the
 * TUI freezes until the user aborts and starts a new turn.
 *
 * Pi 0.84 no longer sends cumulative updates. RpcClientBase restores them from deltas during
 * ordinary streaming, while shim v7 retains one cumulative snapshot across a detached gap.
 * This adapter synthesizes the missing `message_start` from that recovered snapshot (or from
 * a terminal `message_end` if the generation finished during the rebind gap).
 */
export class StreamHeal {
  private needsHeal = false;

  /** True after a rebind that found the pod still mid-turn, until the first heal or a boundary. */
  get armed(): boolean {
    return this.needsHeal;
  }

  /**
   * Arm after the TUI has rebound. Only `isStreaming` matters: compaction uses different
   * events, and completed assistant steps are already in the session snapshot.
   */
  arm(isStreaming: boolean): void {
    this.needsHeal = isStreaming;
  }

  /** Disarm without emitting — used when a natural stream boundary arrives. */
  disarm(): void {
    this.needsHeal = false;
  }

  /**
   * Expand one inbound agent event into the events the TUI should see.
   * At most one synthetic `message_start` is ever prepended per arm cycle.
   */
  expand(event: unknown): unknown[] {
    const typed = event as { type?: string; message?: { role?: string } } | null;
    const type = typed?.type;
    if (typeof type !== "string") return [event];

    if (type === "message_start" && typed?.message?.role === "assistant") {
      this.needsHeal = false;
      return [event];
    }

    // A new turn or a settled/ended turn owns its own start; drop a stale arm.
    if (type === "agent_start" || type === "agent_end" || type === "agent_settled") {
      this.needsHeal = false;
      return [event];
    }

    if (
      this.needsHeal &&
      (type === "message_update" || type === "message_end") &&
      typed?.message?.role === "assistant"
    ) {
      this.needsHeal = false;
      return [{ type: "message_start", message: typed.message }, event];
    }

    return [event];
  }
}
