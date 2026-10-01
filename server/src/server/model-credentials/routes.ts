/**
 * Account model-credential HTTP + login WebSocket routes (frozen protocol).
 *
 * Human JWT only on REST (never allowPodToken). The login WebSocket authenticates
 * solely by a one-shot ticket so the account JWT never appears in a URL.
 *
 * Frames, close codes, and done-error codes match `/tmp/briefs/credential-protocol.md`
 * exactly. Prompt/event payloads are a whitelist of protocol fields — never raw
 * AuthPrompt.signal or provider secrets.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { audit } from "../audit.js";
import { requirePermission, type AuthContext } from "../auth/plugin.js";
import { HttpError, notFound } from "../httperrors.js";
import { withPodSandbox } from "../pods/lifecycle.js";
import { getPod } from "../pods/store.js";
import type { PodServiceDeps } from "../pods/types.js";
import type { KekProvider } from "../secrets/crypto.js";
import {
  classifyCredentialMeta,
  createModelCredentialBroker,
  listConnectableProviders,
} from "./broker.js";
import { brokerCapability, type BrokerCapability } from "./dependencies.js";
import { acquireLease } from "./lease.js";
import {
  consumeLoginTicket,
  createLoginTicket,
  type ConsumedLoginTicket,
  type LoginExec,
} from "./login.js";
import {
  materializeCredentialLease,
  persistPodCredentialContract,
  readPodCredentialContract,
} from "./materializer.js";
import { ensureFreshCredential, MIN_VALIDITY_MS, type RefreshExec } from "./refresh.js";
import { listCredentialMeta } from "./store.js";
import type {
  BrokerAuthInteraction,
  BrokerAuthType,
  CredentialStatus,
  CredentialSubject,
  ModelCredentialBroker,
} from "./types.js";

export interface ModelCredentialRouteDeps {
  kek: KekProvider;
  /** Present in the server app; optional for isolated broker route tests. */
  podDeps?: PodServiceDeps;
  broker?: ModelCredentialBroker;
  loginExec?: LoginExec;
  refreshExec?: RefreshExec;
}

const ProviderParams = z.object({
  providerId: z.string().min(1).max(200),
});

const LoginTicketBody = z
  .object({
    authType: z.enum(["oauth", "api_key"]),
    podId: z.string().uuid().nullish(),
  })
  .strict();

const WS_INVALID_TICKET = 4001;
const WS_NORMAL_CLOSE = 1000;
const WS_DONE_REASON = "done";
const WS_PING_INTERVAL_MS = 20_000;

const DONE_ERROR_CODES = ["login_failed", "cancelled", "credential_provider_unsupported", "missing_refresh_token"] as const;
type DoneErrorCode = (typeof DONE_ERROR_CODES)[number];

const DONE_ERROR_MESSAGES: Record<DoneErrorCode, string> = {
  login_failed: "Login failed.",
  cancelled: "Login was cancelled.",
  credential_provider_unsupported: "Account login is not supported for this provider.",
  missing_refresh_token: "OAuth login did not produce a usable refresh token.",
};

const DONE_ERROR_CODE_SET = new Set<string>(DONE_ERROR_CODES);

type AuthPrompt = Parameters<BrokerAuthInteraction["prompt"]>[0];
type AuthEvent = Parameters<BrokerAuthInteraction["notify"]>[0];

function subjectOf(auth: AuthContext): CredentialSubject {
  return { orgId: auth.orgId, userId: auth.userId };
}

function assertPodAccess(pod: { user_id: string }, auth: AuthContext): void {
  if (pod.user_id === auth.userId) return;
  requirePermission(auth, "pods:manage_any");
}

function unsupportedLoginError(
  providerId: string,
  authType: BrokerAuthType,
  capability: BrokerCapability,
): HttpError {
  let message: string;
  if (!capability.supported) {
    message = `Account login is not supported for provider "${providerId}".`;
  } else if (capability.apiKey && authType === "oauth") {
    message = `Account oauth login is not supported for provider "${providerId}". Store a scoped API-key secret instead.`;
  } else {
    message = `Account ${authType} login is not supported for provider "${providerId}".`;
  }
  return new HttpError(400, "credential_provider_unsupported", {
    code: "credential_provider_unsupported",
    message,
    provider: providerId,
  });
}

