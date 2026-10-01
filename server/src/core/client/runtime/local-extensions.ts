/**
 * src/client/runtime/local-extensions.ts — the client-side extension host.
 *
 * Display-only Pi extensions listed in `pi.clientExtensions` run *in the launcher process*,
 * where pi's real `InteractiveMode` and pi-tui classes live, instead of in the pod — their
 * rendering hooks (entry/message renderers, markdown transformers, prototype patches) cannot
 * cross the JSON/RPC boundary. A listed extension runs locally *instead of* in the pod, never
 * in both places: the launch path subtracts it from the settings uploaded to the pod.
 *
 * The genuine `ExtensionRunner` runs here, over pi's genuine loader. The loader is a deep
 * file import rather than a package import because pi's public entry does not re-export
 * `loadExtensions` — the resolved file is the same module instance pi's own dist imports, so
 * jiti's bundled-package aliases (and therefore prototype patches against pi-tui classes)
 * hit the launcher's own copies. The surface canary (scripts/check-runtime-surface.ts)
 * asserts these internals on every lint run, so a pi upgrade that moves them fails loudly.
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { buildContextEntries as buildPiContextEntries, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { HOST_PI_AGENT_SUBPATH, hostHome } from "../../hostconfig.js";
import { debug } from "../../log.js";
import {
  APPEND_ENTRY_COMMAND,
  APPEND_ENTRY_MAX_CUSTOM_TYPE_LENGTH,
  APPEND_ENTRY_PROTOCOL_VERSION,
  TREE_BRIDGE_MAX_ENCODED_REQUEST_BYTES,
} from "../../shim/pi-pod-ext.js";
import type { RpcClientBase } from "../rpc.js";
import type { HostBridge } from "./bridge.js";
import { findTreeNode, type RemoteStateCache } from "./state.js";

// ---------------------------------------------------------------------------
// Resolution: config names → loadable paths
// ---------------------------------------------------------------------------

export interface ResolvedClientExtensions {
  /** Extension entry files, ready for pi's `loadExtensions` (which takes files, not packages). */
  paths: string[];
  /** Names that could not be resolved — warnings, never errors: the config is committed. */
  warnings: string[];
}

/** A `pi.clientExtensions` entry that names a filesystem location rather than a package. */
function looksLikePath(name: string): boolean {
  if (name.startsWith("@")) return false; // scoped npm package
  return path.isAbsolute(name) || name.startsWith(".") || name.startsWith("~") || name.includes("/") || name.includes("\\");
}

/**
 * A directory's extension entry files, the way pi's own discovery resolves them: the
 * package.json `pi.extensions` manifest first, else an `index.ts`/`index.js`. Mirrored here
 * because pi exposes this resolution only inside `discoverAndLoadExtensions`, whose
 * project/agent-dir sweep would drag in extensions nobody listed; `loadExtensions` itself
 * loads files and fails outright on a directory.
 */
function extensionEntriesOf(dir: string): string[] {
  const manifestPath = path.join(dir, "package.json");
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
        pi?: { extensions?: unknown };
      };
      const declared = Array.isArray(manifest.pi?.extensions) ? manifest.pi.extensions : [];
      const entries = declared
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => path.resolve(dir, entry))
        .filter((entry) => fs.existsSync(entry));
      if (entries.length > 0) return entries;
    } catch {
      // Malformed manifest: fall through to the index convention.
    }
  }
  for (const index of ["index.ts", "index.js"]) {
    const candidate = path.join(dir, index);
    if (fs.existsSync(candidate)) return [candidate];
  }
  return [];
}

/**
 * Resolve `pi.clientExtensions` entries against the host machine. Package names resolve under
 * `~/.pi/agent/npm/node_modules/<name>` (pi's user-scope install root); path-looking entries
 * resolve against the project root. Missing entries warn rather than fail — the config is
 * committed and a teammate may not have the package installed.
 */
