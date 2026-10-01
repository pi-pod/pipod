export const CLIENT_PING_MS = 30_000;
export const CLIENT_PONG_DEADLINE_MS = 75_000;

interface SupervisedSocket {
  readonly OPEN: number;
  readonly readyState: number;
  on(event: "pong", listener: () => void): unknown;
  once(event: "close", listener: () => void): unknown;
  ping(): void;
  terminate(): void;
}

interface RepeatingTask {
  cancel(): void;
  unref?(): void;
}

export type RepeatingScheduler = (callback: () => void, intervalMs: number) => RepeatingTask;

const scheduleInterval: RepeatingScheduler = (callback, intervalMs) => {
  const timer = setInterval(callback, intervalMs);
  return {
    cancel: () => clearInterval(timer),
    unref: () => timer.unref?.(),
  };
};

/**
 * Own a client socket's ping/pong and close cleanup as one idempotent lifetime. A timed-out
 * half-open connection detaches immediately; the later socket close observes the same cleanup.
 */
export function superviseClientSocket(args: {
  socket: SupervisedSocket;
  onDetach: () => void;
  now?: () => number;
  schedule?: RepeatingScheduler;
  pingIntervalMs?: number;
  pongDeadlineMs?: number;
}): { detach: () => void } {
  const now = args.now ?? Date.now;
  let lastPongAt = now();
  let detached = false;
  let task: RepeatingTask | null = null;

  const detach = () => {
    if (detached) return;
    detached = true;
    task?.cancel();
    args.onDetach();
  };

  args.socket.on("pong", () => {
    if (!detached) lastPongAt = now();
  });
  args.socket.once("close", detach);

  task = (args.schedule ?? scheduleInterval)(() => {
    if (args.socket.readyState !== args.socket.OPEN) return;
    if (now() - lastPongAt > (args.pongDeadlineMs ?? CLIENT_PONG_DEADLINE_MS)) {
      args.socket.terminate();
      detach();
      return;
    }
    args.socket.ping();
  }, args.pingIntervalMs ?? CLIENT_PING_MS);
  task.unref?.();

  return { detach };
}
