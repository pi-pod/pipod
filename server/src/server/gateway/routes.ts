import type { FastifyInstance } from "fastify";
import { HttpError, badRequest } from "../httperrors.js";
import type { GatewayService, ClientMessage, ServerMessage } from "./service.js";
import { superviseClientSocket } from "./client-supervision.js";
import { consumeTicket, refundTicket } from "./tickets.js";
import { AgentdTransportUnavailableError } from "../pods/supervisor.js";
import { getPod } from "../pods/store.js";
import { assertPersonalPodAccess } from "../edition.js";

/**
 * Distinct close codes so clients can react instead of guessing (spec §9.2): re-mint a
 * ticket on 4001, surface "pod not found" on 4404, offer a Start button on 4409, retry
 * later on 4500. 4400 is the client's own request being malformed. 4410 tells an agentd
 * supervisor the pod is archived: a permanent rejection, so the daemon must exit.
 */
export function wsCloseForError(e: unknown): { code: number; errCode: string; message: string; detail?: unknown } {
  const message = e instanceof Error ? e.message : "connection refused";
  if (e instanceof AgentdTransportUnavailableError) {
    return { code: 4500, errCode: "pod_transport_unavailable", message };
  }
  if (e instanceof HttpError) {
    const detail = e.detail as { reason?: string } | undefined;
    if (e.statusCode === 503 && ["host_starting", "host_stopped", "host_archived"].includes(detail?.reason ?? "")) {
      return { code: 4420, errCode: detail!.reason!, message, detail: e.detail };
    }
    switch (e.statusCode) {
      case 400:
        return { code: 4400, errCode: "bad_request", message };
      case 401:
      case 403:
        return { code: 4001, errCode: "unauthorized", message };
      case 404:
        return { code: 4404, errCode: "pod_not_found", message };
      case 409:
        return { code: 4409, errCode: "pod_unavailable", message };
    }
  }
  // Handshake refusals are the user's to fix. The JSON errCode is what the CLI prints;
  // 4500 keeps the close code in the existing set (Flutter maps unknown codes to reconnect).
  if (/version skew|speaks frame protocol/i.test(message)) {
    return { code: 4500, errCode: "version_skew", message };
  }
  return { code: 4500, errCode: "internal_error", message };
}

/**
 * WSS /v1/pods/:podId/session?ticket=…&from_seq=N&from_session=… (spec §9.2). Ticket
 * auth only: the JWT never appears in a URL (§13).
 */
const CLIENT_BUFFER_LIMIT = 8 * 1024 * 1024;
/** Largest inbound client message the gateway will parse: covers the 32 MiB image
 * budget + text + framing, while keeping a single socket from OOMing the process.
 * Oversize senders get an error frame (not a close) so the session survives. */
export const CLIENT_MESSAGE_LIMIT = 40 * 1024 * 1024;

/** Inbound size gate for client sockets. Pure so the boundary is unit-testable: exactly
 * at the limit passes, one byte over is rejected before JSON.parse allocates objects. */
export function inboundMessageTooLarge(byteLength: number): boolean {
  return byteLength > CLIENT_MESSAGE_LIMIT;
}

