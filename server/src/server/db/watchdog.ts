/**
 * src/server/db/watchdog.ts — the liveness check Docker cannot make for us.
 *
 * A healthcheck only labels a container; neither Docker nor Compose restarts anything for being
 * unhealthy, and `restart: unless-stopped` acts on exit alone. So a process that is wedged rather
 * than dead sits there indefinitely — which is how a pool with every connection checked out stayed
 * up for fourteen hours answering nothing.
 *
 * Exiting is the remediation, but only for a fault a restart actually repairs. That is the reason
 * this reads the pool rather than probing the database: a restart clears connections this process
 * is holding and will not give back, and does nothing whatsoever for a database that is down.
 * /healthz deliberately still reports 200 while the database is unreachable (see app.ts) — the
 * same distinction, made in the same direction.
 */
import { getPool, POOL_MAX } from "./index.js";

const CHECK_INTERVAL_MS = 10_000;

/** Sustained across a minute, so a burst that merely saturates the pool is left alone. */
const CHECKS_BEFORE_EXIT = 6;

export interface PoolStats {
  total: number;
  idle: number;
  waiting: number;
}

/**
 * Every connection checked out, none idle, and callers queued behind them. A database that has
 * gone away fails its connections instead, which drops `total` below the maximum — so this
 * signature specifically means the holders are in this process.
 */
export function poolIsWedged(stats: PoolStats): boolean {
  return stats.total >= POOL_MAX && stats.idle === 0 && stats.waiting > 0;
}

export function startPoolWatchdog(deps: {
  stats?: () => PoolStats;
  onWedged: (checks: number) => void;
  intervalMs?: number;
  checksBeforeExit?: number;
}): () => void {
  const readStats =
    deps.stats ??
    (() => {
      const pool = getPool();
      return { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount };
    });
  const limit = deps.checksBeforeExit ?? CHECKS_BEFORE_EXIT;
  let consecutive = 0;
  let timer: NodeJS.Timeout;

  const check = (): void => {
    if (!poolIsWedged(readStats())) {
      consecutive = 0;
      return;
    }
    consecutive += 1;
    if (consecutive >= limit) {
      clearInterval(timer);
      deps.onWedged(consecutive);
    }
  };

  timer = setInterval(check, deps.intervalMs ?? CHECK_INTERVAL_MS);
  // The watchdog must never be the reason the process stays alive.
  timer.unref();
  return () => clearInterval(timer);
}
