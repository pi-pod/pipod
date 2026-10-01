/**
 * Generic client half of remote extension UI. Extension component code executes in the pod;
 * this module mounts a structural proxy in the local InteractiveMode and forwards only
 * rendered lines, input, resize, and lifecycle messages.
 */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { RpcClientBase } from "../rpc.js";
import {
  REMOTE_UI_INPUT_PREFIX,
  REMOTE_UI_MAX_LINE_LENGTH,
  REMOTE_UI_MAX_LINES,
  REMOTE_UI_MAX_SURFACES,
  REMOTE_UI_NOTIFICATION_PREFIX,
  REMOTE_UI_PROTOCOL_VERSION,
  decodeRemoteUiPayload,
  encodeRemoteUiPayload,
  type RemoteUiControlFrame,
  type RemoteUiFrame,
  type RemoteUiInput,
  type RemoteUiSurfaceFrame,
} from "../../remote-ui-protocol.js";
import type { HostBridge, HostUiContext } from "./bridge.js";

export interface RemoteUiExtensionRequest {
  type: "extension_ui_request";
  id: string;
  method: string;
  title?: string;
  message?: string;
}

interface TuiLike {
  terminal?: { rows?: number };
  requestRender?(force?: boolean): void;
}

type Done = (value: unknown) => void;

class RemoteSurfaceComponent {
  focused = true;
  wantsKeyRelease = true;
  onSubmit?: (text: string) => void;
  onChange?: (text: string) => void;
  private tui: TuiLike | null = null;
  private done: Done | null = null;
  private lastWidth = 0;
  private lastHeight = 0;
  private lastEditorSubmitId = 0;

  constructor(private readonly owner: RemoteSurface) {}

  bind(tui: TuiLike, done?: Done): this {
    this.tui = tui;
    this.done = done ?? null;
    this.owner.flush();
    return this;
  }

  render(width: number): string[] {
    const height = Math.max(1, Number(this.tui?.terminal?.rows ?? 24));
    if (width !== this.lastWidth || height !== this.lastHeight) {
      this.lastWidth = width;
      this.lastHeight = height;
      queueMicrotask(() => this.owner.resize(width, height));
    }
    // Frames are rendered in the pod and lag a resize round trip behind the local terminal,
    // so after a shrink the newest lines are still the old, wider ones — and a line wider than
    // the component's width aborts pi's renderer.
    return this.owner.lines.map((line) => (visibleWidth(line) > width ? truncateToWidth(line, width, "") : line));
  }

  handleInput(data: string): void {
    this.owner.input(data, Math.max(1, this.lastWidth || 80), Math.max(1, this.lastHeight || 24));
  }

  getText(): string {
    return this.owner.editorText;
  }

  getExpandedText(): string {
    return this.owner.editorText;
  }

  setText(text: string): void {
    this.owner.setEditorText(text, Math.max(1, this.lastWidth || 80), Math.max(1, this.lastHeight || 24));
  }

  insertTextAtCursor(text: string): void {
    this.setText(this.owner.editorText + text);
  }

  addToHistory(): void {}
  setAutocompleteProvider(): void {}
  setPaddingX(): void {}
  setAutocompleteMaxVisible(): void {}

  applyEditorFrame(text: string | undefined, submit: string | undefined, submitId: number | undefined): void {
    if (text !== undefined && text !== this.owner.editorText) {
      this.owner.editorText = text;
      this.onChange?.(text);
    }
    if (submit !== undefined && submitId !== undefined && submitId > this.lastEditorSubmitId) {
      this.lastEditorSubmitId = submitId;
      this.onSubmit?.(submit);
    }
  }

  invalidate(): void {}

  requestRender(): void {
    this.tui?.requestRender?.();
  }

  finish(): void {
    this.done?.(undefined);
    this.done = null;
  }

  dispose(): void {
    this.owner.localDisposed();
  }
}

