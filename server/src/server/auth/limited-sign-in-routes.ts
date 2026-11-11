/**
 * HTTP for limited sign-ins (auth/limited-sign-in.ts).
 *
 * The machine's side is OAuth-shaped, so a script that renews a token itself can follow it with a
 * form post: start (RFC 8628 device authorization), token (device-code and refresh-token grants,
 * RFC 6749 errors) and revoke (RFC 7009). These take no bearer token.
 *
 * The person's side is the dashboard page that shows what a code asks for and confirms or
 * declines it, with the person's own (full) sign-in. A limited sign-in can never confirm another.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { audit } from "../audit.js";
import { badRequest } from "../httperrors.js";
import type { KekProvider } from "../secrets/crypto.js";
import type { ServerEnv } from "../env.js";
import type { AuthContext } from "./plugin.js";
import { userEmail } from "./snapshots.js";
import {
  approveRequest,
  collectSignIn,
  describeRequest,
  denyRequest,
  endSignIn,
  GrantError,
  isLimitRefusal,
  renewSignIn,
  startRequest,
} from "./limited-sign-in.js";

const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

const UserCodeParams = z.object({ code: z.string().min(1).max(32) });

/** Where people confirm codes: SERVER_URL, or the address this request reached the server at. */
function pageBase(env: ServerEnv, req: FastifyRequest): string {
  return env.SERVER_URL ?? `${req.protocol}://${req.host}`;
}

function bodyField(body: unknown, name: string): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const value = (body as Record<string, unknown>)[name];
  return typeof value === "string" ? value : undefined;
}

function sendGrantError(reply: FastifyReply, error: GrantError) {
  return reply
    .code(error.status)
    .header("cache-control", "no-store")
    .send({ error: error.error, error_description: error.message });
}

function person(auth: AuthContext) {
  return { userId: auth.userId, orgId: auth.orgId, permissions: auth.permissions };
}

export function registerLimitedSignInRoutes(app: FastifyInstance, deps: { env: ServerEnv; kek: KekProvider }): void {
  // Token and revocation requests are form posts in OAuth; this scope alone parses them.
  app.register(async (scope) => {
    scope.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "string", bodyLimit: 16 * 1024 },
      (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string))),
    );
    const r = scope.withTypeProvider<ZodTypeProvider>();

    r.post(
      "/sign-ins/device",
      { schema: { body: z.object({ template: z.string().trim().min(1).max(200) }).strict() } },
      async (req, reply) => {
        const authorization = await startRequest(req.body.template, pageBase(deps.env, req));
        return reply.code(200).header("cache-control", "no-store").send(authorization);
      },
    );

    r.post("/sign-ins/token", async (req, reply) => {
      const grantType = bodyField(req.body, "grant_type");
      try {
        if (grantType === DEVICE_CODE_GRANT) {
          const deviceCode = bodyField(req.body, "device_code");
          if (!deviceCode) throw new GrantError("invalid_request", "device_code is required");
          return reply.header("cache-control", "no-store").send(await collectSignIn(deviceCode));
        }
        if (grantType === "refresh_token") {
          const refreshToken = bodyField(req.body, "refresh_token");
          if (!refreshToken) throw new GrantError("invalid_request", "refresh_token is required");
          return reply.header("cache-control", "no-store").send(await renewSignIn(deps, refreshToken));
        }
        throw new GrantError("unsupported_grant_type", "use the device_code or refresh_token grant");
      } catch (error) {
        if (error instanceof GrantError) return sendGrantError(reply, error);
        throw error;
      }
    });

    r.post("/sign-ins/revoke", async (req, reply) => {
      const token = bodyField(req.body, "token");
      if (!token) throw badRequest("token is required");
      await endSignIn(deps, token);
      return reply.code(200).header("cache-control", "no-store").send({});
    });
  });

  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/sign-ins/requests/:code",
    { preHandler: [app.authenticate], schema: { params: UserCodeParams } },
    async (req) => describeRequest(req.params.code, person(req.auth)),
  );

  r.post(
    "/sign-ins/requests/:code/approve",
    {
      preHandler: [app.authenticate],
      schema: {
        params: UserCodeParams,
        // The refresh token of the dashboard session confirming: the sign-in keeps it.
        body: z.object({ refreshToken: z.string().min(1).max(4096) }).strict(),
      },
    },
    async (req) => {
      const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
      // The machine's /me answers from the user row; Zitadel's access tokens carry no email.
      await userEmail(deps.env, req.auth.userId, bearer).catch(() => null);
      const approved = await approveRequest(deps, req.params.code, person(req.auth), req.body.refreshToken);
      return { approved: true, signInId: approved.signInId, template: approved.template };
    },
  );

  r.post(
    "/sign-ins/requests/:code/deny",
    { preHandler: [app.authenticate], schema: { params: UserCodeParams } },
    async (req) => {
      await denyRequest(req.params.code, person(req.auth));
      return { denied: true };
    },
  );
}

/** onError hook: every refusal of a limited sign-in is audited, whichever route or check made it. */
export async function auditLimitRefusal(req: FastifyRequest, _reply: FastifyReply, error: Error): Promise<void> {
  const auth = (req as { auth?: AuthContext }).auth;
  if (!auth?.limitedTo || !isLimitRefusal(error)) return;
  await audit({
    orgId: auth.orgId,
    actorId: auth.userId,
    action: "sign_in.limited.refuse",
    targetType: "limited_sign_in",
    targetId: auth.limitedTo.signInId,
    detail: {
      templateId: auth.limitedTo.templateId,
      method: req.method,
      route: req.routeOptions.url ?? null,
      reason: error.message,
    },
  }).catch(() => undefined);
}
