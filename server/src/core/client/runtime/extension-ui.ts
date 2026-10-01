/**
 * src/client/runtime/extension-ui.ts — the extension-UI sub-protocol, client side (§5.3).
 *
 * Extensions run pod-side, inside pi; their UI reaches the user through pi's documented
 * `extension_ui_request` / `extension_ui_response` protocol, arriving here as ordinary E
 * frames. Dialogs render through InteractiveMode's own extension components (captured via
 * `bindExtensions`, see bridge.ts) and answer back over the wire; fire-and-forget methods
 * map straight onto the local surface.
 */
import type { RpcClientBase } from "../rpc.js";
import type { HostBridge } from "./bridge.js";

interface ExtensionUiRequest {
  type: "extension_ui_request";
  id: string;
  method: string;
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  timeout?: number;
  notifyType?: "info" | "warning" | "error";
  statusKey?: string;
  statusText?: string;
  widgetKey?: string;
  widgetLines?: string[];
  widgetPlacement?: "aboveEditor" | "belowEditor";
  text?: string;
}

/** Bound in case a wedged pod streams dialog requests during a long startup. */
const MAX_PENDING_REQUESTS = 64;

const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
const FIRE_AND_FORGET_METHODS = new Set(["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"]);

/** A method that blocks the agent until this client answers it (§5.3, §12). */
function isDialogMethod(request: ExtensionUiRequest): boolean {
  return (
    DIALOG_METHODS.has(request.method) ||
    (!FIRE_AND_FORGET_METHODS.has(request.method) && request.timeout === undefined)
  );
}

/** The local surface went away before the user answered; the pod is still waiting. */
const ABANDONED = Symbol("abandoned");

interface LiveDialog {
  request: ExtensionUiRequest;
  /** Unblocks the `await` on a surface that will never resolve, without answering the pod. */
  abandon: () => void;
  abandoned: boolean;
}

/** Displayed or already answered, keyed by request id; "settled" holds the answered ids. */
type DialogEntry = LiveDialog | "settled";

/** What a session invalidation does to the dialogs currently on screen. */
export type DialogInvalidation =
  /** The transport dropped: the pod still holds these requests, so show them again. */
  | "redisplay"
  /** Another session or pod owns them now: nothing will replay them, and nobody may answer. */
  | "drop";

export interface ExtensionUiWiring {
  /** Stop routing; anything still queued is cancelled rather than left hanging. */
  dispose(): void;
  /**
   * InteractiveMode is about to destroy its dialog surfaces (`resetExtensionUI`). Answering
   * for the user would wrongly reject a tool approval nobody saw, so abandon each dialog
   * instead: the pod-side request stays pending, and `redisplay` renders it again on the
   * next UI bind. Must be called synchronously with the reset, before any await, so a
   * surface that resolves on dispose cannot answer on its way out.
   */
  invalidateDialogs(fate: DialogInvalidation): void;
}

/**
 * Route extension-UI requests into the local TUI.
 *
 * Requests that arrive before InteractiveMode binds its UI context are queued and replayed
 * on bind, so a dialog or notification raised while the TUI is still booting is shown
 * rather than silently declined. Once bound, dialogs whose local surface is missing (a
 * method the context does not offer) are cancelled rather than left hanging — the agent
 * side also auto-resolves on its own timeout, so neither side ever blocks forever (§12).
 *
 * Delivery is not resolution: a blocking dialog stays pending pod-side until its response,
 * so both transports re-deliver it after a reconnect (shim `ui_replay`, gateway attach).
 * The registry below keeps that idempotent — at most one surface and one response per
 * request id, however many copies arrive.
 */
