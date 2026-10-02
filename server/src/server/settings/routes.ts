import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { requirePermission } from "../auth/plugin.js";
import { audit } from "../audit.js";
import { forbidden } from "../httperrors.js";
import { IdentityId } from "../ids.js";
import { MAX_INIT_SCRIPT_BYTES, readLayer, writeLayer } from "./merge.js";
import { PiSettingsFilesSchema } from "./pi-settings.js";
import { registerSettingsProposalRoutes } from "./proposals.js";

const PutBody = z.object({
  config: z.record(z.unknown()),
  /** Undefined leaves the organization's default init script unchanged; "" clears it. */
  initScript: z.string().max(MAX_INIT_SCRIPT_BYTES).optional(),
  /** Same update semantics as initScript, for the org's default bake layer. */
  bakeScript: z.string().max(MAX_INIT_SCRIPT_BYTES).optional(),
  /** Undefined leaves the flat Pi file set unchanged; {} clears it. */
  piFiles: PiSettingsFilesSchema.optional(),
  /** Optimistic concurrency: the version read, 0 for first write. */
  version: z.number().int().min(0),
});

export function registerSettingsRoutes(app: FastifyInstance): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  for (const [path, scopeType, permission] of [
    ["/orgs/:id/settings", "org_defaults", "org:manage"],
    ["/orgs/:id/policy", "org_policy", "policy:write"],
  ] as const) {
    r.get(
      path,
      {
        preHandler: [app.authenticate],
        // Org defaults are visible in pods so agents can prepare an org-scoped proposal.
        ...(scopeType === "org_defaults" ? { config: { allowPodToken: true } } : {}),
        schema: { params: z.object({ id: IdentityId }) },
      },
      async (req) => {
        if (req.params.id !== req.auth.orgId) throw forbidden("org mismatch");
        return readLayer(scopeType, req.auth.orgId, req.auth.orgId);
      },
    );
    r.put(
      path,
      {
        preHandler: [app.authenticate],
        schema: { params: z.object({ id: IdentityId }), body: PutBody },
      },
      async (req) => {
        if (req.params.id !== req.auth.orgId) throw forbidden("org mismatch");
        requirePermission(req.auth, permission);
        const version = await writeLayer({
          scopeType,
          scopeId: req.auth.orgId,
          orgId: req.auth.orgId,
          config: req.body.config,
          initScript: req.body.initScript,
          bakeScript: req.body.bakeScript,
          piFiles: req.body.piFiles,
          expectedVersion: req.body.version,
          updatedBy: req.auth.userId,
        });
        await audit({
          orgId: req.auth.orgId,
          actorId: req.auth.userId,
          action: scopeType === "org_policy" ? "policy.update" : "settings.org.update",
        });
        return { version };
      },
    );
  }

  r.get(
    "/users/:id/settings",
    {
      preHandler: [app.authenticate],
      schema: { params: z.object({ id: IdentityId }) },
    },
    async (req) => {
      if (req.params.id !== req.auth.userId) throw forbidden("settings of another user");
      return readLayer("user_defaults", req.auth.userId, req.auth.orgId);
    },
  );

  r.put(
    "/users/:id/settings",
    {
      preHandler: [app.authenticate],
      schema: { params: z.object({ id: IdentityId }), body: PutBody },
    },
    async (req) => {
      if (req.params.id !== req.auth.userId) throw forbidden("settings of another user");
      requirePermission(req.auth, "settings:own:write");
      const version = await writeLayer({
        scopeType: "user_defaults",
        scopeId: req.auth.userId,
        orgId: req.auth.orgId,
        config: req.body.config,
        initScript: req.body.initScript,
        bakeScript: req.body.bakeScript,
        piFiles: req.body.piFiles,
        expectedVersion: req.body.version,
        updatedBy: req.auth.userId,
      });
      await audit({
        orgId: req.auth.orgId,
        actorId: req.auth.userId,
        action: "settings.user.update",
      });
      return { version };
    },
  );

  registerSettingsProposalRoutes(app);
}
