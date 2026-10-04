/**
 * src/client/runtime/append-entry-bridge.ts — custom session entries recorded in the pod.
 *
 * The pod's session file is the transcript of record, so the client never appends locally: it
 * asks the pod extension's append-entry command to write the entry there. Both callers —
 * extension `pi.appendEntry` and pi's own `sessionManager.appendCustomEntry` (the `/bug` report
 * record) — treat appending as fire-and-forget, so the bridge never throws. An entry it cannot
 * record is dropped with one warning per session.
 */
import { randomUUID } from "node:crypto";
import { debug } from "../../log.js";
import {
  APPEND_ENTRY_COMMAND,
  APPEND_ENTRY_MAX_CUSTOM_TYPE_LENGTH,
  APPEND_ENTRY_PROTOCOL_VERSION,
  TREE_BRIDGE_MAX_ENCODED_REQUEST_BYTES,
} from "../../shim/pi-pod-ext.js";
import type { RpcClientBase } from "../rpc.js";
import type { HostBridge } from "./bridge.js";
import type { RemoteStateCache } from "./state.js";

export type AppendEntry = (customType: string, data?: unknown) => void;

export function createAppendEntryBridge(opts: {
  rpc: RpcClientBase;
  cache: RemoteStateCache;
  bridge: HostBridge;
}): AppendEntry {
  const { rpc, cache, bridge } = opts;
  let warned = false;
  const unavailable = (reason: string) => {
    if (warned) return;
    warned = true;
    bridge.onUiBound(() => bridge.notify(`session entry not recorded: ${reason}`, "warning"));
  };
  const supported = () =>
    cache.commands.some((command) => {
      const candidate = command as { name?: unknown; source?: unknown };
      return candidate.name === APPEND_ENTRY_COMMAND && candidate.source === "extension";
    });

  return (customType, data) => {
    if (typeof customType !== "string" || customType.length === 0 || customType.length > APPEND_ENTRY_MAX_CUSTOM_TYPE_LENGTH) {
      unavailable(`invalid custom type ${JSON.stringify(customType).slice(0, 64)}`);
      return;
    }
    if (!supported()) {
      unavailable("this pod runs an older pi pod extension (restart Pi in the pod to update it)");
      return;
    }
    const request = {
      v: APPEND_ENTRY_PROTOCOL_VERSION,
      id: randomUUID(),
      op: "append-entry",
      customType,
      ...(data !== undefined ? { data } : {}),
    };
    let encoded: string;
    try {
      encoded = Buffer.from(JSON.stringify(request), "utf8").toString("base64url");
    } catch (error) {
      unavailable(`entry data is not serializable (${error instanceof Error ? error.message : String(error)})`);
      return;
    }
    if (Buffer.byteLength(encoded, "utf8") > TREE_BRIDGE_MAX_ENCODED_REQUEST_BYTES) {
      unavailable("entry data exceeds the bridge size limit");
      return;
    }
    void rpc
      .prompt(`/${APPEND_ENTRY_COMMAND} ${encoded}`)
      .then(() => cache.refreshTree().then(() => undefined))
      .catch((error: unknown) => {
        unavailable(error instanceof Error ? error.message : String(error));
        debug(`append-entry bridge failed: ${error instanceof Error ? error.message : String(error)}`);
      });
  };
}
