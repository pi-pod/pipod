import pg from "pg";

export type Queryable = Pick<pg.PoolClient, "query">;

export type DbMetricsEvent = {
  kind: "query" | "transaction";
  result: "ok" | "error";
  seconds: number;
};

/**
 * Optional observer for query/transaction timing. Metrics registers this at scrape setup so
 * this module never imports the metrics registry (the dependency runs the other way).
 */
let dbMetricsHook: ((event: DbMetricsEvent) => void) | null = null;

export function setDbMetricsHook(hook: ((event: DbMetricsEvent) => void) | null): void {
  dbMetricsHook = hook;
}

/**
 * Waiting forever for a free connection turns one stuck transaction into a total outage: every
 * later request queues behind it until even /healthz stops answering, so the process looks alive
 * while nothing it does can finish. Failing the checkout keeps the damage to the routes that need
 * a connection right now.
 */
export const POOL_MAX = 10;
const POOL_OPTIONS = { max: POOL_MAX, connectionTimeoutMillis: 5_000 } satisfies pg.PoolConfig;

let pool: pg.Pool | null = null;

export function getPool(connectionString?: string): pg.Pool {
  if (!pool) {
    if (!connectionString) throw new Error("database pool not initialized");
    pool = new pg.Pool({ connectionString, ...POOL_OPTIONS });
  }
  return pool;
}

export function initPool(connectionString: string, options?: { max?: number }): pg.Pool {
  pool = new pg.Pool({
    connectionString,
    ...POOL_OPTIONS,
    ...(options?.max !== undefined ? { max: options.max } : {}),
  });
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

async function timed<T>(kind: DbMetricsEvent["kind"], work: () => Promise<T>): Promise<T> {
  const started = process.hrtime.bigint();
  try {
    const result = await work();
    dbMetricsHook?.({ kind, result: "ok", seconds: Number(process.hrtime.bigint() - started) / 1e9 });
    return result;
  } catch (error) {
    dbMetricsHook?.({ kind, result: "error", seconds: Number(process.hrtime.bigint() - started) / 1e9 });
    throw error;
  }
}

export async function query<R extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<pg.QueryResult<R>> {
  return timed("query", () => getPool().query<R>(text, params));
}

/** Run `fn` inside a transaction; rolls back on throw. */
export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  return timed("transaction", async () => {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  });
}
