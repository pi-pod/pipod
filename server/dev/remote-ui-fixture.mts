/**
 * dev/remote-ui-fixture.mts — a scripted stand-in for a pod extension that owns TUI
 * surfaces, for manual and driven testing of remote extension UI without a real pod.
 *
 * It speaks the same wire format the injected pod extension does (frames over
 * `extension_ui_request`, input over `extension_ui_response`), so the gateway classifies,
 * caches, fans out and replays these frames exactly as it would real ones. Every role is
 * represented, one surface animates, the editor exercises editorSubmit, and the overlay
 * mirrors focus.
 *
 * Drive it from a session by prompting `REMOTEUI` (and `REMOTEUICLOSE` to tear it down).
 */
import {
  REMOTE_UI_INPUT_PREFIX,
  REMOTE_UI_NOTIFICATION_PREFIX,
  REMOTE_UI_PROTOCOL_VERSION,
  encodeRemoteUiPayload,
  remoteUiInputFromResponse,
  type RemoteUiRole,
  type RemoteUiSurfaceFrame,
} from "../src/core/remote-ui-protocol.js";

const CONTEXT_REVISION = 1;
const OPTIONS = ["Staging", "Production", "Canary"] as const;

const bold = (text: string) => `\u001b[1m${text}\u001b[0m`;
const dim = (text: string) => `\u001b[2m${text}\u001b[0m`;
const color = (index: number, text: string) => `\u001b[38;5;${index}m${text}\u001b[0m`;
const inverse = (text: string) => `\u001b[7m${text}\u001b[0m`;

interface FixtureSurface {
  id: string;
  role: RemoteUiRole;
  metadata: Record<string, unknown>;
  revision: number;
  requestId: string | null;
  width: number;
  height: number;
  render(): string[];
  input?(data: string): void;
  setText?(text: string): void;
  takeEditorFields?(): Record<string, unknown>;
}

export class RemoteUiFixture {
  private readonly surfaces = new Map<string, FixtureSurface>();
  private timer: NodeJS.Timeout | null = null;
  private nextId = 0;
  private tick = 0;
  private stopping = false;
  private selected = 0;
  private editorText = "";
  private editorSubmitId = 0;
  private pendingEditorSubmit: string | null = null;

  constructor(private readonly emit: (event: unknown) => void) {}

  get isRunning(): boolean {
    return this.surfaces.size > 0;
  }

