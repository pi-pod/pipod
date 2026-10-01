import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  CURRENT_SESSION_VERSION,
  getPackageDir,
  SessionManager,
  SessionSelectorComponent,
  type SessionEntry,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import type {
  GatewayRpcClient,
  SessionCatalogEntry,
  SessionsFrame,
} from "../../account/gateway-rpc.js";
import type { RemoteRuntime } from "./remote-runtime.js";

const SESSION_CATALOG_UNAVAILABLE =
  "Pod session list needs an updated server/pod. Exit Pi, then attach again after the server is updated.";
const TRUST_FIXED = "Pod trust is fixed at pod creation and cannot be changed from a pod session.";
const RELOAD_UNAVAILABLE =
  "Pod resource reload isn't available in this pod session; exit and re-attach to pick up resource changes. Launcher chords remain available.";

interface PodInteractiveMode {
  session: {
    isStreaming: boolean;
    isCompacting: boolean;
    reload(options?: unknown): Promise<void>;
    modelRuntime: unknown;
    state: unknown;
  };
  ui: {
    requestRender(force?: boolean): void;
  };
  editorContainer: unknown;
  editor: unknown;
  keybindings: unknown;
  showSelector(create: (done: () => void) => { component: unknown; focus: unknown }): void;
  handleResumeSession(path: string): Promise<unknown>;
  getPathCommandArgument(text: string, command: string): string | undefined;
  showStatus(message: string): void;
  showWarning(message: string): void;
  showError(message: string): void;
  shutdown(): Promise<void>;
  showSessionSelector(): void;
  showTrustSelector(): void;
  handleExportCommand(text: string): Promise<void>;
  handleShareCommand(): Promise<void>;
  handleReloadCommand(): Promise<void>;
}

export interface MaterializedSession {
  sessionId: string;
  cwd: string;
  entries: readonly SessionEntry[];
  timestamp?: string;
}

interface ExportFromFile {
  (inputPath: string, options?: { outputPath?: string; themeName?: string }): Promise<string>;
}

interface ShareSession {
  (context: {
    session: unknown;
    ui: unknown;
    editorContainer: unknown;
    editor: unknown;
    showStatus(message: string): void;
    showError(message: string): void;
  }): Promise<void>;
}

/** Convert the server catalog into Pi's picker shape without reviving any local sessions. */
export function catalogToSessionInfo(entries: readonly SessionCatalogEntry[]): SessionInfo[] {
  const pathById = new Map(
    entries.flatMap((entry) => entry.path ? [[entry.id, entry.path] as const] : []),
  );
  return entries.flatMap((entry) => {
    if (!entry.path) return [];
    const parentSessionPath = entry.parentSessionId ? pathById.get(entry.parentSessionId) : undefined;
    return [{
      path: entry.path,
      id: entry.id,
      cwd: entry.cwd ?? "",
      ...(entry.name !== undefined ? { name: entry.name } : {}),
      ...(parentSessionPath !== undefined ? { parentSessionPath } : {}),
      created: new Date(entry.createdAt),
      modified: new Date(entry.modified ?? entry.createdAt),
      messageCount: entry.messageCount ?? 0,
      firstMessage: entry.firstMessage ?? "",
      // Search remains metadata-only in v1; transcript text stays beside the pod-side index.
      allMessagesText: "",
    }];
  });
}

/** Loader pair used by SessionSelectorComponent: exact pod-workdir matches vs the full catalog. */
export function catalogLoaders(frame: SessionsFrame): {
  current(): Promise<SessionInfo[]>;
  all(): Promise<SessionInfo[]>;
} {
  const all = catalogToSessionInfo(frame.sessions);
  const current = all.filter((session) => session.cwd === frame.workdir);
  return {
    current: async () => current,
    all: async () => all,
  };
}

/** Deterministic branch materialization in Pi's native version-3 JSONL format. */
export function materializeSessionJsonl(session: MaterializedSession): string {
  const timestamp = session.timestamp ?? new Date().toISOString();
  const header = {
    type: "session" as const,
    version: CURRENT_SESSION_VERSION,
    id: session.sessionId,
    timestamp,
    cwd: session.cwd,
  };
  let parentId: string | null = null;
  const entries = session.entries.map((entry) => {
    const linear = { ...entry, parentId };
    parentId = entry.id;
    return linear;
  });
  return [...[header], ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}

export function writeMaterializedSession(filePath: string, session: MaterializedSession): string {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, materializeSessionJsonl(session), "utf8");
  return resolved;
}

async function loadPiCommandInternals(): Promise<{ exportFromFile: ExportFromFile; shareSession: ShareSession }> {
  const packageDir = getPackageDir();
  const exporter = await import(pathToFileURL(path.join(packageDir, "dist/core/export-html/index.js")).href) as {
    exportFromFile: ExportFromFile;
  };
  const sharing = await import(pathToFileURL(path.join(packageDir, "dist/modes/interactive/session-share.js")).href) as {
    shareSession: ShareSession;
  };
  return { exportFromFile: exporter.exportFromFile, shareSession: sharing.shareSession };
}

