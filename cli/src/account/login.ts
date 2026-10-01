/**
 * src/account/login.ts — `pipod login|logout|whoami` plus Account/Admin Console links.
 *
 * The browser flow is loopback PKCE against Zitadel directly. The CLI discovers
 * OIDC endpoints, opens the authorization endpoint with the Zitadel resource-owner
 * and project-role scopes, and exchanges the code itself. The server never sees a code, verifier, or refresh token.
 */
import * as http from "node:http";
import { spawn } from "node:child_process";
import { PiPodError } from "../errors.js";
import { hint, info } from "../log.js";
import { AccountClient } from "./api.js";
import {
  accountConsoleUrl,
  adminConsoleUrl,
  authorizeUrl,
  createNonce,
  createPkce,
  createState,
  discover,
  endSessionUrl,
  exchangeCode,
  organizationFromAccessToken,
  revokeToken,
  timingSafeEqualString,
  DEFAULT_CLIENT_ID,
  DEFAULT_ISSUER,
} from "./oidc.js";
import {
  accountAuthPath,
  clearAccountAuth,
  readAccountAuth,
  readPodTokenAuth,
  writeAccountAuth,
  type AccountAuth,
} from "./store.js";

/** Fixed, small: each `http://127.0.0.1:<port>/callback` must be allowlisted on `pipod-cli`. */
export const LOOPBACK_PORTS = [43117, 43118, 43119, 43120, 43121, 43122, 43123, 43124, 43125, 43126];
/** Production control plane — used when neither --server, a prior session, nor PI_POD_ACCOUNT_URL is set. */
export const DEFAULT_ACCOUNT_SERVER_URL = "https://api.pipod.dev";
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

export interface LoginFlags {
  server?: string | undefined;
  org?: string | undefined;
  token?: string | undefined;
  issuer?: string | undefined;
  home?: string | undefined;
}

export async function runLogin(flags: LoginFlags): Promise<number> {
  const previous = safeReadAuth(flags.home);
  const serverUrl = normalizeServerUrl(
    flags.server ?? previous?.serverUrl ?? process.env["PI_POD_ACCOUNT_URL"] ?? DEFAULT_ACCOUNT_SERVER_URL,
  );
  const issuerInput =
    flags.issuer ?? previous?.issuer ?? process.env["PI_POD_ISSUER"] ?? defaultIssuerForServer(serverUrl);
  if (!issuerInput) {
    throw new PiPodError(`no identity provider is known for ${serverUrl}`, {
      hint: "pass --issuer <url> (the ZITADEL_ISSUER of that server); pi pod only infers it for api.pipod.dev and loopback servers",
    });
  }
  const issuer = normalizeIssuerInput(issuerInput);
  const clientId = previous?.clientId ?? process.env["PI_POD_OIDC_CLIENT_ID"] ?? DEFAULT_CLIENT_ID;

  let accessToken: string;
  let refreshToken: string | undefined;
  let idToken: string | undefined;
  if (flags.token) {
    accessToken = flags.token;
  } else {
    const pair = await browserLogin({ issuer, clientId, orgAlias: flags.org });
    accessToken = pair.accessToken;
    refreshToken = pair.refreshToken;
    idToken = pair.idToken;
  }

  const tokenOrg = organizationFromAccessToken(accessToken);
  const probe = new AccountClient(
    {
      serverUrl,
      accessToken,
      ...(refreshToken ? { refreshToken } : {}),
      ...(idToken ? { idToken } : {}),
      issuer,
      clientId,
      user: { id: "", email: "" },
      orgId: tokenOrg?.id ?? "",
    },
    { home: flags.home },
  );
  let me: Awaited<ReturnType<AccountClient["me"]>>;
  try {
    me = await probe.me();
  } catch (e) {
    // A 401 on the very token we just minted is not an expired session — the server trusts
    // someone else. Saying "run `pipod login`" here would send the user round the same loop.
    if (e instanceof PiPodError && e.status === 401) {
      throw new PiPodError(`${serverUrl} rejected the token issued by ${issuer}`, {
        hint: "the server trusts a different identity provider or audience: check --issuer against the server's ZITADEL_ISSUER, and ZITADEL_API_AUDIENCE on the server",
        cause: e,
      });
    }
    throw e;
  }

  const orgId = me.currentOrgId || tokenOrg?.id || "";
  const orgName = me.organization?.name ?? tokenOrg?.name ?? orgId;
  const pending = !orgId || (me.permissions ?? []).length === 0;

  const auth: AccountAuth = {
    serverUrl,
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(idToken ? { idToken } : {}),
    issuer,
    clientId,
    user: { id: me.user.id, email: me.user.email ?? "" },
    orgId,
    ...(me.organization?.alias || tokenOrg?.alias
      ? { orgAlias: me.organization?.alias ?? tokenOrg?.alias }
      : {}),
  };
  const file = writeAccountAuth(auth, flags.home);

  if (pending) {
    info(`signed in to ${serverUrl} as ${me.user.email ?? me.user.id}`);
    info("access is pending Zitadel organization membership or role grants");
    info(`manage account: ${me.accountConsoleUrl ?? accountConsoleUrl(issuer)}`);
    hint("an administrator invites you and grants `member` (or another bundle) in the Zitadel Console");
  } else {
    info(`signed in to ${serverUrl} as ${me.user.email ?? me.user.id} (org: ${orgName})`);
  }
  info(`signed-in session stored in ${file}; pod operations now use this server`);
  return 0;
}