  /** Restarts from a clean slate so a manual run always begins in a known state. */
  start(): void {
    if (this.isRunning) this.stop();
    this.selected = 0;
    this.tick = 0;
    this.editorText = "";
    this.editorSubmitId = 0;
    this.pendingEditorSubmit = null;
    this.open("header", {}, () => [
      `${color(39, bold(" pi pod remote UI fixture "))} ${dim("header surface")}`,
    ]);
    this.open("footer", {}, () => [
      dim(`footer · frame ${this.tick} · ${OPTIONS[this.selected]}`),
    ]);
    this.open("widget", { widgetKey: "fixture-counter", placement: "aboveEditor" }, () => [
      `${color(213, "▍")} ${bold("aboveEditor widget")} ${dim(`repaint ${this.tick}`)}`,
      `  ${color(48, "▁▂▃▄▅▆▇█".slice(0, 1 + (this.tick % 8)))}`,
    ]);
    this.open("widget", { widgetKey: "fixture-status", placement: "belowEditor" }, () => [
      `${color(208, "●")} belowEditor widget · ${dim("selection:")} ${OPTIONS[this.selected]}`,
    ]);
    this.open(
      "editor",
      {},
      () => [
        `${color(39, "❯")} ${this.editorText || dim("type here, enter submits")}`,
        dim(`  ${this.editorText.length} characters · submit #${this.editorSubmitId}`),
      ],
      {
        setText: (text: string) => {
          this.editorText = text;
        },
        input: (data: string) => {
          if (data === "\r" || data === "\n") {
            this.pendingEditorSubmit = this.editorText;
            this.editorSubmitId += 1;
            this.editorText = "";
            return;
          }
          if (data === "\u007f") this.editorText = this.editorText.slice(0, -1);
          else if (!data.startsWith("\u001b") && data >= " ") this.editorText += data;
        },
        takeEditorFields: () => {
          const submit = this.pendingEditorSubmit;
          this.pendingEditorSubmit = null;
          return {
            editorText: this.editorText,
            ...(submit === null ? {} : { editorSubmit: submit, editorSubmitId: this.editorSubmitId }),
          };
        },
      },
    );
    this.open(
      "custom",
      {
        overlay: true,
        overlayOptions: { width: "60%", maxHeight: "50%", anchor: "center", margin: 1 },
        focused: true,
      },
      () => [
        bold("Where should this deploy?"),
        "",
        ...OPTIONS.map((option, index) =>
          index === this.selected ? inverse(` ❯ ${option} `) : `   ${option}`,
        ),
        "",
        dim("↑/↓ choose · enter confirm · esc dismiss"),
      ],
      {
        input: (data: string) => {
          if (data === "\u001b[A") this.selected = (this.selected + OPTIONS.length - 1) % OPTIONS.length;
          else if (data === "\u001b[B") this.selected = (this.selected + 1) % OPTIONS.length;
          else if (data === "\r" || data === "\u001b") this.closeOverlay();
        },
      },
    );

    this.control("setWorkingVisible", true);
    this.control("setWorkingMessage", "Fixture surfaces are live");
    this.control("setToolsExpanded", true);
    this.control("setHiddenThinkingLabel", "Fixture is thinking");

    // A component that repaints on a timer is the load case the app has to
    // survive: the gateway caches, and the client coalesces.
    this.timer = setInterval(() => {
      this.tick += 1;
      for (const surface of this.surfaces.values()) {
        if (surface.role === "custom" || surface.role === "editor") continue;
        this.notify(surface);
      }
    }, 1000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.stopping) return;
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const surface of [...this.surfaces.values()]) this.close(surface);
    this.stopping = false;
    this.control("setWorkingVisible", false);
    this.control("setToolsExpanded", false);
    this.control("setHiddenThinkingLabel", undefined);
  }

  /** Returns true when the response was remote-UI input this fixture owns. */
  handleResponse(response: { id?: string; value?: unknown }): boolean {
    const input = remoteUiInputFromResponse(response);
    if (!input) return false;
    const surface = this.surfaces.get(input.surfaceId);
    if (!surface || surface.requestId !== response.id) return true;
    surface.requestId = null;
    if (input.width > 0) surface.width = input.width;
    if (input.height > 0) surface.height = input.height;
    if (input.kind === "close") {
      this.close(surface);
      return true;
    }
    if (input.kind === "input") {
      for (const data of input.events ?? (input.data === undefined ? [] : [input.data])) {
        surface.input?.(data);
      }
    }
    if (input.kind === "setText" && typeof input.data === "string") surface.setText?.(input.data);
    if (this.surfaces.has(surface.id)) this.request(surface, "frame");
    return true;
  }

  private open(
    role: RemoteUiRole,
    metadata: Record<string, unknown>,
    render: () => string[],
    handlers: Partial<Pick<FixtureSurface, "input" | "setText" | "takeEditorFields">> = {},
  ): void {
    const surface: FixtureSurface = {
      id: `fixture-${role}-${++this.nextId}`,
      role,
      metadata,
      revision: 0,
      requestId: null,
      width: 80,
      height: 24,
      render,
      ...handlers,
    };
    this.surfaces.set(surface.id, surface);
    this.request(surface, "open");
  }

  private closeOverlay(): void {
    for (const surface of [...this.surfaces.values()]) {
      if (surface.role === "custom") this.close(surface);
    }
  }

  private close(surface: FixtureSurface): void {
    this.surfaces.delete(surface.id);
    this.emit({
      type: "extension_ui_request",
      method: "notify",
      message: REMOTE_UI_NOTIFICATION_PREFIX + encodeRemoteUiPayload(this.frame(surface, "close")),
    });
    if (this.surfaces.size === 0) this.stop();
  }

  /** The blocking half of the loop: a frame the client may answer with input. */
  private request(surface: FixtureSurface, kind: "open" | "frame"): void {
    surface.requestId = `remote-ui-${surface.id}-${surface.revision + 1}`;
    this.emit({
      type: "extension_ui_request",
      id: surface.requestId,
      method: "input",
      title: REMOTE_UI_INPUT_PREFIX + encodeRemoteUiPayload(this.frame(surface, kind)),
    });
  }

  /** A repaint nobody has to answer. */
  private notify(surface: FixtureSurface): void {
    this.emit({
      type: "extension_ui_request",
      method: "notify",
      message: REMOTE_UI_NOTIFICATION_PREFIX + encodeRemoteUiPayload(this.frame(surface, "frame")),
    });
  }

  private frame(surface: FixtureSurface, kind: "open" | "frame" | "close"): RemoteUiSurfaceFrame {
    return {
      v: REMOTE_UI_PROTOCOL_VERSION,
      kind,
      surfaceId: surface.id,
      revision: ++surface.revision,
      role: surface.role,
      contextRevision: CONTEXT_REVISION,
      lines: kind === "close" ? [] : surface.render(),
      ...surface.metadata,
      ...(surface.takeEditorFields?.() ?? {}),
    } as RemoteUiSurfaceFrame;
  }

  private control(action: string, value: unknown): void {
    this.emit({
      type: "extension_ui_request",
      method: "notify",
      message:
        REMOTE_UI_NOTIFICATION_PREFIX +
        encodeRemoteUiPayload({
          v: REMOTE_UI_PROTOCOL_VERSION,
          kind: "control",
          contextRevision: CONTEXT_REVISION,
          action,
          value,
        } as never),
    });
  }
}
