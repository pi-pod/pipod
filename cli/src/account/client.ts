import { PiPodError } from "../errors.js";
import { AccountClient } from "./api.js";
import { readAccountAuth, readPodTokenAuth } from "./store.js";

export function signInRequiredError(cause?: unknown): PiPodError {
  return new PiPodError("sign in required for pod operations", {
    hint: "sign in with `pipod login`",
    ...(cause !== undefined ? { cause } : {}),
  });
}

export function accountClientOrNull(opts: {
  home?: string | undefined;
  env?: NodeJS.ProcessEnv;
} = {}): AccountClient | null {
  let auth;
  try {
    auth = readAccountAuth(opts.home) ?? readPodTokenAuth(opts.env ?? process.env);
  } catch (error) {
    throw signInRequiredError(error);
  }
  return auth ? new AccountClient(auth, { home: opts.home }) : null;
}

export function requireAccountClient(opts: {
  home?: string | undefined;
  env?: NodeJS.ProcessEnv;
} = {}): AccountClient {
  const client = accountClientOrNull(opts);
  if (!client) throw signInRequiredError();
  return client;
}
