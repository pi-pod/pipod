/**
 * src/shim/pi-pod-ext.ts — the pod-side pi-pod extension (§5.4).
 *
 * Pi-pod generates exactly one standalone extension for each Pi process and loads it with
 * `-e`. Common commands and lifecycle hooks are shared; RPC sessions add the remote UI/tree/auth
 * bridges, while raw TUI sessions add work/echo/name beacons over their PTY byte channel.
 * The generated file imports no launcher code because only the file itself is uploaded.
 *
 * Session naming runs here rather than on the host because model credentials live in the pod
 * and its egress already reaches the provider. RPC carries the resulting `session_info_changed`
 * event directly; remote TUI mirrors it through a private OSC beacon.
 */
import type { SessionNaming } from "../config.js";
import { POD_PI_AGENT_DIR } from "../hostconfig.js";
import { POD_TITLE_MARKER } from "../client/pod-title.js";
import { buildEchoBeaconSource } from "./echo-beacon.js";
import { buildPodCompanionSource } from "./pod-companion-source.js";
import { buildRemoteUiExtensionSource } from "./remote-ui-source.js";
import { buildSessionNameBeaconSource } from "./session-name-beacon.js";
import { buildWorkMarkerSource } from "./work-marker-ext.js";
import { SEED_BRIDGE_LOGIC } from "./seed-bridge.js";
import {
  SESSION_CATALOG_LOGIC,
  SESSION_CATALOG_MAX_DISCOVERED_FILES,
} from "./session-catalog.js";
import { FILE_LIST_LOGIC, FILE_LIST_MAX_QUERY_LENGTH } from "./file-list.js";

export {
  FILE_LIST_IGNORED_DIRECTORIES,
  FILE_LIST_MAX_QUERY_LENGTH,
  FILE_LIST_MAX_RESULTS,
  FILE_LIST_MAX_SCANNED_ENTRIES,
  FILE_LIST_MAX_SCAN_MS,
} from "./file-list.js";

export {
  SESSION_CATALOG_FIRST_MESSAGE_MAX_CHARS,
  SESSION_CATALOG_HEADER_SCAN_BYTES,
  SESSION_CATALOG_MAX_DISCOVERED_FILES,
  SESSION_CATALOG_MAX_SCAN_BYTES,
  SESSION_CATALOG_MAX_SCAN_MS,
  SESSION_CATALOG_MAX_SESSIONS,
  SESSION_SEARCH_DEFAULT_LIMIT,
  SESSION_SEARCH_MAX_FILES,
  SESSION_SEARCH_MAX_LIMIT,
  SESSION_SEARCH_MAX_SCAN_BYTES,
  SESSION_SEARCH_MAX_SCAN_MS,
  SESSION_SEARCH_SNIPPET_MAX_CHARS,
} from "./session-catalog.js";

/** Where the launcher uploads the extension. */
export const POD_EXT_PATH = "/tmp/pi-pod-ext.js";
/** Reported by the RPC shim so reattaching launchers can diagnose extension skew. */
export const POD_EXTENSION_VERSION = 11;

export interface PodExtensionOptions {
  /** `pi.sessionNaming` — baked in at upload time rather than passed as an env marker. */
  sessionNaming?: SessionNaming;
  /** Select the mode-specific module composed into this process's one extension. */
  mode?: "rpc" | "tui";
  /** TUI-only speculative echo support. Ignored in RPC mode. */
  localEcho?: boolean;
  /**
   * The pi-pod documentation uploaded beside the extension (src/poddocs.ts). Present only
   * when the install actually shipped docs; the agent is pointed at them via the system
   * prompt rather than having two thousand lines of reference in every turn.
   */
  docs?: {
    /** Pod-side directory the docs were uploaded to (POD_DOCS_DIR). */
    dir: string;
    /** File names available in `dir`, so the agent knows what to read. */
    files: string[];
    /** The launcher version those docs belong to. */
    version: string;
  };
}

/** Versioned, private command protocol shared by the generated extension and client. */
export const TREE_BRIDGE_PROTOCOL_VERSION = 1 as const;
export const TREE_BRIDGE_NAVIGATE_COMMAND = "pod:_tree-navigate-v1";
/** Same request as v1, but the acknowledgement carries the target's full editor text. */
export const TREE_BRIDGE_NAVIGATE_V2_COMMAND = "pod:_tree-navigate-v2";
export const TREE_BRIDGE_LABEL_COMMAND = "pod:_tree-label-v1";
export const TREE_BRIDGE_NOTIFICATION_PREFIX = "pi-pod-internal/tree-v1:";
export const POD_INTERNAL_COMMAND_PREFIX = "pod:_";
export const TREE_BRIDGE_MAX_ENCODED_REQUEST_BYTES = 16 * 1024;
export const TREE_BRIDGE_MAX_ENCODED_RESPONSE_BYTES = 256 * 1024;
/** Above this the navigate acknowledgement omits editorText rather than failing the navigation. */
export const TREE_BRIDGE_MAX_EDITOR_TEXT_BYTES = 128 * 1024;
export const TREE_BRIDGE_MAX_ID_LENGTH = 128;
export const TREE_BRIDGE_MAX_ENTRY_ID_LENGTH = 512;
export const TREE_BRIDGE_MAX_LABEL_LENGTH = 256;

/**
 * Client-side extensions append durable custom entries through this hidden command (§client
 * extensions, phase 4). Same canonical base64url-JSON request pattern as the tree bridge;
 * fire-and-forget from the client, so the handler emits no acknowledgement.
 */
export const APPEND_ENTRY_COMMAND = "pod:_append-entry-v1";
export const APPEND_ENTRY_PROTOCOL_VERSION = 1 as const;
export const APPEND_ENTRY_MAX_CUSTOM_TYPE_LENGTH = 256;

/** Pod-side provider authentication bridge. Credentials are never included in this protocol. */
export const AUTH_BRIDGE_PROTOCOL_VERSION = 1 as const;
export const AUTH_BRIDGE_COMMAND = "pod:_auth-v1";
export const AUTH_BRIDGE_NOTIFICATION_PREFIX = "pi-pod-internal/auth-v1:";
export const AUTH_BRIDGE_DIALOG_PREFIX = "pi-pod-internal/auth-dialog-v1:";
export const AUTH_BRIDGE_MAX_PROVIDER_ID_LENGTH = 256;
export const AUTH_BRIDGE_MAX_ENCODED_RESPONSE_BYTES = 64 * 1024;

/** Read-only attach seed: active branch entries plus a flat tree summary. */
export const SEED_BRIDGE_PROTOCOL_VERSION = 1 as const;
export const SEED_CONTEXT_COMMAND = "pod:_get-context-v1";
export const SEED_TREE_SUMMARY_COMMAND = "pod:_get-tree-summary-v1";
export const SEED_BRIDGE_NOTIFICATION_PREFIX = "pi-pod-internal/seed-v1:";
export const SEED_CHUNK_CONTEXT_COMMAND = "pod:_get-context-chunked-v1";
export const SEED_CHUNK_TREE_SUMMARY_COMMAND = "pod:_get-tree-summary-chunked-v1";
export const SEED_CHUNK_NOTIFICATION_PREFIX = "pi-pod-internal/seed-chunk-v1:";
export const SEED_CHUNK_MAX_PART_CHARS = 200_000;
export const SEED_CHUNK_MAX_CHUNKS = 4096;
export const SEED_CHUNK_MAX_JSON_BYTES = 64 * 1024 * 1024;
/** Branch content can be megabytes; stay under the 64 MiB frame drop. */
export const SEED_BRIDGE_MAX_ENCODED_RESPONSE_BYTES = 32 * 1024 * 1024;

/**
 * Read-only workspace file listing for the launcher's `@` autocomplete. The embedded TUI
 * runs on the user's machine, so without this it completes against the laptop's disk.
 */
export const FILE_LIST_PROTOCOL_VERSION = 1 as const;
export const FILE_LIST_COMMAND = "pod:_list-files-v1";
export const FILE_LIST_NOTIFICATION_PREFIX = "pi-pod-internal/files-v1:";
/** Results are capped at FILE_LIST_MAX_RESULTS entries, so one notification always fits. */
export const FILE_LIST_MAX_ENCODED_RESPONSE_BYTES = 64 * 1024;

/** Read-only pod session catalog + naive search over on-disk JSONL. */
export const SESSION_CATALOG_PROTOCOL_VERSION = 1 as const;

/**
 * Auxiliary LLM completions for locally-rendered pod extensions. The launcher sends a
 * semantic `aux_complete` gateway message; the gateway runs the completion inside pod-side
 * pi (real auth, real ModelRegistry) over the existing prompt-tunnel pattern. No tools,
 * no conversation entries, no main-turn disturbance.
 */