async function withMaterializedSession<T>(
  session: MaterializedSession,
  run: (inputPath: string) => Promise<T>,
): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pod-session-"));
  const safeId = session.sessionId.replace(/[^A-Za-z0-9._-]/g, "-") || "current";
  const inputPath = path.join(dir, `session-${safeId}.jsonl`);
  try {
    writeMaterializedSession(inputPath, session);
    return await run(inputPath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export async function exportMaterializedSessionToHtml(
  session: MaterializedSession,
  outputPath?: string,
  themeName?: string,
): Promise<string> {
  return withMaterializedSession(session, async (inputPath) => {
    const { exportFromFile } = await loadPiCommandInternals();
    return exportFromFile(inputPath, {
      ...(outputPath !== undefined ? { outputPath } : {}),
      ...(themeName !== undefined ? { themeName } : {}),
    });
  });
}

/** Install the one temporary InteractiveMode shim deleted by the upstream runtime-service seam. */
export function installPodCommandOverrides(
  modeValue: InstanceType<typeof import("@earendil-works/pi-coding-agent").InteractiveMode>,
  runtime: Pick<RemoteRuntime, "cache" | "treeBridge" | "refreshAfterReplacement">,
  gateway: Pick<GatewayRpcClient, "getSessions" | "searchSessions" | "reloadResources">,
  getPodWorkdir: () => string,
): void {
  const mode = modeValue as unknown as PodInteractiveMode;

  mode.showSessionSelector = () => {
    void gateway.getSessions().then((frame) => {
      if (frame.unsupported) {
        mode.showWarning(SESSION_CATALOG_UNAVAILABLE);
        return;
      }
      const loaders = catalogLoaders(frame);
      if (!frame.complete) mode.showWarning("Showing the most recent pod sessions; the catalog was capped.");
      mode.showSelector((done) => {
        const selector = new SessionSelectorComponent(
          loaders.current,
          loaders.all,
          async (sessionPath) => {
            done();
            await mode.handleResumeSession(sessionPath);
          },
          () => {
            done();
            mode.ui.requestRender();
          },
          () => { void mode.shutdown(); },
          () => mode.ui.requestRender(),
          { showRenameHint: false, keybindings: mode.keybindings as never },
          runtime.cache.state.sessionFile,
        );
        return { component: selector, focus: selector };
      });
    }).catch((error: unknown) => {
      mode.showWarning(`${SESSION_CATALOG_UNAVAILABLE} (${error instanceof Error ? error.message : String(error)})`);
    });
  };

  mode.showTrustSelector = () => {
    mode.showWarning(TRUST_FIXED);
  };

  mode.handleExportCommand = async (text) => {
    const outputPath = mode.getPathCommandArgument(text, "/export");
    if (outputPath?.endsWith(".jsonl")) {
      mode.showWarning("/export JSONL is not available in pod sessions; use HTML export instead.");
      return;
    }
    try {
      await runtime.cache.refreshTree();
      const filePath = await exportMaterializedSessionToHtml({
        sessionId: runtime.cache.state.sessionId,
        cwd: getPodWorkdir(),
        entries: runtime.cache.entries,
      }, outputPath);
      mode.showStatus(`Session exported to: ${filePath}`);
    } catch (error) {
      mode.showError(`Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  };

  mode.handleShareCommand = async () => {
    try {
      await runtime.cache.refreshTree();
      await withMaterializedSession({
        sessionId: runtime.cache.state.sessionId,
        cwd: getPodWorkdir(),
        entries: runtime.cache.entries,
      }, async (inputPath) => {
        const manager = SessionManager.open(inputPath);
        const { exportFromFile, shareSession } = await loadPiCommandInternals();
        const shareFacade = new Proxy(mode.session as object, {
          get(target, property, receiver) {
            if (property === "sessionManager") return manager;
            if (property === "exportToHtml") {
              return (outputPath?: string, options?: { themeName?: string }) =>
                exportFromFile(inputPath, {
                  ...(outputPath !== undefined ? { outputPath } : {}),
                  ...(options?.themeName !== undefined ? { themeName: options.themeName } : {}),
                });
            }
            return Reflect.get(target, property, receiver);
          },
        });
        await shareSession({
          session: shareFacade,
          ui: mode.ui,
          editorContainer: mode.editorContainer,
          editor: mode.editor,
          showStatus: (message) => mode.showStatus(message),
          showError: (message) => mode.showError(message),
        });
      });
    } catch (error) {
      mode.showError(`Failed to share session: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  };

  mode.handleReloadCommand = async () => {
    if (mode.session.isStreaming) {
      mode.showWarning("Wait for the current response to finish before reloading.");
      return;
    }
    if (mode.session.isCompacting) {
      mode.showWarning("Wait for compaction to finish before reloading.");
      return;
    }
    const result = await gateway.reloadResources();
    if (result.unsupported) {
      await mode.session.reload();
      mode.showWarning(RELOAD_UNAVAILABLE);
      return;
    }
    if (!result.ok) {
      mode.showError("Pod resource reload failed.");
      return;
    }
    try {
      await runtime.refreshAfterReplacement();
      await mode.session.reload();
      mode.showStatus("Reloaded pod resources and refreshed the session");
    } catch (error) {
      mode.showError(`Reload failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}
