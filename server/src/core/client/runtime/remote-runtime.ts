/**
 * src/client/runtime/remote-runtime.ts — RemoteAgentSessionRuntime (§5.2).
 *
 * The local client IS pi's client: the launcher imports pi's real `InteractiveMode` and hands
 * its constructor this duck-typed runtime host. Nominal typing on the concrete class is a
 * compile-time concern only; at runtime the object must satisfy the member surface
 * InteractiveMode actually touches — measured from pi's shipped dist, and guarded by the
 * surface canary (scripts/check-runtime-surface.ts, §13).
 *
 * The split: sync getters are served from a client-side {@link RemoteStateCache}; methods map
 * ~1:1 onto RPC commands; the settings manager is the real local one (themes, hotkeys and
 * editor preferences are host concerns); pod-side services are backed by their RPC commands.
 */
import {
  SettingsManager,
  calculateContextTokens,
  buildContextEntries as buildPiContextEntries,
  resolveModelScopeWithDiagnostics,
  type ScopedModel,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { debug } from "../../log.js";
import type { RpcClientBase } from "../rpc.js";
import { POD_INTERNAL_COMMAND_PREFIX } from "../../shim/pi-pod-ext.js";
import {
  createLocalExtensionHost,
  type LocalExtensionHost,
  type ResolvedLocalCommand,
} from "./local-extensions.js";
import { HostBridge, type EndingIntent } from "./bridge.js";
import { AuthBridge, type RemoteAuthInteraction } from "./auth-bridge.js";
import { type DialogInvalidation, wireExtensionUi } from "./extension-ui.js";
import { PodExtensionBridge } from "./pod-extension-bridge.js";
import { PodCommandRouter, type PodCommandHost } from "./pod-commands.js";
import { RemoteUiBridge } from "./remote-ui.js";
import { findTreeNode, RemoteStateCache } from "./state.js";
import { StreamHeal } from "./stream-heal.js";

/** What dispose reports to the session driver — the input to §6.2's ending classification. */
export interface RuntimeEnding {
  intent: EndingIntent;
  /** True when InteractiveMode asked to quit (Ctrl-C Ctrl-C, Ctrl-D, or /quit). */
  quitRequested: boolean;
  /** pi's exit code, when the ending was a quit and pi_exit arrived in time. */
  exitCode: number | null;
  /** Tail of pi's stderr, for crash reports (§12). */
  stderrTail: string;
}

export interface RemoteRuntimeOptions {
  rpc: RpcClientBase;
  /** Host-side working directory (the repo root) — file autocomplete and settings live here. */
  cwd: string;
  /** Override for pi's agent dir (settings); undefined means pi's default. */
  agentDir?: string | undefined;
  /** CLI --models patterns, which take precedence over enabledModels in settings. */
  modelPatterns?: string[] | undefined;
  /**
   * The current pod's own enabledModels patterns (§5.2). RPC exposes no scoped-model list,
   * so without this the seed falls back to the host's settings — a different machine's
   * opinion of the scope. A thunk rather than a value so /pod switch reads the new pod.
   */
  getPodModelPatterns?: (() => Promise<string[] | undefined>) | undefined;
  /** Hooks for /pod subcommands beyond the leave family (§5.4). */
  podHost?: PodCommandHost;
  /** The TUI accepted a typed /pod command; clear its editor before the local action runs. */
  onPodCommandSubmit?: (() => void) | undefined;
  /**
   * Resolved `pi.clientExtensions` paths: display-only extensions run by the launcher's own
   * ExtensionRunner instead of in the pod (local-extensions.ts). Empty/absent costs nothing.
   */
  clientExtensionPaths?: string[] | undefined;
  /** Called from `runtimeHost.dispose()` after the ending is settled; teardown lives here. */
  onEnding: (ending: RuntimeEnding) => Promise<void>;
}

export interface RemoteRuntime {
  /** Duck-typed AgentSessionRuntime for `new InteractiveMode(runtimeHost)`. */
  runtimeHost: Record<string, unknown>;
  bridge: HostBridge;
  cache: RemoteStateCache;
  router: PodCommandRouter;
  treeBridge: PodExtensionBridge;
  /** Seed the caches; call before constructing InteractiveMode. */
  init(): Promise<void>;
  /** The session behind the runtime was replaced (§8, §6.4): re-seed and rebind the TUI. */
  refreshAfterReplacement(): Promise<void>;
  /**
   * The transport dropped and came back onto the same session: re-seed like a replacement,
   * but keep the dialogs the pod is still blocked on and put them back on screen (§5.3).
   */
  recoverAfterReconnect(): Promise<void>;
  /** Rebuild InteractiveMode's streaming component from the transport's cumulative snapshot. */
  healStreamingRenderer(): Promise<void>;
}

/** How long dispose waits for pi_exit after sending the shutdown frame (§6.2). */
const QUIT_TIMEOUT_MS = 15_000;

/** Remote slash command shape from get_commands (§5.4, phase 3 merges these). */
interface RemoteCommand {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
  sourceInfo: { path: string; source: string; scope: string; origin: string };
}

type RemoteModel = ScopedModel["model"];

/** Provider metadata crosses the wire, while auth implementations and stored credentials do not. */
interface RemoteProviderFacade {
  id: string;
  name: string;
  auth: {
    apiKey?: { name: string; login?: () => Promise<never> };
    oauth?: { name: string; loginLabel?: string; login: () => Promise<never> };
  };
}

export function createRemoteRuntime(opts: RemoteRuntimeOptions): RemoteRuntime {
  const { rpc, cwd } = opts;
  const bridge = new HostBridge();
  const cache = new RemoteStateCache(rpc);
  const treeBridge = new PodExtensionBridge(rpc, {
    getCommands: () => cache.commands,
    onAmbiguousFailure: () => cache.refreshTree().then(() => undefined),
  });
  const authBridge = new AuthBridge(rpc, { getCommands: () => cache.commands });
  const remoteUiBridge = new RemoteUiBridge(rpc, bridge);
  const router = new PodCommandRouter(bridge, opts.podHost);
  const settingsManager = SettingsManager.create(cwd, opts.agentDir);
  const remoteSettingsManager = new Proxy(settingsManager, {
    get(target, property) {
      if (property === "getBranchSummarySkipPrompt") return () => true;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(target, property, value) {
      return Reflect.set(target, property, value, target);
    },
  });

  // RPC 0.82.1 does not expose the pod session's scoped-model list. Keep the TUI's copy
  // locally, seeded from the same CLI/settings patterns pi used in the pod. Model changes
  // still cross the wire through set_model, so the pod remains authoritative for execution.
  let scopedModels: ScopedModel[] = [];
  const findCachedModel = (provider: string, id: string): RemoteModel | undefined =>
    (cache.availableModels as RemoteModel[]).find((model) => model.provider === provider && model.id === id);
  const rehydrateScopedModels = (): void => {
    scopedModels = scopedModels.flatMap((scoped) => {
      const model = findCachedModel(scoped.model.provider, scoped.model.id);
      return model ? [{ ...scoped, model }] : [];
    });
  };

  const listeners = new Set<(event: unknown) => void>();
  const abortController = new AbortController();
  const streamHeal = new StreamHeal();

  // Client-side extensions (pi.clientExtensions): loaded in init(), null for everyone else.
  let localHost: LocalExtensionHost | null = null;

  // The cache subscribes first, and deliberately so: listeners run in registration order, and
  // InteractiveMode answers events by reading this cache back synchronously — session_info_changed
  // retitles the terminal from `sessionManager.getSessionName()`. Fanning out first would hand
  // the TUI the state as it was *before* the event it is handling.
  const unwireCache = cache.wire();

  rpc.onEvent((event) => {
    const type = (event as { type?: string }).type ?? "";
    // Responses were correlated upstream; extension-UI requests are mapped separately (§5.3).
    if (type === "response" || type.startsWith("extension_ui")) return;
    // The RPC boundary restores cumulative snapshots; StreamHeal supplies the message_start
    // InteractiveMode discarded during a renderer/session rebind (§6.3). Before anyone
    // subscribes — the attach burst on a fresh mid-turn attach — expansion must not run:
    // it would spend the one synthetic message_start on an event nobody renders, and the
    // first post-subscription assistant event could no longer heal the stream.
    for (const expanded of listeners.size > 0 ? streamHeal.expand(event) : [event]) {
      for (const l of listeners) l(expanded);
      // After the cache listener (registration order guarantees the cache is current) and
      // after StreamHeal expansion, so local handlers see the in-process cumulative shape.
      localHost?.emitAgentEvent(expanded);
    }
  });

  const extensionUi = wireExtensionUi(
    rpc,
    bridge,
    (request) =>
      treeBridge.consumeExtensionNotification(request) ||
      authBridge.consumeExtensionRequest(request) ||
      remoteUiBridge.consumeExtensionRequest(request),
  );

  // Session-replacement callbacks InteractiveMode registers at construction (§5.2).
  let rebindSession: (() => Promise<void>) | null = null;
  let beforeSessionInvalidate: (() => void) | null = null;

  /** Arm after a renderer binds, then recover the shim/gateway's latest cumulative partial. */
  const healStreamingRenderer = async (): Promise<void> => {
    streamHeal.arm(cache.state.isStreaming);
    if (cache.state.isStreaming) {
      // InteractiveMode shows its working indicator only on a live agent_start, which a
      // mid-turn attach never sees — a running tool call looks idle. setWorkingVisible
      // re-derives from session.isStreaming, so this is a no-op once the turn has ended.
      bridge.onUiBound(() => bridge.ui?.setWorkingVisible?.(true));
      await rpc.refreshStreamingSnapshot();
    }
  };

  /** A pod-side session replacement succeeded: re-seed the cache, then let the TUI rebind. */
  const applySessionReplacement = async (
    reseedScope = false,
    dialogs: DialogInvalidation = "drop",
  ): Promise<void> => {
    // Both calls destroy the on-screen dialog surfaces, and must stay in the same tick: a
    // surface that answers as it is disposed would beat the abandon flag otherwise.
    beforeSessionInvalidate?.();
    extensionUi.invalidateDialogs(dialogs);
    await cache.reset();
    await authBridge.refresh();
    // A same-pod replacement keeps live /scoped-models edits; a pod switch re-seeds from
    // the new pod's settings, because the old scope was another pod's opinion.
    if (reseedScope) await seedScopedModels();
    else rehydrateScopedModels();
    await rebindSession?.();
    await healStreamingRenderer();
    // Covers /pod switch and pod-side session replacement (/new, /fork, /resume): local
    // extensions observe the same shutdown/start pair an in-process session emits.
    if (localHost) {
      await localHost.sessionShutdown("resume");
      await localHost.sessionStart("resume");
    }
  };

  // --- /pod: an ordinary client-side command source in pi's autocomplete (§5.4) ------------
  const podSubcommands = router.available();
  const podCommand = {
    name: "pod",
    invocationName: "pod",
    description: `pi-pod: ${podSubcommands.map((c) => c.name).join(", ")}`,
    sourceInfo: { path: "pi-pod", source: "pi-pod", scope: "user", origin: "top-level" },
    getArgumentCompletions: (prefix: string) => {
      const value = prefix.trim();
      // Returning the exact argument makes Enter keep accepting the same completion forever
      // instead of submitting `/pod shell` (and every other completed subcommand).
      if (podSubcommands.some((c) => c.name === value)) return null;
      const matches = podSubcommands.filter((c) => c.name.startsWith(value));
      if (matches.length === 0) return null;
      return matches.map((c) => ({ value: c.name, label: c.name, description: c.description }));
    },
  };

  /** Raw commands retain private capabilities; only the filtered view reaches Pi's UI. */
  const remoteCommands = (): RemoteCommand[] => cache.commands as RemoteCommand[];
  const visibleRemoteCommands = (): RemoteCommand[] =>
    remoteCommands().filter((command) => !command.name.startsWith(POD_INTERNAL_COMMAND_PREFIX));

  const localCommands = (): ResolvedLocalCommand[] => localHost?.runner.getRegisteredCommands() ?? [];
  const shadowedRemoteNames = new Set<string>();
  const registeredCommands = () => {
    const local = localCommands();
    const localNames = new Set(local.map((c) => c.name));
    return [
      podCommand,
      ...local,
      ...visibleRemoteCommands()
        .filter((c) => c.source === "extension")
        .filter((c) => {
          // A local command shadowing a remote name wins: the remote copy is unreachable by
          // construction (its extension was subtracted from the pod's settings).
          if (!localNames.has(c.name)) return true;
          if (!shadowedRemoteNames.has(c.name)) {
            shadowedRemoteNames.add(c.name);
            debug(`client extension command /${c.name} shadows the pod-side command of the same name`);
          }
          return false;
        })
        .map((c) => ({
          name: c.name,
          invocationName: c.name,
          description: c.description ?? "",
          sourceInfo: c.sourceInfo,
        })),
    ];
  };

  // --- prompt interception: /pod runs locally, everything else crosses the wire ------------
  const prompt = async (
    text: string,
    promptOpts?: { images?: unknown[]; streamingBehavior?: "steer" | "followUp" },
  ): Promise<void> => {
    if (router.matches(text)) {
      opts.onPodCommandSubmit?.();
      await router.handle(text);
      return;
    }
    const slashName = /^\/([^\s]+)/.exec(text.trimStart())?.[1];
    if (slashName?.startsWith(POD_INTERNAL_COMMAND_PREFIX)) {
      throw new Error("pi-pod internal commands cannot be invoked from the editor");
    }
    // A client-extension command runs here, before anything crosses the wire — exactly like
    // /pod. The remote copy of a shadowed name is unreachable (subtracted from the pod).
    if (slashName !== undefined && localHost && (await localHost.runCommand(text))) return;
    // Pi's editor invokes its async onSubmit callback without observing the returned promise.
    // A transport drop while steering would therefore escape as an uncaught rejection and kill
    // the local TUI. Report delivery failures here, at the RPC boundary, instead. The gateway
    // still owns reconnect-or-shutdown; never replay automatically because the pod may have
    // accepted the prompt before the acknowledgement was lost.
    const response = await rpc.request({
      type: "prompt",
      message: text,
      ...(promptOpts?.images?.length ? { images: promptOpts.images as never } : {}),
      ...(promptOpts?.streamingBehavior ? { streamingBehavior: promptOpts.streamingBehavior } : {}),
    }).catch((error: unknown) => {
      bridge.notify(
        `Prompt delivery was interrupted: ${error instanceof Error ? error.message : String(error)}; check the session before retrying`,
        "error",
      );
      return null;
    });
    if (!response) return;
    if (!response.success) throw new Error(response.error);
    void cache.refreshState();
  };

  /** Run a mutating command, then refresh the state cache so sync getters agree (§5.2). */
  const mutate = async <T>(run: () => Promise<T>): Promise<T> => {
    const result = await run();
    await cache.refreshState();
    return result;
  };

  // --- services (real settings; RPC-backed model runtime; empty local resources) -----------
  const unavailableLogin = async (): Promise<never> => {
    throw new Error("authentication runs in the pod");
  };
  const remoteProviders = (): RemoteProviderFacade[] => {
    if (!authBridge.supportsAuthBridge()) {
      // A live process from an older launcher has no metadata command. Still advertise its
      // known model providers so /login reaches the bridge's actionable restart error rather
      // than falsely claiming that no subscription providers exist.
      return [...new Set((cache.availableModels as Array<{ provider: string }>).map(({ provider }) => provider))]
        .map((id) => ({
          id,
          name: id,
          auth: {
            apiKey: { name: "API key", login: unavailableLogin },
            oauth: { name: "Subscription", login: unavailableLogin },
          },
        }));
    }
    return authBridge.snapshot.providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      auth: {
        ...(provider.auth.apiKey
          ? {
              apiKey: {
                name: provider.auth.apiKey.name,
                // InteractiveMode uses presence of login only to distinguish an interactive
                // key flow from ambient setup. The actual function runs pod-side via login().
                ...(provider.auth.apiKey.interactive ? { login: unavailableLogin } : {}),
              },
            }
          : {}),
        ...(provider.auth.oauth
          ? {
              oauth: {
                name: provider.auth.oauth.name,
                ...(provider.auth.oauth.loginLabel ? { loginLabel: provider.auth.oauth.loginLabel } : {}),
                login: unavailableLogin,
              },
            }
          : {}),
      },
    }));
  };
  const refreshRemoteModels = async (): Promise<RemoteModel[]> => {
    const models = await rpc.getAvailableModels();
    cache.availableModels = models;
    rehydrateScopedModels();
    return models as RemoteModel[];
  };
  const modelRuntime = {
    getAvailable: refreshRemoteModels,
    getAvailableSnapshot: () => cache.availableModels as RemoteModel[],
    getModels: () => cache.availableModels as RemoteModel[],
    getModel: (provider: string, id: string) => findCachedModel(provider, id),
    getProviders: remoteProviders,
    getProvider: (provider: string) => remoteProviders().find(({ id }) => id === provider),
    getProviderAuthStatus: (provider: string) =>
      authBridge.snapshot.providers.find(({ id }) => id === provider)?.status ?? { configured: false },
    listCredentials: async () => authBridge.snapshot.credentials,
    checkAuth: async () => ({ ok: true }),
    getAuth: () => undefined,
    isUsingOAuth: (provider: string) =>
      authBridge.snapshot.providers.find(({ id }) => id === provider)?.usingOAuth ?? false,
    // 0.84 footer calls isUsingSubscription; 0.83 pods only had isUsingOAuth. Provide a polyfill so
    // an older pod does not crash the host TUI when attached from a newer launcher (§10). For 0.83
    // pods isSubscription is not reported, so any OAuth is treated as possible subscription —
    // strictly more (sub) labels, but never a crash. 0.84+ pods will correctly distinguish.
    isUsingSubscription: (provider: string) =>
      authBridge.snapshot.providers.find(({ id }) => id === provider)?.usingOAuth ?? false,
    getError: () => undefined,
    refresh: async () => {
      await Promise.all([refreshRemoteModels(), authBridge.refresh()]);
      return { aborted: false, errors: new Map() };
    },
    login: async (provider: string, type: "oauth" | "api_key", interaction: RemoteAuthInteraction) => {
      await authBridge.login(provider, type, interaction);
      await refreshRemoteModels();
      return { type };
    },
    logout: async (provider: string) => {
      await authBridge.logout(provider);
      await refreshRemoteModels();
    },
  };

  /** Resolve the initial local scope: CLI patterns, then the pod's settings, then the host's. */
  const seedScopedModels = async (): Promise<void> => {
    const podPatterns = await opts.getPodModelPatterns?.().catch(() => undefined);
    const patterns = opts.modelPatterns ?? podPatterns ?? settingsManager.getEnabledModels();
    if (!patterns?.length) {
      scopedModels = [];
      return;
    }
    const resolved = await resolveModelScopeWithDiagnostics(patterns, {
      getAvailable: async () => cache.availableModels,
    } as never);
    scopedModels = resolved.scopedModels;
  };

  /**
   * Cycle locally so direction and live /scoped-models edits work despite RPC's cycle_model
   * command having neither a direction nor a scoped-model setter.
   */
  const cycleModel = async (direction: "forward" | "backward" = "forward") => {
    const isScoped = scopedModels.length > 0;
    const candidates: ScopedModel[] = isScoped
      ? scopedModels
      : (cache.availableModels as RemoteModel[]).map((model) => ({ model }));
    if (candidates.length <= 1) return undefined;

    const current = cache.state.model as RemoteModel | undefined;
    let currentIndex = candidates.findIndex(
      ({ model }) => model.provider === current?.provider && model.id === current?.id,
    );
    if (currentIndex === -1) currentIndex = 0;
    const delta = direction === "backward" ? -1 : 1;
    const next = candidates[(currentIndex + delta + candidates.length) % candidates.length]!;

    await rpc.setModel(next.model.provider, next.model.id);
    cache.state.model = next.model as never;
    if (next.thinkingLevel !== undefined) {
      await rpc.setThinkingLevel(next.thinkingLevel);
      cache.state.thinkingLevel = next.thinkingLevel;
    }
    settingsManager.setDefaultModelAndProvider(next.model.provider, next.model.id);
    await cache.refreshState();
    return {
      model: cache.state.model ?? next.model,
      thinkingLevel: cache.state.thinkingLevel,
      isScoped,
    };
  };

  const resourceLoader = {
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getExtensions: () => ({ extensions: [], errors: [] }),
    // Resources live in the pod, which holds the real loader; the local TUI only asks these
    // to render prompt-source information, and the honest local answer is "none here" —
    // the same emptiness the collections above already return.
    getSystemPromptSource: () => undefined,
    getAppendSystemPromptSources: () => [],
  };

  // What ctx.modelRegistry offers client-side extensions: the RPC-backed model facade, minus
  // completions — credentials live in the pod, and there is no completion RPC.
  const extensionModelRegistry = {
    ...modelRuntime,
    complete: async (): Promise<never> => {
      throw new Error("model completions run in the pod — not available to client-side extensions (pi.clientExtensions)");
    },
  };

  // The local extension host (pi.clientExtensions) serves the renderer/transformer/command
  // hooks when it exists; the stubs below are the zero-cost answer for everyone else.
  const extensionRunner = {
    getRegisteredCommands: registeredCommands,
    getCommand: (name: string) =>
      name === "pod"
        ? podCommand
        : (localHost?.runner.getCommand(name) ??
            visibleRemoteCommands().find((c) => c.source === "extension" && c.name === name)),
    getCommands: () => new Map(registeredCommands().map((c) => [c.name, c])),
    getRegisteredShortcuts: () => [],
    getShortcuts: (resolvedKeybindings?: unknown) =>
      localHost?.runner.getShortcuts(resolvedKeybindings) ?? new Map(),
    getEntryRenderer: (customType: string) => localHost?.runner.getEntryRenderer(customType),
    getMessageRenderer: (customType: string) => localHost?.runner.getMessageRenderer(customType),
    // Display transforms are functions and cannot cross JSON/RPC. Built-in local transforms
    // (including Mermaid) still compose — InteractiveMode appends these to its own chain.
    // Pod extension transforms remain honestly unavailable; client extensions supply theirs here.
    getMarkdownTransformers: () => localHost?.runner.getMarkdownTransformers() ?? [],
    getCommandDiagnostics: () => localHost?.runner.getCommandDiagnostics() ?? [],
    getShortcutDiagnostics: () => localHost?.runner.getShortcutDiagnostics() ?? [],
    getModelRegistry: () => (localHost ? extensionModelRegistry : undefined),
    emitUserBash: async () => undefined,
  };

  const agent = {
    abort: () => void rpc.abort().catch(() => {}),
    signal: abortController.signal,
    /** Written by the /transport toggle; meaningless off-pod, accepted so the write lands. */
    transport: undefined as unknown,
  };

  let treeMutationTail: Promise<void> = Promise.resolve();
  const serializeTreeMutation = <T>(run: () => Promise<T>): Promise<T> => {
    const result = treeMutationTail.then(run, run);
    treeMutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const trackLabelMutation = (entryId: string, labelValue: string | undefined): void => {
    if (!cache.entries.some((entry) => entry.id === entryId) || !findTreeNode(cache.tree, entryId)) {
      bridge.notify("Could not update label: the selected entry is no longer available", "error");
      return;
    }
    const label = labelValue ? labelValue : null;
    const revision = cache.beginLabelMutation(entryId, label);
    void serializeTreeMutation(async () => {
      const acknowledgement = await treeBridge.setLabel(entryId, label);
      const snapshot = await cache.refreshTree(acknowledgement.leafId);
      const authoritative = findTreeNode(snapshot.tree, entryId);
      cache.completeLabelMutation(entryId, revision, {
        ok: true,
        label: authoritative?.label ?? null,
        labelTimestamp: authoritative?.labelTimestamp,
      });
    }).catch((error) => {
      cache.completeLabelMutation(entryId, revision, { ok: false });
      bridge.notify(`Could not save label: ${error instanceof Error ? error.message : String(error)}`, "error");
    });
  };

  // --- sessionManager: get_entries/get_tree plus facts the launcher already knows (§5.2) ---
  const sessionManager = {
    getCwd: () => cwd,
    getEntries: () => cache.entries,
    getLeafId: () => cache.leafId ?? undefined,
    getSessionDir: () => cwd,
    getSessionFile: () => cache.state.sessionFile,
    getSessionName: () => cache.state.sessionName,
    getSessionId: () => cache.state.sessionId,
    getTree: () => cache.tree,
    usesDefaultSessionDir: () => true,
    isPersisted: () => cache.state.sessionFile !== undefined,
    appendLabelChange: (entryId: string, label?: string) => trackLabelMutation(entryId, label),
    buildContextEntries: () => {
      const byId = new Map(cache.entries.map((entry) => [entry.id, entry]));
      return buildPiContextEntries(cache.entries, cache.leafId, byId);
    },
  };

  // --- the 57-member session surface ---------------------------------------------------------
  const session = {
    // sync getters from the cache
    get state() {
      return {
        messages: cache.messages,
        tools: [],
        model: cache.state.model,
        thinkingLevel: cache.state.thinkingLevel,
      };
    },
    get model() {
      return cache.state.model;
    },
    get thinkingLevel() {
      return cache.state.thinkingLevel;
    },
    get isStreaming() {
      return cache.state.isStreaming;
    },
    /**
     * Once an ending is recorded (§6.2) the client has no turn left to wait for, so it reads
     * as idle. InteractiveMode's extension shutdown requester only shuts down when the session
     * is idle and otherwise waits for `agent_settled`; without this a `/pod detach` or its
     * chord would sit until the pod's turn ended, though a leave never touches pod-side pi, and
     * a dropped transport or a pod-side pi exit may never settle the stream at all. A local
     * extension's `ctx.shutdown()` records no ending, so it still waits for the turn as in pi.
     */
    get isIdle() {
      if (bridge.intent) return true;
      return !cache.state.isStreaming && !cache.state.isCompacting;
    },
    get isCompacting() {
      return cache.state.isCompacting;
    },
    get isBashRunning() {
      return cache.isBashRunning;
    },
    get isRetrying() {
      return false;
    },
    get autoRetryEnabled() {
      return true;
    },
    get retryAttempt() {
      return 0;
    },
    get messages() {
      return cache.messages;
    },
    get systemPrompt() {
      return "";
    },
    get steeringMode() {
      return cache.state.steeringMode;
    },
    get followUpMode() {
      return cache.state.followUpMode;
    },
    get sessionFile() {
      return cache.state.sessionFile;
    },
    get sessionId() {
      return cache.state.sessionId;
    },
    get sessionName() {
      return cache.state.sessionName;
    },
    get scopedModels() {
      return scopedModels;
    },
    get promptTemplates() {
      return visibleRemoteCommands()
        .filter((c) => c.source === "prompt")
        .map((c) => ({
          name: c.name,
          description: c.description ?? "",
          // The pod-side path: only ever displayed, but the loaded-resources banner sorts by it.
          filePath: c.sourceInfo?.path ?? `pod:${c.name}`,
          sourceInfo: c.sourceInfo,
        }));
    },
    get pendingMessageCount() {
      return cache.state.pendingMessageCount;
    },
    get autoCompactionEnabled() {
      return cache.state.autoCompactionEnabled;
    },
    get hasPendingBashMessages() {
      return false;
    },

    // local-by-nature services
    settingsManager: remoteSettingsManager,
    sessionManager,
    agent,
    modelRuntime,
    resourceLoader,
    extensionRunner,

    // event stream
    subscribe(listener: (event: unknown) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    // delegated commands
    prompt,
    steer: (text: string, images?: unknown[]) => rpc.steer(text, images as never),
    followUp: (text: string, images?: unknown[]) => rpc.followUp(text, images as never),
    sendUserMessage: (content: unknown) =>
      prompt(
        typeof content === "string"
          ? content
          : (content as Array<{ text?: string }>).map((c) => c.text ?? "").join(""),
      ),
    abort: () => rpc.abort(),
    waitForIdle: (timeoutMs?: number) => rpc.waitForIdle(timeoutMs),
    setModel: (model: { provider: string; id: string }) => mutate(() => rpc.setModel(model.provider, model.id)),
    cycleModel,
    setThinkingLevel: (level: never) => mutate(() => rpc.setThinkingLevel(level)),
    cycleThinkingLevel: async () => {
      const result = await mutate(() => rpc.cycleThinkingLevel());
      return result?.level;
    },
    getAvailableThinkingLevels: () => ["off", "minimal", "low", "medium", "high"],
    supportsThinking: () => (cache.state.model as { reasoning?: boolean } | undefined)?.reasoning ?? false,
    setSteeringMode: (mode: "all" | "one-at-a-time") => mutate(() => rpc.setSteeringMode(mode)),
    setFollowUpMode: (mode: "all" | "one-at-a-time") => mutate(() => rpc.setFollowUpMode(mode)),
    compact: (customInstructions?: string) => mutate(() => rpc.compact(customInstructions)),
    abortCompaction: () => {},
    // Unreachable: the remote settings facade always skips branch summaries.
    abortBranchSummary: () => {},
    setAutoCompactionEnabled: (enabled: boolean) => mutate(() => rpc.setAutoCompaction(enabled)),
    setAutoRetryEnabled: (enabled: boolean) => mutate(() => rpc.setAutoRetry(enabled)),
    abortRetry: () => rpc.abortRetry(),

    /** `!command` bash: streamed chunks arrive as bash_execution_update events with our id (§8). */
    executeBash: async (command: string, onChunk?: (chunk: string) => void) => {
      const id = rpc.newRequestId();
      const off = rpc.onEvent((event) => {
        const e = event as { type?: string; id?: string; delta?: string };
        if (e.type === "bash_execution_update" && e.id === id && e.delta) onChunk?.(e.delta);
      });
      try {
        const response = await rpc.request({ type: "bash", command, id });
        if (!response.success) throw new Error(response.error);
        return (response as { data?: unknown }).data;
      } finally {
        off();
      }
    },
    recordBashResult: () => {},
    abortBash: () => rpc.abortBash(),

    setSessionName: (name: string) => {
      // InteractiveMode's /name reads the name straight back after this call to decide whether
      // pi normalized it, and retitles the terminal from the same read. Over RPC neither the
      // round trip nor session_info_changed has happened by then, so without this every rename
      // in a pod warns that it was "normalized" to the *previous* name and the title lags one
      // rename behind. The event carries pi's authoritative spelling and overwrites this.
      cache.state.sessionName = name;
      return mutate(() => rpc.setSessionName(name));
    },
    navigateTree: async (
      targetId: string,
      navigateOptions?: { summarize?: boolean },
    ): Promise<{ cancelled: boolean; editorText?: string }> => {
      if (navigateOptions?.summarize) {
        throw new Error("Branch summaries are unavailable in remote pi-pod sessions");
      }
      if (!treeBridge.supportsTreeBridge()) {
        throw new Error(
          "This running pod uses an older pi-pod extension. Exit Pi, then attach again so pi-pod can load the updated extension.",
        );
      }
      const entry = cache.entries.find((candidate) => candidate.id === targetId);
      if (!entry || !findTreeNode(cache.tree, targetId)) throw new Error(`Tree entry ${targetId} is no longer available`);
      const editorText = editorTextForEntry(entry);
      return serializeTreeMutation(async () => {
        try {
          const acknowledgement = await treeBridge.navigate(targetId);
          await cache.refreshTree(acknowledgement.leafId);
          return {
            cancelled: acknowledgement.cancelled,
            ...(editorText !== undefined ? { editorText } : {}),
          };
        } catch (error) {
          await cache.refreshTree().catch(() => {});
          throw error;
        }
      });
    },
    getUserMessagesForForking: () =>
      cache.entries
        .filter((e) => {
          const entry = e as { type?: string; message?: { role?: string } };
          return entry.type === "message" && entry.message?.role === "user";
        })
        .map((e) => {
          const entry = e as unknown as { id: string; message: { content?: unknown } };
          const content = entry.message.content;
          const text =
            typeof content === "string"
              ? content
              : Array.isArray(content)
                ? content.map((c: { text?: string }) => c.text ?? "").join("")
                : "";
          return { entryId: entry.id, text };
        }),
    getSessionStats: () => rpc.getSessionStats(),
    /** The footer's context gauge, computed from cached messages the way pi's session does. */
    getContextUsage: () => {
      const model = cache.state.model as { contextWindow?: number } | undefined;
      const contextWindow = model?.contextWindow ?? 0;
      if (contextWindow <= 0) return undefined;
      for (let i = cache.messages.length - 1; i >= 0; i--) {
        const message = cache.messages[i] as {
          role?: string;
          stopReason?: string;
          usage?: Record<string, number>;
        };
        if (message.role !== "assistant" || !message.usage) continue;
        if (message.stopReason === "aborted" || message.stopReason === "error") continue;
        const tokens = calculateContextTokens(message.usage as never);
        if (tokens > 0) return { tokens, contextWindow, percent: (tokens / contextWindow) * 100 };
      }
      return { tokens: null, contextWindow, percent: null };
    },
    getSteeringMessages: () => [],
    getFollowUpMessages: () => [],
    clearQueue: () => ({ steering: [], followUp: [] }),
    getToolDefinition: () => undefined,
    getLastAssistantText: () => rpc.getLastAssistantText(),
    exportToHtml: async (outputPath?: string) => (await rpc.exportHtml(outputPath)).path ?? "",
    exportToJsonl: () => {
      throw new Error("session files live in the pod — use /export html instead");
    },

    /** InteractiveMode hands the runtime its UI context and shutdown requester here (§5.3). */
    bindExtensions: async (bindOpts: {
      uiContext?: Record<string, unknown>;
      shutdownHandler?: () => void;
    }) => {
      bridge.bindUi(
        (bindOpts.uiContext ?? {}) as never,
        bindOpts.shutdownHandler ?? null,
      );
    },
    // Nothing to reload here — resources live in the pod. But /reload clears every extension
    // terminal-input listener on its way in and rebinds nothing, so the chords are ours to
    // put back.
    reload: async () => {
      bridge.rewireUi();
    },
    createReplacedSessionContext: () => ({}),
    hasExtensionHandlers: () => false,
    setActiveToolsByName: () => {},
    getActiveToolNames: () => [],
    getAllTools: () => [],
    setScopedModels: (models: ScopedModel[]) => {
      scopedModels = [...models];
    },
    dispose: () => {},
  };

  // --- runtime host (9 members) -------------------------------------------------------------
  const services = {
    cwd,
    agentDir: opts.agentDir,
    modelRuntime,
    settingsManager: remoteSettingsManager,
    resourceLoader,
    diagnostics: [],
  };

  const runtimeHost: Record<string, unknown> = {
    session,
    services,
    setRebindSession: (callback?: () => Promise<void>) => {
      rebindSession = callback ?? null;
    },
    setBeforeSessionInvalidate: (callback?: () => void) => {
      beforeSessionInvalidate = callback ?? null;
    },

    // Session replacement flows (§8): the pod replaces its session; the client re-seeds
    // its cache and lets InteractiveMode rebind. Session files stay pod-side throughout.
    newSession: async (flowOpts?: { parentSession?: string }) => {
      const result = await rpc.newSession(flowOpts?.parentSession);
      if (!result.cancelled) await applySessionReplacement();
      return { cancelled: result.cancelled };
    },
    switchSession: async (sessionPath: string) => {
      const result = await rpc.switchSession(sessionPath);
      if (!result.cancelled) await applySessionReplacement();
      return { cancelled: result.cancelled };
    },
    fork: async (entryId: string) => {
      const result = await rpc.fork(entryId);
      if (!result.cancelled) await applySessionReplacement();
      return { cancelled: result.cancelled, selectedText: result.text };
    },
    importFromJsonl: async () => {
      bridge.notify("/import is not available over RPC — session files live in the pod", "warning");
      return { cancelled: true };
    },

    /**
     * The one exit everything funnels through (§6.2): InteractiveMode awaits this before its
     * own process.exit, for quits, /pod leaves and signal shutdowns alike. Quitting pi sends
     * the shim shutdown frame and waits for pi_exit; leaving does not touch pi at all.
     */
    dispose: async () => {
      // No prior intent means InteractiveMode initiated shutdown: Ctrl-C Ctrl-C, Ctrl-D, or
      // /quit. A spontaneous remote pi_exit records the same quit intent before requesting
      // shutdown, so remember the distinction before filling in the implicit intent.
      const quitRequested = bridge.intent === null;
      bridge.setIntent({ kind: "quit" }); // no-op when pi, a /pod command, or a signal got there first
      const intent = bridge.intent!;
      // Extensions hear the shutdown while the UI and caches are still live, then go stale.
      if (localHost) {
        await localHost.sessionShutdown("quit").catch(() => {});
        await localHost.dispose();
      }
      unwireCache();
      extensionUi.dispose();
      treeBridge.dispose();
      authBridge.dispose();
      remoteUiBridge.dispose();

      let exitCode: number | null = null;
      if (intent.kind === "quit") exitCode = await quitPi(rpc);

      await opts.onEnding({
        intent,
        quitRequested,
        exitCode,
        stderrTail: rpc.getStderr(),
      });
    },
  };

  return {
    runtimeHost,
    bridge,
    cache,
    router,
    treeBridge,
    init: async () => {
      await cache.init();
      await authBridge.refresh();
      await seedScopedModels();
      if (opts.clientExtensionPaths?.length) {
        try {
          localHost = await createLocalExtensionHost({
            paths: opts.clientExtensionPaths,
            hostCwd: cwd,
            cache,
            bridge,
            rpc,
            getScopedModels: () => scopedModels,
            prompt,
            setModel: (model) => mutate(() => rpc.setModel(model.provider, model.id)),
            setThinkingLevel: (level) => mutate(() => rpc.setThinkingLevel(level as never)),
            setSessionName: (name) => session.setSessionName(name),
            setLabel: (entryId, label) => trackLabelMutation(entryId, label),
            getContextUsage: () => session.getContextUsage(),
            abort: () => void rpc.abort().catch(() => {}),
            compact: (customInstructions) => mutate(() => rpc.compact(customInstructions)),
            waitForIdle: (timeoutMs) => rpc.waitForIdle(timeoutMs),
            modelRegistry: extensionModelRegistry,
            getCommands: () => registeredCommands(),
          });
          // Deferred to the first UI bind, matching in-process pi: InteractiveMode starts its
          // UI before initializing extensions, "so session_start handlers can use interactive
          // dialogs" — and so ctx.ui carries the real theme when session_start fires.
          bridge.onUiBound(() => void localHost?.sessionStart("startup"));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          bridge.onUiBound(() => bridge.notify(`client extensions failed to start: ${message}`, "warning"));
          debug(`client extension host failed: ${message}`);
        }
      }
    },
    refreshAfterReplacement: () => applySessionReplacement(true),
    recoverAfterReconnect: () => applySessionReplacement(true, "redisplay"),
    healStreamingRenderer,
  };
}

function editorTextForEntry(entry: SessionEntry): string | undefined {
  if (entry.type === "message" && entry.message.role === "user") return textContent(entry.message.content);
  if (entry.type === "custom_message") return textContent(entry.content);
  return undefined;
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } =>
      part !== null &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text)
    .join("");
}

/** Send the shutdown frame and wait (bounded) for pi_exit; null when it never came (§6.2). */
export async function quitPi(rpc: RpcClientBase): Promise<number | null> {
  if (rpc.exitCode !== undefined) return rpc.exitCode;

  return new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => {
      off();
      resolve(rpc.exitCode ?? null);
    }, QUIT_TIMEOUT_MS);
    const off = rpc.onControl((event) => {
      if (event.event === "pi_exit") {
        clearTimeout(timer);
        off();
        resolve(event.code);
      }
    });
    rpc.shutdown();
  });
}