export function wireExtensionUi(
  rpc: RpcClientBase,
  bridge: HostBridge,
  intercept?: (request: ExtensionUiRequest) => boolean,
): ExtensionUiWiring {
  /** Requests held for the TUI; null once the queue has flushed. */
  let pending: ExtensionUiRequest[] | null = [];
  const dialogs = new Map<string, DialogEntry>();
  /** Abandoned dialogs waiting for a UI context to render them onto again. */
  let redisplay: ExtensionUiRequest[] = [];

  const remember = (id: string, entry: DialogEntry): void => {
    dialogs.delete(id);
    dialogs.set(id, entry);
    while (dialogs.size > MAX_PENDING_REQUESTS) {
      const oldest = dialogs.keys().next().value;
      if (oldest === undefined) break;
      dialogs.delete(oldest);
    }
  };

  const respond = (
    dialog: LiveDialog,
    answer: { value: string } | { confirmed: boolean } | { cancelled: true },
  ): void => {
    if (dialog.abandoned) return;
    remember(dialog.request.id, "settled");
    rpc.respondExtensionUi({ type: "extension_ui_response", id: dialog.request.id, ...answer });
  };

  const dispatch = async (request: ExtensionUiRequest): Promise<void> => {
    if (!isDialogMethod(request)) {
      dispatchFireAndForget(bridge, request);
      return;
    }
    // A second copy of a dialog already on screen (or already answered) is the replay
    // machinery doing its job; rendering it twice would put two surfaces on one request.
    if (dialogs.has(request.id)) return;

    const dialog: LiveDialog = { request, abandon: () => {}, abandoned: false };
    const surfaceGone = new Promise<typeof ABANDONED>((resolve) => {
      dialog.abandon = () => {
        dialog.abandoned = true;
        resolve(ABANDONED);
      };
    });
    remember(request.id, dialog);
    // `resetExtensionUI` disposes a dialog component without settling its promise, so the
    // abandon signal — not the surface — is what releases this await.
    const settle = <T>(surface: Promise<T> | undefined): Promise<T | undefined | typeof ABANDONED> =>
      surface === undefined ? Promise.resolve(undefined) : Promise.race([surface, surfaceGone]);

    const ui = bridge.ui;
    const cancel = () => respond(dialog, { cancelled: true });
    try {
      switch (request.method) {
        case "select": {
          const value = await settle(ui?.select?.(request.title ?? "", request.options ?? []));
          if (value === ABANDONED) return;
          if (value === undefined) cancel();
          else respond(dialog, { value });
          return;
        }
        case "confirm": {
          if (!ui?.confirm) return cancel();
          const confirmed = await settle(ui.confirm(request.title ?? "", request.message ?? ""));
          if (confirmed === ABANDONED) return;
          respond(dialog, { confirmed: confirmed ?? false });
          return;
        }
        case "input": {
          const value = await settle(ui?.input?.(request.title ?? "", request.placeholder));
          if (value === ABANDONED) return;
          if (value === undefined) cancel();
          else respond(dialog, { value });
          return;
        }
        case "editor": {
          const value = await settle(ui?.editor?.(request.title ?? "", request.prefill));
          if (value === ABANDONED) return;
          if (value === undefined) cancel();
          else respond(dialog, { value });
          return;
        }
        default:
          // A blocking method this client does not know. It must not hang the agent.
          cancel();
          return;
      }
    } catch {
      cancel();
    }
  };

  /** Cancel a request that will never render — but never answer a fire-and-forget. */
  const cancelUnrenderable = (request: ExtensionUiRequest): void => {
    if (!isDialogMethod(request) || dialogs.has(request.id)) return;
    remember(request.id, "settled");
    rpc.respondExtensionUi({ type: "extension_ui_response", id: request.id, cancelled: true });
  };

  bridge.onUiBound(() => {
    const queued = pending ?? [];
    pending = null;
    for (const request of queued) void dispatch(request);
  });
  // Every bind, not just the first: a reconnect rebinds the session, and that is exactly
  // when the dialogs abandoned above need a surface again.
  const unbind = bridge.onEveryUiBound(() => {
    const again = redisplay;
    redisplay = [];
    for (const request of again) void dispatch(request);
  });
  const off = rpc.onEvent((event) => {
    const request = event as unknown as ExtensionUiRequest;
    if (request.type !== "extension_ui_request") return;
    if (intercept?.(request)) return;
    if (pending !== null) {
      if (pending.length < MAX_PENDING_REQUESTS) pending.push(request);
      else cancelUnrenderable(request);
      return;
    }
    void dispatch(request);
  });

  return {
    dispose: () => {
      const queued = pending ?? [];
      pending = null;
      redisplay = [];
      for (const request of queued) cancelUnrenderable(request);
      unbind();
      off();
    },
    invalidateDialogs: (fate) => {
      for (const [id, entry] of dialogs) {
        if (entry === "settled") continue;
        dialogs.delete(id);
        entry.abandon();
        if (fate === "redisplay") redisplay.push(entry.request);
      }
      if (fate === "drop") {
        // Ids of a session this client is leaving; keeping them could only shadow a later one.
        dialogs.clear();
        redisplay = [];
      }
    },
  };
}

function dispatchFireAndForget(bridge: HostBridge, request: ExtensionUiRequest): void {
  const ui = bridge.ui;
  switch (request.method) {
    case "notify":
      ui?.notify?.(request.message ?? "", request.notifyType ?? "info");
      return;
    case "setStatus":
      ui?.setStatus?.(request.statusKey ?? "", request.statusText);
      return;
    case "setWidget":
      // String lines only (§5.3): component factories cannot cross the wire.
      ui?.setWidget?.(
        request.widgetKey ?? "",
        request.widgetLines,
        request.widgetPlacement ? { placement: request.widgetPlacement } : undefined,
      );
      return;
    case "setTitle":
      ui?.setTitle?.(request.title ?? "");
      return;
    case "set_editor_text":
      ui?.setEditorText?.(request.text ?? "");
      return;
    default:
      // A method this client does not know, carrying a timeout: the agent side resolves it.
      return;
  }
}
