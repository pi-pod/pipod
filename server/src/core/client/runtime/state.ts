/**
 * Synchronous cache backing Pi's local InteractiveMode while the authoritative session
 * lives in the pod. The tree is derived from the flat entry list rather than read back,
 * so every published generation is internally consistent by construction.
 */
import type { RpcSessionState, SessionEntry, SessionTreeNode } from "@earendil-works/pi-coding-agent";
import type { RpcClientBase } from "../rpc.js";

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
  entries: SessionEntry[] = [];
  tree: SessionTreeNode[] = [];
  /** Authoritative active branch leaf. This is intentionally not the replay cursor. */
  leafId: string | null = null;
  /** Last entry observed in append order; used exclusively for get_entries(since). */
  entryCursorId: string | null = null;
  availableModels: unknown[] = [];
  /** Raw remote command list, including private capability commands. */
  commands: unknown[] = [];
  isBashRunning = false;

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

  constructor(private readonly rpc: RpcClientBase) {}

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
        if (succeeded && this.sessionRefreshRequested) void this.refreshTree().catch(() => {});
        else if (!succeeded) this.sessionRefreshRequested = false;
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
    const [state, messages, entryResult, availableModels, commands] = await Promise.all([
      this.rpc.getState(),
      this.rpc.getMessages(),
      this.rpc.getEntries(),
      this.rpc.getAvailableModels(),
      this.rpc.getCommands(),
    ] as const);
    if (generation !== this.cacheGeneration) throw new Error("session cache replacement was superseded");

    const entries = dedupeEntries(entryResult.entries);
    this.state = state;
    this.messages = messages;
    this.entries = entries;
    this.reconcileTree(buildTree(entries));
    this.leafId = entryResult.leafId;
    this.entryCursorId = entries.at(-1)?.id ?? null;
    this.availableModels = availableModels;
    this.commands = commands;
    this.resetLabelStatesFromTree();
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
      if (generation === this.cacheGeneration && !this.replacementInProgress) this.state = state;
    } catch {
      // The session driver owns transport reporting; retain the last coherent state.
    }
  }

  async refreshMessages(): Promise<void> {
    if (this.replacementInProgress) return;
    const generation = this.cacheGeneration;
    try {
      const messages = await this.rpc.getMessages();
      if (generation === this.cacheGeneration && !this.replacementInProgress) this.messages = messages;
    } catch {
      // Retain the last coherent copy.
    }
  }

  /** Compatibility name: entry refreshes now reconcile entries, tree, messages, and leaf together. */
  refreshEntries(): Promise<void> {
    return this.refreshTree().then(() => undefined);
  }

  /**
   * Coalesce session refreshes. The append cursor remains forward-only when navigation moves
   * leafId backward; stale cursors retry with a complete entries read.
   */
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
    const generation = this.cacheGeneration;
    const initialCursor = this.entryCursorId;
    let useFullEntries = initialCursor === null;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= SNAPSHOT_ATTEMPTS; attempt++) {
      const cursor = useFullEntries ? null : initialCursor;
      try {
        const [entryResult, messages] = await Promise.all([
          this.rpc.getEntries(cursor ?? undefined),
          this.rpc.getMessages(),
        ] as const);
        if (expected !== NO_EXPECTED_LEAF && entryResult.leafId !== expected) {
          lastError = new Error(
            `pod session refresh did not reconcile (ack ${String(expected)}, entries ${String(entryResult.leafId)})`,
          );
          continue;
        }
        if (generation !== this.cacheGeneration || this.replacementInProgress) {
          throw new Error("session cache refresh was superseded");
        }
        if (!useFullEntries && this.entryCursorId !== initialCursor) {
          this.sessionRefreshRequested = true;
          return { leafId: this.leafId, tree: cloneTree(this.tree) };
        }
        // A strict acknowledgement reconciliation requested while this unqualified read was in
        // flight supersedes this candidate. Never briefly publish the stale leaf/tree generation.
        if (this.expectedRefreshLeaf !== NO_EXPECTED_LEAF) {
          this.sessionRefreshRequested = true;
          return { leafId: this.leafId, tree: cloneTree(this.tree) };
        }

        const nextEntries = useFullEntries
          ? dedupeEntries(entryResult.entries)
          : appendUniqueEntries(this.entries, entryResult.entries);
        const nextCursor = useFullEntries
          ? nextEntries.at(-1)?.id ?? null
          : entryResult.entries.at(-1)?.id ?? this.entryCursorId;

        const nextTree = buildTree(nextEntries);
        this.messages = messages;
        this.entries = nextEntries;
        this.reconcileTree(nextTree);
        this.leafId = entryResult.leafId;
        this.entryCursorId = nextCursor;
        this.synchronizeConfirmedLabels(nextTree);
        this.reapplyLabelOverlays();
        return { leafId: entryResult.leafId, tree: nextTree };
      } catch (error) {
        if (generation !== this.cacheGeneration || this.replacementInProgress) throw error;
        lastError = error instanceof Error ? error : new Error(String(error));
        if (!useFullEntries) {
          useFullEntries = true;
          continue;
        }
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

function dedupeEntries(entries: SessionEntry[]): SessionEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.id)) return false;
    seen.add(entry.id);
    return true;
  });
}

function appendUniqueEntries(current: SessionEntry[], additions: SessionEntry[]): SessionEntry[] {
  const result = [...current];
  const seen = new Set(result.map((entry) => entry.id));
  for (const entry of additions) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    result.push(entry);
  }
  return result;
}

/**
 * pi's SessionManager.getTree(), recomputed from the flat entries instead of read back over the
 * wire: a linear session nests one node per entry, and JSON.stringify overflows the stack past a
 * few thousand levels, so get_tree fails outright on a long session.
 */
function buildTree(entries: SessionEntry[]): SessionTreeNode[] {
  const labels = new Map<string, { label: string; timestamp: string }>();
  for (const entry of entries) {
    if (entry.type !== "label") continue;
    if (entry.label) labels.set(entry.targetId, { label: entry.label, timestamp: entry.timestamp });
    else labels.delete(entry.targetId);
  }

  const nodes = new Map<string, SessionTreeNode>();
  for (const entry of entries) {
    const resolved = labels.get(entry.id);
    nodes.set(entry.id, {
      entry,
      children: [],
      ...(resolved ? { label: resolved.label, labelTimestamp: resolved.timestamp } : {}),
    });
  }

  const roots: SessionTreeNode[] = [];
  for (const entry of entries) {
    const node = nodes.get(entry.id)!;
    const parent =
      entry.parentId === null || entry.parentId === entry.id ? undefined : nodes.get(entry.parentId);
    // A node whose parent is missing is an orphan, and pi renders it as its own root.
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const stack = [...roots];
  while (stack.length > 0) {
    const node = stack.pop()!;
    node.children.sort((a, b) => Date.parse(a.entry.timestamp) - Date.parse(b.entry.timestamp));
    stack.push(...node.children);
  }
  return roots;
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
