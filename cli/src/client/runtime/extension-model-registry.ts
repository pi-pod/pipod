/**
 * src/client/runtime/extension-model-registry.ts — the launcher-side `ctx.modelRegistry`.
 *
 * Native pi hands extensions a `ModelRegistry` facade over the session's authenticated
 * `ModelRuntime` (same instance the agent uses). A pod session's credentials live in the
 * pod, so the launcher cannot hold that instance. This module builds a native-compatible
 * facade instead:
 *
 * - Metadata reads (`find`, `getAvailable`, `getProvider`, `hasConfiguredAuth`, …) are
 *   served from the client-side model catalog and the auth-bridge snapshot. They are
 *   honest but point-in-time: the pod stays authoritative and the snapshot refreshes on
 *   the same boundaries as the model catalog.
 * - `complete` executes pod-side through the semantic `aux_complete` gateway message,
 *   where the pod's own authenticated registry runs it as a turn-external call: no
 *   conversation entries, no main-model change, no prompt-cache interaction
 *   (`cacheRetention: "none"`). Secrets never cross to the launcher. `complete()`
 *   accepts `cacheRetention: "none"` because unchanged callers (notably
 *   pi-lightweight-llm) always pass it; any other value is rejected — the bridge
 *   always runs turn-external with no prompt-cache interaction.
 *
 * Text-only contract (explicit, not full native parity): only `{systemPrompt,
 * messages}` cross, with user/assistant text content. Anything else — `tools`,
 * sampling options (`temperature`, `samplingParams`, …), transports, headers, env,
 * image/audio/tool-result content, thinking blocks — is rejected with an explained
 * error, never silently dropped. The pod runs the call through its real
 * `ModelRegistry.complete` with the native `reasoningEffort` thinking option passed
 * through verbatim (including "off"), so thinking semantics are exactly the pod's
 * native per-API behavior — provider-specific, with no bridge-level translation
 * and no universal guarantee. Empty-text non-terminal outcomes (toolUse/deferred/pending) are
 * reported as failures, never fabricated successes.
 * - Anything that would leak pod credentials (`getApiKeyAndHeaders`, `getProviderAuth`,
 *   `getApiKeyForProvider`) or mutate pod-side providers (`registerProvider`, …) throws
 *   an explained error. Arbitrary API transparency is impossible across this boundary;
 *   the facade says exactly where the boundary is instead of half-working.
 *
 * Ownership/limits: at most {@link AUX_CLIENT_CONCURRENCY} aux completions are in flight
 * per launcher session (fast `aux_busy` failure, never silent queueing); every call has
 * its own deadline (default 60s, cap 5min) and its own AbortSignal, which cancels only
 * that call — never the main turn. Disconnect and session replacement reject/abandon
 * pending calls through the transport's lifecycle invalidation; the gateway owns the
 * pod-side cancel. Payloads are bounded (system prompt, message count/size, max tokens)
 * so a rogue extension cannot turn the pod into an open relay.
 */
import { PiPodError } from "../../errors.js";
import { AUX_EXTENSION_VERSION } from "../../shim/pi-pod-ext.js";
import type { ThinkingLevel } from "../rpc.js";

export type AuxRole = "user" | "assistant";

export interface AuxMessage {
  role: AuxRole;
  content: string;
}

export interface AuxCompleteRequest {
  provider: string;
  model: string;
  systemPrompt?: string | undefined;
  messages: AuxMessage[];
  thinkingLevel?: ThinkingLevel | undefined;
  maxTokens?: number | undefined;
  timeoutMs?: number | undefined;
}

export interface AuxCompleteResult {
  text: string;
  stopReason: string;
  usage: unknown;
}

/** Minimal structural read of a catalog model — provider/id are the whole wire identity. */
export interface AuxCatalogModel {
  provider: string;
  id: string;
  api?: string | undefined;
  reasoning?: boolean | undefined;
  [key: string]: unknown;
}