export const AUX_BRIDGE_PROTOCOL_VERSION = 1 as const;
export const AUX_COMPLETE_COMMAND = "pod:_aux-complete-v1";
export const AUX_CANCEL_COMMAND = "pod:_aux-cancel-v1";
export const AUX_NOTIFICATION_PREFIX = "pi-pod-internal/aux-v1:";
export const AUX_MAX_ENCODED_REQUEST_BYTES = 256 * 1024;
export const AUX_MAX_ENCODED_RESPONSE_BYTES = 256 * 1024;
export const AUX_MAX_TEXT_CHARS = 131072;
export const AUX_CONCURRENCY_LIMIT = 4;
export const SESSION_LIST_COMMAND = "pod:_list-sessions-v1";
export const SESSION_LIST_CHUNKED_COMMAND = "pod:_list-sessions-chunked-v1";
export const SESSION_SEARCH_COMMAND = "pod:_search-sessions-v1";
export const SESSION_LIST_NOTIFICATION_PREFIX = "pi-pod-internal/sessions-v1:";
export const SESSION_LIST_CHUNK_NOTIFICATION_PREFIX = "pi-pod-internal/sessions-chunk-v1:";
export const SESSION_SEARCH_NOTIFICATION_PREFIX = "pi-pod-internal/sessions-search-v1:";
/** Plain list/search notification size cap; oversized list uses the chunked command. */
export const SESSION_CATALOG_MAX_ENCODED_RESPONSE_BYTES = 32 * 1024 * 1024;

