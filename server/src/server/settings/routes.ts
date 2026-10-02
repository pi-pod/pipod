import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { PI_THINKING_LEVELS, validateConfig } from "../../core/config.js";
import { supportedProviders } from "../../core/providers/registry.js";
import { requirePermission } from "../auth/plugin.js";
import { audit } from "../audit.js";
import { query } from "../db/index.js";
import type { ServerEnv } from "../env.js";
import { forbidden } from "../httperrors.js";
import { IdentityId } from "../ids.js";
import { admittedSandboxMemoryGB } from "../pods/capacity.js";
import { NESTED_PODS_DEFAULTS, parentDelegation } from "../pods/lineage.js";
import { deploymentResourceMaximums } from "../pods/planning.js";
import { getPod } from "../pods/store.js";
import { findTemplate } from "../templates/store.js";
import {
  clientFacingConfig,
  MAX_INIT_SCRIPT_BYTES,
  readLayer,
  stripRetiredConfigKeys,
  writeLayer,
  type SettingsLayerRow,
} from "./merge.js";
import { PiSettingsFilesSchema } from "./pi-settings.js";

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
        // Pods read org defaults through /settings/layers; this older path stays readable for
        // agents whose skill predates it. Policy stays out of pods' reach.
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

  /**
   * The layers a launch builds on, read-only: org defaults, the caller's own user layer, and
   * for a pod token the template that pod launched from, as stored now. This is how the agent
   * in a pod sees what it runs with; pods never write the org or user layers, whose scripts
   * run in every later launch, so the agent hands the change to its person instead. A pod
   * launched without its owner's bundle (an org-scoped job, and pods it launches) gets no user
   * layer, just as it gets none of their personal templates. `template` is null when the pod
   * launched without one or it has since been deleted.
   */
  r.get("/settings/layers", { preHandler: [app.authenticate], config: { allowPodToken: true } }, async (req) => {
    const { orgId, userId, podId } = req.auth;
    const [delegation, pod] = podId
      ? await Promise.all([parentDelegation({ query }, { orgId, parentPodId: podId }), getPod(orgId, podId)])
      : [null, null];
    const [org, user, template] = await Promise.all([
      readLayer("org_defaults", orgId, orgId),
      delegation?.includeUserBundle === false ? null : readLayer("user_defaults", userId, orgId),
      pod?.template_id ? findTemplate(orgId, pod.template_id, userId) : null,
    ]);
    return {
      org,
      user,
      template: template && {
        id: template.id,
        name: template.name,
        scope: template.owner_user_id ? ("user" as const) : ("org" as const),
        version: template.version,
        config: stripRetiredConfigKeys(template.config) as Record<string, unknown>,
        initScript: template.init_script ?? "",
        bakeScript: template.bake_script ?? "",
        piFiles: template.pi_settings,
      } satisfies SettingsLayerRow & { id: string; name: string; scope: "user" | "org" },
    };
  });
}

/**
 * What a key left unset in every settings layer comes to on this server, and the choices a
 * settings editor offers, so an editor can show what a blank field inherits without keeping
 * its own copy of the defaults. `podLimits` is the largest pod a launch gets: more CPU or
 * disk is reduced to it, and more memory is refused.
 */
export function registerSettingsDefaultsRoute(app: FastifyInstance, env: ServerEnv): void {
  app.get("/settings/defaults", { preHandler: [app.authenticate] }, async () => ({
    config: clientFacingConfig(validateConfig({}).config),
    nestedPods: NESTED_PODS_DEFAULTS,
    providers: supportedProviders(),
    thinkingLevels: PI_THINKING_LEVELS,
    podLimits: { ...deploymentResourceMaximums(env), memoryGB: admittedSandboxMemoryGB(env) },
  }));
}