class RemoteSurface {
  readonly component = new RemoteSurfaceComponent(this);
  lines: string[] = [];
  editorText = "";
  revision = -1;
  pendingRequestId: string | null = null;
  mounted = false;
  remoteClosing = false;
  private localHandle: { focus(): void; unfocus(): void } | null = null;
  private appliedFocus: boolean | null = null;
  private inputSequence = 0;
  private readonly queuedInputs: Array<{
    kind: "input" | "setText";
    data: string;
    width: number;
    height: number;
  }> = [];
  private size = { width: 0, height: 0 };

  constructor(
    readonly frame: RemoteUiSurfaceFrame,
    private readonly manager: RemoteUiBridge,
  ) {}

  apply(frame: RemoteUiSurfaceFrame, requestId?: string): void {
    if (frame.revision >= this.revision) {
      this.revision = frame.revision;
      this.lines = sanitizeLines(frame.lines ?? []);
      Object.assign(this.frame, frame);
      this.component.requestRender();
      this.component.applyEditorFrame(frame.editorText, frame.editorSubmit, frame.editorSubmitId);
    }
    if (requestId) {
      this.pendingRequestId = requestId;
      this.flush();
    }
    this.applyFocus();
  }

  bindLocalHandle(handle: { focus(): void; unfocus(): void }): void {
    this.localHandle = handle;
    // A remount (session replacement) makes a fresh, unfocused local overlay; reapply.
    this.appliedFocus = null;
    this.applyFocus();
  }

  /**
   * Extension component code runs in the pod, so its handle.focus()/unfocus() calls act on
   * the pod's virtual TUI. Non-capturing overlays receive input only when focused, so the
   * pod mirrors that handle state through frames and it is replayed onto the local handle
   * here — otherwise a remote non-capturing overlay could never accept input at all.
   */
  private applyFocus(): void {
    const want = this.frame.focused;
    if (want === undefined || !this.localHandle || this.appliedFocus === want) return;
    this.appliedFocus = want;
    if (want) this.localHandle.focus();
    else this.localHandle.unfocus();
  }

  flush(): void {
    if (!this.pendingRequestId) return;
    if (this.size.width > 0) {
      const { width, height } = this.size;
      this.size = { width: 0, height: 0 };
      this.send("resize", width, height);
      return;
    }
    const queued = this.queuedInputs.shift();
    if (!queued) return;
    if (queued.kind === "input") {
      const events = [queued.data];
      while (events.length < 64 && this.queuedInputs[0]?.kind === "input") {
        events.push(this.queuedInputs.shift()!.data);
      }
      this.send("input", queued.width, queued.height, undefined, events);
      return;
    }
    this.send(queued.kind, queued.width, queued.height, queued.data);
  }

  resize(width: number, height: number): void {
    if (width <= 0 || height <= 0) return;
    if (!this.pendingRequestId) {
      this.size = { width, height };
      return;
    }
    this.send("resize", width, height);
  }

  input(data: string, width: number, height: number): void {
    const chunks: string[] = [];
    if (data.length === 0) chunks.push("");
    for (let offset = 0; offset < data.length; offset += REMOTE_UI_MAX_LINE_LENGTH) {
      chunks.push(data.slice(offset, offset + REMOTE_UI_MAX_LINE_LENGTH));
    }
    if (!this.pendingRequestId) {
      for (const chunk of chunks) this.queueInput({ kind: "input", data: chunk, width, height });
      return;
    }
    this.send("input", width, height, chunks.shift()!);
    for (const chunk of chunks) this.queueInput({ kind: "input", data: chunk, width, height });
  }

  setEditorText(text: string, width: number, height: number): void {
    this.editorText = text;
    if (!this.pendingRequestId) {
      // Only the newest unsent absolute text replacement matters; raw key events retain order.
      for (let i = this.queuedInputs.length - 1; i >= 0; i--) {
        if (this.queuedInputs[i]!.kind === "setText") this.queuedInputs.splice(i, 1);
      }
      this.queueInput({ kind: "setText", data: text, width, height });
      return;
    }
    this.send("setText", width, height, text);
  }

  private queueInput(input: { kind: "input" | "setText"; data: string; width: number; height: number }): void {
    // A bounded FIFO preserves normal typing across network round trips without unbounded
    // memory growth if a surface stops answering entirely.
    if (this.queuedInputs.length >= 1024) this.queuedInputs.shift();
    this.queuedInputs.push(input);
  }

