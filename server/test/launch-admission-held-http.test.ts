import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import Fastify from "fastify";
import { installErrorHandler } from "../src/server/app.js";
import {
  launchAdmissionHeldError,
  LAUNCH_ADMISSION_HELD_CODE,
  LAUNCH_ADMISSION_HELD_MESSAGE,
  serviceUnavailable,
} from "../src/server/httperrors.js";
import { launchAdmissionHeldDetail } from "../src/server/safe-errors.js";

async function responseFor(error: unknown): Promise<{ statusCode: number; body: unknown }> {
  const app = Fastify({ logger: false });
  installErrorHandler(app);
  app.get("/probe", async () => { throw error; });
  await app.ready();
  try {
    const response = await app.inject({ method: "GET", url: "/probe" });
    return { statusCode: response.statusCode, body: response.json() as unknown };
  } finally {
    await app.close();
  }
}

describe("launch-admission-held HTTP boundary", () => {
  it("returns only fixed copy and a fresh exact detail for the issued gate error", async () => {
    const error = launchAdmissionHeldError();
    const canary = randomBytes(16).toString("hex");
    error.message = canary;

    const detail = launchAdmissionHeldDetail(error);
    assert.deepEqual(detail, { code: LAUNCH_ADMISSION_HELD_CODE, retryable: true });
    assert.notStrictEqual(detail, launchAdmissionHeldDetail(error));

    const response = await responseFor(error);
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.body, {
      error: LAUNCH_ADMISSION_HELD_MESSAGE,
      detail: { code: LAUNCH_ADMISSION_HELD_CODE, retryable: true },
    });
    assert.equal(JSON.stringify(response.body).includes(canary), false);
  });

  it("keeps a forged lookalike 503 opaque", async () => {
    const canary = randomBytes(16).toString("hex");
    const response = await responseFor(serviceUnavailable(canary, {
      code: LAUNCH_ADMISSION_HELD_CODE,
      retryable: true,
    }));
    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.body, { error: "internal server error", detail: null });
    assert.equal(JSON.stringify(response.body).includes(canary), false);
  });

  it("keeps malformed or mutated issued errors opaque without invoking accessors", async () => {
    const canary = randomBytes(16).toString("hex");
    const malformed: Array<{ error: ReturnType<typeof launchAdmissionHeldError>; accessorRead?: () => boolean }> = [];

    const wrongStatus = launchAdmissionHeldError();
    wrongStatus.statusCode = 400;
    malformed.push({ error: wrongStatus });

    const extraDetail = launchAdmissionHeldError();
    extraDetail.detail = { code: LAUNCH_ADMISSION_HELD_CODE, retryable: true, extra: canary };
    malformed.push({ error: extraDetail });

    const accessorDetail = launchAdmissionHeldError();
    let accessorRead = false;
    Object.defineProperty(accessorDetail, "detail", {
      configurable: true,
      get() {
        accessorRead = true;
        throw new Error(canary);
      },
    });
    malformed.push({ error: accessorDetail, accessorRead: () => accessorRead });

    const hostileDetail = launchAdmissionHeldError();
    hostileDetail.detail = new Proxy({}, {
      ownKeys() { throw new Error(canary); },
    });
    malformed.push({ error: hostileDetail });

    for (const testCase of malformed) {
      assert.equal(launchAdmissionHeldDetail(testCase.error), null);
      const response = await responseFor(testCase.error);
      assert.equal(response.statusCode, 500);
      assert.deepEqual(response.body, { error: "internal server error", detail: null });
      assert.equal(JSON.stringify(response.body).includes(canary), false);
      if (testCase.accessorRead) assert.equal(testCase.accessorRead(), false);
    }
  });
});
