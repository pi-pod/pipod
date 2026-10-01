import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { HttpError } from "../src/server/httperrors.js";
import { registerPodRoutes } from "../src/server/pods/routes.js";
import type { PodServiceDeps } from "../src/server/pods/service.js";

describe("retired pi-auth routes", () => {
  const app = Fastify();
  let authentications = 0;

  before(async () => {
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.setErrorHandler((error, _req, reply) => {
      if (error instanceof HttpError) {
        return reply.code(error.statusCode).send({ error: error.message, detail: error.detail ?? null });
      }
      throw error;
    });
    app.decorate("authenticate", async (req: { auth?: unknown }) => {
      authentications += 1;
      req.auth = {
        userId: "tombstone-user",
        email: "tombstone@example.test",
        orgId: "tombstone-org",
        permissions: [],
      };
    });
    const deps = {
      env: {},
      kek: {
        keyId: "unused",
        wrap: () => assert.fail("a tombstone must not encrypt credentials"),
        unwrap: () => assert.fail("a tombstone must not decrypt credentials"),
      },
      log: { info: () => {}, warn: () => {}, error: () => {} },
    } as unknown as PodServiceDeps;
    registerPodRoutes(app, deps, null);
    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  it("returns an authenticated 410 client_upgrade_required from every retired endpoint", async () => {
    const podId = "00000000-0000-7000-8000-000000000001";
    const requests = [
      { method: "GET", url: "/pi-auth" },
      { method: "PUT", url: "/pi-auth", payload: { content: "{}" } },
      { method: "DELETE", url: "/pi-auth" },
      { method: "GET", url: "/pi-auth/content" },
      { method: "GET", url: "/pi-auth/fresh" },
      { method: "POST", url: `/pods/${podId}/save-pi-auth` },
    ] as const;

    for (const request of requests) {
      const response = await app.inject(request);
      assert.equal(response.statusCode, 410, `${request.method} ${request.url}`);
      assert.deepEqual(response.json(), {
        error: "client_upgrade_required",
        detail: {
          code: "client_upgrade_required",
          message: "This client is too old to manage model credentials. Update pi pod.",
        },
      });
    }
    assert.equal(authentications, requests.length, "authentication still runs before every tombstone");
  });
});