/** Build the one standalone extension loaded by this Pi process. */
export function buildPiPodExtension(opts: PodExtensionOptions = {}): string {
  const naming = opts.sessionNaming ?? "auto";
  const mode = opts.mode ?? "rpc";
  const companionRaw = buildPodCompanionSource();
  const workMarkerRaw = buildWorkMarkerSource();
  const echoRaw = mode === "tui" && opts.localEcho === true ? buildEchoBeaconSource() : "";
  const nameBeaconRaw = mode === "tui" ? buildSessionNameBeaconSource() : "";
  // Imports must be at the top of the ESM file; the module sources each start with an
  // import that would otherwise land mid-file when concatenated.
  const companionBody = companionRaw.replace(/^import[^;]*;\s*\n/, "");
  const workMarkerBody = workMarkerRaw.replace(/^import[^;]*;\s*\n/, "");
  const headerImports = [
    'import { execFileSync as piPodExecFileSync } from "node:child_process";',
    'import * as piPodMarkerFs from "node:fs";',
    'import { gzipSync as piPodGzipSync } from "node:zlib";',
    // The remote UI upgrade patches the running Pi's own AgentSession class (jiti resolves
    // this specifier to Pi's module instance in bundled and unbundled builds alike).
    ...(mode === "rpc" ? ['import * as piPodPiCodingAgent from "@earendil-works/pi-coding-agent";'] : []),
  ].join("\n");
  return `// pi-pod extension — generated by pi-pod; do not edit (see src/shim/pi-pod-ext.ts)
${headerImports}
${companionBody}
${workMarkerBody}
${echoRaw}
${nameBeaconRaw}
const POD_EXTENSION_MODE = ${JSON.stringify(mode)};
const POD_TITLE_MARKER = ${JSON.stringify(POD_TITLE_MARKER)};
const PROTOCOL_VERSION = ${TREE_BRIDGE_PROTOCOL_VERSION};
const NAVIGATE_COMMAND = ${JSON.stringify(TREE_BRIDGE_NAVIGATE_COMMAND)};
const NAVIGATE_V2_COMMAND = ${JSON.stringify(TREE_BRIDGE_NAVIGATE_V2_COMMAND)};
const LABEL_COMMAND = ${JSON.stringify(TREE_BRIDGE_LABEL_COMMAND)};
const NOTIFICATION_PREFIX = ${JSON.stringify(TREE_BRIDGE_NOTIFICATION_PREFIX)};
const MAX_REQUEST_BYTES = ${TREE_BRIDGE_MAX_ENCODED_REQUEST_BYTES};
const MAX_RESPONSE_BYTES = ${TREE_BRIDGE_MAX_ENCODED_RESPONSE_BYTES};
const MAX_EDITOR_TEXT_BYTES = ${TREE_BRIDGE_MAX_EDITOR_TEXT_BYTES};
const MAX_ID_LENGTH = ${TREE_BRIDGE_MAX_ID_LENGTH};
const MAX_ENTRY_ID_LENGTH = ${TREE_BRIDGE_MAX_ENTRY_ID_LENGTH};
const MAX_LABEL_LENGTH = ${TREE_BRIDGE_MAX_LABEL_LENGTH};
const APPEND_ENTRY_COMMAND_NAME = ${JSON.stringify(APPEND_ENTRY_COMMAND)};
const APPEND_ENTRY_VERSION = ${APPEND_ENTRY_PROTOCOL_VERSION};
const MAX_CUSTOM_TYPE_LENGTH = ${APPEND_ENTRY_MAX_CUSTOM_TYPE_LENGTH};
const AUTH_PROTOCOL_VERSION = ${AUTH_BRIDGE_PROTOCOL_VERSION};
const AUTH_COMMAND = ${JSON.stringify(AUTH_BRIDGE_COMMAND)};
const AUTH_NOTIFICATION_PREFIX = ${JSON.stringify(AUTH_BRIDGE_NOTIFICATION_PREFIX)};
const AUTH_DIALOG_PREFIX = ${JSON.stringify(AUTH_BRIDGE_DIALOG_PREFIX)};
const MAX_PROVIDER_ID_LENGTH = ${AUTH_BRIDGE_MAX_PROVIDER_ID_LENGTH};
const MAX_AUTH_RESPONSE_BYTES = ${AUTH_BRIDGE_MAX_ENCODED_RESPONSE_BYTES};
const SEED_PROTOCOL_VERSION = ${SEED_BRIDGE_PROTOCOL_VERSION};
const SEED_CONTEXT_COMMAND = ${JSON.stringify(SEED_CONTEXT_COMMAND)};
const SEED_TREE_SUMMARY_COMMAND = ${JSON.stringify(SEED_TREE_SUMMARY_COMMAND)};
const SEED_NOTIFICATION_PREFIX = ${JSON.stringify(SEED_BRIDGE_NOTIFICATION_PREFIX)};
const MAX_SEED_RESPONSE_BYTES = ${SEED_BRIDGE_MAX_ENCODED_RESPONSE_BYTES};
const SEED_CHUNK_CONTEXT_COMMAND = ${JSON.stringify(SEED_CHUNK_CONTEXT_COMMAND)};
const SEED_CHUNK_TREE_SUMMARY_COMMAND = ${JSON.stringify(SEED_CHUNK_TREE_SUMMARY_COMMAND)};
const SEED_CHUNK_NOTIFICATION_PREFIX = ${JSON.stringify(SEED_CHUNK_NOTIFICATION_PREFIX)};
const SEED_CHUNK_MAX_PART_CHARS = ${SEED_CHUNK_MAX_PART_CHARS};
const SEED_CHUNK_MAX_CHUNKS = ${SEED_CHUNK_MAX_CHUNKS};
const SEED_CHUNK_MAX_JSON_BYTES = ${SEED_CHUNK_MAX_JSON_BYTES};
const SESSION_CATALOG_PROTOCOL_VERSION = ${SESSION_CATALOG_PROTOCOL_VERSION};
const SESSION_LIST_COMMAND = ${JSON.stringify(SESSION_LIST_COMMAND)};
const SESSION_LIST_CHUNKED_COMMAND = ${JSON.stringify(SESSION_LIST_CHUNKED_COMMAND)};
const SESSION_SEARCH_COMMAND = ${JSON.stringify(SESSION_SEARCH_COMMAND)};
const SESSION_LIST_NOTIFICATION_PREFIX = ${JSON.stringify(SESSION_LIST_NOTIFICATION_PREFIX)};
const SESSION_LIST_CHUNK_NOTIFICATION_PREFIX = ${JSON.stringify(SESSION_LIST_CHUNK_NOTIFICATION_PREFIX)};
const SESSION_SEARCH_NOTIFICATION_PREFIX = ${JSON.stringify(SESSION_SEARCH_NOTIFICATION_PREFIX)};
const MAX_SESSION_CATALOG_RESPONSE_BYTES = ${SESSION_CATALOG_MAX_ENCODED_RESPONSE_BYTES};
const SESSION_CATALOG_MAX_DISCOVERED_FILES = ${SESSION_CATALOG_MAX_DISCOVERED_FILES};
const FILE_LIST_PROTOCOL_VERSION = ${FILE_LIST_PROTOCOL_VERSION};
const FILE_LIST_COMMAND = ${JSON.stringify(FILE_LIST_COMMAND)};
const FILE_LIST_NOTIFICATION_PREFIX = ${JSON.stringify(FILE_LIST_NOTIFICATION_PREFIX)};
const MAX_FILE_LIST_RESPONSE_BYTES = ${FILE_LIST_MAX_ENCODED_RESPONSE_BYTES};
const MAX_FILE_LIST_QUERY_LENGTH = ${FILE_LIST_MAX_QUERY_LENGTH};
const AUX_PROTOCOL_VERSION = ${AUX_BRIDGE_PROTOCOL_VERSION};
const AUX_COMPLETE_COMMAND = ${JSON.stringify(AUX_COMPLETE_COMMAND)};
const AUX_CANCEL_COMMAND = ${JSON.stringify(AUX_CANCEL_COMMAND)};
const AUX_NOTIFICATION_PREFIX = ${JSON.stringify(AUX_NOTIFICATION_PREFIX)};
const MAX_AUX_REQUEST_BYTES = ${AUX_MAX_ENCODED_REQUEST_BYTES};
const MAX_AUX_RESPONSE_BYTES = ${AUX_MAX_ENCODED_RESPONSE_BYTES};
const MAX_AUX_TEXT_CHARS = ${AUX_MAX_TEXT_CHARS};
const AUX_CONCURRENCY_LIMIT = ${AUX_CONCURRENCY_LIMIT};
const POD_DOCS_DIR = ${JSON.stringify(opts.docs?.dir ?? "")};
${mode === "rpc" ? buildRemoteUiExtensionSource() : ""}

function bridgeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isBoundedString(value, max) {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block) => block && block.type === "text" && typeof block.text === "string").map((block) => block.text).join("");
}

/** Mirrors pi's navigateTree: only user and custom messages restore text into the editor. */
function editorTextForEntry(entry) {
  if (!isPlainObject(entry)) return undefined;
  if (entry.type === "message" && isPlainObject(entry.message) && entry.message.role === "user") {
    return contentText(entry.message.content);
  }
  if (entry.type === "custom_message") return contentText(entry.content);
  return undefined;
}

function hasExactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function decodeBase64Url(encoded) {
  if (typeof encoded !== "string" || encoded.length === 0 || Buffer.byteLength(encoded, "utf8") > MAX_REQUEST_BYTES) {
    throw bridgeError("invalid_payload", "invalid or oversized tree bridge payload");
  }
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw bridgeError("invalid_payload", "tree bridge payload is not canonical base64url");
  }
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.toString("base64url") !== encoded) {
    throw bridgeError("invalid_payload", "tree bridge payload is not canonical base64url");
  }
  let value;
  try {
    const json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(json);
  } catch {
    throw bridgeError("invalid_json", "tree bridge payload is not valid UTF-8 JSON");
  }
  if (!isPlainObject(value)) throw bridgeError("invalid_request", "tree bridge request must be an object");
  return value;
}

function validateCommon(request, expectedOp) {
  if (request.v !== PROTOCOL_VERSION) throw bridgeError("unsupported_version", "unsupported tree bridge protocol version");
  if (request.op !== expectedOp) throw bridgeError("invalid_operation", "tree bridge operation does not match the command");
  if (!isBoundedString(request.id, MAX_ID_LENGTH)) throw bridgeError("invalid_id", "invalid tree bridge correlation id");
}

function validateNavigate(request) {
  validateCommon(request, "navigate");
  if (!hasExactKeys(request, ["v", "id", "op", "targetId"])) {
    throw bridgeError("invalid_request", "invalid navigate request fields");
  }
  if (!isBoundedString(request.targetId, MAX_ENTRY_ID_LENGTH)) {
    throw bridgeError("invalid_target", "invalid navigation target id");
  }
}

function validateLabel(request) {
  validateCommon(request, "label");
  if (!hasExactKeys(request, ["v", "id", "op", "entryId", "label"])) {
    throw bridgeError("invalid_request", "invalid label request fields");
  }
  if (!isBoundedString(request.entryId, MAX_ENTRY_ID_LENGTH)) throw bridgeError("invalid_entry", "invalid label entry id");
  if (request.label !== null && (typeof request.label !== "string" || request.label.length > MAX_LABEL_LENGTH)) {
    throw bridgeError("invalid_label", "label must be null or a string within the configured limit");
  }
}

function validateAuth(request) {
  if (request.v !== AUTH_PROTOCOL_VERSION) throw bridgeError("unsupported_version", "unsupported auth bridge protocol version");
  if (!isBoundedString(request.id, MAX_ID_LENGTH)) throw bridgeError("invalid_id", "invalid auth bridge correlation id");
  if (request.op === "providers") {
    if (!hasExactKeys(request, ["v", "id", "op"])) throw bridgeError("invalid_request", "invalid providers request fields");
    return;
  }
  if (request.op === "login") {
    if (!hasExactKeys(request, ["v", "id", "op", "providerId", "authType"])) {
      throw bridgeError("invalid_request", "invalid login request fields");
    }
    if (!isBoundedString(request.providerId, MAX_PROVIDER_ID_LENGTH)) throw bridgeError("invalid_provider", "invalid provider id");
    if (request.authType !== "oauth" && request.authType !== "api_key") throw bridgeError("invalid_auth_type", "invalid auth type");
    return;
  }
  if (request.op === "logout") {
    if (!hasExactKeys(request, ["v", "id", "op", "providerId"])) throw bridgeError("invalid_request", "invalid logout request fields");
    if (!isBoundedString(request.providerId, MAX_PROVIDER_ID_LENGTH)) throw bridgeError("invalid_provider", "invalid provider id");
    return;
  }
  throw bridgeError("invalid_operation", "unsupported auth bridge operation");
}

function encodeResponse(response) {
  const encoded = Buffer.from(JSON.stringify(response), "utf8").toString("base64url");
  if (Buffer.byteLength(encoded, "utf8") > MAX_RESPONSE_BYTES) {
    const fallback = {
      v: PROTOCOL_VERSION,
      id: response.id,
      op: response.op,
      ok: false,
      error: { code: "response_too_large", message: "tree bridge response exceeded the configured limit" },
    };
    return Buffer.from(JSON.stringify(fallback), "utf8").toString("base64url");
  }
  return encoded;
}

function emit(ctx, response) {
  ctx.ui.notify(NOTIFICATION_PREFIX + encodeResponse(response));
}

function encodeAuthMessage(message) {
  const encoded = Buffer.from(JSON.stringify(message), "utf8").toString("base64url");
  if (Buffer.byteLength(encoded, "utf8") <= MAX_AUTH_RESPONSE_BYTES) return encoded;
  if (message.kind === "response") {
    return Buffer.from(JSON.stringify({
      v: AUTH_PROTOCOL_VERSION,
      id: message.id,
      op: message.op,
      kind: "response",
      ok: false,
      error: { code: "response_too_large", message: "auth bridge response exceeded the configured limit" },
    }), "utf8").toString("base64url");
  }
  throw bridgeError("payload_too_large", "auth bridge event exceeded the configured limit");
}

function emitAuth(ctx, message) {
  ctx.ui.notify(AUTH_NOTIFICATION_PREFIX + encodeAuthMessage(message));
}

function authDialog(message) {
  return AUTH_DIALOG_PREFIX + encodeAuthMessage(message);
}

async function authSnapshot(runtime) {
  const credentials = await runtime.listCredentials();
  const providers = runtime.getProviders().map((provider) => {
    let status = { configured: false };
    try { status = runtime.getProviderAuthStatus(provider.id); } catch {}
    return {
      id: provider.id,
      name: provider.name,
      auth: {
        ...(provider.auth?.apiKey ? { apiKey: { name: provider.auth.apiKey.name, interactive: typeof provider.auth.apiKey.login === "function" } } : {}),
        ...(provider.auth?.oauth ? { oauth: { name: provider.auth.oauth.name, ...(provider.auth.oauth.loginLabel ? { loginLabel: provider.auth.oauth.loginLabel } : {}) } } : {}),
      },
      status,
      usingOAuth: runtime.isUsingOAuth(provider.id),
    };
  });
  return {
    providers,
    credentials: credentials.map(({ providerId, type }) => ({ providerId, type })),
  };
}

async function mutatePodCredential(runtime, op, providerId, authType, interaction) {
  // ModelRuntime.login/logout refresh network-backed catalogs using the process-wide setting.
  // A provider extension can make that refresh unbounded after the credential is already on
  // disk. Use the live runtime's credential-owning Models collection, then perform the same
  // recomposition explicitly without network. These are ordinary JS-private fields in the
  // exactly pinned Pi version, like ModelRegistry.runtime above.
  if (runtime.models && typeof runtime.models[op] === "function") {
    if (op === "login") await runtime.models.login(providerId, authType, interaction);
    else await runtime.models.logout(providerId);
    await runtime.refresh({ allowNetwork: false });
    return;
  }
  if (op === "login") await runtime.login(providerId, authType, interaction);
  else await runtime.logout(providerId);
}

function authInteraction(ctx, id, controller) {
  // A permanently pending RPC confirm is the cancellation channel. The host answers it only
  // when the local LoginDialog is aborted; this also cancels device-code flows that have no
  // ordinary text prompt outstanding.
  void ctx.ui.confirm(
    authDialog({ v: AUTH_PROTOCOL_VERSION, id, kind: "cancel" }),
    "",
    { signal: controller.signal },
  ).then((cancelled) => { if (cancelled) controller.abort(); });

  return {
    signal: controller.signal,
    prompt: async (prompt) => {
      const serializable = {
        type: prompt.type,
        message: prompt.message,
        ...(prompt.placeholder ? { placeholder: prompt.placeholder } : {}),
        ...(prompt.type === "select" ? { options: prompt.options } : {}),
      };
      const title = authDialog({ v: AUTH_PROTOCOL_VERSION, id, kind: "prompt", prompt: serializable });
      let value;
      if (prompt.type === "select") {
        const selected = await ctx.ui.select(title, prompt.options.map((option) => option.label), { signal: controller.signal });
        value = prompt.options.find((option) => option.id === selected || option.label === selected)?.id;
      } else {
        value = await ctx.ui.input(title, prompt.placeholder, { signal: controller.signal });
      }
      if (value === undefined) throw new Error("Login cancelled");
      return value;
    },
    notify: (event) => emitAuth(ctx, { v: AUTH_PROTOCOL_VERSION, id, kind: "event", event }),
  };
}

function failure(id, op, error) {
  const code = typeof error?.code === "string" ? error.code : "operation_failed";
  const message = error instanceof Error ? error.message : String(error);
  return {
    v: PROTOCOL_VERSION,
    id,
    op,
    ok: false,
    error: { code, message: message.slice(0, 1024) || "tree bridge operation failed" },
  };
}

function validateSeed(request, expectedOp) {
  if (request.v !== SEED_PROTOCOL_VERSION) throw bridgeError("unsupported_version", "unsupported seed bridge protocol version");
  if (request.op !== expectedOp) throw bridgeError("invalid_operation", "seed bridge operation does not match the command");
  if (!isBoundedString(request.id, MAX_ID_LENGTH)) throw bridgeError("invalid_id", "invalid seed bridge correlation id");
  if (!hasExactKeys(request, ["v", "id", "op"])) throw bridgeError("invalid_request", "invalid seed bridge request fields");
}

function encodeSeedResponse(response) {
  const encoded = Buffer.from(JSON.stringify(response), "utf8").toString("base64url");
  if (Buffer.byteLength(encoded, "utf8") <= MAX_SEED_RESPONSE_BYTES) return encoded;
  return Buffer.from(JSON.stringify({
    v: SEED_PROTOCOL_VERSION,
    id: response.id,
    op: response.op,
    ok: false,
    error: { code: "response_too_large", message: "seed bridge response exceeded the configured limit" },
  }), "utf8").toString("base64url");
}

function emitSeed(ctx, response) {
  ctx.ui.notify(SEED_NOTIFICATION_PREFIX + encodeSeedResponse(response));
}

function seedFailure(id, op, error) {
  const code = typeof error?.code === "string" ? error.code : "operation_failed";
  const message = error instanceof Error ? error.message : String(error);
  return {
    v: SEED_PROTOCOL_VERSION,
    id,
    op,
    ok: false,
    error: { code, message: message.slice(0, 1024) || "seed bridge operation failed" },
  };
}

function validateSessionList(request) {
  if (request.v !== SESSION_CATALOG_PROTOCOL_VERSION) throw bridgeError("unsupported_version", "unsupported session catalog protocol version");
  if (request.op !== "list-sessions") throw bridgeError("invalid_operation", "session catalog operation does not match the command");
  if (!isBoundedString(request.id, MAX_ID_LENGTH)) throw bridgeError("invalid_id", "invalid session catalog correlation id");
  if (!hasExactKeys(request, ["v", "id", "op"])) throw bridgeError("invalid_request", "invalid session catalog request fields");
}

function validateSessionSearch(request) {
  if (request.v !== SESSION_CATALOG_PROTOCOL_VERSION) throw bridgeError("unsupported_version", "unsupported session catalog protocol version");
  if (request.op !== "search-sessions") throw bridgeError("invalid_operation", "session search operation does not match the command");
  if (!isBoundedString(request.id, MAX_ID_LENGTH)) throw bridgeError("invalid_id", "invalid session catalog correlation id");
  const hasLimit = Object.prototype.hasOwnProperty.call(request, "limit");
  if (hasLimit) {
    if (!hasExactKeys(request, ["v", "id", "op", "text", "limit"])) throw bridgeError("invalid_request", "invalid session search request fields");
    if (typeof request.limit !== "number" || !Number.isFinite(request.limit)) throw bridgeError("invalid_request", "invalid session search limit");
  } else if (!hasExactKeys(request, ["v", "id", "op", "text"])) {
    throw bridgeError("invalid_request", "invalid session search request fields");
  }
  if (typeof request.text !== "string") throw bridgeError("invalid_request", "session search text must be a string");
}

function encodeSessionCatalogResponse(response) {
  const encoded = Buffer.from(JSON.stringify(response), "utf8").toString("base64url");
  if (Buffer.byteLength(encoded, "utf8") <= MAX_SESSION_CATALOG_RESPONSE_BYTES) return encoded;
  return Buffer.from(JSON.stringify({
    v: SESSION_CATALOG_PROTOCOL_VERSION,
    id: response.id,
    op: response.op,
    ok: false,
    error: { code: "response_too_large", message: "session catalog response exceeded the configured limit" },
  }), "utf8").toString("base64url");
}

function emitSessionCatalog(ctx, response) {
  ctx.ui.notify(SESSION_LIST_NOTIFICATION_PREFIX + encodeSessionCatalogResponse(response));
}

function emitSessionSearch(ctx, response) {
  ctx.ui.notify(SESSION_SEARCH_NOTIFICATION_PREFIX + encodeSessionCatalogResponse(response));
}

function sessionCatalogFailure(id, op, error) {
  const code = typeof error?.code === "string" ? error.code : "operation_failed";
  const message = error instanceof Error ? error.message : String(error);
  return {
    v: SESSION_CATALOG_PROTOCOL_VERSION,
    id,
    op,
    ok: false,
    error: { code, message: message.slice(0, 1024) || "session catalog operation failed" },
  };
}

function validateFileList(request) {
  if (request.v !== FILE_LIST_PROTOCOL_VERSION) throw bridgeError("unsupported_version", "unsupported file list protocol version");
  if (request.op !== "list-files") throw bridgeError("invalid_operation", "file list operation does not match the command");
  if (!isBoundedString(request.id, MAX_ID_LENGTH)) throw bridgeError("invalid_id", "invalid file list correlation id");
  if (!hasExactKeys(request, ["v", "id", "op", "query"])) throw bridgeError("invalid_request", "invalid file list request fields");
  if (typeof request.query !== "string") throw bridgeError("invalid_request", "file list query must be a string");
  if (request.query.length > MAX_FILE_LIST_QUERY_LENGTH) throw bridgeError("invalid_request", "file list query exceeded the configured limit");
}

function emitFileList(ctx, response) {
  const encoded = Buffer.from(JSON.stringify(response), "utf8").toString("base64url");
  if (Buffer.byteLength(encoded, "utf8") <= MAX_FILE_LIST_RESPONSE_BYTES) {
    ctx.ui.notify(FILE_LIST_NOTIFICATION_PREFIX + encoded);
    return;
  }
  ctx.ui.notify(FILE_LIST_NOTIFICATION_PREFIX + Buffer.from(JSON.stringify({
    v: FILE_LIST_PROTOCOL_VERSION,
    id: response.id,
    op: "list-files",
    ok: false,
    error: { code: "response_too_large", message: "file list response exceeded the configured limit" },
  }), "utf8").toString("base64url"));
}

function fileListFailure(id, error) {
  const code = typeof error?.code === "string" ? error.code : "operation_failed";
  const message = error instanceof Error ? error.message : String(error);
  return {
    v: FILE_LIST_PROTOCOL_VERSION,
    id,
    op: "list-files",
    ok: false,
    error: { code, message: message.slice(0, 1024) || "file list operation failed" },
  };
}
${SEED_BRIDGE_LOGIC}
${SESSION_CATALOG_LOGIC}
${FILE_LIST_LOGIC}


export default function piPodExtension(pi) {
  installPiPodCompanion(pi);
  const env = process.env;
  const marker = (name) => env[name] || "unknown";

  // Pi restores its ordinary π title after extension startup. Defer our title by one task so
  // raw remote-TUI sessions stay visibly pod-branded; the local RPC client also guards every
  // InteractiveMode title write, including startup, renames, and user extension updates.
  const setPodTerminalTitle = (ctx) => {
    if (!ctx.hasUI) return;
    setTimeout(() => {
      const cwd = process.cwd().replace(/\\/+$/, "").split("/").pop() || process.cwd();
      const session = pi.getSessionName();
      ctx.ui.setTitle(session
        ? POD_TITLE_MARKER + " - " + session + " - " + cwd
        : POD_TITLE_MARKER + " - " + cwd);
    }, 0);
  };
  pi.on("session_start", (_event, ctx) => setPodTerminalTitle(ctx));
  pi.on("session_info_changed", (_event, ctx) => setPodTerminalTitle(ctx));

  pi.registerCommand("pod:info", {
    description: "pi-pod: describe this pod to the agent (enters conversation context)",
    handler: async (_args, ctx) => {
      const lines = [
        "You are running inside a pi-pod sandbox (an ephemeral, provider-managed pod).",
        "  pod id       " + marker("PI_POD_ID"),
        "  provider     " + marker("PI_POD_PROVIDER"),
        "  project      " + marker("PI_POD_PROJECT"),
        "  image        " + marker("PI_POD_IMAGE"),
        "  created      " + marker("PI_POD_CREATED"),
        "  egress       " + marker("PI_POD_EGRESS"),
        "  workdir      " + process.cwd(),
        ...(POD_DOCS_DIR ? ["  docs         " + POD_DOCS_DIR + "/ (pi-pod documentation for the managing launcher's version)"] : []),
        "The clone in the workdir is the workspace; the pod (and anything outside the clone)",
        "is disposable. Commit and push work you want to keep.",
      ];
      const text = lines.join("\\n");
      pi.sendMessage({ customType: "pi-pod-info", content: text, display: true });
      if (ctx.hasUI) ctx.ui.notify("pod info added to the conversation", "info");
    },
  });

  if (POD_EXTENSION_MODE === "rpc") {
  // If the bindExtensions wrap did not land (Pi changed the seam), every component-shaped
  // ui call from every extension degrades to a silent RPC no-op. Say so on each session.
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI || ctx.ui?.__piPodRemoteUiVersion === REMOTE_UI_CONFIG.version) return;
    ctx.ui.notify(
      "pi-pod: remote extension UI is inactive in this pod; extension overlays and custom components will not render",
      "warning",
    );
  });

  const navigateHandler = (includeEditorText) => async (args, ctx) => {
    let id = "invalid";
    try {
      if (ctx.mode !== "rpc" && !ctx.ui?.__piPodRemoteUiVersion) throw bridgeError("rpc_required", "tree bridge commands are available only in RPC mode");
      const request = decodeBase64Url(args.trim());
      if (isBoundedString(request.id, MAX_ID_LENGTH)) id = request.id;
      validateNavigate(request);
      // Read before navigating: pi's RPC actions strip editorText from the result, so the pod
      // reproduces pi's own rule against the full entry the client only holds as a flattened preview.
      const targetEntry = includeEditorText ? ctx.sessionManager.getEntry(request.targetId) : undefined;
      const result = await ctx.navigateTree(request.targetId, { summarize: false });
      const cancelled = Boolean(result?.cancelled);
      const data = { cancelled, leafId: ctx.sessionManager.getLeafId() ?? null };
      const editorText = cancelled ? undefined : editorTextForEntry(targetEntry);
      if (editorText !== undefined && Buffer.byteLength(editorText, "utf8") <= MAX_EDITOR_TEXT_BYTES) {
        data.editorText = editorText;
      }
      emit(ctx, { v: PROTOCOL_VERSION, id, op: "navigate", ok: true, data });
    } catch (error) {
      emit(ctx, failure(id, "navigate", error));
    }
  };

  pi.registerCommand(NAVIGATE_COMMAND, {
    description: "pi-pod internal tree navigation bridge",
    handler: navigateHandler(false),
  });

  pi.registerCommand(NAVIGATE_V2_COMMAND, {
    description: "pi-pod internal tree navigation bridge",
    handler: navigateHandler(true),
  });

  pi.registerCommand(LABEL_COMMAND, {
    description: "pi-pod internal tree label bridge",
    handler: async (args, ctx) => {
      let id = "invalid";
      try {
        if (ctx.mode !== "rpc" && !ctx.ui?.__piPodRemoteUiVersion) throw bridgeError("rpc_required", "tree bridge commands are available only in RPC mode");
        const request = decodeBase64Url(args.trim());
        if (isBoundedString(request.id, MAX_ID_LENGTH)) id = request.id;
        validateLabel(request);
        if (!ctx.sessionManager.getEntry(request.entryId)) throw bridgeError("entry_not_found", "label target entry was not found");
        pi.setLabel(request.entryId, request.label === null ? undefined : request.label);
        emit(ctx, {
          v: PROTOCOL_VERSION,
          id,
          op: "label",
          ok: true,
          data: { leafId: ctx.sessionManager.getLeafId() ?? null },
        });
      } catch (error) {
        emit(ctx, failure(id, "label", error));
      }
    },
  });

  pi.registerCommand(APPEND_ENTRY_COMMAND_NAME, {
    description: "pi-pod internal client-extension entry bridge",
    handler: async (args, ctx) => {
      try {
        if (ctx.mode !== "rpc" && !ctx.ui?.__piPodRemoteUiVersion) throw bridgeError("rpc_required", "append-entry bridge commands are available only in RPC mode");
        const request = decodeBase64Url(args.trim());
        if (request.v !== APPEND_ENTRY_VERSION) throw bridgeError("unsupported_version", "unsupported append-entry protocol version");
        if (request.op !== "append-entry") throw bridgeError("invalid_operation", "append-entry operation does not match the command");
        if (!isBoundedString(request.id, MAX_ID_LENGTH)) throw bridgeError("invalid_id", "invalid append-entry correlation id");
        if (!hasExactKeys(request, ["v", "id", "op", "customType"]) && !hasExactKeys(request, ["v", "id", "op", "customType", "data"])) {
          throw bridgeError("invalid_request", "invalid append-entry request fields");
        }
        if (!isBoundedString(request.customType, MAX_CUSTOM_TYPE_LENGTH)) throw bridgeError("invalid_custom_type", "invalid append-entry custom type");
        pi.appendEntry(request.customType, request.data);
      } catch {
        // Fire-and-forget from the client: a failed append is a lost nicety, never a dialog.
      }
    },
  });

  pi.registerCommand(AUTH_COMMAND, {
    description: "pi-pod internal provider authentication bridge",
    handler: async (args, ctx) => {
      let id = "invalid";
      let op = "providers";
      let controller;
      try {
        if (ctx.mode !== "rpc" && !ctx.ui?.__piPodRemoteUiVersion) throw bridgeError("rpc_required", "auth bridge commands are available only in RPC mode");
        const request = decodeBase64Url(args.trim());
        if (isBoundedString(request.id, MAX_ID_LENGTH)) id = request.id;
        if (typeof request.op === "string") op = request.op;
        validateAuth(request);
        const runtime = ctx.modelRegistry?.runtime;
        if (!runtime || typeof runtime.login !== "function") throw bridgeError("runtime_unavailable", "pod model runtime does not expose authentication");

        if (request.op === "login") {
          controller = new AbortController();
          await mutatePodCredential(runtime, "login", request.providerId, request.authType, authInteraction(ctx, id, controller));
        } else if (request.op === "logout") {
          await mutatePodCredential(runtime, "logout", request.providerId);
        }
        const data = await authSnapshot(runtime);
        emitAuth(ctx, { v: AUTH_PROTOCOL_VERSION, id, op: request.op, kind: "response", ok: true, data });
      } catch (error) {
        const cancelled = controller?.signal.aborted;
        emitAuth(ctx, {
          v: AUTH_PROTOCOL_VERSION,
          id,
          op,
          kind: "response",
          ok: false,
          error: {
            code: cancelled ? "cancelled" : (typeof error?.code === "string" ? error.code : "operation_failed"),
            message: cancelled ? "Login cancelled" : (error instanceof Error ? error.message : String(error)).slice(0, 1024),
          },
        });
      } finally {
        controller?.abort();
      }
    },
  });

  pi.registerCommand(SEED_CONTEXT_COMMAND, {
    description: "pi-pod internal session context bridge",
    handler: async (args, ctx) => {
      let id = "invalid";
      try {
        if (ctx.mode !== "rpc" && !ctx.ui?.__piPodRemoteUiVersion) throw bridgeError("rpc_required", "seed bridge commands are available only in RPC mode");
        const request = decodeBase64Url(args.trim());
        if (isBoundedString(request.id, MAX_ID_LENGTH)) id = request.id;
        validateSeed(request, "get-context");
        emitSeed(ctx, {
          v: SEED_PROTOCOL_VERSION,
          id,
          op: "get-context",
          ok: true,
          data: buildContextData(ctx.sessionManager),
        });
      } catch (error) {
        emitSeed(ctx, seedFailure(id, "get-context", error));
      }
    },
  });

  pi.registerCommand(SEED_TREE_SUMMARY_COMMAND, {
    description: "pi-pod internal session tree summary bridge",
    handler: async (args, ctx) => {
      let id = "invalid";
      try {
        if (ctx.mode !== "rpc" && !ctx.ui?.__piPodRemoteUiVersion) throw bridgeError("rpc_required", "seed bridge commands are available only in RPC mode");
        const request = decodeBase64Url(args.trim());
        if (isBoundedString(request.id, MAX_ID_LENGTH)) id = request.id;
        validateSeed(request, "get-tree-summary");
        emitSeed(ctx, {
          v: SEED_PROTOCOL_VERSION,
          id,
          op: "get-tree-summary",
          ok: true,
          data: buildTreeSummaryData(ctx.sessionManager),
        });
      } catch (error) {
        emitSeed(ctx, seedFailure(id, "get-tree-summary", error));
      }
    },
  });

  pi.registerCommand(SEED_CHUNK_CONTEXT_COMMAND, {
    description: "pi-pod internal chunked session context bridge",
    handler: async (args, ctx) => {
      let id = "invalid";
      let notifications;
      try {
        if (ctx.mode !== "rpc" && !ctx.ui?.__piPodRemoteUiVersion) throw bridgeError("rpc_required", "seed bridge commands are available only in RPC mode");
        const request = decodeBase64Url(args.trim());
        if (isBoundedString(request.id, MAX_ID_LENGTH)) id = request.id;
        validateSeed(request, "get-context");
        const envelope = {
          v: SEED_PROTOCOL_VERSION,
          id,
          op: "get-context",
          ok: true,
          data: buildContextData(ctx.sessionManager),
        };
        notifications = encodeSeedChunkNotifications(envelope, piPodGzipSync);
      } catch (error) {
        notifications = encodeSeedChunkNotifications(seedFailure(id, "get-context", error), piPodGzipSync);
      }
      for (const notification of notifications) ctx.ui.notify(notification);
    },
  });

  pi.registerCommand(SEED_CHUNK_TREE_SUMMARY_COMMAND, {
    description: "pi-pod internal chunked session tree summary bridge",
    handler: async (args, ctx) => {
      let id = "invalid";
      let notifications;
      try {
        if (ctx.mode !== "rpc" && !ctx.ui?.__piPodRemoteUiVersion) throw bridgeError("rpc_required", "seed bridge commands are available only in RPC mode");
        const request = decodeBase64Url(args.trim());
        if (isBoundedString(request.id, MAX_ID_LENGTH)) id = request.id;
        validateSeed(request, "get-tree-summary");
        const envelope = {
          v: SEED_PROTOCOL_VERSION,
          id,
          op: "get-tree-summary",
          ok: true,
          data: buildTreeSummaryData(ctx.sessionManager),
        };
        notifications = encodeSeedChunkNotifications(envelope, piPodGzipSync);
      } catch (error) {
        notifications = encodeSeedChunkNotifications(seedFailure(id, "get-tree-summary", error), piPodGzipSync);
      }
      for (const notification of notifications) ctx.ui.notify(notification);
    },
  });

  pi.registerCommand(SESSION_LIST_COMMAND, {
    description: "pi-pod internal session catalog bridge",
    handler: async (args, ctx) => {
      let id = "invalid";
      try {
        if (ctx.mode !== "rpc" && !ctx.ui?.__piPodRemoteUiVersion) throw bridgeError("rpc_required", "session catalog commands are available only in RPC mode");
        const request = decodeBase64Url(args.trim());
        if (isBoundedString(request.id, MAX_ID_LENGTH)) id = request.id;
        validateSessionList(request);
        emitSessionCatalog(ctx, {
          v: SESSION_CATALOG_PROTOCOL_VERSION,
          id,
          op: "list-sessions",
          ok: true,
          data: buildSessionCatalog(piPodMarkerFs, { env: process.env }),
        });
      } catch (error) {
        emitSessionCatalog(ctx, sessionCatalogFailure(id, "list-sessions", error));
      }
    },
  });

  pi.registerCommand(SESSION_LIST_CHUNKED_COMMAND, {
    description: "pi-pod internal chunked session catalog bridge",
    handler: async (args, ctx) => {
      let id = "invalid";
      let notifications;
      try {
        if (ctx.mode !== "rpc" && !ctx.ui?.__piPodRemoteUiVersion) throw bridgeError("rpc_required", "session catalog commands are available only in RPC mode");
        const request = decodeBase64Url(args.trim());
        if (isBoundedString(request.id, MAX_ID_LENGTH)) id = request.id;
        validateSessionList(request);
        const envelope = {
          v: SESSION_CATALOG_PROTOCOL_VERSION,
          id,
          op: "list-sessions",
          ok: true,
          data: buildSessionCatalog(piPodMarkerFs, { env: process.env }),
        };
        notifications = encodeSeedChunkNotifications(envelope, piPodGzipSync, { notificationPrefix: SESSION_LIST_CHUNK_NOTIFICATION_PREFIX });
      } catch (error) {
        notifications = encodeSeedChunkNotifications(sessionCatalogFailure(id, "list-sessions", error), piPodGzipSync, { notificationPrefix: SESSION_LIST_CHUNK_NOTIFICATION_PREFIX });
      }
      for (const notification of notifications) ctx.ui.notify(notification);
    },
  });

  pi.registerCommand(SESSION_SEARCH_COMMAND, {
    description: "pi-pod internal session search bridge",
    handler: async (args, ctx) => {
      let id = "invalid";
      try {
        if (ctx.mode !== "rpc" && !ctx.ui?.__piPodRemoteUiVersion) throw bridgeError("rpc_required", "session catalog commands are available only in RPC mode");
        const request = decodeBase64Url(args.trim());
        if (isBoundedString(request.id, MAX_ID_LENGTH)) id = request.id;
        validateSessionSearch(request);
        emitSessionSearch(ctx, {
          v: SESSION_CATALOG_PROTOCOL_VERSION,
          id,
          op: "search-sessions",
          ok: true,
          data: searchSessions(piPodMarkerFs, { env: process.env, text: request.text, limit: request.limit }),
        });
      } catch (error) {
        emitSessionSearch(ctx, sessionCatalogFailure(id, "search-sessions", error));
      }
    },
  });

  pi.registerCommand(FILE_LIST_COMMAND, {
    description: "pi-pod internal workspace file listing bridge",
    handler: async (args, ctx) => {
      let id = "invalid";
      try {
        if (ctx.mode !== "rpc" && !ctx.ui?.__piPodRemoteUiVersion) throw bridgeError("rpc_required", "file list commands are available only in RPC mode");
        const request = decodeBase64Url(args.trim());
        if (isBoundedString(request.id, MAX_ID_LENGTH)) id = request.id;
        validateFileList(request);
        emitFileList(ctx, {
          v: FILE_LIST_PROTOCOL_VERSION,
          id,
          op: "list-files",
          ok: true,
          data: buildFileList(piPodMarkerFs, { cwd: ctx.sessionManager.getCwd(), query: request.query }),
        });
      } catch (error) {
        emitFileList(ctx, fileListFailure(id, error));
      }
    },
  });

  const auxInFlight = new Map();

  function decodeAuxRequest(encoded) {
    if (typeof encoded !== "string" || encoded.length === 0 || Buffer.byteLength(encoded, "utf8") > MAX_AUX_REQUEST_BYTES) {
      throw bridgeError("invalid_payload", "invalid or oversized aux bridge payload");
    }
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
      throw bridgeError("invalid_payload", "aux bridge payload is not canonical base64url");
    }
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.toString("base64url") !== encoded) {
      throw bridgeError("invalid_payload", "aux bridge payload is not canonical base64url");
    }
    let value;
    try {
      const json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      value = JSON.parse(json);
    } catch {
      throw bridgeError("invalid_json", "aux bridge payload is not valid UTF-8 JSON");
    }
    if (!isPlainObject(value)) throw bridgeError("invalid_request", "aux bridge request must be an object");
    return value;
  }

  function isAuxThinkingLevel(value) {
    return value === "off" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max";
  }

  function validateAuxComplete(request) {
    if (request.v !== AUX_PROTOCOL_VERSION) throw bridgeError("unsupported_version", "unsupported aux bridge protocol version");
    if (request.op !== "complete") throw bridgeError("invalid_operation", "aux bridge operation does not match the command");
    if (!isBoundedString(request.id, MAX_ID_LENGTH)) throw bridgeError("invalid_id", "invalid aux bridge correlation id");
    const allowed = ["v", "id", "op", "provider", "model", "messages", "systemPrompt", "thinkingLevel", "maxTokens"];
    for (const key of Object.keys(request)) {
      if (allowed.indexOf(key) === -1) throw bridgeError("invalid_request", "invalid aux complete request fields");
    }
    for (const key of ["v", "id", "op", "provider", "model", "messages"]) {
      if (!Object.prototype.hasOwnProperty.call(request, key)) throw bridgeError("invalid_request", "invalid aux complete request fields");
    }
    if (!isBoundedString(request.provider, 128)) throw bridgeError("invalid_provider", "invalid aux provider");
    if (!isBoundedString(request.model, 256)) throw bridgeError("invalid_model", "invalid aux model");
    if (request.systemPrompt !== undefined && (typeof request.systemPrompt !== "string" || request.systemPrompt.length > 16384)) {
      throw bridgeError("invalid_request", "invalid aux system prompt");
    }
    if (!Array.isArray(request.messages) || request.messages.length < 1 || request.messages.length > 16) {
      throw bridgeError("invalid_request", "invalid aux messages");
    }
    for (const message of request.messages) {
      if (!isPlainObject(message)) throw bridgeError("invalid_request", "invalid aux message");
      if (!hasExactKeys(message, ["role", "content"])) throw bridgeError("invalid_request", "invalid aux message fields");
      if (message.role !== "user" && message.role !== "assistant") throw bridgeError("invalid_request", "invalid aux message role");
      if (typeof message.content !== "string" || message.content.length < 1 || message.content.length > 65536) {
        throw bridgeError("invalid_request", "invalid aux message content");
      }
    }
    if (request.thinkingLevel !== undefined && !isAuxThinkingLevel(request.thinkingLevel)) {
      throw bridgeError("invalid_request", "invalid aux thinking level");
    }
    if (request.maxTokens !== undefined && (!Number.isInteger(request.maxTokens) || request.maxTokens < 1 || request.maxTokens > 4096)) {
      throw bridgeError("invalid_request", "invalid aux max tokens");
    }
  }

  function encodeAuxResponse(response) {
    const encoded = Buffer.from(JSON.stringify(response), "utf8").toString("base64url");
    if (Buffer.byteLength(encoded, "utf8") <= MAX_AUX_RESPONSE_BYTES) return encoded;
    return Buffer.from(JSON.stringify({
      v: AUX_PROTOCOL_VERSION,
      id: response.id,
      op: "complete",
      ok: false,
      error: { code: "response_too_large", message: "aux bridge response exceeded the configured limit" },
    }), "utf8").toString("base64url");
  }

  function emitAux(ctx, response) {
    ctx.ui.notify(AUX_NOTIFICATION_PREFIX + encodeAuxResponse(response));
  }

  function auxFailure(id, error) {
    const code = typeof error?.code === "string" ? error.code : "operation_failed";
    const message = error instanceof Error ? error.message : String(error);
    return {
      v: AUX_PROTOCOL_VERSION,
      id,
      op: "complete",
      ok: false,
      error: { code, message: (message || "aux completion failed").slice(0, 1024) },
    };
  }

  pi.registerCommand(AUX_COMPLETE_COMMAND, {
    description: "pi-pod internal auxiliary completion bridge",
    handler: async (args, ctx) => {
      let id = "invalid";
      let controller = null;
      let ceiling = null;
      try {
        if (ctx.mode !== "rpc" && !ctx.ui?.__piPodRemoteUiVersion) throw bridgeError("rpc_required", "aux bridge commands are available only in RPC mode");
        const request = decodeAuxRequest(args.trim());
        if (isBoundedString(request.id, MAX_ID_LENGTH)) id = request.id;
        validateAuxComplete(request);
        if (auxInFlight.has(request.id)) throw bridgeError("busy", "aux completion id is already in flight");
        if (auxInFlight.size >= AUX_CONCURRENCY_LIMIT) throw bridgeError("busy", "too many concurrent aux completions");
        const model = ctx.modelRegistry.find(request.provider, request.model);
        if (!model) throw bridgeError("unknown_model", "unknown aux model");
        if (!ctx.modelRegistry.hasConfiguredAuth(model)) throw bridgeError("auth_unconfigured", "aux model has no configured auth");
        controller = new AbortController();
        auxInFlight.set(request.id, controller);
        // Backstop ceiling so a stuck provider stream can never hold a pod slot forever.
        const ceilingMs = 130000;
        const ceilingPromise = new Promise((_, reject) => {
          ceiling = setTimeout(() => {
            controller.abort();
            reject(bridgeError("timeout", "aux completion timed out"));
          }, ceilingMs);
        });
        const context = {
          ...(request.systemPrompt ? { systemPrompt: request.systemPrompt } : {}),
          messages: request.messages.map((message) => {
            if (message.role === "user") return { role: "user", content: message.content, timestamp: Date.now() };
            return { role: "assistant", content: [{ type: "text", text: message.content }], timestamp: Date.now() };
          }),
        };
        const options = {
          signal: controller.signal,
          maxTokens: request.maxTokens ?? 2048,
          cacheRetention: "none",
          // Thinking uses the exact native option: ModelRegistry.complete runs the raw
          // provider.stream, whose per-API thinking semantics (including reasoningEffort)
          // are provider-specific, as in native Pi. The wire thinkingLevel is passed
          // through verbatim as reasoningEffort — including "off", with no
          // model.reasoning gate — so unchanged callers get byte-identical behavior
          // to an in-process complete(). No bridge-level translation is attempted or promised.
          ...(request.thinkingLevel !== undefined ? { reasoningEffort: request.thinkingLevel } : {}),
        };
        const response = await Promise.race([ctx.modelRegistry.complete(model, context, options), ceilingPromise]);
        if (ceiling !== null) clearTimeout(ceiling);
        const text = (response.content || []).filter((part) => part && part.type === "text" && typeof part.text === "string").map((part) => part.text).join("");
        if (text.length > MAX_AUX_TEXT_CHARS) throw bridgeError("response_too_large", "aux completion exceeded the configured limit");
        if (controller.signal.aborted) throw bridgeError("cancelled", "aux completion was cancelled");
        if (response.stopReason === "error" || response.stopReason === "aborted") {
          throw bridgeError("completion_failed", (response.errorMessage || "aux completion failed").slice(0, 1024));
        }
        // Text-only scope: thinking-only / toolUse / deferred outcomes carry no text and
        // must fail honestly instead of reporting ok:true with empty text.
        if (text.length === 0) throw bridgeError("completion_failed", "aux completion returned no text");
        emitAux(ctx, {
          v: AUX_PROTOCOL_VERSION,
          id: request.id,
          op: "complete",
          ok: true,
          data: { text, stopReason: response.stopReason ?? null, usage: response.usage ?? null },
        });
      } catch (error) {
        // The ceiling timeout aborts first, so check its code before the generic
        // aborted-signal fallback to keep the timeout honest.
        if (error && error.code === "timeout") {
          emitAux(ctx, { v: AUX_PROTOCOL_VERSION, id, op: "complete", ok: false, error: { code: "timeout", message: "aux completion timed out" } });
        } else if ((controller && controller.signal.aborted) || (error && error.code === "cancelled")) {
          emitAux(ctx, { v: AUX_PROTOCOL_VERSION, id, op: "complete", ok: false, error: { code: "cancelled", message: "aux completion was cancelled" } });
        } else {
          emitAux(ctx, auxFailure(id, error));
        }
      } finally {
        if (typeof ceiling !== "undefined" && ceiling !== null) clearTimeout(ceiling);
        if (controller && auxInFlight.get(id) === controller) auxInFlight.delete(id);
      }
    },
  });

  pi.registerCommand(AUX_CANCEL_COMMAND, {
    description: "pi-pod internal auxiliary completion cancel bridge",
    handler: async (args, ctx) => {
      try {
        if (ctx.mode !== "rpc" && !ctx.ui?.__piPodRemoteUiVersion) return;
        const request = decodeAuxRequest(args.trim());
        if (request.v !== AUX_PROTOCOL_VERSION || request.op !== "cancel") return;
        if (!isBoundedString(request.id, MAX_ID_LENGTH)) return;
        if (!hasExactKeys(request, ["v", "id", "op"])) return;
        const controller = auxInFlight.get(request.id);
        if (controller) controller.abort();
      } catch {
        // Fire-and-forget: an undecodable cancel is a lost nicety, never a dialog.
      }
    },
  });
  }
  installPiPodWorkMarker(pi);
  ${mode === "tui" ? "installPiPodSessionNameBeacon(pi);" : ""}
  ${mode === "tui" && opts.localEcho === true ? "installPiPodEchoBeacon(pi);" : ""}
${naming === "auto" ? SESSION_NAMING_SOURCE : ""}${opts.docs ? docsPointerSource(opts.docs) : ""}${BROKER_SYNC_SOURCE}}
`;
}

