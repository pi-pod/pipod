/**
 * Attach-phase telemetry. Records durations and failure phases without command text,
 * frame payloads, environment values, or output.
 */

export type AttachFailurePhase =
  | "shim_hello"
  | "pi_rpc_ready"
  | "transcript_bootstrap"
  | "transport_loss";

export interface AttachPhaseTelemetry {
  podId: string;
  sessionId?: string;
  provider: string;
  transportMs?: number;
  shimHelloMs?: number;
  getStateMs?: number;
  getEntriesMs?: number;
  clientHelloMs?: number;
  pendingRpcCount?: number;
  commandType?: string;
  responseBytes?: number;
  timeoutPhase?: AttachFailurePhase;
  decoderMalformed?: number;
  decoderNoise?: number;
  decoderPendingBytes?: number;
  retirementReason?: string;
}

export function attachPhaseMessage(phase: AttachFailurePhase, detail?: string): string {
  const base = {
    shim_hello: "shim startup/hello failed",
    pi_rpc_ready: "Pi is not RPC-ready",
    transcript_bootstrap: "transcript bootstrap timed out",
    transport_loss: "transport lost after readiness",
  }[phase];
  return detail ? `${base}: ${detail}` : base;
}

/** Structured, secret-free attach log line. */
export function formatAttachTelemetry(event: string, fields: AttachPhaseTelemetry): string {
  const parts = [`attach ${event}`, `pod=${fields.podId}`, `provider=${fields.provider}`];
  if (fields.sessionId) parts.push(`session=${fields.sessionId}`);
  for (const [key, value] of Object.entries(fields)) {
    if (
      key === "podId" ||
      key === "sessionId" ||
      key === "provider"
    ) {
      continue;
    }
    if (value === undefined) continue;
    parts.push(`${key}=${value}`);
  }
  return parts.join(" ");
}

export function phaseFromError(error: unknown): AttachFailurePhase | undefined {
  const message = error instanceof Error ? error.message : String(error);
  if (/no hello from the pod shim|hello handshake|verifyHello|shim/i.test(message)) {
    return "shim_hello";
  }
  if (/get_state|RPC-ready|not RPC-ready|did not answer get_state/i.test(message)) {
    return "pi_rpc_ready";
  }
  if (/get_entries|transcript bootstrap/i.test(message)) {
    return "transcript_bootstrap";
  }
  if (/transport|channel stopped|liveness/i.test(message)) {
    return "transport_loss";
  }
  return undefined;
}
