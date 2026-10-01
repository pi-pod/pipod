/**
 * Typed 503 for Boat host demand at the HTTP boundary.
 *
 * Production 2026-09-09, `SANDBOX_HOST_BACKEND=boat` with a personal host
 * asleep: `POST /v1/pods/:id/files` answered
 * `500 {"error":"internal server error","detail":null}` on every retry while
 * the log recorded the 503 behind it and the durable `resume` had already been
 * committed. The documented retryable `host_starting` signal was a 503, so it
 * missed the `< 500` passthrough, matched neither the `fleet_unavailable` nor
 * the `capacity_wait_expired` allowlist, and fell through to the generic 500.
 *
 * The boundary now recognizes the allowlisted host-demand shape and answers
 * 503 with static per-reason copy plus a freshly built, fully validated detail.
 * Everything unrecognized or malformed still fails closed to 500.
 *
 * Pure unit tests (no database): a bare Fastify instance with the real app
 * error boundary. `boat-demand-503-postgres` drives the same boundary through
 * the real pod route against a sleeping host.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Fastify from "fastify";
import { installErrorHandler } from "../src/server/app.js";
import { HttpError, badRequest, serviceUnavailable } from "../src/server/httperrors.js";
import { requireHostAwake, type BoatState } from "../src/server/pods/hostidentity.js";
import { CAPACITY_WAIT_EXPIRED_CODE } from "../src/server/pods/provision-failure.js";
import { fleetUnavailableError } from "../src/server/pods/sandboxfleet.js";
import {
  BOAT_HOST_DEMAND_MESSAGE,
  FLEET_UNAVAILABLE_MESSAGE,
  boatHostDemandDetail,
  renderBoatHostDemand,
} from "../src/server/safe-errors.js";

async function boundaryApp(throwable: unknown) {
  const app = Fastify();
  installErrorHandler(app);
  app.get("/probe", async () => {
    throw throwable;
  });
  await app.ready();
  return app;
}

async function answer(throwable: unknown) {
  const app = await boundaryApp(throwable);
  try {
    const response = await app.inject({ method: "GET", url: "/probe" });
    return { statusCode: response.statusCode, body: response.json() as { error: string; detail: unknown } };
  } finally {
    await app.close();
  }
}

const HOST_ID = "boat-6f1d0a1e-4d6b-4a0e-9a9a-0f1c2d3e4f50";
const OPERATION_ID = "0f8f9a10-1b2c-4d3e-8f90-a1b2c3d4e5f6";

/** The `ensureOwnedHostReady` throw, field for field (boat/demand.ts). */
function hostStartingThrow(overrides: Record<string, unknown> = {}) {
  return serviceUnavailable("Your workstation is starting. This may take several minutes", {
    kind: "admission", reason: "host_starting", resource: "transitions", unit: "count", retryable: true,
    hostId: HOST_ID, statusHref: `/v1/workstations/${encodeURIComponent(HOST_ID)}`,
    operation: {
      id: OPERATION_ID, kind: "resume", state: "pending", phase: "requested",
      deadlineAt: new Date("2026-09-09T17:20:00.000Z"), retryAt: null, errorCode: null,
    },
    state: "starting", retryAfterMs: 10_000, ...overrides,
  });
}

/** The `BoatControlError` conversion in the same function, field for field. */
function boatControlThrow(code: string) {
  return serviceUnavailable("your workstation cannot start yet", {
    kind: "admission", reason: code, retryable: code !== "host_retired",
    resource: "transitions", unit: "count",
  });
}

