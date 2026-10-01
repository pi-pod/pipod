import type { ServerEnv } from "../env.js";

function instanceBase(issuer: string): string {
  return issuer.replace(/\/+$/, "");
}

export function accountConsoleUrl(env: ServerEnv): string {
  return env.ZITADEL_ACCOUNT_URL ?? `${instanceBase(env.ZITADEL_ISSUER)}/ui/console/users/me`;
}

export function adminConsoleUrl(env: ServerEnv): string {
  return env.ZITADEL_ADMIN_URL ?? `${instanceBase(env.ZITADEL_ISSUER)}/ui/console`;
}