export interface ExtensionModelRegistryDeps {
  /** Live point-in-time catalog (the client-side available-models cache). */
  getModels(): readonly AuxCatalogModel[];
  /** Live point-in-time auth state (the auth-bridge snapshot). */
  isProviderConfigured(provider: string): boolean;
  /** Display name for a provider id, for getProviderDisplayName. */
  getProviderDisplayName(provider: string): string;
  /** Whether the provider authenticates via OAuth (for isUsingOAuth/isUsingSubscription). */
  isUsingOAuth(provider: string): boolean;
  /** Transport-level aux execution (the semantic gateway message). */
  auxComplete: ((request: AuxCompleteRequest, opts?: { signal?: AbortSignal }) => Promise<AuxCompleteResult>) | undefined;
  /** Pod extension version from the shim hello, for honest older-pod errors. */
  getExtensionVersion(): number | undefined;
}

export const AUX_CLIENT_CONCURRENCY = 4;
export const AUX_DEFAULT_TIMEOUT_MS = 60_000;
export const AUX_MAX_TIMEOUT_MS = 300_000;
export const AUX_DEFAULT_MAX_TOKENS = 2048;
export const AUX_MAX_MAX_TOKENS = 4096;
export const AUX_MAX_SYSTEM_PROMPT_CHARS = 16_384;
export const AUX_MAX_MESSAGES = 16;
export const AUX_MAX_MESSAGE_CHARS = 65_536;

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function auxError(code: string, message: string): PiPodError {
  return new PiPodError(message, { code });
}

function unavailable(what: string, why: string): () => never {
  return () => {
    throw auxError("aux_unsupported", `${what} is not available to locally rendered pod extensions — ${why}`);
  };
}

function checkModelShape(model: unknown): asserts model is AuxCatalogModel {
  if (
    typeof model !== "object" ||
    model === null ||
    typeof (model as AuxCatalogModel).provider !== "string" ||
    typeof (model as AuxCatalogModel).id !== "string"
  ) {
    throw auxError("invalid_model", "complete() needs the model object returned by find()");
  }
}

const CONTEXT_KEYS = new Set(["systemPrompt", "messages"]);

function checkContext(context: unknown): { systemPrompt?: string; messages: AuxMessage[] } {
  if (typeof context !== "object" || context === null) {
    throw auxError("invalid_context", "complete() needs a context with a messages array");
  }
  for (const key of Object.keys(context)) {
    if (!CONTEXT_KEYS.has(key)) {
      throw auxError(
        "unsupported_option",
        `complete() context key ${JSON.stringify(key)} cannot cross the aux bridge — only systemPrompt and text-only messages are supported`,
      );
    }
  }
  const { systemPrompt, messages } = context as { systemPrompt?: unknown; messages?: unknown };
  if (systemPrompt !== undefined && typeof systemPrompt !== "string") {
    throw auxError("invalid_context", "complete() systemPrompt must be a string");
  }
  if (typeof systemPrompt === "string" && systemPrompt.length > AUX_MAX_SYSTEM_PROMPT_CHARS) {
    throw auxError(
      "context_too_large",
      `complete() systemPrompt exceeds ${AUX_MAX_SYSTEM_PROMPT_CHARS} characters`,
    );
  }
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > AUX_MAX_MESSAGES) {
    throw auxError(
      "invalid_context",
      `complete() messages must be 1..${AUX_MAX_MESSAGES} entries (text-only user/assistant)`,
    );
  }
  return {
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    messages: messages.map((entry, index) => {
      if (typeof entry !== "object" || entry === null) {
        throw auxError("invalid_context", `complete() messages[${index}] must be an object`);
      }
      const { role, content, timestamp } = entry as {
        role?: unknown;
        content?: unknown;
        timestamp?: unknown;
      };
      void timestamp;
      if (role !== "user" && role !== "assistant") {
        throw auxError(
          "unsupported_role",
          `complete() messages[${index}] has role ${JSON.stringify(role)} — only user/assistant text messages cross the aux bridge`,
        );
      }
      if (typeof content === "string") {
        if (content.length > AUX_MAX_MESSAGE_CHARS) {
          throw auxError(
            "context_too_large",
            `complete() messages[${index}] exceeds ${AUX_MAX_MESSAGE_CHARS} characters`,
          );
        }
        return { role, content };
      }
      if (!Array.isArray(content)) {
        throw auxError("invalid_context", `complete() messages[${index}].content must be text`);
      }
      const text = content
        .map((part) => {
          if (typeof part !== "object" || part === null || (part as { type?: unknown }).type !== "text") {
            throw auxError(
              "unsupported_content",
              `complete() messages[${index}] carries non-text content — only text crosses the aux bridge`,
            );
          }
          return String((part as { text?: unknown }).text ?? "");
        })
        .join("");
      if (text.length > AUX_MAX_MESSAGE_CHARS) {
        throw auxError(
          "context_too_large",
          `complete() messages[${index}] exceeds ${AUX_MAX_MESSAGE_CHARS} characters`,
        );
      }
      return { role, content: text };
    }),
  };
}