  localDisposed(): void {
    if (this.remoteClosing) return;
    this.send("close", Math.max(1, this.size.width || 80), Math.max(1, this.size.height || 24));
    this.manager.forget(this.frame.surfaceId);
  }

  closeFromRemote(): void {
    this.remoteClosing = true;
    this.pendingRequestId = null;
    this.manager.unmount(this);
  }

  private send(
    kind: RemoteUiInput["kind"],
    width: number,
    height: number,
    data?: string,
    events?: string[],
  ): void {
    const id = this.pendingRequestId;
    if (!id) return;
    this.pendingRequestId = null;
    const input: RemoteUiInput = {
      v: REMOTE_UI_PROTOCOL_VERSION,
      kind,
      surfaceId: this.frame.surfaceId,
      sequence: ++this.inputSequence,
      width: Math.max(1, Math.min(1000, Math.floor(width))),
      height: Math.max(1, Math.min(1000, Math.floor(height))),
      ...(data !== undefined ? { data } : {}),
      ...(events?.length ? { events } : {}),
    };
    this.manager.respond(id, input);
  }
}

export class RemoteUiBridge {
  private readonly surfaces = new Map<string, RemoteSurface>();
  private readonly slots = new Map<string, string>();
  private ui: HostUiContext | null = null;
  private disposed = false;
  private warnedUnavailable = false;
  private activeContextRevision = 0;
  private readonly offUiBound: () => void;
  private readonly offLifecycle: () => void;

  constructor(
    private readonly rpc: RpcClientBase,
    private readonly bridge: HostBridge,
  ) {
    this.offUiBound = bridge.onEveryUiBound((ui) => {
      if (this.ui && this.ui !== ui) {
        // InteractiveMode clears extension-owned components during session replacement.
        // Release the old local mounts without closing the still-live remote surfaces, then
        // mount their latest snapshots into the fresh context.
        for (const surface of this.surfaces.values()) {
          if (!surface.mounted) continue;
          surface.remoteClosing = true;
          this.unmount(surface);
          surface.remoteClosing = false;
          surface.mounted = false;
        }
      }
      this.ui = ui;
      for (const surface of this.surfaces.values()) this.mount(surface);
    });
    this.offLifecycle = rpc.onLifecycleInvalidated(() => {
      // Transport replacement may also mean a different pod. Context revisions are scoped to
      // one Pi process, so discard both the old namespace and mounts before replay/attach.
      this.activeContextRevision = 0;
      this.reset();
    });
  }

  /** Intercept reserved input/notify requests before ordinary extension UI dispatch. */
  consumeExtensionRequest(request: RemoteUiExtensionRequest): boolean {
    const encoded =
      request.method === "input" && request.title?.startsWith(REMOTE_UI_INPUT_PREFIX)
        ? request.title.slice(REMOTE_UI_INPUT_PREFIX.length)
        : request.method === "notify" && request.message?.startsWith(REMOTE_UI_NOTIFICATION_PREFIX)
          ? request.message.slice(REMOTE_UI_NOTIFICATION_PREFIX.length)
          : null;
    if (encoded === null) return false;

    const frame = decodeRemoteUiPayload(encoded) as RemoteUiFrame | null;
    if (!frame || frame.v !== REMOTE_UI_PROTOCOL_VERSION) {
      if (request.method === "input") {
        this.rpc.respondExtensionUi({ type: "extension_ui_response", id: request.id, cancelled: true });
      }
      return true;
    }
    if (frame.contextRevision !== undefined) {
      if (frame.contextRevision < this.activeContextRevision) {
        if (request.method === "input") this.respondClose(request.id, frame.kind === "control" ? "stale" : frame.surfaceId);
        return true;
      }
      if (frame.contextRevision > this.activeContextRevision) {
        this.reset();
        this.activeContextRevision = frame.contextRevision;
      }
    }
    if (frame.kind === "control") {
      this.applyControl(frame);
      return true;
    }
    if (frame.kind === "close") {
      this.surfaces.get(frame.surfaceId)?.closeFromRemote();
      this.forget(frame.surfaceId);
      return true;
    }

    let surface = this.surfaces.get(frame.surfaceId);
    if (!surface) {
      if (this.surfaces.size >= REMOTE_UI_MAX_SURFACES) {
        if (request.method === "input") this.respondClose(request.id, frame.surfaceId);
        return true;
      }
      surface = new RemoteSurface({ ...frame }, this);
      this.surfaces.set(frame.surfaceId, surface);
    }
    surface.apply(frame, request.method === "input" ? request.id : undefined);
    this.mount(surface);
    return true;
  }

