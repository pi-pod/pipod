import { pino, type Logger } from "pino";

/** Env values and tokens must never reach a log line (§6.3, §11). */
const REDACT = [
  "headers.authorization",
  "req.headers.authorization",
  "*.headers.authorization",
  "req.body.auth.password",
  "*.auth.password",
  "env",
  "*.env",
  "token",
  "*.token",
  "secretKey",
  "*.secretKey",
  "password",
  "*.password",
];

export function createLogger(level: string): Logger {
  return pino({ level, redact: { paths: REDACT, censor: "[redacted]" } });
}

export type { Logger };