/**
 * Spliced into the generated extension only when the launcher uploaded its documentation
 * beside the extension (src/poddocs.ts). Appends a short pointer to the system prompt on
 * every turn — where the docs are and when to read them — so the agent can answer questions
 * about its own pod from the installed version's reference instead of from memory.
 */
function docsPointerSource(docs: { dir: string; files: string[]; version: string }): string {
  const note = [
    "## pi-pod environment",
    "This session runs inside a pi-pod sandbox, managed by pi-pod v" + docs.version + " on the user's machine. The",
    "documentation for that exact pi-pod version is on this pod's filesystem under " + docs.dir + ":",
    ...docs.files.map((file) => "- " + docs.dir + "/" + file),
    "When the user asks how their pod works, asks about pi-pod itself, or wants to change their .pi-pod/",
    "configuration, read reference.md there first (the full annotated reference) and answer or edit from it.",
    "Do not answer pi-pod questions from memory — what you know may be a different pi-pod version's behavior.",
  ].join("\n");
  return `
  // Point the agent at the uploaded pi-pod documentation (src/poddocs.ts). A pointer, not the
  // text: the reference is long and only relevant when the conversation turns to pi-pod.
  pi.on("before_agent_start", (event) => ({
    systemPrompt: event.systemPrompt + "\\n\\n" + ${JSON.stringify(note)},
  }));
`;
}