export function registerGatewayRoutes(app: FastifyInstance, gateway: GatewayService): void {
  app.get(
    "/pod-transport",
    {
      websocket: true,
      preValidation: [app.authenticate],
      config: { allowPodToken: true },
    },
    async (socket, req) => {
      const podId = req.auth.podId;
      if (!podId) {
        socket.close(4001, "pod_token_required");
        return;
      }
      try {
        await gateway.acceptPodTransport(podId, socket);
      } catch (error) {
        const message = error instanceof Error ? error.message : "connection refused";
        app.log.warn({ podId, error: message }, "pod transport rejected");
        const leaseHeld = /lease is held/.test(message);
        if (/archived pods cannot connect/.test(message)) {
          // A permanent rejection: nothing the daemon can do makes an archived pod attachable,
          // so the close code 4410 tells the daemon to exit instead of reconnect-looping.
          void gateway.cleanupRejectedTransport(podId);
          socket.close(4410, "pod_archived");
          return;
        }
        socket.close(leaseHeld ? 4409 : wsCloseForError(error).code, leaseHeld ? "lease_held" : wsCloseForError(error).errCode);
      }
    },
  );

  app.get("/pods/:podId/session", { websocket: true }, async (socket, req) => {
    const { podId } = req.params as { podId: string };
    const q = req.query as { ticket?: string; from_seq?: string; from_session?: string };
    let ticketConsumed = false;
    let socketClosed = false;
    let attachedClient: Awaited<ReturnType<GatewayService["attachClient"]>> | null = null;
    const attachController = new AbortController();
    // Supervision starts before any database/provider await. A client can time out while
    // attachClient is preparing replay; one idempotent detach owns timeout and close cleanup.
    superviseClientSocket({
      socket,
      onDetach: () => {
        socketClosed = true;
        attachController.abort(new Error("session socket closed during attach"));
        attachedClient?.detach();
      },
    });

    const send = (message: ServerMessage) => {
      if (socket.readyState !== socket.OPEN) return;
      if (socket.bufferedAmount > CLIENT_BUFFER_LIMIT) {
        socket.close(1013, "overloaded");
        return;
      }
      socket.send(JSON.stringify(message));
    };

    try {
      // Validate the request shape before spending the one-shot ticket.
      let fromSeq: number | null = null;
      if (q.from_seq !== undefined) {
        const parsed = Number(q.from_seq);
        if (!Number.isInteger(parsed) || parsed < 0) {
          throw badRequest(`from_seq must be a non-negative integer, got "${q.from_seq}"`);
        }
        fromSeq = parsed;
      }
      if (!q.ticket) throw badRequest("ticket required");

      const ticket = await consumeTicket(q.ticket, podId);
      ticketConsumed = true;
      // Tickets minted before this policy/deployment retain their caller identity;
      // consuming one is not permission to wake another user's personal host.
      await assertPersonalPodAccess(await getPod(ticket.orgId, podId), ticket.userId);

      attachedClient = await gateway.attachClient({
        orgId: ticket.orgId,
        podId,
        fromSeq,
        fromSessionId: q.from_session ?? null,
        sink: {
          send,
          close: (code, reason) => socket.close(code, reason),
        },
        signal: attachController.signal,
      });
      if (socketClosed || socket.readyState !== socket.OPEN) {
        attachedClient.detach();
        return;
      }

      socket.on("message", (raw: Buffer) => {
        if (inboundMessageTooLarge(raw.length)) {
          send({ type: "error", code: "message_too_large", message: "message exceeds 40 MiB limit" });
          return;
        }
        let message: ClientMessage;
        try {
          message = JSON.parse(raw.toString("utf8")) as ClientMessage;
        } catch {
          send({ type: "error", code: "malformed_message", message: "malformed message" });
          return;
        }
        attachedClient!.handle(message).catch((e) => {
          const close = wsCloseForError(e);
          if (close.code === 4420) {
            send({ type: "error", code: close.errCode, message: close.message, detail: close.detail });
            socket.close(close.code, close.errCode);
            return;
          }
          send({
            type: "error",
            code: "command_failed",
            message: e instanceof Error ? e.message : "command failed",
          });
        });
      });
    } catch (e) {
      // The ticket paid for an attach that never happened (pod stopped, gateway busy, …);
      // hand it back so the client's retry does not also need a fresh REST round-trip.
      if (ticketConsumed) await refundTicket(q.ticket!).catch(() => {});
      const close = wsCloseForError(e);
      send({ type: "error", code: close.errCode, message: close.message, ...(close.detail === undefined ? {} : { detail: close.detail }) });
      socket.close(close.code, close.errCode);
    }
  });
}
