import { query, tx } from "../db/index.js";
import { observePushMessage } from "../metrics.js";
import type { ApnsClient } from "../push/apns.js";
import type { FcmClient } from "../push/fcm.js";
import type { PushPayload } from "../push/queue.js";
import type { WorkerDeps } from "./index.js";

const MAX_ATTEMPTS = 8;

export interface PushDevice {
  apns_token: string;
  environment: string;
  token_kind: "apns" | "fcm";
}

interface PushClients {
  apns: Pick<ApnsClient, "configured" | "send">;
  fcm: Pick<FcmClient, "configured" | "send">;
}

export async function deliverPushToDevices(args: {
  devices: PushDevice[];
  payload: PushPayload;
  clients: PushClients;
  prune: (device: PushDevice) => Promise<void>;
}): Promise<{ delivered: boolean; attempted: boolean }> {
  const apnsConfigured = args.clients.apns.configured();
  const fcmConfigured = args.clients.fcm.configured();
  let delivered = false;
  let attempted = false;

  for (const device of args.devices) {
    if (device.token_kind === "apns") {
      if (!apnsConfigured) continue;
      attempted = true;
      const result = await args.clients.apns.send(
        device.apns_token,
        device.environment,
        args.payload,
      );
      if (result.ok) delivered = true;
      if (result.tokenGone) await args.prune(device);
    } else if (device.token_kind === "fcm") {
      if (!fcmConfigured) continue;
      attempted = true;
      const result = await args.clients.fcm.send(device.apns_token, args.payload);
      if (result.ok) delivered = true;
      if (result.tokenGone) await args.prune(device);
    }
  }

  return { delivered, attempted };
}

/** Queue-driven push delivery with retry/backoff; prunes tokens reported dead (spec §12). */
export async function runPushDispatcher(
  deps: WorkerDeps,
  apns: ApnsClient,
  fcm: FcmClient,
): Promise<void> {
  if (!apns.configured() && !fcm.configured()) return;

  const due = await tx(async (c) => {
    const rows = await c.query<{ id: string; user_id: string; payload: PushPayload; attempts: number }>(
      `SELECT id, user_id, payload, attempts FROM push_queue
       WHERE delivered_at IS NULL AND failed_at IS NULL AND next_attempt <= now()
       ORDER BY next_attempt LIMIT 20 FOR UPDATE SKIP LOCKED`,
    );
    if (rows.rows.length > 0) {
      await c.query(
        `UPDATE push_queue SET attempts = attempts + 1,
           next_attempt = now() + make_interval(mins => power(2, attempts)::int)
         WHERE id = ANY($1)`,
        [rows.rows.map((r) => r.id)],
      );
    }
    return rows.rows;
  });

  for (const item of due) {
    const devices = await query<PushDevice>(
      "SELECT apns_token, environment, token_kind FROM devices WHERE user_id = $1",
      [item.user_id],
    );
    if (devices.rows.length === 0) {
      await query("UPDATE push_queue SET failed_at = now() WHERE id = $1", [item.id]);
      observePushMessage(item.payload.data?.kind, "dropped");
      continue;
    }
    const outcome = await deliverPushToDevices({
      devices: devices.rows,
      payload: item.payload,
      clients: { apns, fcm },
      prune: async (device) => {
        await query("DELETE FROM devices WHERE apns_token = $1", [device.apns_token]);
        deps.log.info(`pruned dead ${device.token_kind.toUpperCase()} token for user ${item.user_id}`);
      },
    });
    if (outcome.delivered) {
      await query("UPDATE push_queue SET delivered_at = now() WHERE id = $1", [item.id]);
      observePushMessage(item.payload.data?.kind, "delivered");
    } else if (outcome.attempted && item.attempts + 1 >= MAX_ATTEMPTS) {
      await query("UPDATE push_queue SET failed_at = now() WHERE id = $1", [item.id]);
      observePushMessage(item.payload.data?.kind, "failed");
    }
  }
}
