import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { requirePermission, type AuthContext } from "../auth/plugin.js";
import { audit } from "../audit.js";
import { getPool, tx, type Queryable } from "../db/index.js";
import { badRequest, forbidden, notFound } from "../httperrors.js";
import { IdentityId } from "../ids.js";
import type { KekProvider } from "./crypto.js";
import {
  deleteSecret,
  isProviderCredential,
  listSecrets,
  putSecret,
  SECRET_NAME_MAX_LENGTH,
  SECRET_VALUE_MAX_BYTES,
  type SecretScope,
} from "./store.js";

const ScopeParams = z.object({
  scope: z.enum(["org", "user", "template"]),
  scopeId: IdentityId,
});

async function checkScopeAccess(auth: AuthContext, scope: SecretScope, scopeId: string, write: boolean,
  client: Queryable = getPool(), lock = false) {
  if (scope === "org") {
    if (auth.podId) throw forbidden("pod tokens cannot touch org secrets");
    if (scopeId !== auth.orgId) throw forbidden("org mismatch");
    if (write) requirePermission(auth, "secrets:org:write");
    return;
  }
  if (scope === "user") {
    if (auth.podId) throw forbidden("pod tokens cannot touch user secrets");
    if (scopeId !== auth.userId) throw forbidden("secrets of another user");
    if (write) requirePermission(auth, "secrets:own:write");
    return;
  }
  // Another user's personal template is invisible here, like everywhere else.
  const template = await client.query<{ created_from_pod: string | null }>(
    `SELECT created_from_pod FROM pod_templates
     WHERE id = $1 AND org_id = $2 AND archived_at IS NULL
       AND (owner_user_id IS NULL OR owner_user_id = $3)${lock ? " FOR SHARE" : ""}`,
    [scopeId, auth.orgId, auth.userId],
  );
  const row = template.rows[0];
  if (!row) throw notFound("template not found");
  // Pod tokens reach only templates they created (spec §8.5), and even then write-only like everyone.
  if (auth.podId) {
    if (row.created_from_pod !== auth.podId) {
      throw forbidden("pod tokens may only manage secrets on templates they created");
    }
    return;
  }
  if (write) requirePermission(auth, "templates:write");
}

/** Write-only secret API (spec §7): create, replace, delete — never read back. */
export function registerSecretRoutes(app: FastifyInstance, kek: KekProvider): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/secrets/:scope/:scopeId",
    { preHandler: [app.authenticate], config: { allowPodToken: true }, schema: { params: ScopeParams } },
    async (req) => {
      await checkScopeAccess(req.auth, req.params.scope, req.params.scopeId, false);
      return {
        secrets: await listSecrets({
          orgId: req.auth.orgId,
          scopeType: req.params.scope,
          scopeId: req.params.scopeId,
        }),
      };
    },
  );

  r.put(
    "/secrets/:scope/:scopeId/:name",
    {
      preHandler: [app.authenticate],
      config: { allowPodToken: true },
      schema: {
        params: ScopeParams.extend({ name: z.string().min(1).max(SECRET_NAME_MAX_LENGTH) }),
        body: z.object({ value: z.string().min(1).max(SECRET_VALUE_MAX_BYTES) }),
      },
    },
    async (req, reply) => {
      await checkScopeAccess(req.auth, req.params.scope, req.params.scopeId, true);
      // Server-side provider-credential custody (spec §7): only org scope feeds the
      // provider resolver, so reject other scopes here even though putSecret also guards.
      if (req.params.scope !== "org" && isProviderCredential(req.params.name)) {
        throw badRequest(`"${req.params.name}" is a provider credential and may only be stored in org scope`);
      }
      await tx(async (client) => {
        await checkScopeAccess(req.auth, req.params.scope, req.params.scopeId, true, client, true);
        await putSecret({
          kek,
          orgId: req.auth.orgId,
          scopeType: req.params.scope,
          scopeId: req.params.scopeId,
          name: req.params.name,
          value: req.body.value,
          createdBy: req.auth.userId,
        }, client);
        await audit({
          orgId: req.auth.orgId,
          actorId: req.auth.userId,
          action: "secret.write",
          targetType: "secret",
          detail: { scope: req.params.scope, scopeId: req.params.scopeId,
            name: req.params.name, podId: req.auth.podId ?? null },
        }, client);
      });
      return reply.code(204).send();
    },
  );

  r.delete(
    "/secrets/:scope/:scopeId/:name",
    {
      preHandler: [app.authenticate],
      config: { allowPodToken: true },
      schema: { params: ScopeParams.extend({ name: z.string().min(1).max(SECRET_NAME_MAX_LENGTH) }) },
    },
    async (req, reply) => {
      await checkScopeAccess(req.auth, req.params.scope, req.params.scopeId, true);
      await tx(async (client) => {
        await checkScopeAccess(req.auth, req.params.scope, req.params.scopeId, true, client, true);
        const removed = await deleteSecret({
          orgId: req.auth.orgId,
          scopeType: req.params.scope,
          scopeId: req.params.scopeId,
          name: req.params.name,
        }, client);
        if (!removed) throw notFound("secret not found");
        await audit({
          orgId: req.auth.orgId,
          actorId: req.auth.userId,
          action: "secret.delete",
          targetType: "secret",
          detail: { scope: req.params.scope, scopeId: req.params.scopeId,
            name: req.params.name, podId: req.auth.podId ?? null },
        }, client);
      });
      return reply.code(204).send();
    },
  );
}
