// Server agentd v14 binds version discovery to its launched executable and can refresh
// failed lookups without changing Pi's RPC surface. Keep v13 sessions attachable.
export const SHIM_VERSION = "14";
export const PREVIOUS_SHIM_VERSION = "13";
export const SHIM_PATH = "/tmp/pi-pod-agentd.cjs";
export const SHIM_LOG_PATH = "/tmp/pi-pod-agentd.log";
