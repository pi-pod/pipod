import {
  REMOTE_UI_INPUT_PREFIX,
  REMOTE_UI_INSTALL_SYMBOL,
  REMOTE_UI_MAX_ENCODED_BYTES,
  REMOTE_UI_MAX_LINE_LENGTH,
  REMOTE_UI_MAX_LINES,
  REMOTE_UI_MAX_SURFACES,
  REMOTE_UI_NOTIFICATION_PREFIX,
  REMOTE_UI_PROTOCOL_VERSION,
} from "../remote-ui-protocol.js";

/**
 * Source injected at module scope into the generated pod extension. It wraps
 * `AgentSession.prototype.bindExtensions` — the documented seam through which Pi hands every
 * extension its one shared ExtensionUIContext — so an RPC-mode bind receives a virtual-TUI
 * context and `mode: "tui"` before any extension can observe either. Patching the exported
 * class rather than transforming Pi's source works identically for bundled and unbundled Pi
 * builds and covers every rebind (session switch, fork, reload) without extra state.
 *
 * The emitted code requires `piPodPiCodingAgent` (a namespace import of
 * `@earendil-works/pi-coding-agent`) in scope; the assembling extension hoists that import
 * to the top of the generated ESM file. A namespace import keeps a missing `AgentSession`
 * export a detectable condition instead of a module-load failure.
 */
