/**
 * src/shim/echo-beacon.ts — the pod-side echo beacon for the remote TUI (§5.7).
 *
 * The remote TUI's one ergonomic cost is typing latency: every keystroke round-trips to the
 * pod before its echo comes back. The fix is mosh-style speculative local echo — the launcher
 * draws the typed character immediately and reconciles when the real repaint arrives — but
 * blind prediction against a full-screen TUI mispredicts whenever the composer is not the
 * thing consuming keys. This extension is the "pi-assisted" half: running inside pi, it knows
 * the truth and beacons it to the launcher after every frame.
 *
 * It works because pi-tui already parks the (hidden) hardware cursor at the focused
 * component's text cursor after every frame, for IME candidate-window positioning. So when a
 * frame ends, the real terminal cursor sits exactly where the next typed character will
 * appear — the launcher needs no coordinates, only permission. The beacon appends a private
 * OSC sequence after each frame's cursor parking:
 *
 *   ESC ] 7777 ; b=<bytes> ; f=<0|1> ; c=<col> BEL
 *
 *   b  cumulative stdin bytes this pi has received since the beacon installed — the
 *      launcher's confirmation clock: predictions made at send-offset <= b are reflected
 *      in the frame that preceded this beacon and must not be redrawn
 *   f  1 when a focused component parked a text cursor this frame and is in a plain
 *      insert state (no jump mode) — i.e. a typed printable character would echo at the
 *      cursor cell; 0 disables prediction
 *   c  the parked cursor's absolute screen column (0-based), for the launcher's
 *      wrap-avoidance guard
 *
 * The launcher strips the OSC before the terminal sees it (src/client/local-echo.ts).
 *
 * Installation grabs the TUI instance through the public `setEditorComponent` factory —
 * which pi invokes synchronously with the live TUI — and immediately restores the previous
 * editor, then patches `positionHardwareCursor` on that one TUI instance. The patch is the
 * only non-public surface touched; the pod's pi version is pinned by the image, and a pi
 * whose internals do not match simply never beacons, which leaves the launcher's prediction
 * disabled rather than wrong.
 */

/** The beacon's private OSC introducer, shared with the launcher-side parser. */
export const ECHO_BEACON_OSC_PREFIX = "\x1b]7777;";

/** Module-scope source composed into the generated extension for a local-echo TUI session. */
export function buildEchoBeaconSource(): string {
  return `/**
 * A throwaway editor stand-in: setEditorComponent invokes the factory synchronously and the
 * previous editor is restored on the next line, so this only needs to survive the wiring
 * that setCustomEditorComponent does between those two calls.
 */
function piPodPlaceholderEditor() {
  return {
    text: "",
    focused: false,
    getText() { return this.text; },
    setText(t) { this.text = String(t); },
    render() { return []; },
    handleInput() {},
    invalidate() {},
  };
}

function installPiPodEchoBeacon(pi) {
  let installed = false;

  // The registration API has no UI surface; the live ui/hasUI getters arrive on the
  // context passed to event handlers. session_start fires on every session (new, resume,
  // fork), and interactive mode starts its UI before extensions initialize.
  const tryInstall = (ctx) => {
    if (installed) return true;
    let hasUI = false;
    try { hasUI = ctx.hasUI === true; } catch { return false; }
    if (!hasUI) return false;

    let tui = null;
    try {
      const ui = ctx.ui;
      // Another extension's custom editor (a vim mode, say) must survive the borrow.
      const previous = ui.getEditorComponent ? ui.getEditorComponent() : undefined;
      ui.setEditorComponent((t) => { tui = t; return piPodPlaceholderEditor(); });
      ui.setEditorComponent(previous);
    } catch { return false; }

    if (
      tui === null ||
      typeof tui.positionHardwareCursor !== "function" ||
      !tui.terminal ||
      typeof tui.terminal.write !== "function"
    ) {
      // A pi whose internals moved: stay silent, and the launcher never predicts.
      installed = true;
      return true;
    }

    // Count every stdin byte from here on. The launcher counts what it forwards and
    // resynchronizes its offset on idle beacons, so the baseline may start anywhere —
    // what matters is that from now on both sides advance by exactly the same bytes.
    // Attached only now, when the TUI's own stdin handler already exists, so this
    // passive listener cannot put a pre-TUI stdin into flowing mode and eat input.
    let inputBytes = 0;
    process.stdin.on("data", (chunk) => {
      inputBytes += typeof chunk === "string" ? Buffer.byteLength(chunk, "utf8") : chunk.length;
    });

    let lastF = 0;
    let lastC = 0;
    const emit = () => {
      try {
        tui.terminal.write("\\x1b]7777;b=" + inputBytes + ";f=" + lastF + ";c=" + lastC + "\\x07");
      } catch {
        // Never let the beacon take down a render.
      }
    };

    // tui may be the InteractiveMode's Proxy around the real TuiMainScreen
    // (createInteractiveTuiReference). Capturing via the proxy's get trap
    // returns a wrapper that re-looks up the property on every call, so after
    // patching it would call the patched version again (stack overflow).
    // Read the underlying method directly from the real prototype/instance.
    const proto = Object.getPrototypeOf(tui);
    const desc =
      Object.getOwnPropertyDescriptor(proto, "positionHardwareCursor") ??
      Object.getOwnPropertyDescriptor(tui, "positionHardwareCursor");
    const real = desc?.value ?? tui.positionHardwareCursor;
    const original = Function.prototype.bind.call(real, tui);
    tui.positionHardwareCursor = function patchedPositionHardwareCursor(cursorPos, totalLines) {
      original(cursorPos, totalLines);
      lastF = 0;
      lastC = 0;
      if (cursorPos && typeof cursorPos.col === "number") {
        // A parked cursor means a focused text field. Jump mode is the one editor state
        // where a plain printable key does not insert at the cursor.
        const fc = tui.focusedComponent;
        const jumping = fc !== null && typeof fc === "object" && "jumpMode" in fc && Boolean(fc.jumpMode);
        if (!jumping) {
          lastF = 1;
          lastC = Math.max(0, Math.floor(cursorPos.col));
        }
      }
      emit();
    };

    // Frames only happen when something changes, but the launcher can only anchor its byte
    // clock on a beacon that arrives while the keyboard is quiet — so a quiet session would
    // otherwise never arm. The keepalive repeats the last known state; the launcher knows a
    // beacon with no output in front of it repainted nothing.
    const keepalive = setInterval(emit, 500);
    if (typeof keepalive.unref === "function") keepalive.unref();

    installed = true;
    return true;
  };

  pi.on("session_start", (_event, ctx) => {
    // The short poll covers a UI context that attaches a beat after the event; the cap
    // covers a pi that never grows one (headless), where installing is meaningless.
    if (tryInstall(ctx)) return;
    let attempts = 0;
    const timer = setInterval(() => {
      attempts += 1;
      if (tryInstall(ctx) || attempts >= 100) clearInterval(timer);
    }, 100);
    if (typeof timer.unref === "function") timer.unref();
  });
}
`;
}

/** Standalone form retained for focused executable tests. Production composes the source above. */
export function buildEchoBeaconExtension(): string {
  return `// pi-pod echo beacon — generated by pi-pod; do not edit (see src/shim/echo-beacon.ts)
${buildEchoBeaconSource()}
export default function piPodEchoBeacon(pi) {
  installPiPodEchoBeacon(pi);
}
`;
}