export async function runLogout(flags: { home?: string | undefined }): Promise<number> {
  let auth: AccountAuth | null;
  try {
    auth = readAccountAuth(flags.home);
  } catch {
    if (clearAccountAuth(flags.home)) {
      info("signed out — the unsupported local session was removed");
      return 0;
    }
    info("not signed in");
    return 0;
  }
  if (!auth) {
    if (readPodTokenAuth()) {
      throw new PiPodError("a pod-scoped server token is not a revocable login session");
    }
    info("not signed in");
    return 0;
  }
  if (auth.podToken) {
    throw new PiPodError("a pod-scoped server token is not a revocable login session");
  }
  if (auth.issuer && !auth.podToken) {
    try {
      const meta = await discover(auth.issuer);
      const clientId = auth.clientId ?? DEFAULT_CLIENT_ID;
      if (auth.refreshToken) {
        await revokeToken(meta, { clientId, token: auth.refreshToken, tokenTypeHint: "refresh_token" });
      }
      const url = endSessionUrl(meta, { idToken: auth.idToken, clientId });
      if (url) {
        const endpoint = new URL(url);
        info(`ending the identity-provider session:\n  ${endpoint.origin}${endpoint.pathname}`);
        openBrowser(url);
      }
    } catch {
      // Local truth is the file.
    }
  }
  clearAccountAuth(flags.home);
  info(`signed out of ${auth.serverUrl} — pod operations are unavailable until the next login`);
  return 0;
}

export async function runWhoami(flags: { home?: string | undefined }): Promise<number> {
  const auth = safeReadAuth(flags.home);
  if (!auth) {
    info("not signed in");
    hint("sign in with `pipod login`");
    return 1;
  }
  const client = new AccountClient(auth, { home: flags.home });
  const me = await client.me();
  info(`server  ${auth.serverUrl}`);
  if (auth.issuer) info(`issuer  ${auth.issuer}`);
  info(`user    ${me.user.email ?? "(no email)"} (${me.user.id})`);
  const perms = me.permissions ?? [];
  info(`perms   ${perms.length ? perms.join(", ") : "(none)"}`);
  if (me.organization) {
    info(`org     ${me.organization.name ?? me.organization.alias ?? me.organization.id} — ${me.organization.id}`);
  } else {
    info("org     (none) — access is pending Zitadel membership");
  }
  info(`account ${me.accountConsoleUrl ?? (auth.issuer ? accountConsoleUrl(auth.issuer) : "")}`);
  info(`org-admin ${me.adminConsoleUrl ?? (auth.issuer ? adminConsoleUrl(auth.issuer) : "")}`);
  return 0;
}

export async function runOpenAccount(flags: { home?: string | undefined }): Promise<number> {
  return openConsole(flags, "account");
}

export async function runOpenOrgAdmin(flags: { home?: string | undefined }): Promise<number> {
  return openConsole(flags, "admin");
}

async function openConsole(flags: { home?: string | undefined }, which: "account" | "admin"): Promise<number> {
  const auth = safeReadAuth(flags.home);
  if (!auth?.issuer) {
    throw new PiPodError("not signed in to an identity provider", { hint: "run `pipod login`" });
  }
  const url = which === "account" ? accountConsoleUrl(auth.issuer) : adminConsoleUrl(auth.issuer);
  info(which === "account" ? `opening Account Console:\n  ${url}` : `opening Admin Console:\n  ${url}`);
  openBrowser(url);
  return 0;
}

