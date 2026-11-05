# Keyboard input in the attached TUI

Three input defects turn one key press into several characters, the same character twice, or
into escape-sequence gibberish. All live in the local byte path — nothing typed crosses the
wire — and all are fixed in `src/client/runtime/` rather than by pinning a different pi-tui,
because the pinned version is what pods and the launcher share.

## The path

```
terminal ──bytes──▶ ProcessTerminal ──▶ StdinBuffer ──▶ TUI input listeners ──▶ Editor
                                                                │
                                                    chords · disconnected-quit ·
                                                    key-encoding guard ·
                                                    key-repeat guard
```

Extensions (and this launcher) register listeners through `ExtensionUIContext.onTerminalInput`;
they run ahead of the focused component and may consume a keystroke. pi-tui filters key
*releases* for the focused component but not repeats, and it has no way to see that a repeat
is a repeat for plain text.

## 1. Auto-repeat inserts characters (`key-repeat-guard.ts`)

Ghostty encodes plain-text keys on the text path: press **and** repeat are written as bare
UTF-8, and only the release is a marked `CSI-u` event
(`ghostty: src/input/key_encode.zig` — "Send plain-text non-modified text directly to the
terminal … We don't send release events because those are specially encoded"). So
`isKeyRepeat()` never fires while typing, and a repeat is byte-identical to a fresh press.

A compositor repeats a held key (Hyprland default here: 250 ms delay, then 40/s), and a laggy
prompt — a long session re-rendering, the agent streaming — makes presses last longer than on
an idle session. Every repeat then inserts: one press, several characters.

The release is the surviving signal. pi-tui requests kitty event types, so a key that is still
down has not sent its release; a text press for a key with no release since is a repeat. The
guard consumes exactly those, and nothing else:

- stays inert until the terminal reports event types (`isKittyProtocolActive()` or a release
  observed), so legacy encodings behave exactly as before;
- leaves backspace, Tab, arrows and every other non-inserting key repeating;
- treats a key as fresh once 1.5 s pass without hearing from it, so a lost release cannot
  swallow typing for the rest of a session;
- passes releases through, since extension surfaces may opt into them (`wantsKeyRelease`).

Accepted trade-off: holding a *printable* key types it once. Hold-to-repeat exists for
navigation and deletion, not for text entry.

## 2. A timed-out escape fragment is typed (`stdin-fragment-guard.ts`)

pi-tui's `StdinBuffer` splits stdin into whole sequences and flushes anything it cannot
complete: 50 ms for a partial sequence (`DEFAULT_SEQUENCE_TIMEOUT_MS`), 10 ms for a lone ESC,
100 ms when `SSH_CONNECTION`/`SSH_TTY` is set. Flushing the remainder is how a real Escape key
is delivered, but it also types a *fragment*: a release split across two reads leaves `3u` at
the cursor, and behind a multiplexer a split is routine (tmux forwards a split verbatim,
measured). The same window swallows keystrokes that arrive while an unterminated terminal
reply is buffered.

At the flush the distinction is exact: the buffer is a lone ESC (a key) or an unterminated
escape sequence (never a key). The guard holds the fragment for exactly the next read and
rejoins it only if the two together parse as one key or start with a complete SGR mouse report
(`ESC [ < button ; column ; row M/m`). Fullscreen mode captures wheel, click, drag and release
reports: treating them as non-keys dropped the report's head and typed its coordinates into
the editor. Any input coalesced after the completed report goes through `StdinBuffer` normally.
Otherwise the fragment is discarded and the user's bytes are read on their own, so a stray
fragment cannot swallow the next keystroke.

Fragments shaped like pi-tui's own keyboard-protocol replies are left untouched: the terminal
reassembles those above the buffer already, and the guard must not starve that path. A split
*colour* reply has no such reassembly anywhere, so its head is dropped instead of typed — the
reply may be missed and the theme falls back, which is cosmetic; the prompt stays clean.

Upstream pi-tui 1.4.0 still flushes these fragments (it only rescues recognizable terminal
*replies*), so a version bump would not fix this.

## 3. A press reported in both encodings types once (`key-encoding-guard.ts`)

A terminal with the kitty keyboard protocol enabled may describe one press twice: the key
event as a `CSI-u` sequence **and** the text it produced as raw bytes. pi-tui already guards
this in `StdinBuffer.emitDataSequence` — it remembers the codepoint of the last CSI-u
printable and drops a raw character that repeats it — but its recogniser
(`parseUnmodifiedKittyPrintableCodepoint`) accepts only `ESC[<cp>u`, `ESC[<cp>:<shifted>u` and
`ESC[<cp>::<base>u`, and refuses every form carrying a *modifier parameter*. `decodeKittyPrintable`
accepts those, masking Caps Lock and Num Lock (`KITTY_PRINTABLE_ALLOWED_MODIFIERS = shift | 64
| 128`). So the stock dedupe stops working the moment the terminal puts a modifier bit in that
parameter — measured here with the lock bits a machine carries without anyone noticing, a Num
Lock that is on by default (`input:numlock_by_default = true`) or a Caps Lock — and both copies
insert. Upstream pi fixed the same class of report for one terminal order and shape in
0.70.4 (#3780, "duplicate printable characters from Kitty keyboard protocol CSI-u plus raw
character input on layouts such as Italian"); the pinned pi-tui still has the gap.

The guard consumes a raw character only when a CSI-u printable for exactly that character
arrived immediately before it, only once per CSI-u, and only within 50 ms — the two halves of
one press are written together, so they always meet that window. It is fail-open by
construction: an escaped duplicate costs one visible, recoverable character, while a wrong
suppression would silently eat a keystroke. A release clears the memory rather than arming it,
so the release event that follows a press can never make the next deliberate press of that key
disappear. Releases and repeats otherwise stay with `key-repeat-guard.ts`, which owns them.

Left open deliberately: the reversed order (raw text first, then the CSI-u). No observed
terminal writes it, and deduping it would mean dropping a key *event* on suspicion — the one
direction where a mistake loses input.

## Accepted rows

Measured with a pty harness against pi 1.0.2 + pi-tui 1.0.2 (the pinned pair), driving
Ghostty-accurate bytes (`press` = bare UTF-8, `release` = `CSI-u`), and repeated end-to-end
inside pi's own `InteractiveMode`:

| Input | Before | After |
| --- | --- | --- |
| press `g` + 8 repeats + release | `ggggggggg` | `g` |
| release split past the flush (`\x1b[104;1:` … `3u`) | `h3u` | `h` |
| press split past the flush | `;1:1u` | that key |
| OSC reply fragment, then tap `j` | keystroke lost | `j` |
| Num Lock bit on the CSI-u (`\x1b[97;129u` then `a`) | `aa` | `a` |
| layout base + Num Lock (`\x1b[97:97:97;129u` then `a`) | `aa` | `a` |
| symbol press with Num Lock (`\x1b[64;129u` then `@`) | `@@` | `@` |
| Caps Lock bit (`\x1b[65;65u` then `A`) | `AA` | `A` |
| both halves in one read (`\x1b[104;129uh`) | `hh` | `h` |
| stock dedupe already covers it: `\x1b[64:64:50u` then `@` | `@` | `@` |
| CSI-u half lost, same key 200 ms later | `aa` | `aa` |
| release between the halves, then that key again | press kept | unchanged |

Everything else must stay exactly as it was, and does: a tap inserts one character, two
deliberate taps of the same key insert two, held Backspace and arrows still repeat, a
bracketed paste arrives verbatim, a legacy terminal without releases is untouched, and a
stray fragment (`\x1b[1` followed later by another key) costs neither keystroke.

`PI_TUI_ESC_TIMEOUT` only widens the lone-ESC window, not the 50 ms sequence window, so it is
not a workaround for any of these defects.
