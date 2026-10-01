/**
 * src/client/runtime/pod-commands.ts — the /pod command family (§5.4).
 *
 * Client-local: intercepted in the runtime's `session.prompt` before anything touches the
 * wire, which is what makes these work unconditionally — mid-stream, mid-compaction, even
 * with a wedged pi. Lifecycle belongs to the client (the provider control plane is here);
 * agent-visible context belongs to the pod-side extension (§5.4).
 */
import { type HostBridge, type PodLeaveAction } from "./bridge.js";
import type { ChordConfig } from "./chords.js";

/**
 * What the /pod commands act on. Lifecycle hooks land in later phases; a subcommand whose
 * hook is absent reports that honestly instead of pretending.
 */
export interface PodCommandHost {
  /** Run one locally rendered extension command by name (`/pod local <name> [args]`). */
  runLocalCommand?(arg: string): Promise<void>;
  /** Lines for `/pod status` (§5.4). */
  status?(): Promise<string[]>;
  /** `/pod list` — open the pod picker (§6.4). */
  list?(): Promise<void>;
  /** `/pod switch [pod]` — move the TUI to another pod (§6.4). */
  switchPod?(id?: string): Promise<void>;
  /** `/pod sync` — refresh pod-derived settings and themes for this session. */
  sync?(): Promise<void>;
}

const LEAVE_ACTIONS: Record<string, PodLeaveAction> = {
  detach: "keep",
  archive: "archive",
};

export interface PodSubcommand {
  name: string;
  description: string;
}

export const POD_SUBCOMMANDS: ReadonlyArray<PodSubcommand> = [
  { name: "local", description: "run a locally rendered extension command here (the pod owns /name by default)" },
  { name: "detach", description: "leave; the pod keeps running and the idle timer takes over" },
  { name: "archive", description: "leave, stop the pod and hide it from the list" },
  { name: "status", description: "pod id, provider, state, repo@branch, egress and idle policy" },
  { name: "list", description: "pick from this install's pods" },
  { name: "switch", description: "move to another pod's pi session" },
  { name: "sync", description: "refresh pod-derived settings and themes" },
];

/** Which subcommands a session can actually run: the leave family, plus the host's hooks. */
export function availableSubcommands(host: PodCommandHost): PodSubcommand[] {
  const hooks: Record<string, unknown> = {
    local: host.runLocalCommand,
    status: host.status,
    list: host.list,
    switch: host.switchPod,
    sync: host.sync,
  };
  return POD_SUBCOMMANDS.filter((c) => c.name in LEAVE_ACTIONS || hooks[c.name] !== undefined);
}

/** What the chord wiring tells the help text: how the prefix reads, and which key runs what. */
export interface ChordHints {
  /** The prefix as a human writes it, e.g. `Ctrl-\`. */
  prefix: string;
  /** Subcommand → the ending key that runs it. */
  endings: Record<string, string>;
}

const MODIFIER_LABELS: Array<[string, string]> = [
  ["ctrl", "Ctrl"],
  ["shift", "Shift"],
  ["alt", "Alt"],
  ["super", "Super"],
];

/** A pi-tui KeyId as config and docs spell it: `ctrl+\` → `Ctrl-\`, `escape` → `Escape`. */
export function chordKeyLabel(keyId: string): string {
  const parts = keyId.toLowerCase().split("+");
  const base = parts[parts.length - 1] ?? "";
  const mods = MODIFIER_LABELS.filter(([name]) => parts.slice(0, -1).includes(name)).map(([, label]) => label);
  return [...mods, base.length === 1 ? base : base.charAt(0).toUpperCase() + base.slice(1)].join("-");
}

/** The display form of a chord config, or null when chords are off (§7). */
export function chordHintsFor(chords: ChordConfig | null | undefined): ChordHints | null {
  if (!chords || !chords.enabled) return null;
  const endings: Record<string, string> = {};
  for (const { name } of POD_SUBCOMMANDS) {
    const key = Object.keys(chords.bindings).find((k) => chords.bindings[k] === name);
    if (key !== undefined) endings[name] = chordKeyLabel(key);
  }
  return { prefix: chordKeyLabel(chords.prefix), endings };
}

