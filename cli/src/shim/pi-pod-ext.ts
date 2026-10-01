export const POD_EXTENSION_VERSION = 11;

export const TREE_BRIDGE_PROTOCOL_VERSION = 1 as const;
export const TREE_BRIDGE_NAVIGATE_COMMAND = "pod:_tree-navigate-v1";
/** Same request as v1, but the acknowledgement carries the target's full editor text. */
export const TREE_BRIDGE_NAVIGATE_V2_COMMAND = "pod:_tree-navigate-v2";
export const TREE_BRIDGE_LABEL_COMMAND = "pod:_tree-label-v1";
export const TREE_BRIDGE_NOTIFICATION_PREFIX = "pi-pod-internal/tree-v1:";
export const POD_INTERNAL_COMMAND_PREFIX = "pod:_";

/** Auxiliary completions for locally rendered extensions, executed pod-side with real auth. */
export const AUX_BRIDGE_PROTOCOL_VERSION = 1 as const;
export const AUX_COMPLETE_COMMAND = "pod:_aux-complete-v1";
export const AUX_CANCEL_COMMAND = "pod:_aux-cancel-v1";
export const AUX_NOTIFICATION_PREFIX = "pi-pod-internal/aux-v1:";
/** First pod extension version serving aux completions; older pods get honest errors. */
export const AUX_EXTENSION_VERSION = 11;
export const AUX_MAX_ENCODED_REQUEST_BYTES = 256 * 1024;
export const AUX_MAX_ENCODED_RESPONSE_BYTES = 256 * 1024;
export const TREE_BRIDGE_MAX_ENCODED_REQUEST_BYTES = 16 * 1024;
export const TREE_BRIDGE_MAX_ENCODED_RESPONSE_BYTES = 256 * 1024;
export const TREE_BRIDGE_MAX_ID_LENGTH = 128;
export const TREE_BRIDGE_MAX_ENTRY_ID_LENGTH = 512;
export const TREE_BRIDGE_MAX_LABEL_LENGTH = 256;

export const APPEND_ENTRY_COMMAND = "pod:_append-entry-v1";
export const APPEND_ENTRY_PROTOCOL_VERSION = 1 as const;
export const APPEND_ENTRY_MAX_CUSTOM_TYPE_LENGTH = 256;

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

/** Read-only pod session catalog + naive search over on-disk JSONL. */
export const SESSION_CATALOG_PROTOCOL_VERSION = 1 as const;
export const SESSION_LIST_COMMAND = "pod:_list-sessions-v1";
export const SESSION_SEARCH_COMMAND = "pod:_search-sessions-v1";
