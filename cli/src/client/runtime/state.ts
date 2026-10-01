/**
 * Synchronous cache backing Pi's local InteractiveMode while the authoritative session
 * lives in the pod.
 *
 * `entries` is the active context branch (what `buildContextEntries` returns), not the
 * session log. `tree` is folded from the pod's flat summary rows so `/tree` still sees
 * the whole DAG without shipping every entry's content.
 */
import { sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import type { RpcSessionState, SessionEntry, SessionStats, SessionTreeNode } from "@earendil-works/pi-coding-agent";
import type { RpcClientBase, ThinkingLevel } from "../rpc.js";
import type {
  SeedContextData,
  SeedTreeSummaryData,
  SeedTreeSummaryNode,
  SessionSeedBridge,
} from "./pod-extension-bridge.js";

const SNAPSHOT_ATTEMPTS = 3;
const NO_EXPECTED_LEAF = Symbol("no-expected-leaf");
type ExpectedLeaf = string | null | typeof NO_EXPECTED_LEAF;

interface LabelMutation {
  label: string | null;
  timestamp: string;
}

interface LabelState {
  revision: number;
  confirmedLabel: string | null;
  confirmedTimestamp: string | undefined;
  pendingMutations: Map<number, LabelMutation>;
}

export interface ReconciledSessionSnapshot {
  leafId: string | null;
  tree: SessionTreeNode[];
}

/** The token/cost sums pi's footer accumulates: message usage plus summary-generation usage. */
export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export class RemoteStateCache {
  state: RpcSessionState = {
    thinkingLevel: "off",
    isStreaming: false,
    isCompacting: false,
    steeringMode: "all",
    followUpMode: "one-at-a-time",
    sessionId: "",
    autoCompactionEnabled: true,
    messageCount: 0,
    pendingMessageCount: 0,
  };
  messages: unknown[] = [];
  /** Active context branch, not the full session log. */
  entries: SessionEntry[] = [];
  tree: SessionTreeNode[] = [];
  /** Authoritative active branch leaf. This is intentionally not the replay cursor. */
  leafId: string | null = null;
  /** Compactions in the full session log; branch-only entries cannot reconstruct this. */
  compactionCount = 0;
  /** User messages across the whole DAG, for the fork picker. Null until first seed. */
  forkMessages: Array<{ entryId: string; text: string }> | null = null;
  availableModels: unknown[] = [];
  /** Semantic gateway answer for the active model; null means use the compatibility fallback. */
  availableThinkingLevels: ThinkingLevel[] | null = null;
  /** Raw remote command list, including private capability commands. */
  commands: unknown[] = [];
  isBashRunning = false;
  /**
   * Usage in the pod's full session log that the cached branch entries cannot see —
   * pre-compaction messages and abandoned branches. Pi's footer sums the whole log, so
   * without this overlay a pod session's cumulative totals silently shrink at every
   * compaction. Null until the first stats fetch, and whenever the branch already
   * accounts for everything.
   */
  hiddenUsage: UsageTotals | null = null;
  /** Last authoritative full-log stats from the pod; null until the first boundary fetch. */
  sessionStats: SessionStats | null = null;
  /** Repaint hook: async refreshes land after the event that triggered the last render. */
  onRefreshed: (() => void) | null = null;

  /**
   * Pi's InteractiveMode calls getSessionStats() synchronously (its /session handler
   * destructures the result), so the RPC promise cannot cross this surface. Serve the
   * cached full-log stats, or derive branch-only stats before the first fetch lands.
   */
  sessionStatsSnapshot(): SessionStats {
    return this.sessionStats ?? branchSessionStats(this.entries, this.state);
  }

  /**
   * Forget locally-cached turn flags after the pod sleeps. A stale `isCompacting`
   * makes InteractiveMode queue the next submit locally (no RPC, so no wake); a
   * stale `isStreaming` steers instead of prompting. Truth is re-seeded on wake.
   */
  forceIdle(): void {
    this.state.isStreaming = false;
    this.state.isCompacting = false;
    this.isBashRunning = false;
  }


  private sessionRefreshPromise: Promise<ReconciledSessionSnapshot> | null = null;
  private sessionRefreshRequested = false;
  private expectedRefreshLeaf: ExpectedLeaf = NO_EXPECTED_LEAF;
  private cacheGeneration = 0;
  private replacementInProgress = false;
  private readonly labelStates = new Map<string, LabelState>();
  private seedBridge: SessionSeedBridge | null = null;

  constructor(private readonly rpc: RpcClientBase) {}

  bindSeedBridge(bridge: SessionSeedBridge): void {
    this.seedBridge = bridge;
  }

  private usesSeedBridge(): boolean {
    return this.seedBridge?.supportsSeedBridge(this.commands) === true;
  }

  /** Re-seed as one strict cache generation; failure leaves the previous generation intact. */
  async reset(): Promise<void> {
    const generation = ++this.cacheGeneration;
    this.replacementInProgress = true;
    let succeeded = false;
    try {
      if (this.sessionRefreshPromise) await this.sessionRefreshPromise.catch(() => {});
      await this.seed(generation);
      succeeded = true;
    } finally {
      if (generation === this.cacheGeneration) {
        this.replacementInProgress = false;
        // A successful seed already published a coherent generation. A refresh requested
        // against the replaced cache would only duplicate work on a retired in-flight loop.
        if (succeeded) this.sessionRefreshRequested = false;
        else this.sessionRefreshRequested = false;
      }
    }
  }

  /** Seed every synchronous surface, including tree and raw commands, as one generation. */
  async init(_strict = false): Promise<void> {
    const generation = ++this.cacheGeneration;
    if (this.sessionRefreshPromise) await this.sessionRefreshPromise.catch(() => {});
    await this.seed(generation);
  }

  private async seed(generation: number): Promise<void> {
    const assertCurrent = (): void => {
      if (generation !== this.cacheGeneration) throw new Error("session cache replacement was superseded");
    };
    const [state, commands] = await Promise.all([this.rpc.getState(), this.rpc.getCommands()] as const);
    assertCurrent();
    this.commands = commands;
    if (!this.usesSeedBridge()) {
      throw new Error(
        "This running pod uses an older pi pod extension. Exit Pi, then attach again so pi pod can load the updated extension.",
      );
    }
    const [context, summary] = await Promise.all([
      this.seedBridge!.getContext(),
      this.seedBridge!.getTreeSummary(),
    ] as const);
    assertCurrent();
    this.applySeedSnapshot(state, context, summary);
    void this.refreshModels();
  }

  private applySeedSnapshot(
    state: RpcSessionState,
    context: SeedContextData,
    summary: SeedTreeSummaryData,
  ): void {
    this.state = state;
    this.entries = dedupeEntries(context.entries);
    // Derived, not fetched: a full get_messages reply is one unbounded frame that a long
    // session can push past the transport's 64 MiB line drop (the 2026-08 attach outages).
    // pi rebuilds its own message list the same way: buildContextEntries().flatMap(convert).
    this.messages = deriveMessages(this.entries);
    this.compactionCount = context.compactionCount;
    this.leafId = context.leafId;
    this.reconcileTree(foldTreeSummary(summary.nodes));
    this.resetLabelStatesFromTree();
    // The old session's overlay and stats must not survive into a replacement's totals.
    this.hiddenUsage = null;
    this.sessionStats = null;
    void this.refreshForkMessages();
    void this.refreshHiddenUsage();
  }

  /** Keep streaming/compaction flags live and reconcile at every completion boundary. */
  wire(): () => void {
    return this.rpc.onEvent((event) => {
      const type = (event as { type?: string }).type;
      switch (type) {
        case "agent_start":
          this.state.isStreaming = true;
          break;
        case "compaction_start":
          this.state.isCompacting = true;
          break;
        case "bash_execution_start":
          this.isBashRunning = true;
          break;
        case "bash_execution_end":
          this.isBashRunning = false;
          break;
        case "agent_end":
          this.state.isStreaming = false;
          void this.refreshState();
          void this.refreshTree().catch(() => {});
          break;
        case "compaction_end":
          this.state.isCompacting = false;
          void this.refreshState();
          void this.refreshTree().catch(() => {});
          break;
        case "agent_settled":
          this.state.isStreaming = false;
          this.state.isCompacting = false;
          void this.refreshState();
          void this.refreshTree().catch(() => {});
          break;
        case "entry_appended":
          this.applyEntryAppended((event as { entry: SessionEntry }).entry);
          break;
        case "session_info_changed":
          // Applied synchronously as well as refreshed: the host InteractiveMode handles this
          // same event by reading the name back through this cache to retitle the terminal, so
          // an async-only refresh would leave the tab title one rename behind.
          this.state.sessionName = (event as { name?: string }).name;
          void this.refreshState();
          break;
      }
    });
  }

  async refreshState(): Promise<void> {
    if (this.replacementInProgress) return;
    const generation = this.cacheGeneration;
    try {
      const state = await this.rpc.getState();
      if (generation === this.cacheGeneration && !this.replacementInProgress) {
        this.state = state;
        this.onRefreshed?.();
      }
    } catch {
      // The session driver owns transport reporting; retain the last coherent state.
    }
  }

  /**
   * Recompute the hidden-usage overlay from the pod's authoritative full-log totals.
   * The delta is frozen against the branch entries current at fetch time: usage appended
   * afterwards grows the branch and the log equally, so branch + delta stays correct
   * between completion boundaries.
   */
  private async refreshHiddenUsage(): Promise<void> {
    const generation = this.cacheGeneration;
    try {
      const stats = await this.rpc.getSessionStats();
      if (generation !== this.cacheGeneration || this.replacementInProgress) return;
      this.sessionStats = stats;
      const branch = branchUsageTotals(this.entries);
      const hidden: UsageTotals = {
        input: Math.max(0, stats.tokens.input - branch.input),
        output: Math.max(0, stats.tokens.output - branch.output),
        cacheRead: Math.max(0, stats.tokens.cacheRead - branch.cacheRead),
        cacheWrite: Math.max(0, stats.tokens.cacheWrite - branch.cacheWrite),
        cost: Math.max(0, stats.cost - branch.cost),
      };
      const empty =
        hidden.input === 0 && hidden.output === 0 && hidden.cacheRead === 0 &&
        hidden.cacheWrite === 0 && hidden.cost < 1e-9;
      this.hiddenUsage = empty ? null : hidden;
      this.onRefreshed?.();
    } catch {
      // Totals keep the previous overlay; the next boundary refresh retries.
    }
  }


  /** Compatibility name: entry refreshes now reconcile entries, tree, messages, and leaf together. */
  refreshEntries(): Promise<void> {
    return this.refreshTree().then(() => undefined);
  }

  /** Await the refresh an event listener already started, or start one if none is active. */
  reconcileTreeAfterEvent(): Promise<ReconciledSessionSnapshot> {
    return this.sessionRefreshPromise ?? this.refreshTree();
  }

  /** Coalesce session refreshes. Each pass re-pulls context + summary. */
  refreshTree(expectedLeaf?: string | null): Promise<ReconciledSessionSnapshot> {
    this.sessionRefreshRequested = true;
    if (arguments.length > 0) this.expectedRefreshLeaf = expectedLeaf ?? null;
    if (this.replacementInProgress) {
      return Promise.resolve({ leafId: this.leafId, tree: cloneTree(this.tree) });
    }
    if (this.sessionRefreshPromise) {
      const active = this.sessionRefreshPromise;
      return active.then((result) => (this.sessionRefreshRequested ? this.refreshTree() : result));
    }
    this.sessionRefreshPromise = this.runSessionRefreshLoop().finally(() => {
      this.sessionRefreshPromise = null;
    });
    return this.sessionRefreshPromise;
  }

  private async runSessionRefreshLoop(): Promise<ReconciledSessionSnapshot> {
    let result: ReconciledSessionSnapshot = { leafId: this.leafId, tree: cloneTree(this.tree) };
    while (this.sessionRefreshRequested) {
      if (this.replacementInProgress) return result;
      this.sessionRefreshRequested = false;
      const expected = this.expectedRefreshLeaf;
      this.expectedRefreshLeaf = NO_EXPECTED_LEAF;
      result = await this.refreshSessionOnce(expected);
    }
    return result;
  }

  private async refreshSessionOnce(expected: ExpectedLeaf): Promise<ReconciledSessionSnapshot> {
    if (!this.usesSeedBridge()) {
      throw new Error(
        "This running pod uses an older pi pod extension. Exit Pi, then attach again so pi pod can load the updated extension.",
      );
    }
    return this.refreshFromSeedBridge(expected);
  }

  private async refreshFromSeedBridge(expected: ExpectedLeaf): Promise<ReconciledSessionSnapshot> {
    const generation = this.cacheGeneration;
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= SNAPSHOT_ATTEMPTS; attempt++) {
      try {
        const [context, summary] = await Promise.all([
          this.seedBridge!.getContext(),
          this.seedBridge!.getTreeSummary(),
        ] as const);
        if (expected !== NO_EXPECTED_LEAF && context.leafId !== expected) {
          lastError = new Error(
            `pod session refresh did not reconcile (ack ${String(expected)}, context ${String(context.leafId)})`,
          );
          continue;
        }
        if (generation !== this.cacheGeneration || this.replacementInProgress) {
          throw new Error("session cache refresh was superseded");
        }
        if (this.expectedRefreshLeaf !== NO_EXPECTED_LEAF) {
          this.sessionRefreshRequested = true;
          return { leafId: this.leafId, tree: cloneTree(this.tree) };
        }
        const nextTree = foldTreeSummary(summary.nodes);
        this.entries = dedupeEntries(context.entries);
        this.messages = deriveMessages(this.entries);
        this.compactionCount = context.compactionCount;
        this.leafId = context.leafId;
        this.reconcileTree(nextTree);
        this.synchronizeConfirmedLabels(nextTree);
        this.reapplyLabelOverlays();
        void this.refreshForkMessages();
        void this.refreshHiddenUsage();
        this.onRefreshed?.();
        return { leafId: context.leafId, tree: nextTree };
      } catch (error) {
        if (generation !== this.cacheGeneration || this.replacementInProgress) throw error;
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }
    throw lastError ?? new Error("pod session refresh could not be reconciled");
  }

  async refreshModels(): Promise<void> {
    try {
      this.availableModels = await this.rpc.getAvailableModels();
    } catch {
      // Catalog stays stale.
    }
  }

  async refreshCommands(): Promise<void> {
    try {
      this.commands = await this.rpc.getCommands();
    } catch {
      // Capability list stays stale and callers fail closed.
    }
  }

  private async refreshForkMessages(): Promise<void> {
    try {
      this.forkMessages = await this.rpc.getForkMessages();
    } catch {
      if (this.forkMessages === null) this.forkMessages = deriveForkMessages(this.entries);
    }
  }

  private applyEntryAppended(entry: SessionEntry): void {
    if (!entry || typeof entry.id !== "string") return;
    if (!this.entries.some((existing) => existing.id === entry.id)) this.entries.push(entry);
    if (!findTreeNode(this.tree, entry.id)) {
      const node: SessionTreeNode = { entry, children: [] };
      const parent = entry.parentId ? findTreeNode(this.tree, entry.parentId) : undefined;
      if (parent) parent.children.push(node);
      else this.tree.push(node);
    }
    if (entry.type === "label") {
      const target = findTreeNode(this.tree, entry.targetId);
      if (target) {
        if (entry.label) {
          target.label = entry.label;
          target.labelTimestamp = entry.timestamp;
        } else {
          delete target.label;
          delete target.labelTimestamp;
        }
      }
    }
    this.leafId = entry.id;
    if (entry.type === "compaction") this.compactionCount += 1;
    if (entry.type === "message" && entry.message?.role === "user") {
      const text = forkText(entry);
      if (text !== undefined) {
        const messages = this.forkMessages ?? [];
        if (!messages.some((item) => item.entryId === entry.id)) {
          this.forkMessages = [...messages, { entryId: entry.id, text }];
        }
      }
    }
  }

  beginLabelMutation(entryId: string, label: string | null): number {
    const state = this.labelStates.get(entryId) ?? this.createLabelState(entryId);
    const revision = ++state.revision;
    state.pendingMutations.set(revision, { label, timestamp: new Date().toISOString() });
    this.applyLabelState(entryId, state);
    return revision;
  }

  completeLabelMutation(
    entryId: string,
    revision: number,
    outcome:
      | { ok: false }
      | { ok: true; label: string | null; labelTimestamp: string | undefined },
  ): void {
    const state = this.labelStates.get(entryId);
    if (!state || !state.pendingMutations.has(revision)) return;
    state.pendingMutations.delete(revision);
    if (outcome.ok) {
      state.confirmedLabel = outcome.label;
      state.confirmedTimestamp = outcome.labelTimestamp;
    }
    this.applyLabelState(entryId, state);
  }

  private createLabelState(entryId: string): LabelState {
    const node = findTreeNode(this.tree, entryId);
    const state: LabelState = {
      revision: 0,
      confirmedLabel: node?.label ?? null,
      confirmedTimestamp: node?.labelTimestamp,
      pendingMutations: new Map(),
    };
    this.labelStates.set(entryId, state);
    return state;
  }

  private resetLabelStatesFromTree(): void {
    this.labelStates.clear();
  }

  private synchronizeConfirmedLabels(authoritativeTree: SessionTreeNode[]): void {
    for (const [entryId, state] of this.labelStates) {
      if (state.pendingMutations.size > 0) continue;
      const node = findTreeNode(authoritativeTree, entryId);
      state.confirmedLabel = node?.label ?? null;
      state.confirmedTimestamp = node?.labelTimestamp;
    }
  }

  private reapplyLabelOverlays(): void {
    for (const [entryId, state] of this.labelStates) this.applyLabelState(entryId, state);
  }

  private applyLabelState(entryId: string, state: LabelState): void {
    const node = findTreeNode(this.tree, entryId);
    if (!node) return;
    const latest = [...state.pendingMutations.entries()].at(-1)?.[1];
    const label = latest ? latest.label : state.confirmedLabel;
    const timestamp = latest?.timestamp ?? state.confirmedTimestamp;
    if (label) {
      node.label = label;
      node.labelTimestamp = timestamp;
    } else {
      delete node.label;
      delete node.labelTimestamp;
    }
  }

  /** Reconcile nodes in place so an already-open TreeSelector keeps authoritative objects. */
  private reconcileTree(authoritative: SessionTreeNode[]): void {
    const existing = new Map<string, SessionTreeNode>();
    walkTree(this.tree, (node) => existing.set(node.entry.id, node));
    const adopt = (source: SessionTreeNode): SessionTreeNode => {
      const target = existing.get(source.entry.id) ?? { entry: source.entry, children: [] };
      target.entry = source.entry;
      if (source.label !== undefined) target.label = source.label;
      else delete target.label;
      if (source.labelTimestamp !== undefined) target.labelTimestamp = source.labelTimestamp;
      else delete target.labelTimestamp;
      return target;
    };
    const roots = authoritative.map(adopt);
    const stack = authoritative.map((source, index) => ({ source, target: roots[index]! }));
    while (stack.length > 0) {
      const { source, target } = stack.pop()!;
      const children = source.children.map(adopt);
      target.children.splice(0, target.children.length, ...children);
      source.children.forEach((child, index) => stack.push({ source: child, target: children[index]! }));
    }
    this.tree.splice(0, this.tree.length, ...roots);
  }
}

/** Branch-only stand-in for pi's getSessionStats(), used until the pod's totals arrive. */
function branchSessionStats(entries: SessionEntry[], state: RpcSessionState): SessionStats {
  const totals = branchUsageTotals(entries);
  let userMessages = 0;
  let assistantMessages = 0;
  let toolResults = 0;
  let totalMessages = 0;
  let toolCalls = 0;
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    totalMessages += 1;
    const message = entry.message as { role?: string; content?: unknown };
    if (message.role === "user") userMessages += 1;
    else if (message.role === "toolResult") toolResults += 1;
    else if (message.role === "assistant") {
      assistantMessages += 1;
      if (Array.isArray(message.content)) {
        toolCalls += message.content.filter((part: { type?: string }) => part.type === "toolCall").length;
      }
    }
  }
  return {
    sessionFile: state.sessionFile,
    sessionId: state.sessionId,
    userMessages,
    assistantMessages,
    toolCalls,
    toolResults,
    totalMessages,
    tokens: {
      input: totals.input,
      output: totals.output,
      cacheRead: totals.cacheRead,
      cacheWrite: totals.cacheWrite,
      total: totals.input + totals.output + totals.cacheRead + totals.cacheWrite,
    },
    cost: totals.cost,
  };
}

