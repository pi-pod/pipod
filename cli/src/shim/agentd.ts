// Server agentd v13 adds the tui_manifest control command without changing the C/E/S
// protocol seen by clients. Keep one previous generation attachable.
export const SHIM_VERSION = "13";
export const PREVIOUS_SHIM_VERSION = "12";
export const SHIM_PATH = "/tmp/pi-pod-agentd.cjs";
export const SHIM_LOG_PATH = "/tmp/pi-pod-agentd.log";