export function resolveClientExtensions(
  names: string[],
  opts: { home?: string | undefined; projectRoot?: string | undefined } = {},
): ResolvedClientExtensions {
  const paths: string[] = [];
  const warnings: string[] = [];
  if (names.length === 0) return { paths, warnings };

  const home = hostHome(opts.home);
  for (const name of names) {
    if (looksLikePath(name)) {
      const expanded = name.startsWith("~") && home ? path.join(home, name.slice(1)) : name;
      const resolved = path.resolve(opts.projectRoot ?? process.cwd(), expanded);
      if (!fs.existsSync(resolved)) {
        warnings.push(`pi.clientExtensions: ${name} does not exist — skipped`);
        continue;
      }
      if (fs.statSync(resolved).isDirectory()) {
        const entries = extensionEntriesOf(resolved);
        if (entries.length === 0) {
          warnings.push(`pi.clientExtensions: ${name} has no extension entry (pi.extensions manifest or index.ts/index.js) — skipped`);
          continue;
        }
        paths.push(...entries);
      } else {
        paths.push(resolved);
      }
      continue;
    }
    if (!home) {
      warnings.push(`pi.clientExtensions: no host home directory to resolve "${name}" — skipped`);
      continue;
    }
    const packageDir = path.join(home, HOST_PI_AGENT_SUBPATH, "npm", "node_modules", name);
    if (!fs.existsSync(packageDir)) {
      warnings.push(
        `pi.clientExtensions: ${name} is not installed on this host (${packageDir}) — skipped. ` +
          `Install it with pi (settings.json "packages") or remove it from pi.clientExtensions`,
      );
      continue;
    }
    const entries = extensionEntriesOf(packageDir);
    if (entries.length === 0) {
      warnings.push(
        `pi.clientExtensions: ${name} declares no extension entry (pi.extensions manifest or index.ts/index.js) — skipped`,
      );
      continue;
    }
    paths.push(...entries);
  }
  return { paths, warnings };
}

// ---------------------------------------------------------------------------
// Pi internals: the loader and runner, deep-imported (see module docs)
// ---------------------------------------------------------------------------

/** The slice of pi's ExtensionRunner the host touches; canary-guarded, duck-typed. */
export interface LocalExtensionRunner {
  bindCore(actions: unknown, contextActions: unknown, providerActions?: unknown): void;
  bindCommandContext(actions?: unknown): void;
  setUIContext(uiContext?: unknown, mode?: string): void;
  getAllRegisteredTools(): unknown[];
  getRegisteredCommands(): ResolvedLocalCommand[];
  getCommand(name: string): ResolvedLocalCommand | undefined;
  getCommandDiagnostics(): unknown[];
  getShortcuts(resolvedKeybindings: unknown): Map<string, unknown>;
  getShortcutDiagnostics(): unknown[];
  getEntryRenderer(customType: string): unknown;
  getMessageRenderer(customType: string): unknown;
  getMarkdownTransformers(): unknown[];
  createCommandContext(): unknown;
  hasHandlers(eventType: string): boolean;
  emit(event: unknown): Promise<unknown>;
  emitError(error: { extensionPath: string; event: string; error: string }): void;
  onError(listener: (error: { extensionPath: string; event: string; error: string }) => void): () => void;
  invalidate(message?: string): void;
}

export interface ResolvedLocalCommand {
  name: string;
  invocationName: string;
  description?: string;
  sourceInfo: unknown;
  getArgumentCompletions?: (prefix: string) => unknown;
  handler: (args: string, ctx: unknown) => Promise<void>;
}

interface LoadedExtension {
  path: string;
  resolvedPath: string;
  tools: Map<string, unknown>;
  handlers: Map<string, unknown[]>;
}

interface PiExtensionInternals {
  loadExtensions(
    paths: string[],
    cwd: string,
    eventBus?: unknown,
    runtime?: unknown,
  ): Promise<{
    extensions: LoadedExtension[];
    errors: Array<{ path: string; error: string }>;
    runtime: {
      pendingProviderRegistrations: Array<{ extensionPath: string }>;
      pendingNativeProviderRegistrations: Array<{ extensionPath: string }>;
    };
  }>;
  createExtensionRuntime(): unknown;
}

/**
 * Pi's loader module, by file path. The URL resolves to the same file pi's own
 * `dist/index.js` imports, so Node's module cache guarantees one shared instance —
 * which is what makes the loader's bundled-package aliases point at the launcher's pi.
 */