async function browserLogin(args: {
  issuer: string;
  clientId: string;
  orgAlias?: string;
}): Promise<{ accessToken: string; refreshToken?: string; idToken?: string }> {
  const meta = await discover(args.issuer);
  const pkce = createPkce();
  const state = createState();
  const nonce = createNonce();

  const { server, port } = await bindLoopback();
  try {
    const redirectUri = `http://127.0.0.1:${port}/callback`;
    const url = authorizeUrl(meta, {
      clientId: args.clientId,
      redirectUri,
      challenge: pkce.challenge,
      state,
      nonce,
      orgAlias: args.orgAlias,
    });

    info("opening your browser to sign in…");
    info(`if nothing opens, visit:\n  ${url}`);
    openBrowser(url);

    const code = await waitForCallback(server, state);
    return exchangeCode(meta, {
      clientId: args.clientId,
      code,
      verifier: pkce.verifier,
      redirectUri,
      nonce,
    });
  } finally {
    server.close();
  }
}

function bindLoopback(): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const tryPort = (index: number): void => {
      if (index >= LOOPBACK_PORTS.length) {
        reject(
          new PiPodError("no loopback port available for the sign-in redirect", {
            hint: `free one of ports ${LOOPBACK_PORTS[0]}–${LOOPBACK_PORTS[LOOPBACK_PORTS.length - 1]} and retry`,
          }),
        );
        return;
      }
      const server = http.createServer();
      server.once("error", () => tryPort(index + 1));
      server.listen(LOOPBACK_PORTS[index], "127.0.0.1", () => {
        server.removeAllListeners("error");
        resolve({ server, port: LOOPBACK_PORTS[index]! });
      });
    };
    tryPort(0);
  });
}

function waitForCallback(server: http.Server, expectedState: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new PiPodError("sign-in timed out after 5 minutes"));
    }, LOGIN_TIMEOUT_MS);
    server.on("request", (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const state = url.searchParams.get("state") ?? "";
      const code = url.searchParams.get("code");
      if (!timingSafeEqualString(state, expectedState) || !code) {
        res.writeHead(400, { "content-type": "text/html" }).end("<h3>Sign-in failed — return to the terminal.</h3>");
        clearTimeout(timer);
        reject(new PiPodError("the sign-in redirect did not match this login attempt"));
        return;
      }
      res
        .writeHead(200, { "content-type": "text/html" })
        .end("<h3>Signed in — you can close this tab and return to the terminal.</h3>");
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function openBrowser(url: string): void {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    const child = spawn(command, [url], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // The URL is printed either way.
  }
}

function normalizeServerUrl(raw: string | undefined): string {
  if (!raw) {
    throw new PiPodError("no pi pod server to sign in to", {
      hint: `pass --server <url>, set PI_POD_ACCOUNT_URL, or use the default ${DEFAULT_ACCOUNT_SERVER_URL}`,
    });
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PiPodError(`--server is not a URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PiPodError(`--server must be http(s), got ${url.protocol}`);
  }
  return url.origin;
}

function normalizeIssuerInput(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new PiPodError(`--issuer must be http(s), got ${url.protocol}`);
    }
    if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
      throw new PiPodError("--issuer must use HTTPS except for loopback development");
    }
    if (url.username || url.password || url.hash || url.search) {
      throw new PiPodError("--issuer must not contain credentials, a query, or a fragment");
    }
    return url.toString().replace(/\/+$/, "");
  } catch (e) {
    if (e instanceof PiPodError) throw e;
    throw new PiPodError(`--issuer is not a URL: ${raw}`);
  }
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]"
  );
}

/**
 * Only two deployments have a knowable identity provider: the hosted control plane and a
 * loopback dev stack. Guessing for anyone else opens a stranger's IdP and mints a token the
 * self-hosted server will reject — null instead, so the caller asks for `--issuer`.
 */
function defaultIssuerForServer(serverUrl: string): string | null {
  const url = new URL(serverUrl);
  if (url.hostname === "api.pipod.dev") return DEFAULT_ISSUER;
  if (isLoopbackHost(url.hostname)) return "http://127.0.0.1:8081";
  return null;
}

function safeReadAuth(home?: string | undefined): AccountAuth | null {
  try {
    return readAccountAuth(home);
  } catch {
    return null;
  }
}

export { accountAuthPath };