  respond(id: string, input: RemoteUiInput): void {
    try {
      this.rpc.respondExtensionUi({
        type: "extension_ui_response",
        id,
        value: REMOTE_UI_INPUT_PREFIX + encodeRemoteUiPayload(input),
      } as never);
    } catch {
      // Recovery replays the still-pending request; retaining the surface is correct.
    }
  }

  forget(surfaceId: string): void {
    this.surfaces.delete(surfaceId);
    for (const [slot, id] of this.slots) if (id === surfaceId) this.slots.delete(slot);
  }

  unmount(surface: RemoteSurface): void {
    const ui = this.ui;
    if (!ui) return;
    switch (surface.frame.role) {
      case "custom":
        surface.component.finish();
        break;
      case "widget":
        if (surface.frame.widgetKey && this.owns(`widget:${surface.frame.widgetKey}`, surface)) {
          ui.setWidget?.(surface.frame.widgetKey, undefined);
        }
        break;
      case "header":
        if (this.owns("header", surface)) ui.setHeader?.(undefined);
        break;
      case "footer":
        if (this.owns("footer", surface)) ui.setFooter?.(undefined);
        break;
      case "editor":
        if (this.owns("editor", surface)) ui.setEditorComponent?.(undefined);
        break;
    }
  }

  reset(): void {
    for (const surface of this.surfaces.values()) {
      surface.remoteClosing = true;
      this.unmount(surface);
    }
    this.surfaces.clear();
    this.slots.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const surface of this.surfaces.values()) surface.localDisposed();
    this.reset();
    this.offUiBound();
    this.offLifecycle();
  }

  private mount(surface: RemoteSurface): void {
    if (surface.mounted || this.disposed || !this.ui) return;
    const ui = this.ui;
    const proxy = surface.component;
    switch (surface.frame.role) {
      case "custom": {
        if (!ui.custom) return this.unavailable(surface);
        surface.mounted = true;
        void ui
          .custom(
            (tui, _theme, _keybindings, done) => proxy.bind(tui as TuiLike, done as Done),
            {
              overlay: surface.frame.overlay,
              ...(surface.frame.overlayOptions ? { overlayOptions: surface.frame.overlayOptions } : {}),
              onHandle: (handle: { focus(): void; unfocus(): void }) => surface.bindLocalHandle(handle),
            },
          )
          .catch(() => surface.localDisposed());
        break;
      }
      case "widget": {
        if (!ui.setWidget || !surface.frame.widgetKey) return this.unavailable(surface);
        surface.mounted = true;
        const slot = `widget:${surface.frame.widgetKey}`;
        this.slots.set(slot, surface.frame.surfaceId);
        ui.setWidget(
          surface.frame.widgetKey,
          (tui) => proxy.bind(tui as TuiLike),
          surface.frame.placement ? { placement: surface.frame.placement } : undefined,
        );
        break;
      }
      case "header":
        if (!ui.setHeader) return this.unavailable(surface);
        surface.mounted = true;
        this.slots.set("header", surface.frame.surfaceId);
        ui.setHeader((tui) => proxy.bind(tui as TuiLike));
        break;
      case "footer":
        if (!ui.setFooter) return this.unavailable(surface);
        surface.mounted = true;
        this.slots.set("footer", surface.frame.surfaceId);
        ui.setFooter((tui) => proxy.bind(tui as TuiLike));
        break;
      case "editor":
        if (!ui.setEditorComponent) return this.unavailable(surface);
        surface.mounted = true;
        this.slots.set("editor", surface.frame.surfaceId);
        ui.setEditorComponent((tui) => proxy.bind(tui as TuiLike));
        break;
    }
  }

  private unavailable(surface: RemoteSurface): void {
    if (!this.warnedUnavailable) {
      this.warnedUnavailable = true;
      this.bridge.notify("This local Pi version cannot mount remote extension components", "warning");
    }
    if (surface.pendingRequestId) this.respondClose(surface.pendingRequestId, surface.frame.surfaceId);
    this.forget(surface.frame.surfaceId);
  }

  private respondClose(id: string, surfaceId: string): void {
    this.respond(id, {
      v: REMOTE_UI_PROTOCOL_VERSION,
      kind: "close",
      surfaceId,
      sequence: 1,
      width: 80,
      height: 24,
    });
  }

  private owns(slot: string, surface: RemoteSurface): boolean {
    return this.slots.get(slot) === surface.frame.surfaceId;
  }

  private applyControl(frame: RemoteUiControlFrame): void {
    const ui = this.ui;
    if (!ui) return;
    switch (frame.action) {
      case "setWorkingMessage":
        ui.setWorkingMessage?.(typeof frame.value === "string" ? frame.value : undefined);
        break;
      case "setWorkingVisible":
        ui.setWorkingVisible?.(Boolean(frame.value));
        break;
      case "setWorkingIndicator":
        ui.setWorkingIndicator?.(frame.value);
        break;
      case "setHiddenThinkingLabel":
        ui.setHiddenThinkingLabel?.(typeof frame.value === "string" ? frame.value : undefined);
        break;
      case "setToolsExpanded":
        ui.setToolsExpanded?.(Boolean(frame.value));
        break;
    }
  }
}