export async function loadPiExtensionInternals(): Promise<PiExtensionInternals> {
  // import.meta.resolve rather than require.resolve: pi's exports map declares only the
  // "import" condition, so a CJS-style resolve has no entry to find.
  const entryUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
  const loader = (await import(new URL("core/extensions/loader.js", entryUrl).href)) as Partial<PiExtensionInternals>;
  if (typeof loader.loadExtensions !== "function" || typeof loader.createExtensionRuntime !== "function") {
    throw new Error(
      "pi's extension loader no longer exposes loadExtensions/createExtensionRuntime — " +
        "pi-pod needs an update for this pi version",
    );
  }
  return loader as PiExtensionInternals;
}

// ---------------------------------------------------------------------------
// The host
// ---------------------------------------------------------------------------

/** What createLocalExtensionHost needs from the remote runtime; everything else is the cache's. */
export interface LocalExtensionHostOptions {
  paths: string[];
  hostCwd: string;
  cache: RemoteStateCache;
  bridge: HostBridge;
  rpc: RpcClientBase;
  /** Live values owned by the remote runtime (scope edits, CLI overrides). */
  getScopedModels(): readonly unknown[];
  /** Session actions that already exist on the runtime's 57-member session surface. */
  prompt(text: string, opts?: { streamingBehavior?: "steer" | "followUp" }): Promise<void>;
  setModel(model: { provider: string; id: string }): Promise<unknown>;
  setThinkingLevel(level: unknown): Promise<unknown>;
  setSessionName(name: string): unknown;
  setLabel(entryId: string, label: string | undefined): void;
  getContextUsage(): unknown;
  abort(): void;
  compact(customInstructions?: string): Promise<unknown>;
  waitForIdle(timeoutMs?: number): Promise<void>;
  /** The runtime's model facade, handed to extensions as ctx.modelRegistry. */
  modelRegistry: object;
  /** Merged command list for pi.getCommands() — the same view the TUI autocomplete gets. */
  getCommands(): unknown[];
  /** Test seam: substitute pi internals. */
  internals?: PiExtensionInternals;
}

export interface LocalExtensionHost {
  runner: LocalExtensionRunner;
  /** Extension display names, for launch reporting. */
  names: string[];
  /** Run `/name args` when a local extension registered it. False when no command matches. */
  runCommand(text: string): Promise<boolean>;
  /** Forward one already-healed RPC event to local handlers; results are ignored. */
  emitAgentEvent(event: unknown): void;
  sessionStart(reason: "startup" | "resume"): Promise<void>;
  sessionShutdown(reason: "quit" | "resume"): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * Events client-side handlers may observe: the RPC stream restores their in-process
 * cumulative shape (StreamHeal), and none of them can alter agent behavior — blocking hooks
 * (`tool_call`, `context`, `before_agent_start`) run pod-side and are not in the stream.
 */
const FORWARDED_EVENTS = new Set([
  "agent_start",
  "agent_end",
  "agent_settled",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
]);

/** A human name for an extension: its npm package when installed as one, else the file. */
function extensionDisplayName(extensionPath: string): string {
  const marker = `node_modules${path.sep}`;
  const index = extensionPath.lastIndexOf(marker);
  if (index !== -1) {
    const rest = extensionPath.slice(index + marker.length).split(path.sep);
    return rest[0]?.startsWith("@") ? `${rest[0]}/${rest[1] ?? ""}` : (rest[0] ?? extensionPath);
  }
  return path.basename(extensionPath);
}

function unavailable(what: string, use?: string): () => never {
  return () => {
    throw new Error(
      `${what} is not available to client-side extensions (pi.clientExtensions)` + (use ? ` — ${use}` : ""),
    );
  };
}

/** Root-to-target entry chain, the way pi's SessionManager.getBranch reads. */
function branchOf(entries: SessionEntry[], fromId: string | null): SessionEntry[] {
  if (fromId === null) return [];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const out: SessionEntry[] = [];
  let current = byId.get(fromId);
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    out.push(current);
    current =
      current.parentId !== null && current.parentId !== current.id ? byId.get(current.parentId) : undefined;
  }
  return out.reverse();
}

/**
 * Load the listed extensions and stand up a real ExtensionRunner over the RPC-backed session.
 * Returns null when nothing loads — the caller stays on the zero-cost stub path. Load
 * failures degrade to a warning: a session without a cosmetic extension beats no session.
 */