function checkOptions(options: unknown): {
  signal?: AbortSignal;
  thinkingLevel?: ThinkingLevel;
  maxTokens: number;
  timeoutMs: number;
} {
  if (options === undefined) {
    return { maxTokens: AUX_DEFAULT_MAX_TOKENS, timeoutMs: AUX_DEFAULT_TIMEOUT_MS };
  }
  if (typeof options !== "object" || options === null) {
    throw auxError("invalid_options", "complete() options must be an object");
  }
  // Reject — never silently drop — anything outside the text-only aux contract.
  // Native complete() accepts per-API sampling/transport/tools options; none of
  // those cross this bridge. cacheRetention: "none" is accepted because unchanged
  // callers always pass it and the bridge enforces no-cache behavior anyway.
  const OPTION_KEYS = new Set(["signal", "thinkingLevel", "reasoningEffort", "maxTokens", "timeoutMs", "cacheRetention"]);
  for (const key of Object.keys(options)) {
    if (!OPTION_KEYS.has(key)) {
      throw auxError(
        "unsupported_option",
        `complete() option ${JSON.stringify(key)} cannot cross the aux bridge — supported options are signal, thinkingLevel, maxTokens, timeoutMs, cacheRetention: "none"`,
      );
    }
  }
  const { cacheRetention } = options as { cacheRetention?: unknown };
  if (cacheRetention !== undefined && cacheRetention !== "none") {
    throw auxError(
      "unsupported_option",
      `complete() cacheRetention ${JSON.stringify(cacheRetention)} cannot cross the aux bridge — auxiliary completions always run with no prompt-cache interaction`,
    );
  }
  const { signal, thinkingLevel, reasoningEffort, maxTokens, timeoutMs } = options as {
    signal?: unknown;
    thinkingLevel?: unknown;
    reasoningEffort?: unknown;
    maxTokens?: unknown;
    timeoutMs?: unknown;
  };
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw auxError("invalid_options", "complete() signal must be an AbortSignal");
  }
  const level = thinkingLevel ?? reasoningEffort;
  if (level !== undefined && (typeof level !== "string" || !THINKING_LEVELS.has(level))) {
    throw auxError(
      "invalid_options",
      "complete() thinkingLevel must be one of off/minimal/low/medium/high/xhigh/max",
    );
  }
  const checkedLevel = level as ThinkingLevel | undefined;
  const tokens = maxTokens === undefined ? AUX_DEFAULT_MAX_TOKENS : maxTokens;
  if (typeof tokens !== "number" || !Number.isInteger(tokens) || tokens < 1 || tokens > AUX_MAX_MAX_TOKENS) {
    throw auxError("invalid_options", `complete() maxTokens must be 1..${AUX_MAX_MAX_TOKENS}`);
  }
  const timeout = timeoutMs === undefined ? AUX_DEFAULT_TIMEOUT_MS : timeoutMs;
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout < 1000 || timeout > AUX_MAX_TIMEOUT_MS) {
    throw auxError("invalid_options", `complete() timeoutMs must be 1000..${AUX_MAX_TIMEOUT_MS}`);
  }
  return {
    ...(signal ? { signal } : {}),
    ...(checkedLevel !== undefined ? { thinkingLevel: checkedLevel } : {}),
    maxTokens: tokens,
    timeoutMs: timeout,
  };
}

