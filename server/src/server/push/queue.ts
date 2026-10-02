import { query } from "../db/index.js";
import { uuidv7 } from "../ids.js";
import { observePushMessage } from "../metrics.js";

export interface PushPayload {
  title: string;
  body: string;
  interruptionLevel?: "passive" | "active" | "time-sensitive";
  data: {
    pod_id?: string;
    job_id?: string;
    org_id?: string;
    session_id?: string;
    seq?: number;
    kind: "turn_completed" | "session_ended" | "pod_error" | "idle_stop" | "archived" | "job_failed";
  };
}

export async function enqueuePush(userId: string, payload: PushPayload): Promise<void> {
  await query("INSERT INTO push_queue (id, user_id, payload) VALUES ($1, $2, $3)", [
    uuidv7(),
    userId,
    JSON.stringify(payload),
  ]);
  observePushMessage(payload.data.kind, "enqueued");
}
