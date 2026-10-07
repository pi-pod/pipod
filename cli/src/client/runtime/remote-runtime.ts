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
  resolveModelScopeWithDiagnostics,
  type AgentSessionEvent,
  type CacheWarmingMode,
  type ScopedModel,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { PiPodError } from "../../errors.js";
import { debug, warn } from "../../log.js";
import type { ImageContent, RpcClientBase, ThinkingLevel } from "../rpc.js";
import { POD_INTERNAL_COMMAND_PREFIX } from "../../shim/pi-pod-ext.js";
import {
  createLocalExtensionHost,
  type LocalExtensionHost,
  type ResolvedLocalCommand,
} from "./local-extensions.js";
import { createAppendEntryBridge } from "./append-entry-bridge.js";
import { HostBridge, type EndingIntent, type HostUiContext } from "./bridge.js";
import {
  wrapWithPodFiles,
  FILE_LIST_UNAVAILABLE,
  type AutocompleteProviderLike,
  type FileListData,
} from "./pod-file-completion.js";
import { AuthBridge, type RemoteAuthInteraction, type RemoteAuthType } from "./auth-bridge.js";
import { type DialogInvalidation, wireExtensionUi } from "./extension-ui.js";
import { preparePromptImages, collectImageCandidates } from "./local-images.js";
import { PodExtensionBridge } from "./pod-extension-bridge.js";
import {
  createExtensionModelRegistry,
  type AuxCatalogModel,
  type AuxCompleteRequest,
  type AuxCompleteResult,
} from "./extension-model-registry.js";
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
  /**
   * Settings-manager cwd override. Pod-derived sessions pass a synthetic empty dir so the
   * host project's `.pi/settings.json` never merges over pod values; file autocomplete and
   * everything else keeps the real `cwd`.
   */
  settingsCwd?: string | undefined;
  /** Pod-derived themes, served through pi's own directory loader; absent means none. */
  getLocalThemes?: (() => { themes: unknown[]; diagnostics: unknown[] }) | undefined;
  /** CLI --models patterns, which take precedence over enabledModels in settings. */
  modelPatterns?: string[] | undefined;
  /**
   * The current pod's own enabledModels patterns (§5.2). RPC exposes no scoped-model list,
   * so without this the seed falls back to the host's settings — a different machine's
   * opinion of the scope. A thunk rather than a value so /pod switch reads the new pod.
   */
  getPodModelPatterns?: (() => Promise<string[] | undefined>) | undefined;
  /** Semantic gateway query for the active model's thinking levels. */
  getAvailableThinkingLevels?: (() => Promise<ThinkingLevel[]>) | undefined;
  /**
   * Semantic gateway query backing `@` completion. Absent means no suggestions — which is
   * the honest answer, and never the host's own files (§5.2).
   */
  listPodFiles?: ((query: string) => Promise<FileListData>) | undefined;
  /** Hooks for /pod subcommands beyond the leave family (§5.4). */
  podHost?: PodCommandHost;
  /** The TUI accepted a typed /pod command; clear its editor before the local action runs. */
  onPodCommandSubmit?: (() => void) | undefined;
  /**
   * Entry files of the server-attested pod extensions (the code channel): loaded by the
   * launcher's own ExtensionRunner for rendering hooks only — commands and tools stay
   * pod-authoritative. Empty/absent costs nothing.
   */
  attestedExtensionPaths?: string[] | undefined;
  /** A lost transport cannot receive shutdown or pi_exit; skip that bounded wait on local quit. */
  waitForRemoteExitOnQuit?: (() => boolean) | undefined;
  /** Account-mode provider capability check; absent in local-mode runtimes. */
  accountAuthSupported?: ((provider: string, type?: RemoteAuthType) => Promise<boolean>) | undefined;
  /** Connect a broker-supported provider in account custody instead of inside this pod. */
  accountLogin?: ((provider: string, type: RemoteAuthType, interaction: RemoteAuthInteraction) => Promise<unknown>) | undefined;
  /** Remove a broker-supported provider from account custody. */
  accountLogout?: ((provider: string) => Promise<void>) | undefined;
  /**
   * Semantic aux-completion transport (the gateway's `aux_complete` message). Absent on
   * transports without aux support — `complete()` then fails with an honest error.
   */
  auxComplete?:
    | ((request: AuxCompleteRequest, opts?: { signal?: AbortSignal }) => Promise<AuxCompleteResult>)
    | undefined;
  /**
   * Extension command names (without the slash) that execute in the launcher's local
   * extension host instead of the pod — e.g. `["transcript"]` so an unchanged
   * TUI-gated extension's UI commands run with the real TUI context. Default: empty,
   * the pod owns every slash command (the pre-bridge behavior). Anything not listed
   * — and every unknown command — crosses the wire exactly once; local execution
   * never falls back to a second remote run. Local commands are always reachable
   * explicitly via `/pod local <name> [args]`, with no allowlist needed.
   */
  localCommands?: readonly string[] | undefined;
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
  /**
   * Re-read the settings files in place (pod-derived sync rewrote them; the paths never
   * change, so pi's own reload suffices — no rebinding).
   */
  reloadSettings(): Promise<void>;
  /**
   * Stop serving attested-extension rendering hooks (loaded code cannot be unloaded, but it
   * can stop being consulted) — the `/pod switch` path when the target's attested set
   * differs.
   */
  disableLocalExtensions(): Promise<void>;
}

