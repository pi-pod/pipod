/**
 * src/account/store.ts — the machine's pi pod server session, `~/.pi-pod/auth.json`
 * (account-mode-spec §3.2).
 *
 * Presence of this file IS account mode (§2): every command that would otherwise talk to a
 * provider reads it first and, when it holds a session, talks to the server instead. It
 * lives next to `~/.pi-pod/env`, which already holds secrets of equivalent severity, and is
 * written 600 the same way.
 */
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { PiPodError } from "../errors.js";
import { userConfigDir } from "../userconfig.js";

export const AUTH_FILE = "auth.json";
export const AUTH_LOCK_STALE_MS = 2 * 60 * 1000;
export const AUTH_LOCK_WAIT_MS = 30 * 1000;
const AUTH_LOCK_RETRY_MS = 25;

export interface AccountUser {
  id: string;
  email: string;
  displayName?: string | null;
}

export interface AccountAuth {
  serverUrl: string;
  accessToken: string;
  /** Absent for `login --token` sessions (dev/CI): they expire hard, by design. */
  refreshToken?: string;
  /** Present after a direct Zitadel login; used for RP-initiated logout. */
  idToken?: string;
  /** Zitadel instance issuer used for discovery, refresh, and logout. */
  issuer?: string;
  clientId?: string;
  user: AccountUser;
  /** Active organization id copied from the verified token; not a request selector. */
  orgId: string;
  orgAlias?: string;
  /** A pod's own scoped token rather than a person's session: reaches only its children. */
  podToken?: boolean;
}

export function accountAuthPath(home?: string | undefined): string | null {
  const dir = userConfigDir(home);
  return dir ? path.join(dir, AUTH_FILE) : null;
}

export function readAccountAuth(home?: string | undefined): AccountAuth | null {
  const file = accountAuthPath(home);
  if (!file || !fs.existsSync(file)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new PiPodError(`could not parse ${file}`, {
      hint: "run `pipod login` again to replace the invalid session",
    });
  }
  const auth = parsed as AccountAuth;
  if (
    !auth ||
    typeof auth.serverUrl !== "string" ||
    typeof auth.accessToken !== "string" ||
    !auth.user ||
    typeof auth.orgId !== "string"
  ) {
    throw new PiPodError(`${file} is not a pi pod session`, {
      hint: "run `pipod login` again to replace the invalid session",
    });
  }
  if (!auth.podToken && auth.refreshToken && (typeof auth.issuer !== "string" || typeof auth.clientId !== "string")) {
    throw new PiPodError(`${file} contains a session from an unsupported identity provider`, {
      hint: "run `pipod login` again to create a Zitadel OIDC session",
    });
  }
  return auth;
}

/**
 * Account mode from inside a pod (nested pods): the server injected this pod's scoped token,
 * so `pipod` works here without a sign-in — bounded to the pods this one launched. The org
 * and user are the server's to know; the token names them on every request.
 */
export function readPodTokenAuth(env: NodeJS.ProcessEnv = process.env): AccountAuth | null {
  const serverUrl = env["PI_POD_SERVER_URL"]?.trim();
  const accessToken = env["PI_POD_SERVER_TOKEN"]?.trim();
  if (!serverUrl || !accessToken) return null;
  return {
    serverUrl,
    accessToken,
    user: { id: env["PI_POD_SERVER_POD_ID"] ?? "", email: "this pod" },
    orgId: "",
    podToken: true,
  };
}

/** Replace auth.json atomically so readers see either the old or complete new owner-only file. */
export function writeAccountAuth(auth: AccountAuth, home?: string | undefined): string {
  const file = accountAuthPath(home);
  if (!file) throw new PiPodError("cannot resolve a home directory to store the login in");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let handle: number | null = null;
  try {
    handle = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(handle, `${JSON.stringify(auth, null, 2)}\n`, "utf8");
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = null;
    fs.renameSync(temp, file);
  } finally {
    if (handle !== null) fs.closeSync(handle);
    fs.rmSync(temp, { force: true });
  }
  return file;
}

/** Serialize refresh-token rotation across independent CLI processes. */
export async function withAccountAuthLock<T>(
  home: string | undefined,
  action: () => Promise<T>,
): Promise<T> {
  const file = accountAuthPath(home);
  if (!file) throw new PiPodError("cannot resolve a home directory to refresh the login in");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  const owner = `${process.pid}:${randomBytes(16).toString("hex")}`;
  const deadline = Date.now() + AUTH_LOCK_WAIT_MS;

  while (true) {
    try {
      const handle = fs.openSync(lock, "wx", 0o600);
      try {
        fs.writeFileSync(handle, owner, "utf8");
        fs.fsyncSync(handle);
      } finally {
        fs.closeSync(handle);
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const stat = fs.statSync(lock);
        if (Date.now() - stat.mtimeMs > AUTH_LOCK_STALE_MS) {
          fs.rmSync(lock, { force: true });
          continue;
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw statError;
      }
      if (Date.now() >= deadline) {
        throw new PiPodError("timed out waiting for another pi pod process to refresh the login", {
          hint: "retry the command; if it persists, run `pipod login` again",
        });
      }
      await new Promise((resolve) => setTimeout(resolve, AUTH_LOCK_RETRY_MS));
    }
  }

  try {
    return await action();
  } finally {
    try {
      if (fs.readFileSync(lock, "utf8") === owner) fs.rmSync(lock, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export function clearAccountAuth(home?: string | undefined): boolean {
  const file = accountAuthPath(home);
  if (!file || !fs.existsSync(file)) return false;
  fs.rmSync(file);
  return true;
}