function sanitizeLines(lines: string[]): string[] {
  return lines.slice(0, REMOTE_UI_MAX_LINES).map((line) => sanitizeLine(String(line)));
}

function sanitizeLine(line: string): string {
  const cursorMarker = "\x1b_pi:c\x07";
  let safe = "";
  for (let i = 0; i < line.length && safe.length < REMOTE_UI_MAX_LINE_LENGTH; ) {
    const code = line.charCodeAt(i);
    if (code !== 0x1b) {
      // Keep printable text and tabs; component lines must not carry raw terminal controls.
      if (code === 0x09 || (code >= 0x20 && code !== 0x7f)) safe += line[i];
      i += 1;
      continue;
    }
    if (line.startsWith(cursorMarker, i)) {
      if (safe.length + cursorMarker.length <= REMOTE_UI_MAX_LINE_LENGTH) safe += cursorMarker;
      i += cursorMarker.length;
      continue;
    }
    if (line[i + 1] === "[") {
      let end = i + 2;
      while (end < line.length && !(line.charCodeAt(end) >= 0x40 && line.charCodeAt(end) <= 0x7e)) end += 1;
      if (end < line.length) {
        const sequence = line.slice(i, end + 1);
        if (line[end] === "m" && /^\x1b\[[0-9;:]*m$/.test(sequence) && safe.length + sequence.length <= REMOTE_UI_MAX_LINE_LENGTH) {
          safe += sequence;
        }
        i = end + 1;
        continue;
      }
      break;
    }
    if (line[i + 1] === "]" || line[i + 1] === "P" || line[i + 1] === "_" || line[i + 1] === "^" || line[i + 1] === "X") {
      let end = i + 2;
      while (end < line.length && line.charCodeAt(end) !== 0x07 && !(line[end] === "\\" && line.charCodeAt(end - 1) === 0x1b)) end += 1;
      i = Math.min(line.length, end + 1);
      continue;
    }
    // Drop a complete ESC sequence (RIS, save/restore cursor, index, charset, etc.).
    let end = i + 1;
    while (end < line.length && line.charCodeAt(end) >= 0x20 && line.charCodeAt(end) <= 0x2f) end += 1;
    if (end < line.length && line.charCodeAt(end) >= 0x30 && line.charCodeAt(end) <= 0x7e) end += 1;
    i = Math.max(i + 1, end);
  }
  return safe;
}