/** How long dispose waits for pi_exit after sending the shutdown frame (§6.2). */
const QUIT_TIMEOUT_MS = 15_000;
const FALLBACK_THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];
/** How pi spells a skill in `get_commands`; its own loader re-adds this to the bare name. */
const SKILL_COMMAND_PREFIX = "skill:";

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

function isUnsupportedCredentialProvider(error: unknown): boolean {
  return error instanceof PiPodError && error.code === "credential_provider_unsupported";
}

export function createRemoteRuntime(opts: RemoteRuntimeOptions): RemoteRuntime {
  const { rpc, cwd } = opts;
  const bridge = new HostBridge();
  const cache = new RemoteStateCache(rpc);
  const appendEntry = createAppendEntryBridge({ rpc, cache, bridge });
  const refreshThinkingLevels = async (): Promise<void> => {
    cache.availableThinkingLevels = null;
    if (!opts.getAvailableThinkingLevels) return;
    try {
      const levels = await opts.getAvailableThinkingLevels();
      cache.availableThinkingLevels = levels.length > 0 ? [...levels] : null;
    } catch {
      // Old gateways never answer get_models; old pod shims answer with an empty list.
    }
  };
  // Explicit local-command routing: the pod owns every slash command by default.
  const localCommandAllowlist = new Set(
    (opts.localCommands ?? [])
      .map((name) => (typeof name === "string" ? name.replace(/^\/+/, "").trim() : ""))
      .filter((name) => name.length > 0),
  );
  const runLocalCommandByName = async (name: string, args: string): Promise<boolean> => {
    if (!localHost) return false;
    return localHost.runLocalCommand(name, args);
  };
  const runPodLocalNamespace = async (arg: string): Promise<void> => {
    const trimmed = arg.trim();
    if (trimmed === "") {
      const names = (localHost?.runner.getRegisteredCommands() ?? [])
        .map((c) => c.name)
        .filter((name) => name !== "pod");
      bridge.notify(
        names.length > 0
          ? `locally rendered commands: ${names.join(", ")} — run one as /pod local <name> [args]`
          : "no locally rendered pod extensions in this session — every slash command runs in the pod",
      );
      return;
    }
    const space = trimmed.search(/\s/);
    const name = space === -1 ? trimmed : trimmed.slice(0, space);
    const args = space === -1 ? "" : trimmed.slice(space + 1).trim();
    try {
      if (await runLocalCommandByName(name, args)) return;
    } catch (error) {
      bridge.notify(
        `/pod local: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
      return;
    }
    // Strict namespace: an unregistered name errors honestly — it never falls
    // through to the pod, so one input can never execute in both places.
    bridge.notify(`/pod local: no locally registered command /${name.replace(/^\/+/, "")} here — the pod owns /${name.replace(/^\/+/, "")}`, "warning");
  };
  const treeBridge = new PodExtensionBridge(rpc, {
    getCommands: () => cache.commands,
    onAmbiguousFailure: () => cache.refreshTree().then(() => undefined),
  });
  cache.bindSeedBridge(treeBridge);
  const authBridge = new AuthBridge(rpc, { getCommands: () => cache.commands });
  const remoteUiBridge = new RemoteUiBridge(rpc, bridge);
  const router = new PodCommandRouter(bridge, { ...opts.podHost, runLocalCommand: runPodLocalNamespace });

  /**
   * Pi-tui completes `@` by walking the host's disk, but the files the agent can act on are
   * the pod's. Re-registered on every UI bind because pi drops its wrappers each time.
   */
  const installPodFileCompletion = (ui: HostUiContext): void => {
    ui.addAutocompleteProvider?.((base) =>
      wrapWithPodFiles(base as AutocompleteProviderLike, async (query) =>
        (await opts.listPodFiles?.(query)) ?? FILE_LIST_UNAVAILABLE,
      ),
    );
  };
  bridge.onEveryUiBound(installPodFileCompletion);
  const settingsManager = SettingsManager.create(opts.settingsCwd ?? cwd, opts.agentDir);
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
  // Pi 0.84 emits bash output updates but no start/end event, so local requests own this state.
  const activeBashRequests = new Set<string>();

  // Attested pod extensions (rendering hooks): loaded in init(), null for everyone else.
  let localHost: LocalExtensionHost | null = null;

  // The cache subscribes first, and deliberately so: listeners run in registration order, and
  // InteractiveMode answers events by reading this cache back synchronously — session_info_changed
  // retitles the terminal from `sessionManager.getSessionName()`. Fanning out first would hand
  // the TUI the state as it was *before* the event it is handling.
  const unwireCache = cache.wire();

  const fanOutEvent = (event: AgentSessionEvent): void => {
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
  };

  // Pi appends the compaction entry before emitting a successful compaction_end. In-process
  // InteractiveMode therefore reads the new entry synchronously while handling that event.
  // The remote cache only learns it through the seed bridge, so hold this event (and every
  // event behind it) until the same invariant is true locally. Without this barrier the TUI
  // throws "Completed compaction is missing from the session context" and exits.
  const heldEvents: AgentSessionEvent[] = [];
  let reconcilingCompaction = false;
  const drainHeldEvents = (): void => {
    if (reconcilingCompaction) return;
    while (heldEvents.length > 0) {
      const event = heldEvents.shift()!;
      if (event.type !== "compaction_end" || event.aborted || !event.result) {
        fanOutEvent(event);
        continue;
      }

      reconcilingCompaction = true;
      void cache.reconcileTreeAfterEvent().then(() => {
        const entry = cache.entries[0];
        const result = event.result!;
        if (
          entry?.type !== "compaction" ||
          entry.summary !== result.summary ||
          entry.firstKeptEntryId !== result.firstKeptEntryId ||
          entry.tokensBefore !== result.tokensBefore
        ) {
          throw new Error("the refreshed session context does not contain the completed compaction");
        }
        fanOutEvent(event);
      }).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        debug(`completed compaction context refresh failed: ${message}`);
        bridge.notify(`Compaction completed, but the local transcript could not be refreshed: ${message}`, "error");
        // Still clear InteractiveMode's compaction state and flush its queued input, but omit
        // the result that makes it synchronously consume a compaction entry we do not have.
        fanOutEvent({ ...event, result: undefined });
      }).finally(() => {
        reconcilingCompaction = false;
        drainHeldEvents();
      });
      return;
    }
  };

  rpc.onEvent((event) => {
    const typedEvent = event as { type?: string; entry?: { type?: string } };
    const type = typedEvent.type ?? "";
    if (
      type === "model_changed" ||
      (type === "entry_appended" && typedEvent.entry?.type === "model_change")
    ) {
      void refreshThinkingLevels();
    }
    // Responses were correlated upstream; extension-UI requests are mapped separately (§5.3).
    if (type === "response" || type.startsWith("extension_ui")) return;
    heldEvents.push(event);
    drainHeldEvents();
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
    reason: "new" | "resume" | "fork" = "resume",
  ): Promise<void> => {
    // Cancel locally queued aux waits BEFORE refresh/rebind: their late replies
    // correlate to the old session and must never land in the replacement one.
    // In-flight pod executions are the gateway's to cancel; this never aborts the turn.
    extensionModelRegistry.discardPending(`the pi pod session was replaced (${reason})`);
    const previousSessionFile = cache.state.sessionFile ?? undefined;
    // Both calls destroy the on-screen dialog surfaces, and must stay in the same tick: a
    // surface that answers as it is disposed would beat the abandon flag otherwise.
    beforeSessionInvalidate?.();
    extensionUi.invalidateDialogs(dialogs);
    await cache.reset();
    await refreshThinkingLevels();
    await authBridge.refresh();
    // A same-pod replacement keeps live /scoped-models edits; a pod switch re-seeds from
    // the new pod's settings, because the old scope was another pod's opinion.
    if (reseedScope) await seedScopedModels();
    else rehydrateScopedModels();
    await rebindSession?.();
    await healStreamingRenderer();
    // Covers /pod switch and pod-side session replacement (/new, /fork, /resume): local
    // extensions observe the same shutdown/start pair an in-process session emits, with
    // pi's own reasons (native: new/resume/fork) so mode-gated capabilities reset correctly.
    if (localHost) {
      const targetSessionFile = cache.state.sessionFile ?? undefined;
      await localHost.sessionShutdown(
        reason,
        targetSessionFile !== undefined ? { targetSessionFile } : undefined,
      );
      await localHost.sessionStart(
        reason,
        previousSessionFile !== undefined ? { previousSessionFile } : undefined,
      );
    }
  };

  // --- /pod: an ordinary client-side command source in pi's autocomplete (§5.4) ------------
  const podSubcommands = router.available();
  const podCommand = {
    name: "pod",
    invocationName: "pod",
    description: `pi pod: ${podSubcommands.map((c) => c.name).join(", ")}`,
    sourceInfo: { path: "pi-pod", source: "pi-pod", scope: "user", origin: "top-level" },
    getArgumentCompletions: (prefix: string) => {
      const value = prefix.trim();
      // `/pod local <name>`: complete locally registered command names so the
      // explicit-local namespace stays discoverable without shadowing pod listings.
      if (value === "local" || value.startsWith("local ")) {
        const needle = value === "local" ? "" : value.slice("local ".length).trimStart();
        const names = (localHost?.runner.getRegisteredCommands() ?? [])
          .map((c) => c.name)
          .filter((name) => name !== "pod" && name.startsWith(needle));
        if (names.length === 0 || (names.length === 1 && names[0] === needle)) return null;
        return names.map((name) => ({ value: `local ${name}`, label: name, description: "run locally" }));
      }
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

  // The pod owns every slash command by default (the pre-bridge behavior): the same
  // attested extensions execute in the pod, so the pod's copy of every command stays
  // the one autocomplete lists and prompt() executes. Local execution is explicit —
  // the localCommands allowlist or the `/pod local <name>` namespace — and therefore
  // needs no shadowing rules and can never double-execute.
  const registeredCommands = () => [
    podCommand,
    ...visibleRemoteCommands()
      .filter((c) => c.source === "extension")
      .map((c) => ({
        name: c.name,
        invocationName: c.name,
        description: c.description ?? "",
        sourceInfo: c.sourceInfo,
      })),
  ];

  // --- prompt interception: /pod runs locally, everything else crosses the wire ------------
  // Local image references (clipboard pastes, drag-drops, `@shot.png`, typed paths) name
  // host files the pod cannot see, so they are read and processed here and ride the
  // existing RPC `images` field. Extraction runs after the local-command checks: /pod and
  // pod-internal commands never name user files. `extraImages` (extension-supplied parts)
  // share the per-prompt budget, so the combined turn always fits the gateway's caps.
  const withLocalImages = async (
    text: string,
    extraImages?: unknown[],
  ): Promise<{ message: string; images: unknown[] | undefined }> => {
    const prepared = await preparePromptImages(text, {
      cwd,
      notify: (message, type) => bridge.notify(message, type),
      existingImages: extraImages as ImageContent[] | undefined,
    });
    const images = [...(extraImages ?? []), ...(prepared.images ?? [])];
    return { message: prepared.text, images: images.length > 0 ? images : undefined };
  };
  const prompt = async (
    text: string,
    promptOpts?: { images?: unknown[]; streamingBehavior?: "steer" | "followUp"; skipLocalScan?: boolean },
  ): Promise<void> => {
    if (router.matches(text)) {
      opts.onPodCommandSubmit?.();
      await router.handle(text);
      return;
    }
    const slashName = /^\/([^\s]+)/.exec(text.trimStart())?.[1];
    if (slashName?.startsWith(POD_INTERNAL_COMMAND_PREFIX)) {
      throw new Error("pi pod internal commands cannot be invoked from the editor");
    }
    // Command ownership: the pod owns every slash command unless the caller opted a
    // name into local execution via the localCommands allowlist (generic, no hardcoded
    // extension names). An allowlisted name with no local registration falls through
    // to the pod — the same extension runs there, so behavior is preserved with a
    // single owner and never a duplicate or fallback second run. `/pod local <name>`
    // (handled above by the router) is the strict explicit route.
    if (slashName && localCommandAllowlist.has(slashName)) {
      const afterName = text.trimStart().slice(slashName.length + 1);
      if (await runLocalCommandByName(slashName, afterName.trim())) return;
    }
    // Imageless prompts skip the async scan: the rpc.request below runs in this tick,
    // exactly as before image support existed. (This call must stay textually inside
    // `prompt`: the classic-architecture freeze counts RPC call sites, and `prompt:prompt`
    // is the one allotted slot for the prompt tunnel.)
    let message = text;
    let images = promptOpts?.images?.length ? [...promptOpts.images] : undefined;
    if (!promptOpts?.skipLocalScan && collectImageCandidates(text).length > 0) {
      const prepared = await withLocalImages(text, promptOpts?.images);
      message = prepared.message;
      images = prepared.images;
    }
    const streamingBehavior = promptOpts?.streamingBehavior;
    // Pi's editor invokes its async onSubmit callback without observing the returned promise.
    // A transport drop while steering would therefore escape as an uncaught rejection and kill
    // the local TUI. Report delivery failures here, at the RPC boundary, instead. The gateway
    // still owns reconnect-or-shutdown; never replay automatically because the pod may have
    // accepted the prompt before the acknowledgement was lost.
    return rpc.request({
      type: "prompt",
      message,
      ...(images?.length ? { images: images as never } : {}),
      ...(streamingBehavior ? { streamingBehavior } : {}),
    }).catch((error: unknown) => {
      bridge.notify(
        `Prompt delivery was interrupted: ${error instanceof Error ? error.message : String(error)}; check the session before retrying`,
        "error",
      );
      return null;
    }).then((response) => {
      if (!response) return;
      if (!response.success) throw new Error(response.error);
      void cache.refreshState();
    });
  };

  /** Run a mutating command, then refresh the state cache so sync getters agree (§5.2). */
  const mutate = async <T>(run: () => Promise<T>): Promise<T> => {
    const result = await run();
    await cache.refreshState();
    return result;
  };
  const setRemoteModel = async <T>(run: () => Promise<T>): Promise<T> => {
    const result = await mutate(run);
    await refreshThinkingLevels();
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
    login: async (provider: string, type: RemoteAuthType, interaction: RemoteAuthInteraction) => {
      const accountSupported = opts.accountLogin &&
        (opts.accountAuthSupported ? await opts.accountAuthSupported(provider, type) : true);
      if (accountSupported) {
        try {
          await opts.accountLogin!(provider, type, interaction);
        } catch (error) {
          if (!isUnsupportedCredentialProvider(error)) throw error;
          await authBridge.login(provider, type, interaction);
        }
      } else {
        await authBridge.login(provider, type, interaction);
      }
      await refreshRemoteModels();
      return { type };
    },
    logout: async (provider: string) => {
      const accountSupported = opts.accountLogout &&
        (opts.accountAuthSupported ? await opts.accountAuthSupported(provider) : true);
      if (accountSupported) {
        warn(`signing out of ${provider} removes that account credential for every pod`);
        try {
          await opts.accountLogout!(provider);
        } catch (error) {
          if (!isUnsupportedCredentialProvider(error)) throw error;
          await authBridge.logout(provider);
        }
      } else {
        await authBridge.logout(provider);
      }
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
    await refreshThinkingLevels();
    return {
      model: cache.state.model ?? next.model,
      thinkingLevel: cache.state.thinkingLevel,
      isScoped,
    };
  };

  const resourceLoader = {
    getThemes: () => opts.getLocalThemes?.() ?? { themes: [], diagnostics: [] },
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    // Pi re-adds the `skill:` prefix when it builds the command, so hand back the bare name.
    getSkills: () => ({
      skills: visibleRemoteCommands()
        .filter((c) => c.source === "skill" && c.name.startsWith(SKILL_COMMAND_PREFIX))
        .map((c) => ({
          name: c.name.slice(SKILL_COMMAND_PREFIX.length),
          description: c.description ?? "",
          // The pod-side path: only ever displayed, but the loaded-resources banner keys on it.
          filePath: c.sourceInfo?.path ?? `pod:${c.name}`,
          sourceInfo: c.sourceInfo,
        })),
      diagnostics: [],
    }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getExtensions: () => ({ extensions: [], errors: [] }),
    // Resources live in the pod, which holds the real loader; the local TUI only asks these
    // to render prompt-source information, and the honest local answer is "none here" —
    // the same emptiness the collections above already return.
    getSystemPromptSource: () => undefined,
    getAppendSystemPromptSources: () => [],
  };

  // What ctx.modelRegistry offers locally rendered extensions: metadata from the
  // client-side catalog/auth snapshot, completions executed pod-side with real auth.
  // Secret-bearing and provider-mutating methods throw explained errors — pod
  // credentials never cross to the launcher (see extension-model-registry.ts).
  const extensionModelRegistry = createExtensionModelRegistry({
    getModels: () => cache.availableModels as AuxCatalogModel[],
    isProviderConfigured: (provider) =>
      authBridge.snapshot.providers.find(({ id }) => id === provider)?.status.configured ?? false,
    getProviderDisplayName: (provider) =>
      authBridge.snapshot.providers.find(({ id }) => id === provider)?.name ??
      remoteProviders().find(({ id }) => id === provider)?.name ??
      provider,
    isUsingOAuth: (provider) =>
      authBridge.snapshot.providers.find(({ id }) => id === provider)?.usingOAuth ?? false,
    auxComplete: opts.auxComplete,
    getExtensionVersion: () => rpc.helloInfo?.extensionVersion ?? undefined,
  });

  // The local extension host (attested pod extensions) serves the renderer/transformer
  // hooks when it exists; the stubs below are the zero-cost answer for everyone else.
  // The command listing stays pod-authoritative (pod ownership is the default); local
  // commands are discovered through `/pod local` completion below, not shadowing.
  const extensionRunner = {
    getRegisteredCommands: registeredCommands,
    getCommand: (name: string) =>
      name === "pod"
        ? podCommand
        : visibleRemoteCommands().find((c) => c.source === "extension" && c.name === name),
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
    // Tool renderers from client extensions wrap the built-in one, as in-process.
    resolveToolRenderers: (toolName: string, base: () => unknown) =>
      localHost ? localHost.runner.resolveToolRenderers(toolName, base) : base(),
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
    if (!findTreeNode(cache.tree, entryId)) {
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

  // --- sessionManager: cache-backed branch entries and folded tree (§5.2) ---
  const sessionManager = {
    getCwd: () => cwd,
    getEntries: () => cache.entries,
    getBranch: () => cache.entries,
    getEntryCount: () => cache.entries.length,
    getLeafId: () => cache.leafId ?? undefined,
    getSessionDir: () => cwd,
    getSessionFile: () => cache.state.sessionFile,
    getSessionName: () => cache.state.sessionName,
    getSessionId: () => cache.state.sessionId,
    getTree: () => cache.tree,
    usesDefaultSessionDir: () => true,
    isPersisted: () => cache.state.sessionFile !== undefined,
    appendLabelChange: (entryId: string, label?: string) => trackLabelMutation(entryId, label),
    /** pi's `/bug` records the report here; the entry belongs in the pod's session file. */
    appendCustomEntry: (customType: string, data?: unknown) => appendEntry(customType, data),
    buildContextEntries: () => cache.entries,
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
      return activeBashRequests.size > 0 || cache.isBashRunning;
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
    // RPC reports neither the cache warmer nor where a virtual model routed a request, so the
    // footer and /settings show what pi shows when they are unavailable.
    get cacheWarmingStatus() {
      return undefined;
    },
    get routedModel() {
      return undefined;
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
    steer: async (text: string, images?: unknown[]) => {
      const prepared = await withLocalImages(text, images);
      await rpc.steer(prepared.message, prepared.images as ImageContent[] | undefined);
    },
    followUp: async (text: string, images?: unknown[]) => {
      const prepared = await withLocalImages(text, images);
      await rpc.followUp(prepared.message, prepared.images as ImageContent[] | undefined);
    },
    sendUserMessage: (content: unknown) => {
      if (typeof content === "string") return prompt(content);
      // Extension-supplied parts (attested local extensions only — InteractiveMode's
      // editor path calls prompt() directly). Forwarded with the scan skipped: scanning
      // here would read host files the extension merely mentioned in prose. pi joins
      // text parts with newlines, which this matches.
      const parts = content as Array<{ type?: string; text?: string }>;
      const text = parts
        .filter((part) => part?.type === "text")
        .map((part) => part?.text ?? "")
        .join("\n");
      const carried = parts.filter((part) => part?.type === "image");
      return prompt(text, { ...(carried.length > 0 ? { images: carried } : {}), skipLocalScan: true });
    },
    abort: () => rpc.abort(),
    waitForIdle: (timeoutMs?: number) => rpc.waitForIdle(timeoutMs),
    setModel: (model: { provider: string; id: string }) =>
      setRemoteModel(() => rpc.setModel(model.provider, model.id)),
    cycleModel,
    setThinkingLevel: (level: never) => mutate(() => rpc.setThinkingLevel(level)),
    cycleThinkingLevel: async () => {
      const result = await mutate(() => rpc.cycleThinkingLevel());
      return result?.level;
    },
    getAvailableThinkingLevels: () => [
      ...(cache.availableThinkingLevels ?? FALLBACK_THINKING_LEVELS),
    ],
    supportsThinking: () => (cache.state.model as { reasoning?: boolean } | undefined)?.reasoning ?? false,
    setSteeringMode: (mode: "all" | "one-at-a-time") => mutate(() => rpc.setSteeringMode(mode)),
    setFollowUpMode: (mode: "all" | "one-at-a-time") => mutate(() => rpc.setFollowUpMode(mode)),
    compact: (customInstructions?: string) => mutate(() => rpc.compact(customInstructions)),
    abortCompaction: () => {},
    // Unreachable: the remote settings facade always skips branch summaries.
    abortBranchSummary: () => {},
    setAutoCompactionEnabled: (enabled: boolean) => mutate(() => rpc.setAutoCompaction(enabled)),
    /** Persisted like the /transport toggle; the warmer itself runs in the pod. */
    setCacheWarmingMode: (mode: CacheWarmingMode) => remoteSettingsManager.setCacheWarmingMode(mode),
    setAutoRetryEnabled: (enabled: boolean) => mutate(() => rpc.setAutoRetry(enabled)),
    abortRetry: () => rpc.abortRetry(),

    /** `!command` bash: streamed chunks arrive as bash_execution_update events with our id (§8). */
    executeBash: async (command: string, onChunk?: (chunk: string) => void) => {
      const id = rpc.newRequestId();
      activeBashRequests.add(id);
      let rendered = "";
      const off = rpc.onEvent((event) => {
        const e = event as { type?: string; id?: string; delta?: string };
        if (e.type === "bash_execution_update" && e.id === id && e.delta) {
          rendered += e.delta;
          onChunk?.(e.delta);
        }
      });
      try {
        const response = await rpc.request({ type: "bash", command, id });
        if (!response.success) throw new Error(response.error);
        const data = (response as { data?: { output?: string; truncated?: boolean } }).data;
        const output = typeof data?.output === "string" ? data.output : "";
        if (output.length > rendered.length && output.startsWith(rendered)) {
          const suffix = output.slice(rendered.length);
          if (suffix) onChunk?.(suffix);
        } else if (rendered.length === 0 && output) {
          onChunk?.(output);
        }
        return data;
      } finally {
        activeBashRequests.delete(id);
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
        throw new Error("Branch summaries are unavailable in remote pi pod sessions");
      }
      if (!treeBridge.supportsTreeBridge()) {
        throw new Error(
          "This running pod uses an older pi pod extension. Exit Pi, then attach again so pi pod can load the updated extension.",
        );
      }
      if (!findTreeNode(cache.tree, targetId)) throw new Error(`Tree entry ${targetId} is no longer available`);
      // session_tree is runner-local in pi (never on the wire): synthesize it after a
      // successful local navigation so TUI-mode capabilities rescan, like in-process pi.
      const oldLeafId = cache.leafId ?? null;
      return serializeTreeMutation(async () => {
        try {
          const acknowledgement = await treeBridge.navigate(targetId);
          await cache.refreshTree(acknowledgement.leafId);
          // Older pods answer without editorText; their tree stubs carry only a whitespace-flattened,
          // truncated preview, so restored text loses newlines until the pod's extension is updated.
          let editorText = acknowledgement.editorText;
          if (editorText === undefined) {
            const entry = cache.entries.find((candidate) => candidate.id === targetId) ?? findTreeNode(cache.tree, targetId)?.entry;
            editorText = entry ? editorTextForEntry(entry) : undefined;
          }
          const result = {
            cancelled: acknowledgement.cancelled,
            ...(editorText !== undefined ? { editorText } : {}),
          };
          if (!result.cancelled) {
            localHost?.emitLifecycle({
              type: "session_tree",
              newLeafId: acknowledgement.leafId,
              oldLeafId,
              fromExtension: false,
            });
          }
          return result;
        } catch (error) {
          await cache.refreshTree().catch(() => {});
          throw error;
        }
      });
    },
    getUserMessagesForForking: () => cache.forkMessages ?? [],
    // Sync by contract: InteractiveMode's /session destructures the result immediately,
    // so the RPC promise must never cross this surface (it crashed the TUI as stats.tokens
    // === undefined). The cache refreshes from the pod at every completion boundary.
    getSessionStats: () => cache.sessionStatsSnapshot(),
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
    // terminal-input listener and autocomplete wrapper on its way in and rebinds nothing, so
    // the chords and pod file completion are ours to put back.
    reload: async () => {
      bridge.rewireUi();
      if (bridge.ui) installPodFileCompletion(bridge.ui);
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
      if (!result.cancelled) await applySessionReplacement(false, "drop", "new");
      return { cancelled: result.cancelled };
    },
    switchSession: async (sessionPath: string) => {
      const result = await rpc.switchSession(sessionPath);
      if (!result.cancelled) await applySessionReplacement(false, "drop", "resume");
      return { cancelled: result.cancelled };
    },
    fork: async (entryId: string) => {
      const result = await rpc.fork(entryId);
      if (!result.cancelled) await applySessionReplacement(false, "drop", "fork");
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
      // Abandon locally queued aux waits; in-flight pod executions are the gateway's to
      // cancel, and their late replies correlate to nothing.
      extensionModelRegistry.discardPending("the pi pod session ended");
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
      if (intent.kind === "quit" && (opts.waitForRemoteExitOnQuit?.() ?? true)) {
        exitCode = await quitPi(rpc);
      }

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
      await refreshThinkingLevels();
      await authBridge.refresh();
      await seedScopedModels();
      if (opts.attestedExtensionPaths?.length) {
        try {
          localHost = await createLocalExtensionHost({
            paths: opts.attestedExtensionPaths,
            hostCwd: cwd,
            cache,
            bridge,
            appendEntry,
            getScopedModels: () => scopedModels,
            prompt,
            setModel: (model) => setRemoteModel(() => rpc.setModel(model.provider, model.id)),
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
          bridge.onUiBound(() => bridge.notify(`pod extension rendering failed to start: ${message}`, "warning"));
          debug(`local extension host failed: ${message}`);
        }
      }
    },
    refreshAfterReplacement: () => applySessionReplacement(true),
    recoverAfterReconnect: () => applySessionReplacement(true, "redisplay"),
    healStreamingRenderer,
    reloadSettings: () => settingsManager.reload(),
    disableLocalExtensions: async () => {
      if (!localHost) return;
      const host = localHost;
      localHost = null;
      await host.sessionShutdown("resume").catch(() => {});
      await host.dispose();
    },
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
