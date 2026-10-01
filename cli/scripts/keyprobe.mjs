#!/usr/bin/env node
/**
 * scripts/keyprobe.mjs — what does this terminal actually send for a key?
 *
 * The detach chord is matched on the bytes the host terminal produces, and a TUI can change
 * those bytes underneath the launcher: pi pushes the kitty keyboard protocol
 * (`ESC [ > 7 u`) into the *host* terminal and never pops it, after which a terminal that
 * supports it may report ctrl-combinations as `CSI u` escape sequences instead of the C0
 * control byte pi pod is looking for.
 *
 * Injecting bytes into a pty cannot reproduce that — it bypasses the terminal's encoder,
 * which is the thing under test. Only a real keypress in a real terminal answers it.
 *
 * Usage:
 *   node scripts/keyprobe.mjs          # legacy encoding (plain terminal)
 *   node scripts/keyprobe.mjs --kitty  # after enabling kitty mode, as pi leaves it
 */
const KITTY = process.argv.includes("--kitty");

if (!process.stdin.isTTY) {
  console.error("keyprobe needs a real terminal (stdin is not a tty)");
  process.exit(2);
}

const NAMES = new Map([
  [0x1b, "Esc"],
  [0x0d, "Enter / Ctrl-M"],
  [0x09, "Tab / Ctrl-I"],
  [0x7f, "Backspace"],
  [0x03, "Ctrl-C"],
  [0x04, "Ctrl-D"],
  [0x1c, "Ctrl-\\   <-- the default detach prefix"],
  [0x1d, "Ctrl-]"],
  [0x1e, "Ctrl-^"],
  [0x1f, "Ctrl-/ or Ctrl-_"],
]);

function describe(bytes) {
  if (bytes.length === 1) {
    const b = bytes[0];
    if (NAMES.has(b)) return NAMES.get(b);
    if (b < 0x20) return `Ctrl-${String.fromCharCode(b + 0x40)}`;
    return `'${String.fromCharCode(b)}'`;
  }
  // CSI <params> u — the kitty "key as escape code" form.
  const text = Buffer.from(bytes).toString("latin1");
  const m = /^\x1b\[([0-9;:]*)u$/.exec(text);
  if (m) {
    const [keyPart = "", modPart = ""] = m[1].split(";");
    const codepoint = Number(keyPart.split(":")[0]);
    const mods = Number(modPart.split(":")[0] || "1") - 1;
    const held = [
      mods & 1 && "Shift",
      mods & 2 && "Alt",
      mods & 4 && "Ctrl",
      mods & 8 && "Super",
    ].filter(Boolean);
    const key = Number.isFinite(codepoint) ? `'${String.fromCharCode(codepoint)}'` : "?";
    return `CSI-u key event: ${held.join("+") || "no modifiers"} + ${key}  <-- NOT a legacy control byte`;
  }
  if (text.startsWith("\x1b")) return "escape sequence";
  return "multi-byte input";
}

if (KITTY) {
  // Exactly what pi pushes, so the probe reproduces the in-session condition.
  process.stdout.write("\x1b[>7u");
}

process.stdin.setRawMode(true);
process.stdin.resume();

const restore = () => {
  if (KITTY) process.stdout.write("\x1b[<u"); // pop the flags back off
  process.stdin.setRawMode(false);
};

process.stdout.write(
  `keyprobe — ${KITTY ? "kitty keyboard mode ENABLED (as pi leaves it)" : "legacy encoding"}\r\n` +
    `press the keys you want to test. Ctrl-C twice to quit.\r\n\r\n`,
);

let lastWasCtrlC = false;
process.stdin.on("data", (d) => {
  const bytes = [...d];
  if (bytes.length === 1 && bytes[0] === 0x03) {
    if (lastWasCtrlC) {
      restore();
      process.stdout.write("\r\nbye\r\n");
      process.exit(0);
    }
    lastWasCtrlC = true;
  } else {
    lastWasCtrlC = false;
  }
  const hex = bytes.map((b) => "0x" + b.toString(16).padStart(2, "0")).join(" ");
  process.stdout.write(`${hex.padEnd(34)} ${describe(bytes)}\r\n`);
});

process.on("SIGINT", restore);
process.on("exit", restore);