function zeroUsage(): Record<string, number> {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
}

/** Native-shaped assistant message returned by complete(). */
export interface AuxAssistantMessage {
  role: "assistant";
  content: Array<{ type: "text"; text: string }>;
  api: string;
  provider: string;
  model: string;
  usage: unknown;
  stopReason: string;
  timestamp: number;
}

/**
 * Build the launcher-side model registry. `getModels`/`isProviderConfigured` are thunks so
 * every call reads the live cache/snapshot rather than a stale copy.
 */
export function createExtensionModelRegistry(deps: ExtensionModelRegistryDeps): ExtensionModelRegistry {
  let inFlight = 0;
  const activeControllers = new Set<AbortController>();

  const find = (provider: string, modelId: string): AuxCatalogModel | undefined =>
    deps.getModels().find((model) => model.provider === provider && model.id === modelId);

  const hasConfiguredAuth = (model: AuxCatalogModel): boolean => {
    if (!model || typeof model.provider !== "string") return false;
    return deps.isProviderConfigured(model.provider);
  };

  const complete = async (
    model: unknown,
    context: unknown,
    options?: unknown,
  ): Promise<AuxAssistantMessage> => {
    checkModelShape(model);
    const checked = checkContext(context);
    const opts = checkOptions(options);
    // An already-aborted caller signal fails before any transport use.
    opts.signal?.throwIfAborted();
    if (!deps.auxComplete) {
      throw auxError(
        "aux_unsupported",
        "auxiliary completions need a gateway session with aux support — this transport has none",
      );
    }
    const extensionVersion = deps.getExtensionVersion();
    if (extensionVersion !== undefined && extensionVersion < AUX_EXTENSION_VERSION) {
      throw auxError(
        "aux_unsupported",
        "this pod runs an older pi pod extension without auxiliary completions — restart Pi in the pod and reattach",
      );
    }
    if (inFlight >= AUX_CLIENT_CONCURRENCY) {
      throw auxError(
        "aux_busy",
        `too many concurrent auxiliary completions (>${AUX_CLIENT_CONCURRENCY}) — retry when one settles`,
      );
    }
    if (!hasConfiguredAuth(model)) {
      throw auxError(
        "auth_unconfigured",
        `no configured authentication for ${model.provider} — run /login ${model.provider} in the pod session`,
      );
    }
    if (!find(model.provider, model.id)) {
      throw auxError("unknown_model", `unknown model ${model.provider}/${model.id} in this pod session`);
    }

    inFlight += 1;
    const controller = new AbortController();
    activeControllers.add(controller);
    const onCallerAbort = (): void => {
      controller.abort(opts.signal?.reason);
    };
    opts.signal?.addEventListener("abort", onCallerAbort, { once: true });
    const timer = setTimeout(() => {
      controller.abort(new Error(`auxiliary completion timed out after ${Math.round(opts.timeoutMs / 1000)}s`));
    }, opts.timeoutMs);
    timer.unref?.();
    try {
      const result = await deps.auxComplete(
        {
          provider: model.provider,
          model: model.id,
          ...(checked.systemPrompt !== undefined ? { systemPrompt: checked.systemPrompt } : {}),
          messages: checked.messages,
          ...(opts.thinkingLevel !== undefined ? { thinkingLevel: opts.thinkingLevel } : {}),
          maxTokens: opts.maxTokens,
          timeoutMs: opts.timeoutMs,
        },
        { signal: controller.signal },
      );
      // A late reply after caller abort, timeout, or session invalidation is never
      // returned as a success: the caller already observed the cancellation.
      controller.signal.throwIfAborted();
      if (typeof result.text !== "string") {
        throw auxError("aux_malformed", "auxiliary completion reply carried no text");
      }
      if (result.text === "" && result.stopReason !== "stop" && result.stopReason !== "length") {
        throw auxError(
          "completion_failed",
          `auxiliary completion ended without text (stopReason ${JSON.stringify(result.stopReason)}) — the text-only bridge cannot serve tool-use or deferred outcomes`,
        );
      }
      // A native-shaped assistant message: the caller's contract (stopReason/usage/content)
      // is the same one ModelRegistry.complete returns in-process. Usage passes through
      // untouched (including cost); the pod never fabricates it.
      return {
        role: "assistant",
        content: [{ type: "text", text: result.text }],
        api: model.api ?? "unknown",
        provider: model.provider,
        model: model.id,
        usage: result.usage ?? zeroUsage(),
        stopReason: result.stopReason,
        timestamp: Date.now(),
      };
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onCallerAbort);
      activeControllers.delete(controller);
      inFlight -= 1;
    }
  };

  return {
    find,
    hasConfiguredAuth,
    complete,
    getAll: () => [...deps.getModels()],
    getAvailable: () => [...deps.getModels()],
    getProviderDisplayName: (provider: string) => deps.getProviderDisplayName(provider),
    isUsingOAuth: (model: AuxCatalogModel) =>
      typeof model?.provider === "string" && deps.isUsingOAuth(model.provider),
    isUsingSubscription: (model: AuxCatalogModel) =>
      typeof model?.provider === "string" && deps.isUsingOAuth(model.provider),
    getError: () => undefined,
    // Provider credentials live in the pod; the launcher must never see them.
    getApiKeyAndHeaders: unavailable(
      "modelRegistry.getApiKeyAndHeaders",
      "pod credentials never cross to the launcher — run the completion pod-side via complete()",
    ),
    getProviderAuth: unavailable(
      "modelRegistry.getProviderAuth",
      "pod credentials never cross to the launcher — run the completion pod-side via complete()",
    ),
    getApiKeyForProvider: unavailable(
      "modelRegistry.getApiKeyForProvider",
      "pod credentials never cross to the launcher — run the completion pod-side via complete()",
    ),
    // Providers execute in the pod; local registration would fork the catalog.
    registerProvider: unavailable(
      "modelRegistry.registerProvider",
      "providers execute in the pod — configure them there",
    ),
    unregisterProvider: unavailable(
      "modelRegistry.unregisterProvider",
      "providers execute in the pod — configure them there",
    ),
    getRegisteredProviderConfig: unavailable(
      "modelRegistry.getRegisteredProviderConfig",
      "providers execute in the pod",
    ),
    getRegisteredNativeProvider: unavailable(
      "modelRegistry.getRegisteredNativeProvider",
      "providers execute in the pod",
    ),
    getRegisteredProviderIds: () => [] as string[],
    /**
     * Abort locally queued aux waits (session replacement/dispose). In-flight pod
     * executions are the gateway's to cancel (the transport aborts on our signal);
     * late pod replies correlate to nothing and are discarded by the post-await
     * abort check in complete(). Never aborts the main turn.
     */
    discardPending: (reason = "the pi pod session was replaced") => {
      const error = new Error(reason);
      for (const controller of activeControllers) {
        try {
          controller.abort(error);
        } catch {
          // Aborting never fails usefully; the finally in complete() still runs.
        }
      }
      activeControllers.clear();
    },
  };
}

export type ExtensionModelRegistry = {
  find(provider: string, modelId: string): AuxCatalogModel | undefined;
  hasConfiguredAuth(model: AuxCatalogModel): boolean;
  complete(
    model: unknown,
    context: unknown,
    options?: unknown,
  ): Promise<AuxAssistantMessage>;
  getAll(): AuxCatalogModel[];
  getAvailable(): AuxCatalogModel[];
  getProviderDisplayName(provider: string): string;
  isUsingOAuth(model: AuxCatalogModel): boolean;
  isUsingSubscription(model: AuxCatalogModel): boolean;
  getError(): undefined;
  getApiKeyAndHeaders(): never;
  getProviderAuth(): never;
  getApiKeyForProvider(): never;
  registerProvider(): never;
  unregisterProvider(): never;
  getRegisteredProviderConfig(): never;
  getRegisteredNativeProvider(): never;
  getRegisteredProviderIds(): string[];
  discardPending(reason?: string): void;
};
