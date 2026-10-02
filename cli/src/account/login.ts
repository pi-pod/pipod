/**
 * src/account/login.ts — `pipod login|logout|whoami` plus Account/Admin Console links.
 *
 * The browser flow is loopback PKCE against Zitadel directly. The CLI discovers
 * OIDC endpoints, opens the authorization endpoint with the Zitadel resource-owner
 * and project-role scopes, and exchanges the code itself. Where no browser can open on
 * this machine, the device flow (RFC 8628) asks for the same scopes and the person finishes
 * on any other device with a short code. The server never sees a code, verifier, or refresh token.
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
  awaitDeviceTokens,
  createNonce,
  createPkce,
  createState,
  discover,
  endSessionUrl,
  exchangeCode,
  organizationFromAccessToken,
  revokeToken,
  startDeviceAuthorization,
  timingSafeEqualString,
  DEFAULT_CLIENT_ID,
  DEFAULT_ISSUER,
  OIDC_NETWORK_TIMEOUT_MS,
  type OidcMetadata,
  type TokenSet,
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
  /** Sign in with a code on another device even where a browser could open here. */
  device?: boolean | undefined;
  home?: string | undefined;
}

export async function runLogin(flags: LoginFlags): Promise<number> {
  const stored = safeReadAuth(flags.home);
  const serverUrl = normalizeServerUrl(
    flags.server ?? stored?.serverUrl ?? process.env["PI_POD_ACCOUNT_URL"] ?? DEFAULT_ACCOUNT_SERVER_URL,
  );
  // A session with another server says nothing about this one's identity provider.
  const previous = stored?.serverUrl === serverUrl ? stored : null;
  const published = await fetchSignInConfig(serverUrl);
  const issuerInput =
    flags.issuer ??
    process.env["PI_POD_ISSUER"] ??
    published?.issuer ??
    previous?.issuer ??
    defaultIssuerForServer(serverUrl);
  if (!issuerInput) {
    throw new PiPodError(`no identity provider is known for ${serverUrl}`, {
      hint: "pass --issuer <url> (the ZITADEL_ISSUER of that server); this server does not publish one",
    });
  }
  const issuer = normalizeIssuerInput(issuerInput);
  const clientId =
    process.env["PI_POD_OIDC_CLIENT_ID"] ?? published?.cliClientId ?? previous?.clientId ?? DEFAULT_CLIENT_ID;

  let accessToken: string;
  let refreshToken: string | undefined;
  let idToken: string | undefined;
  if (flags.token) {
    accessToken = flags.token;
  } else {
    const pair = await interactiveLogin({ issuer, clientId, orgAlias: flags.org, device: flags.device === true });
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

  // Zitadel's access tokens carry no email, so the server rarely knows it; the ID token does.
  const email = me.user.email ?? emailFromIdToken(idToken) ?? "";
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
    user: { id: me.user.id, email },
    orgId,
    ...(me.organization?.alias || tokenOrg?.alias
      ? { orgAlias: me.organization?.alias ?? tokenOrg?.alias }
      : {}),
  };
  const file = writeAccountAuth(auth, flags.home);

  if (pending) {
    info(`signed in to ${serverUrl} as ${email || me.user.id}`);
    info("access is pending Zitadel organization membership or role grants");
    info(`manage account: ${me.accountConsoleUrl ?? accountConsoleUrl(issuer)}`);
    hint("an administrator invites you and grants `member` (or another bundle) in the Zitadel Console");
  } else {
    info(`signed in to ${serverUrl} as ${email || me.user.id} (org: ${orgName})`);
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
  info(`signed out of ${auth.serverUrl}; sign back in with \`pipod login --server ${auth.serverUrl}\``);
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
  info(`user    ${me.user.email ?? (auth.user.email || "(no email)")} (${me.user.id})`);
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

/**
 * Sign a person in. Where no browser can open on this machine (an SSH session, a headless
 * server, a container), or with --device, they finish on any other device with a short code.
 * An identity provider that does not allow that for this client falls back to the browser
 * flow, unless --device asked for the code explicitly.
 */
async function interactiveLogin(args: {
  issuer: string;
  clientId: string;
  orgAlias?: string | undefined;
  device: boolean;
}): Promise<TokenSet> {
  const meta = await discover(args.issuer);
  const browserHere = canOpenBrowserHere();
  if (args.device || !browserHere) {
    const authorization = await startDeviceAuthorization(meta, { clientId: args.clientId, orgAlias: args.orgAlias });
    if (authorization) {
      const page = authorization.verificationUriComplete ?? authorization.verificationUri;
      const verb = authorization.verificationUriComplete ? "confirm" : "enter";
      info(`to sign in, open this page on any device and ${verb} the code ${authorization.userCode}:\n  ${page}`);
      info("waiting for you to finish signing in…");
      return awaitDeviceTokens(meta, { clientId: args.clientId, authorization });
    }
    if (args.device) {
      throw new PiPodError(`${args.issuer} does not allow this CLI to sign in with a code`, {
        hint: "on a self-hosted server the operator enables it with `selfhost/upgrade --apply-zitadel`; until then run `pipod login` without --device",
      });
    }
    info("this identity provider does not offer sign-in with a code; using the browser flow");
  }
  return browserLogin(meta, { clientId: args.clientId, orgAlias: args.orgAlias, browserHere });
}

/**
 * Whether `openBrowser` can show a page to the person at this terminal. Over SSH a Mac or
 * Windows host opens it on its own screen; elsewhere a browser needs a display (X11
 * forwarding brings one over SSH) or a $BROWSER.
 */
function canOpenBrowserHere(): boolean {
  const env = process.env;
  if (process.platform === "darwin" || process.platform === "win32") {
    return !env["SSH_CONNECTION"] && !env["SSH_TTY"];
  }
  return Boolean(env["DISPLAY"] || env["WAYLAND_DISPLAY"] || env["BROWSER"]);
}

async function browserLogin(
  meta: OidcMetadata,
  args: { clientId: string; orgAlias?: string | undefined; browserHere: boolean },
): Promise<TokenSet> {
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

    if (args.browserHere) {
      info("opening your browser to sign in…");
      info(`if nothing opens, visit:\n  ${url}`);
      openBrowser(url);
    } else {
      info(`to sign in, open this page in a browser that reaches port ${port} on this machine:\n  ${url}`);
      hint(`over SSH, forward it first: ssh -L ${port}:127.0.0.1:${port} <this host>`);
    }

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
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" }).end("<h3>Sign-in failed — return to the terminal.</h3>");
        clearTimeout(timer);
        reject(new PiPodError("the sign-in redirect did not match this login attempt"));
        return;
      }
      res
        .writeHead(200, { "content-type": "text/html; charset=utf-8" })
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

/**
 * The sign-in settings a server publishes at GET /v1/auth/config; null from a server that
 * predates it. Failing to reach the server at all stops the login here, before the browser.
 */
async function fetchSignInConfig(serverUrl: string): Promise<{ issuer?: string; cliClientId?: string } | null> {
  let res: Response;
  try {
    res = await fetch(`${serverUrl}/v1/auth/config`, {
      redirect: "error",
      signal: AbortSignal.timeout(OIDC_NETWORK_TIMEOUT_MS),
    });
  } catch (e) {
    throw new PiPodError(`cannot reach the pi pod server at ${serverUrl}`, {
      hint: e instanceof Error && e.cause instanceof Error ? e.cause.message : "check --server and that the server is running",
    });
  }
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as { issuer?: unknown; cliClientId?: unknown } | null;
  const issuer = typeof body?.issuer === "string" ? body.issuer : undefined;
  // A token from the hosted service's identity provider is good at api.pipod.dev: no other
  // server gets to ask for one.
  if (issuer && normalizeIssuerInput(issuer) === DEFAULT_ISSUER && new URL(serverUrl).hostname !== "api.pipod.dev") {
    throw new PiPodError(`${serverUrl} asks you to sign in to pipod.dev, which is not its identity provider`, {
      hint: "pass --issuer <url> if you really mean to sign in there",
    });
  }
  return {
    ...(issuer ? { issuer } : {}),
    ...(typeof body?.cliClientId === "string" ? { cliClientId: body.cliClientId } : {}),
  };
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
  // Every request carries a bearer token; only loopback may carry it in cleartext.
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    throw new PiPodError("--server must use HTTPS except for loopback development", {
      hint: "put the server behind TLS, or reach it through an SSH tunnel to 127.0.0.1",
    });
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

/** The `email` claim of an ID token this login already verified, if it has one. */
function emailFromIdToken(idToken: string | undefined): string | undefined {
  if (!idToken) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8")) as { email?: unknown };
    return typeof claims.email === "string" && claims.email ? claims.email : undefined;
  } catch {
    return undefined;
  }
}

function safeReadAuth(home?: string | undefined): AccountAuth | null {
  try {
    return readAccountAuth(home);
  } catch {
    return null;
  }
}

export { accountAuthPath };