/**
 * Spliced into the generated extension only when `pi.sessionNaming` is "auto".
 *
 * Everything here is best-effort and silent: a session name is a nicety, and a failed
 * completion must not put an error in front of someone who only wanted to send a prompt.
 */
const SESSION_NAMING_SOURCE = `
  // Auto-name the session from its first prompt (§5.4). Never blocks the turn, never fights
  // a name the user or a previous session already set, and degrades to a heuristic when the
  // model call is unavailable.
  let naming = false;
  // The latch guards one session, not the process: starting a fresh session in the same pi
  // (\`/new\`) leaves it unnamed, and a latch that never reopened would leave it that way.
  pi.on("session_start", () => {
    naming = false;
  });
  pi.on("input", (event, ctx) => {
    if (naming || pi.getSessionName() !== undefined) return;
    const prompt = (event.text || "").trim();
    if (prompt === "" || prompt.startsWith("/")) return;
    naming = true;
    void nameSession(prompt, ctx).catch(() => {});
  });

  async function nameSession(prompt, ctx) {
    let name = await generateName(prompt, ctx).catch(() => undefined);
    if (!name) name = heuristicName(prompt);
    // Re-checked because the completion is not instant: the user may have run /name while
    // it was in flight, and their name wins.
    if (name && pi.getSessionName() === undefined) pi.setSessionName(name);
  }

  async function generateName(prompt, ctx) {
    // ExtensionContext.model is resolved at input-event time, so this is the model the user
    // selected for the turn (including a /model change or a launch --model override). Route the
    // completion back through Pi's registry: it owns provider adapters, custom base URLs, and
    // API-key/OAuth resolution. Importing pi-ai from this uploaded /tmp extension cannot resolve
    // Pi's nested dependency, and bypassing the registry would lose custom-provider behavior.
    const model = ctx.model;
    if (!model || typeof ctx.modelRegistry?.complete !== "function") return undefined;
    const message = await ctx.modelRegistry.complete(
      model,
      {
        messages: [
          {
            role: "user",
            content:
              "Generate a concise 2-5 word title for a coding session that starts with this " +
              "request. Reply with the title only. Request: " + prompt.slice(0, 500),
          },
        ],
      },
      // Some current Pi models (notably OpenAI Codex) reject temperature entirely. A title
      // needs only a small output cap; provider defaults keep this portable across models.
      { maxTokens: 64 },
    );
    const text = (message.content || [])
      .filter((part) => part && part.type === "text")
      .map((part) => part.text)
      .join(" ");
    return clean(text);
  }

  /** The LLM-failure fallback, and the whole path when no model is configured. */
  function heuristicName(prompt) {
    // Quotes and trailing punctuation come from the prompt's own sentence structure and read
    // as damage in a tab title, so they go before the word count rather than after.
    const words = prompt
      .replace(/["'\\\`]/g, "")
      .split(/\\s+/)
      // Operators and redirections mean nothing once the command is not being run, and a
      // title ending "&&" or "2>&1" reads as a half-copied command rather than a name.
      .filter((word) => /\\p{L}/u.test(word) || /^\\p{N}+$/u.test(word))
      .slice(0, 6);
    // Cutting at a fixed word count lands mid-phrase often enough to be worth undoing: a title
    // ending "... in scratch.txt for" reads as truncation, the same title without it does not.
    const dangling = /^(a|an|and|at|by|for|from|in|into|of|on|or|the|then|to|with)$/i;
    while (words.length > 1 && dangling.test(words[words.length - 1])) words.pop();
    return clean(words.join(" ").replace(/[\\s.,;:!?-]+$/, ""));
  }

  function clean(raw) {
    const name = String(raw || "")
      .replace(/[\\r\\n]+/g, " ")
      .replace(/^["'\\\`]+|["'\\\`]+$/g, "")
      .trim()
      .slice(0, 48)
      .trim();
    return name === "" ? undefined : name;
  }
`;