export async function createLocalExtensionHost(
  opts: LocalExtensionHostOptions,
): Promise<LocalExtensionHost | null> {
  if (opts.paths.length === 0) return null;
  const { cache, bridge, rpc } = opts;
  const notifyWhenBound = (message: string, type: "info" | "warning" | "error") => {
    bridge.onUiBound(() => bridge.notify(message, type));
  };

  let internals: PiExtensionInternals;
  let ExtensionRunnerClass: new (...args: never[]) => unknown;
  try {
    internals = opts.internals ?? (await loadPiExtensionInternals());
    ExtensionRunnerClass = (await import("@earendil-works/pi-coding-agent"))
      .ExtensionRunner as unknown as new (...args: never[]) => unknown;
  } catch (error) {
    notifyWhenBound(
      `client extensions unavailable: ${error instanceof Error ? error.message : String(error)}`,
      "warning",
    );
    return null;
  }

  const runtime = internals.createExtensionRuntime();
  const loaded = await internals.loadExtensions(opts.paths, opts.hostCwd, undefined, runtime);
  for (const failure of loaded.errors) {
    notifyWhenBound(
      `client extension failed to load (${extensionDisplayName(failure.path)}): ${failure.error}`,
      "warning",
    );
  }

  // --- load-time gate: display-only is enforced, not assumed -----------------
  // Tools and providers execute in the pod; an extension registering either cannot be a
  // client extension. Refuse it by name and capability, and keep the session going.
  const providerPaths = new Set(
    [...loaded.runtime.pendingProviderRegistrations, ...loaded.runtime.pendingNativeProviderRegistrations].map(
      (registration) => registration.extensionPath,
    ),
  );
  const kept: LoadedExtension[] = [];
  for (const extension of loaded.extensions) {
    const capabilities = [
      ...(extension.tools.size > 0 ? [`tools (${[...extension.tools.keys()].join(", ")})`] : []),
      ...(providerPaths.has(extension.path) || providerPaths.has(extension.resolvedPath) ? ["a provider"] : []),
    ];
    if (capabilities.length > 0) {
      notifyWhenBound(
        `pi.clientExtensions: ${extensionDisplayName(extension.path)} registers ${capabilities.join(" and ")}, ` +
          "which execute in the pod — remove it from pi.clientExtensions to run it pod-side. Not loaded client-side.",
        "error",
      );
      continue;
    }
    kept.push(extension);
  }
  // Nothing may flush queued provider registrations at bindCore time.
  loaded.runtime.pendingProviderRegistrations.length = 0;
  loaded.runtime.pendingNativeProviderRegistrations.length = 0;
  if (kept.length === 0) return null;

  // --- session/model facades -------------------------------------------------
  const throwMutator = (name: string) =>
    unavailable(`sessionManager.${name}`, "session files live in the pod");
  const sessionManagerFacade = {
    getCwd: () => opts.hostCwd,
    getSessionDir: () => opts.hostCwd,
    usesDefaultSessionDir: () => true,
    isPersisted: () => cache.state.sessionFile !== undefined,
    getSessionId: () => cache.state.sessionId,
    getSessionFile: () => cache.state.sessionFile,
    getSessionName: () => cache.state.sessionName,
    getLeafId: () => cache.leafId,
    getLeafEntry: () => cache.entries.find((entry) => entry.id === cache.leafId),
    getEntry: (id: string) => cache.entries.find((entry) => entry.id === id),
    getChildren: (parentId: string) => cache.entries.filter((entry) => entry.parentId === parentId),
    getEntries: () => cache.entries,
    getTree: () => cache.tree,
    getLabel: (id: string) => findTreeNode(cache.tree, id)?.label,
    getBranch: (fromId?: string) => branchOf(cache.entries, fromId ?? cache.leafId),
    buildContextEntries: () => {
      const byId = new Map(cache.entries.map((entry) => [entry.id, entry]));
      return buildPiContextEntries(cache.entries, cache.leafId, byId);
    },
    // Mutators throw: the pod's session file is authoritative, and a silent local write
    // would fork the transcript.
    appendMessage: throwMutator("appendMessage"),
    appendCustomEntry: throwMutator("appendCustomEntry"),
    appendSessionInfo: throwMutator("appendSessionInfo"),
    appendThinkingLevelChange: throwMutator("appendThinkingLevelChange"),
    appendModelChange: throwMutator("appendModelChange"),
    appendLabelChange: throwMutator("appendLabelChange"),
    setSessionFile: throwMutator("setSessionFile"),
    newSession: throwMutator("newSession"),
    branch: throwMutator("branch"),
    branchWithSummary: throwMutator("branchWithSummary"),
    createBranchedSession: throwMutator("createBranchedSession"),
    resetLeaf: throwMutator("resetLeaf"),
  };

  const runner = new (ExtensionRunnerClass as new (
    extensions: unknown,
    runtime: unknown,
    cwd: string,
    sessionManager: unknown,
    modelRegistry: unknown,
  ) => LocalExtensionRunner)(kept, runtime, opts.hostCwd, sessionManagerFacade, opts.modelRegistry);

  // --- appendEntry bridge (phase 4): durable entries land in the pod's JSONL ---
  let appendEntryWarned = false;
  const appendEntryUnavailable = (reason: string) => {
    if (appendEntryWarned) return;
    appendEntryWarned = true;
    notifyWhenBound(`client extension appendEntry: ${reason} — the entry was not recorded`, "warning");
  };
  const supportsAppendEntry = () =>
    cache.commands.some((command) => {
      const candidate = command as { name?: unknown; source?: unknown };
      return candidate.name === APPEND_ENTRY_COMMAND && candidate.source === "extension";
    });
  const sendAppendEntry = (customType: string, data?: unknown): void => {
    if (typeof customType !== "string" || customType.length === 0 || customType.length > APPEND_ENTRY_MAX_CUSTOM_TYPE_LENGTH) {
      appendEntryUnavailable(`invalid custom type ${JSON.stringify(customType).slice(0, 64)}`);
      return;
    }
    if (!supportsAppendEntry()) {
      appendEntryUnavailable("this pod runs an older pi-pod extension (restart Pi in the pod to update it)");
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
      appendEntryUnavailable(`entry data is not serializable (${error instanceof Error ? error.message : String(error)})`);
      return;
    }
    if (Buffer.byteLength(encoded, "utf8") > TREE_BRIDGE_MAX_ENCODED_REQUEST_BYTES) {
      appendEntryUnavailable("entry data exceeds the bridge size limit");
      return;
    }
    void rpc
      .prompt(`/${APPEND_ENTRY_COMMAND} ${encoded}`)
      .then(() => cache.refreshTree().then(() => undefined))
      .catch((error: unknown) => {
        appendEntryUnavailable(error instanceof Error ? error.message : String(error));
        debug(`append-entry bridge failed: ${error instanceof Error ? error.message : String(error)}`);
      });
  };

  // --- bindCore: the extension-facing pi.* actions --------------------------
  const actions = {
    sendMessage: unavailable("pi.sendMessage", "conversation context is built in the pod"),
    sendUserMessage: (content: unknown, sendOptions?: { streamingBehavior?: "steer" | "followUp" }) => {
      const text =
        typeof content === "string"
          ? content
          : (content as Array<{ text?: string }>).map((part) => part.text ?? "").join("");
      void opts
        .prompt(text, sendOptions?.streamingBehavior ? { streamingBehavior: sendOptions.streamingBehavior } : undefined)
        .catch((error: unknown) =>
          bridge.notify(
            `extension sendUserMessage failed: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          ),
        );
    },
    appendEntry: (customType: string, data?: unknown) => sendAppendEntry(customType, data),
    setSessionName: (name: string) => void opts.setSessionName(name),
    getSessionName: () => cache.state.sessionName,
    setLabel: (entryId: string, label: string | undefined) => opts.setLabel(entryId, label),
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools: unavailable("pi.setActiveTools", "tools execute in the pod"),
    refreshTools: () => {},
    getCommands: () => opts.getCommands(),
    setModel: async (model: { provider: string; id: string }) => {
      await opts.setModel(model);
      return true;
    },
    getThinkingLevel: () => cache.state.thinkingLevel,
    setThinkingLevel: (level: unknown) => void opts.setThinkingLevel(level),
  };
  const contextActions = {
    getModel: () => cache.state.model,
    getScopedModels: () => opts.getScopedModels(),
    isIdle: () => !cache.state.isStreaming && !cache.state.isCompacting,
    // The pod session runs with the workspace trusted (--approve is pi-pod's default).
    isProjectTrusted: () => true,
    getSignal: () => undefined,
    abort: () => opts.abort(),
    hasPendingMessages: () => cache.state.pendingMessageCount > 0,
    shutdown: () => bridge.requestShutdown(),
    getContextUsage: () => opts.getContextUsage(),
    compact: (compactOptions?: { customInstructions?: string }) =>
      void opts.compact(compactOptions?.customInstructions).catch((error: unknown) =>
        bridge.notify(`compaction failed: ${error instanceof Error ? error.message : String(error)}`, "error"),
      ),
    getSystemPrompt: () => "",
  };
  const providerActions = {
    registerProvider: unavailable("pi.registerProvider", "providers execute in the pod"),
    registerNativeProvider: unavailable("pi.registerProvider", "providers execute in the pod"),
    unregisterProvider: unavailable("pi.unregisterProvider", "providers execute in the pod"),
  };
  runner.bindCore(actions, contextActions, providerActions);
  runner.bindCommandContext({
    waitForIdle: () => opts.waitForIdle(),
    newSession: unavailable("ctx.newSession", "run /new in the session instead"),
    fork: unavailable("ctx.fork", "run /fork in the session instead"),
    navigateTree: unavailable("ctx.navigateTree", "run /tree in the session instead"),
    switchSession: unavailable("ctx.switchSession", "run /resume in the session instead"),
    reload: unavailable("ctx.reload", "run /reload in the session instead"),
  });
  runner.onError((error) =>
    bridge.notify(`client extension error (${extensionDisplayName(error.extensionPath)}): ${error.error}`, "error"),
  );

  // The real local UI context (theme included) — rebound on every session replacement,
  // because InteractiveMode hands over a fresh context each time it rebinds.
  const unbindUi = bridge.onEveryUiBound((ui) => runner.setUIContext(ui as never, "tui"));

  const emitLifecycle = async (event: { type: string; reason: string }): Promise<void> => {
    if (!runner.hasHandlers(event.type)) return;
    await runner.emit(event).catch((error: unknown) => {
      debug(`client extension ${event.type} handler failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  };

  let disposed = false;
  // In-process pi guarantees session_start precedes every agent event (it fires after the
  // UI binds, so handlers can use dialogs). Events that arrive before the deferred startup
  // session_start — a reattach to a mid-stream session — are dropped rather than delivered
  // out of order; the transcript itself is rebuilt from components, not from these hooks.
  let started = false;
  return {
    runner,
    names: kept.map((extension) => extensionDisplayName(extension.path)),
    runCommand: async (text: string): Promise<boolean> => {
      const trimmed = text.trimStart();
      if (!trimmed.startsWith("/")) return false;
      const space = trimmed.indexOf(" ");
      const name = space === -1 ? trimmed.slice(1) : trimmed.slice(1, space);
      const command = runner.getCommand(name);
      if (!command) return false;
      const args = space === -1 ? "" : trimmed.slice(space + 1).trim();
      try {
        await command.handler(args, runner.createCommandContext());
      } catch (error) {
        runner.emitError({
          extensionPath: `command:${name}`,
          event: "command",
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return true;
    },
    emitAgentEvent: (event: unknown): void => {
      if (disposed || !started) return;
      const type = (event as { type?: string }).type ?? "";
      if (!FORWARDED_EVENTS.has(type) || !runner.hasHandlers(type)) return;
      void runner.emit(event).catch((error: unknown) => {
        debug(`client extension ${type} handler failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    },
    sessionStart: (reason) => {
      started = true;
      return emitLifecycle({ type: "session_start", reason });
    },
    sessionShutdown: (reason) => emitLifecycle({ type: "session_shutdown", reason }),
    dispose: async (): Promise<void> => {
      if (disposed) return;
      disposed = true;
      unbindUi();
      runner.invalidate("This client-side extension context is stale: the pi-pod session has ended.");
    },
  };
}