describe("Boat host-demand HTTP boundary", () => {
  it("answers the sleeping-host demand throw as 503 with the documented detail", async () => {
    const { statusCode, body } = await answer(hostStartingThrow());
    assert.equal(statusCode, 503, JSON.stringify(body));
    assert.deepEqual(body, {
      error: "Your workstation is starting. This may take several minutes",
      detail: {
        kind: "admission",
        reason: "host_starting",
        resource: "transitions",
        unit: "count",
        retryable: true,
        hostId: HOST_ID,
        statusHref: `/v1/workstations/${HOST_ID}`,
        state: "starting",
        retryAfterMs: 10_000,
        operation: {
          id: OPERATION_ID,
          kind: "resume",
          state: "pending",
          phase: "requested",
          deadlineAt: "2026-09-09T17:20:00.000Z",
          retryAt: null,
          errorCode: null,
        },
      },
    });
  });

  it("answers the real requireHostAwake throws for every host state it reports", async () => {
    const expected: Record<string, { reason: string; retryable: boolean; error: string }> = {
      stopped: { reason: "host_stopped", retryable: true, error: "your workstation is asleep; start it, then retry" },
      deleted: { reason: "host_deleted", retryable: false, error: "your workstation has been deleted; create a new one" },
      starting: { reason: "host_starting", retryable: true, error: "Your workstation is starting. This may take several minutes" },
      stopping: { reason: "host_starting", retryable: true, error: "Your workstation is starting. This may take several minutes" },
    };
    for (const [boatState, want] of Object.entries(expected)) {
      // The real hostidentity throw, not a copy of its shape.
      const thrown = (() => {
        try {
          requireHostAwake({ boat_state: boatState as BoatState });
          return null;
        } catch (error) {
          return error;
        }
      })();
      assert.ok(thrown instanceof HttpError, boatState);
      const { statusCode, body } = await answer(thrown);
      assert.equal(statusCode, 503, `${boatState}: ${JSON.stringify(body)}`);
      assert.equal(body.error, want.error);
      assert.deepEqual(body.detail, {
        kind: "admission",
        reason: want.reason,
        resource: "transitions",
        unit: "count",
        retryable: want.retryable,
      });
    }
  });

  it("answers the allowlisted BoatControlError codes and keeps the rest generic", async () => {
    const allowed: Record<string, boolean> = {
      host_retired: false,
      host_requires_reconciliation: true,
      boat_starts_disabled: true,
    };
    for (const [code, retryable] of Object.entries(allowed)) {
      const { statusCode, body } = await answer(boatControlThrow(code));
      assert.equal(statusCode, 503, `${code}: ${JSON.stringify(body)}`);
      assert.deepEqual(body.detail, {
        kind: "admission", reason: code, resource: "transitions", unit: "count", retryable,
      });
      assert.notEqual(body.error, "internal server error");
    }
    // Control-plane faults: their codes name internal state, so they stay 500.
    for (const code of ["invalid_boat_pins", "user_missing", "host_org_mismatch", "host_auth_missing"]) {
      const { statusCode, body } = await answer(boatControlThrow(code));
      assert.equal(statusCode, 500, `${code}: ${JSON.stringify(body)}`);
      assert.deepEqual(body, { error: "internal server error", detail: null });
    }
  });

  it("returns only allowlisted fields and never the thrown object", async () => {
    const thrown = hostStartingThrow({
      // A forged/foreign field on the detail, and a hostile nested one.
      hostUrl: "https://boat-secret.internal/?token=shhh",
      operation: {
        id: OPERATION_ID, kind: "resume", state: "pending", phase: "requested",
        deadlineAt: new Date("2026-09-09T17:20:00.000Z"), retryAt: null, errorCode: null,
        phase_data: { runtimeSha256: "a".repeat(64), orgId: "team_secret" },
        vendorRequestId: "vendor-123", leaseOwner: "boat-worker-1",
      },
    });
    const { statusCode, body } = await answer(thrown);
    assert.equal(statusCode, 503, JSON.stringify(body));
    const detail = body.detail as Record<string, unknown>;
    assert.deepEqual(Object.keys(detail).sort(), [
      "hostId", "kind", "operation", "reason", "resource", "retryAfterMs", "retryable", "state", "statusHref", "unit",
    ]);
    assert.deepEqual(Object.keys(detail["operation"] as Record<string, unknown>).sort(), [
      "deadlineAt", "errorCode", "id", "kind", "phase", "retryAt", "state",
    ]);
    const serialized = JSON.stringify(body);
    for (const secret of ["shhh", "team_secret", "vendor-123", "boat-worker-1", "phase_data"]) {
      assert.equal(serialized.includes(secret), false, secret);
    }
    // The recognizer builds a new object; the thrown detail is never returned.
    const detailOf = (error: unknown) => (error as { detail?: unknown }).detail;
    assert.notEqual(boatHostDemandDetail(thrown), detailOf(thrown));
  });

  it("fails closed to 500 for forged or malformed host-demand shapes", async () => {
    const malformed: Record<string, unknown> = {
      "unknown reason": { reason: "host_on_fire" },
      "non-admission kind": { kind: "fleet" },
      "missing discriminator": { kind: undefined },
      "foreign resource": { resource: "memory" },
      "foreign unit": { unit: "bytes" },
      "stringly retryable": { retryable: "true" },
      "host id off the route rule": { hostId: "boat-../../etc/passwd", statusHref: "/v1/workstations/boat-..%2F..%2Fetc%2Fpasswd" },
      "host id without the boat- prefix": { hostId: "host-1", statusHref: "/v1/workstations/host-1" },
      "href the host id does not generate": { statusHref: "https://evil.invalid/v1/workstations/x" },
      "href without a host id": { hostId: undefined, statusHref: `/v1/workstations/${HOST_ID}` },
      "unknown host state": { state: "melting" },
      "hint past the 300s bound": { retryAfterMs: 300_001 },
      "negative hint": { retryAfterMs: -1 },
      "non-finite hint": { retryAfterMs: Number.POSITIVE_INFINITY },
      "stringly hint": { retryAfterMs: "10000" },
      "operation that is not an object": { operation: "resume" },
      "operation id that is not a uuid": { operation: { id: "../../etc", kind: "resume", state: "pending", phase: "requested", deadlineAt: new Date(), retryAt: null, errorCode: null } },
      "operation kind off the column": { operation: { id: OPERATION_ID, kind: "exfiltrate", state: "pending", phase: "requested", deadlineAt: new Date(), retryAt: null, errorCode: null } },
      "operation state off the column": { operation: { id: OPERATION_ID, kind: "resume", state: "melting", phase: "requested", deadlineAt: new Date(), retryAt: null, errorCode: null } },
      "operation phase carrying prose": { operation: { id: OPERATION_ID, kind: "resume", state: "pending", phase: "failed: token sk-live-1234 rejected by https://boat.invalid", deadlineAt: new Date(), retryAt: null, errorCode: null } },
      "operation error code carrying prose": { operation: { id: OPERATION_ID, kind: "resume", state: "pending", phase: "requested", deadlineAt: new Date(), retryAt: null, errorCode: "vendor said: no (https://boat.invalid)" } },
      "operation deadline that is not an instant": { operation: { id: OPERATION_ID, kind: "resume", state: "pending", phase: "requested", deadlineAt: "soon", retryAt: null, errorCode: null } },
      "operation missing a status field": { operation: { id: OPERATION_ID, kind: "resume", state: "pending", phase: "requested", retryAt: null, errorCode: null } },
    };
    for (const [name, override] of Object.entries(malformed)) {
      const { statusCode, body } = await answer(hostStartingThrow(override as Record<string, unknown>));
      assert.equal(statusCode, 500, `${name}: ${JSON.stringify(body)}`);
      assert.deepEqual(body, { error: "internal server error", detail: null });
    }
    // Non-HttpError throws and the untyped host 503s stay generic too.
    for (const throwable of [
      new Error("boom"),
      Object.assign(new Error("nope"), { statusCode: 503 }),
      serviceUnavailable("the pod's host is asleep or starting"),
      serviceUnavailable("host endpoint is not ready", { reason: "host_starting", retryable: true }),
      new HttpError(502, "bad gateway", { kind: "admission", reason: "host_starting", resource: "transitions", unit: "count", retryable: true }),
    ]) {
      const { statusCode, body } = await answer(throwable);
      assert.equal(statusCode, 500, JSON.stringify(body));
      assert.deepEqual(body, { error: "internal server error", detail: null });
    }
  });

  it("leaves the other boundary paths exactly as they were", async () => {
    const fleet = await answer(fleetUnavailableError("no sandbox host in the fleet answered with room for a sandbox"));
    assert.equal(fleet.statusCode, 503, JSON.stringify(fleet.body));
    assert.deepEqual(fleet.body, {
      error: FLEET_UNAVAILABLE_MESSAGE,
      detail: { code: "fleet_unavailable", reason: "fleet_unavailable", retryable: true, retryAfterMs: 15_000 },
    });

    const wait = await answer(serviceUnavailable("the host is still at capacity; retry the wake shortly", {
      code: CAPACITY_WAIT_EXPIRED_CODE, reason: "fairness_degraded", waitedSeconds: 5,
    }));
    assert.equal(wait.statusCode, 503, JSON.stringify(wait.body));
    assert.deepEqual(wait.body.detail, {
      code: "capacity_wait_expired", reason: "fairness_degraded", waitedSeconds: 5,
    });

    const client = await answer(badRequest("no sandbox credential", "store a key"));
    assert.equal(client.statusCode, 400, JSON.stringify(client.body));
    assert.deepEqual(client.body, { error: "no sandbox credential", detail: "store a key" });
  });

  it("keeps the in-process callers that already classify these throws unchanged", async () => {
    // lifecycle.isHostStartingRetryable, workers/jobs.hostStarting and
    // gateway.wsCloseForError read the throw, never the HTTP body: the
    // recognizer must not alter the thrown error it inspects.
    const thrown = hostStartingThrow();
    const before = JSON.stringify(thrown.detail);
    assert.ok(boatHostDemandDetail(thrown));
    assert.equal(JSON.stringify(thrown.detail), before);
    assert.equal(thrown.statusCode, 503);
    assert.equal(thrown.message, "Your workstation is starting. This may take several minutes");
  });

  it("reads each field once, from own data properties only", async () => {
    // The recognizer validates a field and then reads it again to copy it. An
    // accessor could make those two reads disagree, and an inherited property
    // could answer a lookup we never meant to accept. Neither is reachable from
    // the server-constructed throw sites; the snapshot is what keeps it that way.
    let reads = 0;
    const twoFaced = serviceUnavailable("crafted", Object.defineProperties({
      kind: "admission", reason: "host_starting", resource: "transitions", unit: "count",
      retryable: true, state: "starting",
    }, {
      hostId: {
        enumerable: true,
        get() {
          reads += 1;
          return reads === 1 ? HOST_ID : "boat-someone-elses-host";
        },
      },
    }));
    const accessor = await answer(twoFaced);
    assert.equal(accessor.statusCode, 503, JSON.stringify(accessor.body));
    assert.equal(reads, 0, "an accessor on the thrown detail must never be invoked");
    assert.deepEqual(accessor.body.detail, {
      kind: "admission", reason: "host_starting", resource: "transitions",
      unit: "count", retryable: true, state: "starting",
    }, "a getter-supplied hostId must be dropped, not copied and not re-read");

    const inherited = serviceUnavailable("crafted", Object.create(
      { hostId: HOST_ID, operation: null },
      Object.getOwnPropertyDescriptors({
        kind: "admission", reason: "host_starting", resource: "transitions", unit: "count",
        retryable: true,
      }),
    ));
    const proto = await answer(inherited);
    assert.equal(proto.statusCode, 503, JSON.stringify(proto.body));
    assert.deepEqual(proto.body.detail, {
      kind: "admission", reason: "host_starting", resource: "transitions",
      unit: "count", retryable: true,
    }, "inherited hostId/operation must not reach the body");
  });

  it("never renders a prototype member as client copy", () => {
    // `reason` is allowlisted before render, so this is unreachable today; a
    // plain object lookup would still answer "constructor" with a function.
    for (const reason of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      const copy = renderBoatHostDemand({ reason });
      assert.equal(typeof copy, "string", reason);
      assert.equal(copy, BOAT_HOST_DEMAND_MESSAGE, reason);
    }
  });
});
