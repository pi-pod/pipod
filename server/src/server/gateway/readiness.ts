/**
 * Pi RPC readiness is distinct from sandbox/shim hello. One in-flight probe is coalesced so
 * concurrent attaches do not pile get_state onto a cold Pi. A settled result is never cached:
 * each later reattach must prove that Pi is still semantically responsive.
 */

export function coalesceReadyProbe<T>(
  session: { readyProbe?: Promise<T> | null },
  start: () => Promise<T>,
): Promise<T> {
  if (session.readyProbe) return session.readyProbe;
  const probe = start();
  session.readyProbe = probe;
  void probe.then(
    () => {
      if (session.readyProbe === probe) session.readyProbe = null;
    },
    () => {
      if (session.readyProbe === probe) session.readyProbe = null;
    },
  );
  return probe;
}

export function bashSnapshotAccumulate(
  current: string | undefined,
  delta: string,
  maxBytes = 64 * 1024,
): string {
  const next = (current ?? "") + delta;
  return next.length <= maxBytes ? next : next.slice(next.length - maxBytes);
}