/**
 * The bare-`/pod` listing, with a chord column when chords are wired (§8).
 *
 * `subcommands` is what this session can run. Listing the whole family regardless would
 * advertise capabilities that answer "not available in this session" — the listing is where
 * people learn what /pod is, so it has to be true of the session they are in.
 */
export function podCommandHelp(
  hints?: ChordHints | null,
  subcommands: ReadonlyArray<PodSubcommand> = POD_SUBCOMMANDS,
): string {
  const nameWidth = Math.max(...subcommands.map((c) => c.name.length));
  const chords = subcommands.map((c) => {
    const ending = hints?.endings[c.name];
    return ending ? `${hints!.prefix} ${ending}` : "";
  });
  const chordWidth = Math.max(...chords.map((c) => c.length));
  const lines = subcommands.map((c, i) => {
    const chord = chordWidth > 0 ? `  ${chords[i]!.padEnd(chordWidth)}` : "";
    return `  /pod ${c.name.padEnd(nameWidth)}${chord} — ${c.description}`;
  });
  return ["/pod commands:", ...lines].join("\n");
}

/** `/pod …` → its subcommand and argument, or null when this is not a /pod invocation. */
export function parsePodCommand(text: string): { sub: string; arg: string } | null {
  const m = /^\/pod(?:\s+(\S+))?(?:\s+(.*))?$/.exec(text.trim());
  if (!m) return null;
  return { sub: m[1] ?? "", arg: (m[2] ?? "").trim() };
}

export class PodCommandRouter {
  constructor(
    private readonly bridge: HostBridge,
    private readonly host: PodCommandHost = {},
  ) {}

  /** Set by the chord wiring so the help text can show what each chord runs (§8). */
  private chordHints: ChordHints | null = null;

  setChordHints(hints: ChordHints | null): void {
    this.chordHints = hints;
  }

  /** True when `text` is a /pod invocation this router owns. */
  matches(text: string): boolean {
    return parsePodCommand(text) !== null;
  }

  /** What this session can run — the listing, and the chord help, are built from it. */
  available(): PodSubcommand[] {
    return availableSubcommands(this.host);
  }

  /** Run a /pod command locally. The caller has already checked {@link matches}. */
  async handle(text: string): Promise<void> {
    const parsed = parsePodCommand(text);
    if (!parsed) return;
    const { sub, arg } = parsed;

    const leave = LEAVE_ACTIONS[sub];
    if (leave !== undefined) {
      this.bridge.requestLeave(leave);
      return;
    }

    switch (sub) {
      case "local":
        if (!this.host.runLocalCommand) return this.unsupported("local");
        await this.host.runLocalCommand(arg);
        return;
      case "status": {
        if (!this.host.status) return this.unsupported("status");
        const lines = await this.host.status();
        this.bridge.notify(lines.join("\n"));
        return;
      }
      case "shell":
        this.bridge.notify("/pod shell is not supported — a raw pod shell is not available", "warning");
        return;
      case "list":
        if (!this.host.list) return this.unsupported("list");
        await this.host.list();
        return;
      case "switch":
        if (!this.host.switchPod) return this.unsupported("switch");
        await this.host.switchPod(arg === "" ? undefined : arg);
        return;
      case "sync":
        if (!this.host.sync) return this.unsupported("sync");
        await this.host.sync();
        return;
      case "":
        this.bridge.notify(podCommandHelp(this.chordHints, this.available()));
        return;
      default:
        this.bridge.notify(`unknown command: /pod ${sub} — try /pod for the list`, "warning");
        return;
    }
  }

  private unsupported(sub: string): void {
    this.bridge.notify(`/pod ${sub} is not available in this session`, "warning");
  }
}

/** The one-line session-start hint: the leave family, and the chords that alias it (§8). */
export function podCommandNotice(hints?: ChordHints | null): string {
  const base = "leave with /pod detach, or logically archive with /pod archive";
  const keys = ["detach", "archive"].map((sub) => hints?.endings[sub]);
  if (!hints || keys.some((k) => k === undefined)) return base;
  return `${base} — or ${hints.prefix} then ${keys.join(" / ")}`;
}
