# Fullscreen Pi in pipod

Pipod uses its bundled Pi renderer locally; fullscreen does not need a different pod image
or a remote terminal. Launch or attach with an explicit layout:

```sh
pipod -- --tui-mode fullscreen
pipod attach <pod> -- --tui-mode fullscreen
pipod attach <pod> -- --tui-mode regular
```

The override applies only to this client. Without it, Pi uses the derived pod/host display
settings. Fullscreen keeps the editor and footer fixed while the transcript scrolls in the
alternate screen; regular mode uses the terminal's scrollback. `/settings` can switch layouts
without disconnecting. Display changes made there are session-local, not saved account or
template configuration.

## Mouse preferences

The pod's display projection includes `tuiMode`, `fullscreenExitOutput`,
`fullscreenScrollbar`, `fullscreenCopyOnSelect` (boolean), and
`fullscreenWheelScrollLines` (`"auto"` or an integer from 1 through 100). Invalid pod values
are ignored; command-valued settings never cross this boundary. Host-only preferences remain
local. Both the server's manifest producer and the CLI validator need the new fields for pod
copy/scroll preferences to reach an attached client. An already-running shim keeps its old
projection until restarted; a server source update alone does not change it.

## Input compatibility

Fullscreen captures mouse reports. A wheel/click/drag/release report split across reads,
past pi-tui's sequence timeout, must still reach the renderer as one report—not type its
coordinates into the editor. The [stdin fragment guard](keyboard-input.md) rejoins a complete
SGR mouse report and preserves any following input in the same read. A malformed fragment
still cannot swallow the next ordinary keystroke. This retains the existing bound: recovery
covers the next read, not arbitrarily delayed multi-fragment streams.

## Manual acceptance

Use a real pod in an agent-owned tmux session. Build and invoke the checkout by absolute path;
do not accidentally verify a globally installed CLI instead. Keep and archive only the pod
you create. No model call is needed: `!` shell commands can generate transcript content.

Check the alternate-screen/mouse flags, not only visible text. Exercise:

- Startup and reattach with both explicit layouts and the default.
- Narrow/wide terminal resizes; editor/footer stay visible and input remains usable.
- Transcript keyboard and wheel scrolling, including split SGR reports ending in `M` and `m`.
- A completed report followed by printable input in the same read; only the printable input
  enters the editor. Malformed fragments must not discard ordinary typing.
- `/settings` layout switching and the detach chord afterward.
- Detach/quit returns to the main screen with mouse reporting off, and leaves the pod running.
- Real generated shim → validated manifest → Pi's file-backed SettingsManager: both copy
  booleans, `"auto"`, numeric wheel bounds, invalid values, and unchanged host-only settings.

When sending a partial mouse report through tmux, use `send-keys -H` for its hex bytes. A
trailing semicolon in a `send-keys -l` argument is a tmux command separator and can be removed,
turning a valid intended report into malformed diagnostic input.