function assertLoginCapability(providerId: string, authType: BrokerAuthType): void {
  const capability = brokerCapability(providerId);
  const methodSupported = authType === "oauth" ? capability.oauth : capability.apiKey;
  if (!methodSupported) throw unsupportedLoginError(providerId, authType, capability);
}

async function auditRoute(
  auth: Pick<AuthContext, "orgId" | "userId">,
  action: string,
  providerId: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await audit({
    orgId: auth.orgId,
    actorId: auth.userId,
    action,
    targetType: "model_credential",
    targetId: providerId,
    detail: { provider: providerId, ...detail },
  });
}

function isAbortError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const name = (error as { name?: unknown }).name;
  if (name === "AbortError") return true;
  if (error instanceof Error && error.message === "login cancelled") return true;
  return false;
}

function detailMessage(detail: unknown): string | undefined {
  if (detail === null || typeof detail !== "object" || Array.isArray(detail)) return undefined;
  const message = (detail as { message?: unknown }).message;
  return typeof message === "string" && message.length > 0 ? message : undefined;
}

function detailCode(detail: unknown): string | undefined {
  if (detail === null || typeof detail !== "object" || Array.isArray(detail)) return undefined;
  const code = (detail as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function loginDoneError(error: unknown): { code: DoneErrorCode; message: string } {
  if (isAbortError(error)) {
    return { code: "cancelled", message: DONE_ERROR_MESSAGES.cancelled };
  }
  if (error instanceof HttpError) {
    const code = DONE_ERROR_CODE_SET.has(error.message)
      ? (error.message as DoneErrorCode)
      : detailCode(error.detail) && DONE_ERROR_CODE_SET.has(detailCode(error.detail)!)
        ? (detailCode(error.detail) as DoneErrorCode)
        : undefined;
    if (code) {
      return { code, message: detailMessage(error.detail) ?? DONE_ERROR_MESSAGES[code] };
    }
  }
  return { code: "login_failed", message: DONE_ERROR_MESSAGES.login_failed };
}

function abortError(): Error {
  const err = new Error("login cancelled");
  err.name = "AbortError";
  return err;
}

async function applyLoginToPod(
  deps: ModelCredentialRouteDeps,
  ticket: ConsumedLoginTicket,
): Promise<void> {
  if (!ticket.podId) return;
  const pod = await getPod(ticket.orgId, ticket.podId);
  // Login tickets are account-scoped; never graft one person's credential onto another
  // owner's contract, even if an administrator could otherwise inspect that pod.
  if (pod.user_id !== ticket.userId) {
    throw new HttpError(403, "credential login pod owner changed");
  }
  const current = await readPodCredentialContract(pod);
  const contract = [...new Set([...current, ticket.providerId])].sort();
  await persistPodCredentialContract(pod.id, contract);

  // A podId denotes an attached login. Isolated route tests omit podDeps; production always
  // supplies them. Sleeping/non-materialized pods retain the contract and receive the lease
  // on their next strict readiness or best-effort wake pass.
  if (!deps.podDeps || pod.provider_state !== "started" || !pod.provider_sandbox_id) return;
  const { lease } = await acquireLease(
    deps.kek,
    { orgId: pod.org_id, userId: pod.user_id },
    contract,
    MIN_VALIDITY_MS,
  );
  await withPodSandbox(deps.podDeps, pod, (sandbox) =>
    materializeCredentialLease(sandbox, lease),
  );
}

function serializePrompt(prompt: AuthPrompt): Record<string, unknown> {
  const body: Record<string, unknown> = {
    type: prompt.type,
    message: prompt.message,
  };
  if ("placeholder" in prompt && typeof prompt.placeholder === "string") {
    body.placeholder = prompt.placeholder;
  }
  if (prompt.type === "select") {
    body.options = prompt.options.map((option) => {
      const item: { id: string; label: string; description?: string } = {
        id: option.id,
        label: option.label,
      };
      if (option.description) item.description = option.description;
      return item;
    });
  }
  return body;
}

function serializeEvent(event: AuthEvent): Record<string, unknown> {
  switch (event.type) {
    case "info": {
      const body: Record<string, unknown> = { type: "info", message: event.message };
      if (event.links && event.links.length > 0) {
        body.links = event.links.map((link) => {
          const item: { url: string; label?: string } = { url: link.url };
          if (link.label) item.label = link.label;
          return item;
        });
      }
      return body;
    }
    case "auth_url": {
      const body: Record<string, unknown> = { type: "auth_url", url: event.url };
      if (event.instructions) body.instructions = event.instructions;
      return body;
    }
    case "device_code": {
      const body: Record<string, unknown> = {
        type: "device_code",
        userCode: event.userCode,
        verificationUri: event.verificationUri,
      };
      if (event.intervalSeconds !== undefined) body.intervalSeconds = event.intervalSeconds;
      if (event.expiresInSeconds !== undefined) body.expiresInSeconds = event.expiresInSeconds;
      return body;
    }
    case "progress":
      return { type: "progress", message: event.message };
  }
}

function rawToString(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  if (Array.isArray(raw)) return Buffer.concat(raw.filter(Buffer.isBuffer)).toString("utf8");
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString("utf8");
  return String(raw);
}

export function registerModelCredentialRoutes(app: FastifyInstance, deps: ModelCredentialRouteDeps): void {
  const broker =
    deps.broker ??
    createModelCredentialBroker(deps.kek, {
      loginExec: deps.loginExec,
      refreshExec: deps.refreshExec,
    });
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/model-credentials",
    { preHandler: [app.authenticate] },
    async (req) => {
      const [credentials, providers] = await Promise.all([
        broker.status(subjectOf(req.auth)),
        listConnectableProviders(),
      ]);
      return { credentials, providers };
    },
  );

  r.post(
    "/model-credentials/:providerId/login-ticket",
    {
      preHandler: [app.authenticate],
      schema: { params: ProviderParams, body: LoginTicketBody },
    },
    async (req, reply) => {
      const { providerId } = req.params;
      const authType = req.body.authType;
      const podId = req.body.podId ?? null;
      try {
        assertLoginCapability(providerId, authType);
        if (podId) {
          const pod = await getPod(req.auth.orgId, podId);
          assertPodAccess(pod, req.auth);
        }
        const minted = await createLoginTicket(subjectOf(req.auth), providerId, authType, podId);
        await auditRoute(req.auth, "model_credentials.login_ticket", providerId, {
          outcome: "ok",
        });
        return reply.code(201).send(minted);
      } catch (error) {
        try {
          await auditRoute(req.auth, "model_credentials.login_ticket", providerId, {
            outcome: error instanceof HttpError ? error.message : "error",
          });
        } catch {
          // keep original
        }
        throw error;
      }
    },
  );

  r.post(
    "/model-credentials/:providerId/test",
    {
      preHandler: [app.authenticate],
      schema: { params: ProviderParams },
    },
    async (req) => {
      const { providerId } = req.params;
      const subject = subjectOf(req.auth);
      try {
        const outcome = await ensureFreshCredential(
          deps.kek,
          subject,
          providerId,
          MIN_VALIDITY_MS,
          { refreshExec: deps.refreshExec },
        );
        if (outcome.state === "missing") {
          await auditRoute(req.auth, "model_credentials.test", providerId, { outcome: "missing" });
          throw notFound("credential not found");
        }
        const meta = (await listCredentialMeta(subject)).find((row) => row.providerId === providerId);
        if (!meta) {
          await auditRoute(req.auth, "model_credentials.test", providerId, { outcome: "missing" });
          throw notFound("credential not found");
        }
        const status = classifyCredentialMeta(meta);
        await auditRoute(req.auth, "model_credentials.test", providerId, { outcome: status.state });
        return { status };
      } catch (error) {
        if (error instanceof HttpError && error.statusCode === 404) throw error;
        try {
          await auditRoute(req.auth, "model_credentials.test", providerId, {
            outcome: error instanceof HttpError ? error.message : "error",
          });
        } catch {
          // keep original
        }
        throw error;
      }
    },
  );

  r.delete(
    "/model-credentials/:providerId",
    {
      preHandler: [app.authenticate],
      schema: { params: ProviderParams },
    },
    async (req, reply) => {
      const removed = await broker.remove(subjectOf(req.auth), req.params.providerId);
      if (!removed) throw notFound("credential not found");
      return reply.code(204).send();
    },
  );

  // Ticket-only: no authenticate preHandler, no allowPodToken.
  app.get(
    "/model-credentials/:providerId/login",
    { websocket: true },
    async (socket, req) => {
      const providerId = (req.params as { providerId?: string }).providerId ?? "";
      const ticketValue = (req.query as { ticket?: unknown }).ticket;
      if (typeof ticketValue !== "string" || ticketValue.length === 0) {
        socket.close(WS_INVALID_TICKET, "invalid_ticket");
        return;
      }

      const ticket = await consumeLoginTicket(ticketValue);
      if (!ticket || ticket.providerId !== providerId) {
        socket.close(WS_INVALID_TICKET, "invalid_ticket");
        return;
      }

      const controller = new AbortController();
      const pending = new Map<string, { resolve: (value: string) => void; reject: (error: Error) => void }>();
      let promptSeq = 0;
      let finished = false;

      const pingTimer = setInterval(() => {
        if (socket.readyState === socket.OPEN) {
          try {
            socket.ping();
          } catch {
            // socket already closing
          }
        }
      }, WS_PING_INTERVAL_MS);

      const rejectPending = (error: Error) => {
        for (const waiter of pending.values()) waiter.reject(error);
        pending.clear();
      };

      const cleanup = () => {
        clearInterval(pingTimer);
        rejectPending(abortError());
      };

      const sendFrame = (frame: Record<string, unknown>): boolean => {
        if (socket.readyState !== socket.OPEN) return false;
        try {
          socket.send(JSON.stringify(frame));
          return true;
        } catch {
          return false;
        }
      };

      const finishSuccess = (status: CredentialStatus) => {
        if (finished) return;
        finished = true;
        sendFrame({ type: "done", ok: true, status });
        try {
          socket.close(WS_NORMAL_CLOSE, WS_DONE_REASON);
        } catch {
          // already closed
        }
        cleanup();
      };

      const finishFailure = (error: unknown) => {
        if (finished) return;
        finished = true;
        const done = loginDoneError(error);
        sendFrame({ type: "done", ok: false, error: { code: done.code, message: done.message } });
        try {
          socket.close(WS_NORMAL_CLOSE, WS_DONE_REASON);
        } catch {
          // already closed
        }
        cleanup();
      };

      const cancelLogin = () => {
        if (finished || controller.signal.aborted) return;
        controller.abort(abortError());
        rejectPending(abortError());
      };

      socket.on("close", () => {
        cleanup();
        if (!finished) controller.abort(abortError());
      });

      socket.on("message", (raw: unknown) => {
        if (finished) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(rawToString(raw));
        } catch {
          cancelLogin();
          return;
        }
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          cancelLogin();
          return;
        }
        const message = parsed as { type?: unknown; id?: unknown; value?: unknown };
        if (message.type === "cancel") {
          cancelLogin();
          return;
        }
        if (message.type === "response" && typeof message.id === "string" && typeof message.value === "string") {
          const waiter = pending.get(message.id);
          if (!waiter) {
            cancelLogin();
            return;
          }
          pending.delete(message.id);
          waiter.resolve(message.value);
          return;
        }
        cancelLogin();
      });

      if (socket.readyState !== socket.OPEN) {
        cleanup();
        return;
      }

      const interaction: BrokerAuthInteraction = {
        signal: controller.signal,
        prompt: (prompt) =>
          new Promise<string>((resolve, reject) => {
            if (controller.signal.aborted) {
              reject(abortError());
              return;
            }
            promptSeq += 1;
            const id = `p${promptSeq}`;
            const fail = () => {
              pending.delete(id);
              reject(abortError());
            };
            if (prompt.signal?.aborted) {
              reject(abortError());
              return;
            }
            pending.set(id, { resolve, reject });
            prompt.signal?.addEventListener("abort", fail, { once: true });
            if (!sendFrame({ type: "prompt", id, prompt: serializePrompt(prompt) })) {
              pending.delete(id);
              reject(abortError());
            }
          }),
        notify: (event) => {
          sendFrame({ type: "event", event: serializeEvent(event) });
        },
      };

      try {
        const status = await broker.login(
          { orgId: ticket.orgId, userId: ticket.userId },
          providerId,
          ticket.authType,
          interaction,
          { signal: controller.signal },
        );
        await applyLoginToPod(deps, ticket);
        finishSuccess(status);
      } catch (error) {
        finishFailure(error);
      }
    },
  );
}