/**
 * Spliced into every generated extension; self-disables outside account mode.
 *
 * The pod's `auth.json` holds borrowed access tokens and no refresh tokens. In account
 * mode the pi-pod server is the single refresh authority, so the pod polls
 * GET /v1/pods/{podId}/model-credential-lease for a freshly minted lease and merges
 * provider entries into where pi reads credentials. Server entries win per provider; a
 * provider only this pod logged into (a pod-side `/login`) survives the merge.
 * Local-mode pods have no broker env, and this is a no-op there: the launcher's own
 * auth sync renews the file over the session wire instead.
 *
 * Claude `.credentials.json` is not written from this poller.
 *
 * Everything here is best-effort and silent: a failed poll leaves the current file in
 * place, and the next one retries. A credential-state notify is omitted — there is no
 * existing notify channel for that payload without a new RPC protocol.
 */
const BROKER_SYNC_SOURCE = `
  const brokerAuthPath = ${JSON.stringify(`${POD_PI_AGENT_DIR}/auth.json`)};
  const brokerUrl = (process.env.PI_POD_SERVER_URL || "").replace(/\\/+$/, "");
  const brokerToken = process.env.PI_POD_SERVER_TOKEN || "";
  const brokerPodId = process.env.PI_POD_SERVER_POD_ID || "";
  if (brokerUrl && brokerToken && brokerPodId) {
    let brokerInFlight = false;
    let lastRevision = "";
    const writeIfChanged = (fs, path, contents) => {
      let current = null;
      try { current = fs.readFileSync(path, "utf8"); } catch {}
      if (current === contents) return;
      const tmp = path + ".broker-tmp";
      fs.writeFileSync(tmp, contents, { mode: 0o600 });
      fs.renameSync(tmp, path);
    };
    const syncBrokerAuth = async () => {
      if (brokerInFlight) return;
      brokerInFlight = true;
      try {
        const res = await fetch(
          brokerUrl + "/v1/pods/" + encodeURIComponent(brokerPodId) + "/model-credential-lease?revision=" + encodeURIComponent(lastRevision),
          { headers: { authorization: "Bearer " + brokerToken } },
        );
        if (res.status === 304) return;
        if (!res.ok) return;
        const body = await res.json();
        if (!body || typeof body !== "object" || Array.isArray(body)) return;
        if (typeof body.revision !== "string" || !body.revision) return;
        if (!body.providers || typeof body.providers !== "object" || Array.isArray(body.providers)) return;
        const remoteEntries = {};
        for (const [id, item] of Object.entries(body.providers)) {
          if (!item || typeof item !== "object" || Array.isArray(item)) continue;
          const entry = item.entry;
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
          remoteEntries[id] = entry;
        }
        const fs = await import("node:fs");
        let local = {};
        try {
          const parsed = JSON.parse(fs.readFileSync(brokerAuthPath, "utf8"));
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) local = parsed;
        } catch {}
        const mergedEntries = { ...local, ...remoteEntries };
        writeIfChanged(fs, brokerAuthPath, JSON.stringify(mergedEntries, null, 2) + "\\n");
        lastRevision = body.revision;
      } catch {
        // best-effort: the next poll retries
      } finally {
        brokerInFlight = false;
      }
    };
    void syncBrokerAuth();
    const brokerTimer = setInterval(() => void syncBrokerAuth(), 10 * 60 * 1000 + Math.floor(Math.random() * 30 * 1000));
    if (typeof brokerTimer.unref === "function") brokerTimer.unref();
  }
`;
