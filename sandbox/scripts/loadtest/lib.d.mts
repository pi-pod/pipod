export interface LoadtestDefaults {
  base: string;
  image: string;
  tag: string;
  out: string;
  host: string;
  class: string;
  imageDigest: string;
  kernel: string;
  envFile: string;
  ltDir: string;
  service: string;
  cgroupRoot: string;
  stateDir: string;
}

export interface ParsedLoadtestArgs extends LoadtestDefaults {
  extra: Record<string, string>;
}

export interface SampleSummary {
  n: number;
  p50: number | null;
  p90: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
}

export interface LoadtestResult {
  schemaVersion: 1;
  host: string;
  class: string;
  imageDigest: string;
  kernel: string;
  config: Record<string, unknown>;
  subcommand: string;
  n: number;
  p50: number | null;
  p90: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
  wallMs: number | null;
  errors: string[];
  startedAt: string;
  finishedAt: string;
}

export declare const DEFAULTS: LoadtestDefaults;
export declare const SCHEMA_VERSION: 1;
export declare function percentile(values: number[], p: number): number | null;
export declare function summarizeSamples(values: unknown[] | undefined | null): SampleSummary;
export declare function parseArgs(argv: string[], env?: NodeJS.ProcessEnv): ParsedLoadtestArgs;
export declare function requireToken(env?: NodeJS.ProcessEnv): string;
export declare function requireOwnerKey(env?: NodeJS.ProcessEnv): string;
export declare function withLoadtestOwner<T extends Record<string, unknown>>(
  body: T,
  ownerKey: string,
): T & { owner: { userKey: string } };
export declare function buildResult(args: {
  host?: string;
  class?: string;
  imageDigest?: string;
  kernel?: string;
  config?: Record<string, unknown>;
  subcommand: string;
  samples?: number[];
  wallMs?: number | null;
  errors?: unknown[];
  startedAt?: string | null;
  finishedAt?: string | null;
}): LoadtestResult;
export declare function validateResult(obj: unknown): string[];