export function buildRemoteUiExtensionSource(): string {
  const config = JSON.stringify({
    version: REMOTE_UI_PROTOCOL_VERSION,
    installSymbol: REMOTE_UI_INSTALL_SYMBOL,
    notificationPrefix: REMOTE_UI_NOTIFICATION_PREFIX,
    inputPrefix: REMOTE_UI_INPUT_PREFIX,
    maxEncodedBytes: REMOTE_UI_MAX_ENCODED_BYTES,
    maxSurfaces: REMOTE_UI_MAX_SURFACES,
    maxLines: REMOTE_UI_MAX_LINES,
    maxLineLength: REMOTE_UI_MAX_LINE_LENGTH,
  });

  return String.raw`
// --- generalized remote extension UI ----------------------------------------
// Component factories stay in the pod. This adapter supplies a virtual public TUI, renders
// components to lines, and carries only frames/input over Pi's existing extension UI channel.
const REMOTE_UI_CONFIG = ${config};
const REMOTE_UI_INSTALLED_KEY = Symbol.for(REMOTE_UI_CONFIG.installSymbol);
const REMOTE_UI_STATE_KEY = Symbol.for(REMOTE_UI_CONFIG.installSymbol + ".state");

function installRemoteExtensionUi(ui) {
  if (!ui || ui.__piPodRemoteUiVersion === REMOTE_UI_CONFIG.version) return ui;
  const previousState = globalThis[REMOTE_UI_STATE_KEY];
  const contextRevision = (previousState?.contextRevision || 0) + 1;
  previousState?.closeAll?.();

  const base = {
    input: typeof ui.input === "function" ? ui.input.bind(ui) : async () => undefined,
    notify: typeof ui.notify === "function" ? ui.notify.bind(ui) : () => {},
    setWidget: typeof ui.setWidget === "function" ? ui.setWidget.bind(ui) : () => {},
    setStatus: typeof ui.setStatus === "function" ? ui.setStatus.bind(ui) : () => {},
    setTitle: typeof ui.setTitle === "function" ? ui.setTitle.bind(ui) : () => {},
  };
  const surfaces = new Map();
  const statuses = new Map();
  let nextSurfaceId = 0;

  const encode = (value) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const decode = (value) => {
    if (typeof value !== "string" || !value.startsWith(REMOTE_UI_CONFIG.inputPrefix)) return null;
    const encoded = value.slice(REMOTE_UI_CONFIG.inputPrefix.length);
    if (!encoded || Buffer.byteLength(encoded, "utf8") > REMOTE_UI_CONFIG.maxEncodedBytes || !/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
    try {
      const bytes = Buffer.from(encoded, "base64url");
      if (bytes.toString("base64url") !== encoded) return null;
      const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      return parsed && parsed.v === REMOTE_UI_CONFIG.version ? parsed : null;
    } catch {
      return null;
    }
  };
  const boundedLines = (lines) => {
    if (!Array.isArray(lines)) return ["[remote extension returned an invalid render result]"];
    return lines.slice(0, REMOTE_UI_CONFIG.maxLines).map((line) => String(line).slice(0, REMOTE_UI_CONFIG.maxLineLength));
  };
  const safeOverlayOptions = (options) => {
    if (!options || typeof options !== "object") return undefined;
    const allowed = ["width", "minWidth", "maxHeight", "anchor", "offsetX", "offsetY", "row", "col", "margin", "nonCapturing"];
    const result = {};
    for (const key of allowed) if (options[key] !== undefined && typeof options[key] !== "function") result[key] = options[key];
    return result;
  };
  const encodeFrame = (frame) => {
    frame = { ...frame, contextRevision };
    let encoded = encode(frame);
    if (Buffer.byteLength(encoded, "utf8") <= REMOTE_UI_CONFIG.maxEncodedBytes) return encoded;
    const fallback = frame.surfaceId
      ? { ...frame, lines: ["[remote extension UI exceeded the frame-size limit]"], error: "remote UI frame too large" }
      : { v: REMOTE_UI_CONFIG.version, kind: "control", action: frame.action, contextRevision };
    encoded = encode(fallback);
    return Buffer.byteLength(encoded, "utf8") <= REMOTE_UI_CONFIG.maxEncodedBytes ? encoded : null;
  };
  const emit = (frame) => {
    let encoded;
    try { encoded = encodeFrame(frame); } catch { return; }
    if (encoded) base.notify(REMOTE_UI_CONFIG.notificationPrefix + encoded);
  };
  const emitControl = (action, value) => emit({ v: REMOTE_UI_CONFIG.version, kind: "control", action, value });

  const keyMap = {
    "tui.select.up": ["\u001b[A"],
    "tui.select.down": ["\u001b[B"],
    "tui.select.pageUp": ["\u001b[5~"],
    "tui.select.pageDown": ["\u001b[6~"],
    "tui.select.confirm": ["\r", "\n"],
    "tui.select.cancel": ["\u001b", "\u0003"],
    "tui.input.submit": ["\r", "\n"],
    "tui.input.tab": ["\t"],
    "tui.input.copy": ["\u0003"],
    "tui.input.newLine": ["\u000a"],
    "tui.editor.cursorUp": ["\u001b[A"],
    "tui.editor.cursorDown": ["\u001b[B"],
    "tui.editor.cursorLeft": ["\u001b[D", "\u0002"],
    "tui.editor.cursorRight": ["\u001b[C", "\u0006"],
    "tui.editor.cursorLineStart": ["\u001b[H", "\u0001"],
    "tui.editor.cursorLineEnd": ["\u001b[F", "\u0005"],
    "tui.editor.deleteCharBackward": ["\u007f", "\b"],
    "tui.editor.deleteCharForward": ["\u001b[3~", "\u0004"],
    "tui.editor.deleteWordBackward": ["\u0017"],
    "tui.editor.deleteWordForward": ["\u001bd"],
    "tui.editor.deleteToLineStart": ["\u0015"],
    "tui.editor.deleteToLineEnd": ["\u000b"],
    "tui.editor.yank": ["\u0019"],
    "tui.editor.undo": ["\u001f"],
  };
  const keybindings = {
    matches: (data, action) => (keyMap[action] || []).includes(data),
    getKeys: (action) => [...(keyMap[action] || [])],
    getDefinition: (action) => ({ defaultKeys: keyMap[action] || [], description: action }),
    getConflicts: () => [],
    getUserBindings: () => ({}),
    getResolvedBindings: () => ({}),
    setUserBindings: () => {},
  };

  class RemoteVirtualTui {
    constructor(surface) {
      this.surface = surface;
      this.focusedComponent = null;
      this.inputListeners = new Set();
      this.overlays = [];
      this.terminal = {
        start() {}, stop() {}, drainInput: async () => {}, write() {}, moveBy() {}, hideCursor() {}, showCursor() {},
        clearLine() {}, clearFromCursor() {}, clearScreen() {}, setProgress() {},
        setTitle: (title) => base.setTitle(String(title)),
        get columns() { return surface.width; },
        get rows() { return surface.height; },
        get kittyProtocolActive() { return false; },
      };
    }
    setFocus(component) {
      if (this.focusedComponent && "focused" in this.focusedComponent) this.focusedComponent.focused = false;
      this.focusedComponent = component || null;
      if (this.focusedComponent && "focused" in this.focusedComponent) this.focusedComponent.focused = true;
      this.requestRender();
    }
    addInputListener(listener) { this.inputListeners.add(listener); return () => this.inputListeners.delete(listener); }
    removeInputListener(listener) { this.inputListeners.delete(listener); }
    requestRender(force) { this.surface.requestRender(Boolean(force)); }
    invalidate() { this.surface.component?.invalidate?.(); this.requestRender(true); }
    start() {} stop() {}
    showOverlay(component, options) {
      const entry = { component, options: options || {}, hidden: false };
      this.overlays.push(entry);
      if (!entry.options.nonCapturing) this.setFocus(component);
      this.requestRender(true);
      return {
        hide: () => { this.overlays = this.overlays.filter((candidate) => candidate !== entry); this.requestRender(true); },
        setHidden: (hidden) => { entry.hidden = Boolean(hidden); this.requestRender(true); },
        isHidden: () => entry.hidden,
        focus: () => this.setFocus(component),
        unfocus: () => this.setFocus(this.surface.component),
        isFocused: () => this.focusedComponent === component,
      };
    }
    hideOverlay() { const entry = this.overlays.pop(); entry?.component?.dispose?.(); this.setFocus(this.surface.component); }
    hasOverlay() { return this.overlays.some((entry) => !entry.hidden); }
    onTerminalColorSchemeChange() { return () => {}; }
    setTerminalColorSchemeNotifications() {}
    queryTerminalBackgroundColor() { return Promise.resolve(undefined); }
    dispatchInput(data) {
      let next = data;
      for (const listener of this.inputListeners) {
        const result = listener(next);
        if (result?.consume) return;
        if (typeof result?.data === "string") next = result.data;
      }
      const target = [...this.overlays].reverse().find((entry) => !entry.hidden)?.component || this.focusedComponent || this.surface.component;
      target?.handleInput?.(next);
    }
  }

  class RemoteSurface {
    constructor(role, metadata) {
      this.id = "surface-" + Date.now().toString(36) + "-" + (++nextSurfaceId).toString(36);
      this.role = role;
      this.metadata = metadata || {};
      this.width = 80;
      this.height = 24;
      this.revision = 0;
      this.sequence = 0;
      this.component = null;
      this.closed = false;
      this.finished = false;
      this.result = undefined;
      this.editorSubmit = undefined;
      this.editorSubmitSequence = 0;
      this.renderTimer = null;
      this.controller = new AbortController();
      this.tui = new RemoteVirtualTui(this);
    }
    frame(kind) {
      let lines = [];
      let error;
      try { lines = boundedLines(this.renderComponent()); }
      catch (cause) { error = cause instanceof Error ? cause.message : String(cause); lines = ["[remote extension UI failed: " + error + "]"]; }
      const editorSubmit = this.editorSubmit;
      this.editorSubmit = undefined;
      return {
        v: REMOTE_UI_CONFIG.version,
        kind,
        surfaceId: this.id,
        revision: ++this.revision,
        role: this.role,
        lines,
        ...(this.role === "editor" && typeof this.component?.getText === "function"
          ? { editorText: String(this.component.getText()) } : {}),
        ...(editorSubmit !== undefined
          ? { editorSubmit: editorSubmit.text, editorSubmitId: editorSubmit.id } : {}),
        ...this.metadata,
        ...(error ? { error: error.slice(0, 1024) } : {}),
      };
    }
    renderComponent() {
      const overlay = [...this.tui.overlays].reverse().find((entry) => !entry.hidden);
      return (overlay?.component || this.component)?.render?.(Math.max(1, this.width)) || [];
    }
    requestRender(force) {
      if (this.closed) return;
      if (force && this.renderTimer) { clearTimeout(this.renderTimer); this.renderTimer = null; }
      if (this.renderTimer) return;
      this.renderTimer = setTimeout(() => {
        this.renderTimer = null;
        if (!this.closed && this.component) emit(this.frame("frame"));
      }, force ? 0 : 16);
    }
    finish(value) {
      if (this.finished) return;
      this.finished = true;
      this.result = value;
      this.controller.abort();
    }
    close() {
      if (this.closed) return;
      this.closed = true;
      this.controller.abort();
      if (this.renderTimer) clearTimeout(this.renderTimer);
      this.renderTimer = null;
      try { this.component?.dispose?.(); } catch {}
      for (const entry of this.tui.overlays) { try { entry.component?.dispose?.(); } catch {} }
      this.tui.overlays = [];
      surfaces.delete(this.id);
      emit({ v: REMOTE_UI_CONFIG.version, kind: "close", surfaceId: this.id, revision: ++this.revision, role: this.role, ...this.metadata });
    }
    async run(factory, factoryArgs) {
      if (surfaces.size >= REMOTE_UI_CONFIG.maxSurfaces) throw new Error("too many remote extension UI surfaces");
      surfaces.set(this.id, this);
      try {
        this.component = await factory(this.tui, ...factoryArgs, (value) => this.finish(value));
        if (!this.component || typeof this.component.render !== "function") throw new Error("extension UI factory did not return a component");
        if (this.role === "editor") {
          this.component.onSubmit = (text) => {
            this.editorSubmit = { id: ++this.editorSubmitSequence, text: String(text) };
            this.requestRender(true);
          };
          this.component.onChange = () => this.requestRender();
        }
        this.tui.setFocus(this.component);
        let first = true;
        while (!this.closed && !this.finished) {
          const request = this.frame(first ? "open" : "frame");
          first = false;
          const encodedRequest = encodeFrame(request);
          if (!encodedRequest) throw new Error("remote UI request exceeded the frame-size limit");
          const title = REMOTE_UI_CONFIG.inputPrefix + encodedRequest;
          const value = await base.input(title, undefined, { signal: this.controller.signal });
          if (this.finished || this.closed) break;
          const event = decode(value);
          if (!event || event.surfaceId !== this.id) { this.finish(undefined); break; }
          if (Number.isInteger(event.width) && event.width > 0 && event.width <= 1000) this.width = event.width;
          if (Number.isInteger(event.height) && event.height > 0 && event.height <= 1000) this.height = event.height;
          if (event.kind === "close") { this.finish(undefined); break; }
          if (event.kind === "input") {
            const inputEvents = Array.isArray(event.events) ? event.events : [event.data];
            for (const input of inputEvents) if (typeof input === "string") this.tui.dispatchInput(input);
          }
          if (event.kind === "setText" && typeof event.data === "string" && typeof this.component?.setText === "function") {
            this.component.setText(event.data);
          }
          // Pi never invalidates a mounted component per event — its components cache by width and
          // re-render on their own. Doing it here makes extensions that read invalidate() as "you were
          // unmounted" re-register on every event, tearing the surface down and rebuilding it.
        }
        return this.result;
      } finally {
        this.close();
      }
    }
  }

  const persistent = new Map();
  const replacePersistent = (slot, role, factory, metadata, factoryArgs) => {
    persistent.get(slot)?.finish(undefined);
    persistent.delete(slot);
    if (typeof factory !== "function") return;
    const surface = new RemoteSurface(role, metadata);
    persistent.set(slot, surface);
    void surface.run(factory, factoryArgs).catch(() => {}).finally(() => {
      if (persistent.get(slot) === surface) persistent.delete(slot);
    });
  };

  // Pi wraps the bound UI context with an object spread before command handlers see it.
  // Keep the marker enumerable so that wrapper preserves the RPC-origin proof even though
  // this adapter deliberately exposes mode "tui" for component-capable pod extensions.
  Object.defineProperty(ui, "__piPodRemoteUiVersion", { value: REMOTE_UI_CONFIG.version, enumerable: true });
  ui.custom = async (factory, options) => {
    const overlayOptions = typeof options?.overlayOptions === "function" ? options.overlayOptions() : options?.overlayOptions;
    const surface = new RemoteSurface("custom", {
      overlay: Boolean(options?.overlay),
      ...(overlayOptions ? { overlayOptions: safeOverlayOptions(overlayOptions) } : {}),
    });
    let handle;
    if (typeof options?.onHandle === "function") {
      // Focus is mirrored through frame metadata: the client replays it onto its local
      // overlay handle. Without this, a non-capturing overlay could never receive input,
      // because handle.focus() here acts on the pod, not on the terminal the user types in.
      const setFocused = (value) => {
        if (surface.metadata.focused === value) return;
        surface.metadata.focused = value;
        surface.requestRender(true);
      };
      handle = {
        hide: () => surface.finish(undefined), setHidden: () => {}, isHidden: () => false,
        focus: () => setFocused(true),
        unfocus: () => setFocused(false),
        isFocused: () => surface.metadata.focused === true,
      };
      options.onHandle(handle);
    }
    return surface.run(factory, [ui.theme, keybindings]);
  };
  ui.setWidget = (key, content, options) => {
    if (content === undefined || Array.isArray(content)) {
      persistent.get("widget:" + key)?.finish(undefined);
      persistent.delete("widget:" + key);
      base.setWidget(key, content, options);
      return;
    }
    replacePersistent("widget:" + key, "widget", content, {
      widgetKey: String(key), placement: options?.placement === "belowEditor" ? "belowEditor" : "aboveEditor",
    }, [ui.theme]);
  };
  ui.setHeader = (factory) => replacePersistent("header", "header", factory, {}, [ui.theme]);
  ui.setFooter = (factory) => {
    const footerData = {
      getGitBranch: () => null,
      getExtensionStatuses: () => new Map(statuses),
      getAvailableProviderCount: () => 0,
      onBranchChange: () => () => {},
    };
    replacePersistent("footer", "footer", factory, {}, [ui.theme, footerData]);
  };
  ui.setEditorComponent = (factory) => {
    const selectList = {
      selectedPrefix: (text) => ui.theme.fg("accent", text),
      selectedText: (text) => ui.theme.fg("accent", text),
      description: (text) => ui.theme.fg("muted", text),
      scrollInfo: (text) => ui.theme.fg("muted", text),
      noMatch: (text) => ui.theme.fg("muted", text),
    };
    const editorTheme = { borderColor: (text) => ui.theme.fg("borderMuted", text), selectList };
    replacePersistent("editor", "editor", factory, {}, [editorTheme, keybindings]);
  };
  ui.setStatus = (key, text) => {
    if (text === undefined) statuses.delete(key); else statuses.set(key, text);
    base.setStatus(key, text);
    persistent.get("footer")?.requestRender();
  };
  ui.setWorkingMessage = (value) => emitControl("setWorkingMessage", value);
  ui.setWorkingVisible = (value) => emitControl("setWorkingVisible", Boolean(value));
  ui.setWorkingIndicator = (value) => emitControl("setWorkingIndicator", value);
  ui.setHiddenThinkingLabel = (value) => emitControl("setHiddenThinkingLabel", value);
  ui.setToolsExpanded = (value) => emitControl("setToolsExpanded", Boolean(value));
  ui.getToolsExpanded = () => false;
  globalThis[REMOTE_UI_STATE_KEY] = {
    contextRevision,
    closeAll: () => {
      for (const surface of [...surfaces.values()]) surface.finish(undefined);
    },
  };
  return ui;
}

// Extensions load before the first bind, and jiti resolves this import to the running Pi's
// own module instance, so this wrap intercepts the exact uiContext RPC mode is about to
// bind. Guarded per process: a reloaded extension module must not re-wrap the wrap.
if (globalThis[REMOTE_UI_INSTALLED_KEY] !== REMOTE_UI_CONFIG.version) {
  const remoteUiAgentSession = piPodPiCodingAgent.AgentSession;
  const remoteUiProto = typeof remoteUiAgentSession === "function" ? remoteUiAgentSession.prototype : undefined;
  const originalBindExtensions = remoteUiProto?.bindExtensions;
  if (typeof originalBindExtensions === "function") {
    remoteUiProto.bindExtensions = function (bindings) {
      if (!bindings || bindings.mode !== "rpc" || !bindings.uiContext) {
        return originalBindExtensions.call(this, bindings);
      }
      return originalBindExtensions.call(this, {
        ...bindings,
        mode: "tui",
        uiContext: installRemoteExtensionUi(bindings.uiContext),
      });
    };
    globalThis[REMOTE_UI_INSTALLED_KEY] = REMOTE_UI_CONFIG.version;
  }
}
`;
}