/** The same buckets pi's footer sums: assistant + toolResult message usage, summary usage. */
function branchUsageTotals(entries: SessionEntry[]): UsageTotals {
  const totals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const entry of entries) {
    let usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } } | undefined;
    if (entry.type === "message") {
      const message = entry.message as { role?: string; usage?: typeof usage };
      if (message.role === "assistant" || message.role === "toolResult") usage = message.usage;
    } else if (entry.type === "compaction" || entry.type === "branch_summary") {
      usage = (entry as { usage?: typeof usage }).usage;
    }
    if (!usage) continue;
    totals.input += usage.input ?? 0;
    totals.output += usage.output ?? 0;
    totals.cacheRead += usage.cacheRead ?? 0;
    totals.cacheWrite += usage.cacheWrite ?? 0;
    totals.cost += usage.cost?.total ?? 0;
  }
  return totals;
}

function dedupeEntries(entries: SessionEntry[]): SessionEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.id)) return false;
    seen.add(entry.id);
    return true;
  });
}

/** Fold the pod's flat summary rows into SessionTreeNode[]. Orphans become roots. */
export function foldTreeSummary(nodes: SeedTreeSummaryNode[]): SessionTreeNode[] {
  const byId = new Map<string, SessionTreeNode>();
  for (const row of nodes) {
    byId.set(row.id, {
      entry: stubEntry(row),
      children: [],
      ...(row.label ? { label: row.label, labelTimestamp: row.labelTimestamp } : {}),
    });
  }
  const roots: SessionTreeNode[] = [];
  for (const row of nodes) {
    const node = byId.get(row.id)!;
    const parent =
      row.parentId === null || row.parentId === row.id ? undefined : byId.get(row.parentId);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

function stubEntry(row: SeedTreeSummaryNode): SessionEntry {
  const base = { id: row.id, parentId: row.parentId, timestamp: row.timestamp };
  switch (row.type) {
    case "message": {
      const role = row.role ?? "user";
      if (role === "toolResult") {
        return { ...base, type: "message", message: { role, content: [], toolName: row.toolName } } as unknown as SessionEntry;
      }
      if (role === "bashExecution") {
        return { ...base, type: "message", message: { role, command: row.preview } } as unknown as SessionEntry;
      }
      return { ...base, type: "message", message: { role, content: row.preview } } as unknown as SessionEntry;
    }
    case "compaction":
      return { ...base, type: "compaction", summary: row.preview, firstKeptEntryId: "", tokensBefore: row.tokensBefore ?? 0 } as SessionEntry;
    case "branch_summary":
      return { ...base, type: "branch_summary", fromId: "", summary: row.preview } as SessionEntry;
    case "custom_message":
      return { ...base, type: "custom_message", customType: row.customType ?? "", content: row.preview, display: true } as SessionEntry;
    case "custom":
      return { ...base, type: "custom", customType: row.customType ?? "" } as SessionEntry;
    case "label":
      return { ...base, type: "label", targetId: row.parentId ?? row.id, label: row.preview || undefined } as SessionEntry;
    case "model_change":
      return { ...base, type: "model_change", provider: "", modelId: row.modelId ?? row.preview } as SessionEntry;
    case "thinking_level_change":
      return { ...base, type: "thinking_level_change", thinkingLevel: row.thinkingLevel ?? row.preview } as SessionEntry;
    case "session_info":
      return { ...base, type: "session_info", name: row.name ?? row.preview } as SessionEntry;
    default:
      return { ...base, type: "custom", customType: row.type } as SessionEntry;
  }
}

/** The same projection pi applies in buildSessionContext(); tolerant of stub entries. */
function deriveMessages(entries: SessionEntry[]): unknown[] {
  const messages: unknown[] = [];
  for (const entry of entries) {
    try {
      messages.push(...sessionEntryToContextMessages(entry));
    } catch {
      // A malformed entry loses its message, never the whole seed.
    }
  }
  return messages;
}

function deriveForkMessages(entries: SessionEntry[]): Array<{ entryId: string; text: string }> {
  const messages: Array<{ entryId: string; text: string }> = [];
  for (const entry of entries) {
    const text = forkText(entry);
    if (text !== undefined) messages.push({ entryId: entry.id, text });
  }
  return messages;
}

function forkText(entry: SessionEntry): string | undefined {
  if (entry.type !== "message" || entry.message?.role !== "user") return undefined;
  const content = (entry.message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part: { text?: string }) => part.text ?? "").join("");
}

function walkTree(tree: SessionTreeNode[], visit: (node: SessionTreeNode) => void): void {
  const stack = [...tree];
  while (stack.length > 0) {
    const node = stack.pop()!;
    visit(node);
    stack.push(...node.children);
  }
}

export function findTreeNode(tree: SessionTreeNode[], entryId: string): SessionTreeNode | undefined {
  let found: SessionTreeNode | undefined;
  walkTree(tree, (node) => {
    if (!found && node.entry.id === entryId) found = node;
  });
  return found;
}

function cloneTree(tree: SessionTreeNode[]): SessionTreeNode[] {
  const copy = (node: SessionTreeNode): SessionTreeNode => ({
    ...node,
    entry: { ...node.entry } as SessionEntry,
    children: [],
  });
  const roots = tree.map(copy);
  const stack = tree.map((source, index) => ({ source, target: roots[index]! }));
  while (stack.length > 0) {
    const { source, target } = stack.pop()!;
    for (const child of source.children) {
      const clone = copy(child);
      target.children.push(clone);
      stack.push({ source: child, target: clone });
    }
  }
  return roots;
}
