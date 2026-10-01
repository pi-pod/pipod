/**
 * M0 old-client compatibility: retired providers must 400 with the supported list.
 *
 * Production 2026-09-09: POST /v1/pods {provider:'e2b'} answered 400
 * {"error":"validation failed","detail":[{"instancePath":"/provider",...}]}
 * with NO supported list, violating the box plan §3.5 release order ("old
 * clients that send provider:e2b get a 400 naming the supported list").
 *
 * The zod-enum failure carries the allowed list only in message/params, which
 * the redaction boundary drops by design. The HTTP boundary now answers
 * provider-location failures with the static registry-driven list, without
 * echoing message/params/data (no credential or raw-body echo).
 *
 * A bare Fastify instance with the real validator + the real app error boundary
 * + the production LaunchBody schema; no database.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { installErrorHandler } from "../src/server/app.js";
import { LaunchBody } from "../src/server/pods/routes.js";
import { isProviderValidationFailure, scrubValidationIssues } from "../src/server/safe-errors.js";
import { supportedProviders } from "../src/core/providers/registry.js";
import {
  assertAllowedProvidersSupported,
  assertDeniedProvidersSupported,
} from "../src/server/settings/merge.js";
import { HttpError } from "../src/server/httperrors.js";

function makeCanary(): string {
  return randomBytes(16).toString("hex");
}

async function podsApp() {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  installErrorHandler(app);
  app.post("/v1/pods", { schema: { body: LaunchBody } }, async () => ({ ok: true }));
  await app.ready();
  return app;
}

async function boundaryApp(throwable: unknown) {
  const app = Fastify();
  installErrorHandler(app);
  app.get("/probe", async () => {
    throw throwable;
  });
  await app.ready();
  return app;
}

describe("old-client provider 400 names the supported list (no DB)", () => {
  it("rejects retired/unknown providers with the static supported list", async () => {
    const app = await podsApp();
    try {
      for (const provider of ["e2b", "daytona", "unknown"]) {
        const res = await app.inject({ method: "POST", url: "/v1/pods", payload: { provider } });
        assert.equal(res.statusCode, 400, `${provider}: ${res.body}`);
        const body = res.json() as { error: string; detail: unknown };
        const blob = JSON.stringify(body);
        assert.match(body.error, /unsupported provider/, `${provider}: ${res.body}`);
        assert.ok(blob.includes("sandbox") && blob.includes("host"), `${provider}: ${res.body}`);
        // Detail stays the scrubbed location/rule pair — no message/params/data echo.
        assert.deepEqual(body.detail, [
          {
            instancePath: "/provider",
            schemaPath: "#/provider/invalid_enum_value",
            keyword: "invalid_enum_value",
          },
        ]);
      }
    } finally {
      await app.close();
    }
  });

  it("hints resolve too when registered under the /v1 prefix like production", async () => {
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    installErrorHandler(app);
    await app.register(
      async (v1) => {
        const r = v1.withTypeProvider<ZodTypeProvider>();
        r.post("/pods", { schema: { body: LaunchBody } }, async () => ({ ok: true }));
        r.post(
          "/pods/resolve",
          {
            schema: {
              body: z.object({ provider: z.enum(["sandbox", "host"] as [string, ...string[]]).optional() }).strict(),
            },
          },
          async () => ({ ok: true }),
        );
      },
      { prefix: "/v1" },
    );
    await app.ready();
    try {
      for (const url of ["/v1/pods", "/v1/pods/resolve"]) {
        const res = await app.inject({ method: "POST", url, payload: { provider: "e2b" } });
        assert.equal(res.statusCode, 400, `${url}: ${res.body}`);
        assert.ok(res.body.includes("sandbox") && res.body.includes("unsupported provider"), `${url}: ${res.body}`);
      }
    } finally {
      await app.close();
    }
  });

  it("never echoes the submitted provider value (credential-safe)", async () => {
    const canary = makeCanary();
    const app = await podsApp();
    try {
      const res = await app.inject({ method: "POST", url: "/v1/pods", payload: { provider: canary } });
      assert.equal(res.statusCode, 400, res.body);
      assert.ok(!res.body.includes(canary), `leaked submitted value in ${res.body.slice(0, 400)}`);
      assert.ok(res.body.includes("sandbox"), res.body);
    } finally {
      await app.close();
    }
  });

  it("still launches for supported providers and omitted provider", async () => {
    const app = await podsApp();
    try {
      for (const payload of [{ provider: "sandbox" }, { provider: "host" }, {}]) {
        const res = await app.inject({ method: "POST", url: "/v1/pods", payload });
        assert.equal(res.statusCode, 200, `${JSON.stringify(payload)}: ${res.body}`);
      }
    } finally {
      await app.close();
    }
  });

  it("keeps generic redaction for non-provider validation failures", async () => {
    const app = await podsApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/pods",
        payload: { templateId: "not-a-uuid" },
      });
      assert.equal(res.statusCode, 400, res.body);
      const body = res.json() as { error: string };
      assert.equal(body.error, "validation failed");
      assert.ok(!res.body.includes("sandbox"), `must not hint providers here: ${res.body}`);
    } finally {
      await app.close();
    }
  });

  it("keeps unrelated routes generic even when their provider field fails", async () => {
    // Narrow-scope regression (PR254 review): the sandbox/host hint must fire
    // ONLY for pod launch/resolve body validation. An unrelated body field or
    // path param also named provider — same instancePath /provider — must stay
    // generic scrubbed 400 with no sandbox/host list.
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    installErrorHandler(app);
    app.post(
      "/v1/unrelated-body",
      { schema: { body: z.object({ provider: z.string().min(5) }).strict() } },
      async () => ({ ok: true }),
    );
    app.post(
      "/v1/unrelated/:provider",
      { schema: { params: z.object({ provider: z.string().min(5) }) } },
      async () => ({ ok: true }),
    );
    await app.ready();
    try {
      const bodyFail = await app.inject({
        method: "POST",
        url: "/v1/unrelated-body",
        payload: { provider: "ab" },
      });
      assert.equal(bodyFail.statusCode, 400, bodyFail.body);
      assert.equal((bodyFail.json() as { error: string }).error, "validation failed");
      assert.ok(!bodyFail.body.includes("sandbox") && !bodyFail.body.includes("unsupported provider"), bodyFail.body);

      const paramFail = await app.inject({ method: "POST", url: "/v1/unrelated/abc", payload: {} });
      assert.equal(paramFail.statusCode, 400, paramFail.body);
      assert.equal((paramFail.json() as { error: string }).error, "validation failed");
      assert.ok(!paramFail.body.includes("sandbox") && !paramFail.body.includes("unsupported provider"), paramFail.body);
    } finally {
      await app.close();
    }
  });

  it("helper HttpErrors cross the real boundary as 400 with the supported list", async () => {
    for (const throwable of [
      (() => {
        try {
          assertDeniedProvidersSupported({ deniedProviders: ["e2b"] }, "org");
        } catch (e) {
          return e;
        }
      })(),
      (() => {
        try {
          assertAllowedProvidersSupported({ allowedProviders: ["daytona"] });
        } catch (e) {
          return e;
        }
      })(),
    ]) {
      const app = await boundaryApp(throwable);
      try {
        const res = await app.inject({ method: "GET", url: "/probe" });
        assert.equal(res.statusCode, 400, res.body);
        assert.ok(res.body.includes("sandbox") && res.body.includes("host"), res.body);
      } finally {
        await app.close();
      }
    }
  });
});
