import { TERMINAL_RESOURCE_LIMITS } from "@opencraft/appserver-protocol";
import type { AppServerWorkbenchRuntime } from "./appserver-runtime";
import type {
  AppServerTerminalPhase,
  AppServerTerminalSession,
  AppServerTerminalSnapshot,
} from "./appserver-terminal";

const DEFAULT_TERMINAL_COMMAND = Object.freeze(["/bin/bash", "--noprofile", "--norc"]);
export const CONVERSATION_TERMINAL_BUFFER_LIMIT = 16_000;

export interface ConversationTerminalOpenOptions {
  readonly threadId?: string | null;
  readonly projectId?: string | null;
  readonly resourceOwnerId?: string;
  readonly hostId: string;
  readonly cwd: string | null;
  readonly cols?: number;
  readonly rows?: number;
}

export interface ConversationTerminalSessionSummary {
  readonly sessionId: string;
  readonly hostId: string;
  readonly processId: string;
  readonly cwd: string;
  readonly shell: string;
  readonly title: string;
  readonly phase: AppServerTerminalPhase;
  readonly exitCode: number | null;
}

export interface ConversationTerminalDirectorySnapshot {
  readonly revision: number;
  readonly ownerId: string;
  readonly sessionIds: readonly string[];
  readonly activeSessionId: string | null;
  readonly sessions: readonly ConversationTerminalSessionSummary[];
}

export interface ConversationTerminalReadSnapshot extends ConversationTerminalSessionSummary {
  readonly buffer: string;
  readonly truncated: boolean;
}

interface OwnedTerminalSession {
  readonly openOptions: ConversationTerminalOpenOptions;
  readonly ownerId: string | null;
  readonly hostId: string;
  readonly cwd: string;
  readonly shell: string;
  readonly title: string;
  readonly session: AppServerTerminalSession;
  readonly unsubscribe: () => void;
}

interface OwnerState {
  revision: number;
  sessionIds: string[];
  activeSessionId: string | null;
}

function bytesFromBase64(value: string): Uint8Array {
  const binary = globalThis.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function terminalBuffer(
  snapshot: AppServerTerminalSnapshot,
  limit: number,
): Pick<ConversationTerminalReadSnapshot, "buffer" | "truncated"> {
  const chunks = [...snapshot.output].sort((left, right) => left.sequence - right.sequence);
  const byteLength = chunks.reduce(
    (total, chunk) => total + Math.floor(chunk.deltaBase64.length * 3 / 4),
    0,
  );
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    const decoded = bytesFromBase64(chunk.deltaBase64);
    bytes.set(decoded, offset);
    offset += decoded.length;
  }
  const text = new TextDecoder().decode(bytes.subarray(0, offset));
  return {
    buffer: text.length > limit ? text.slice(-limit) : text,
    truncated: text.length > limit || (chunks[0]?.sequence ?? 1) > 1,
  };
}

/**
 * Application-owned semantic directory for terminal resources attached to a
 * Conversation Scope. The Host remains the sole PTY/process owner.
 */
export class ConversationTerminalSessionRegistry {
  private readonly sessions = new Map<string, OwnedTerminalSession>();
  private readonly owners = new Map<string, OwnerState>();
  private readonly ownerSnapshots = new Map<string, ConversationTerminalDirectorySnapshot>();
  private readonly ownerListeners = new Map<string, Set<() => void>>();
  private disposed = false;
  private restoreRevision = 0;
  private readonly ownerRestoreRevisions = new Map<string, number>();
  private readonly restoreRequests = new Map<string, { hostId: string; ownerId?: string; scope?: { threadId?: string | null; projectId?: string | null }; aliases: readonly string[] }>();
  private readonly retiredSessions = new Map<string, { hostId: string; ownerId: string | null }>();

  constructor(
    private readonly resolveRuntime: (hostId: string) => AppServerWorkbenchRuntime,
    private readonly bufferLimit = CONVERSATION_TERMINAL_BUFFER_LIMIT,
    private readonly directoryChanged?: (hostId: string) => void,
  ) {
    if (!Number.isSafeInteger(bufferLimit) || bufferLimit < 1) {
      throw new RangeError("Conversation terminal buffer limit must be a positive integer");
    }
  }

  open(options: ConversationTerminalOpenOptions): string {
    this.ensureOpen();
    if ([...this.sessions.values()].filter(session => session.hostId === options.hostId).length >= TERMINAL_RESOURCE_LIMITS.retainedPerHost)
      throw new Error("Terminal tab limit reached. Close an existing terminal before creating another.");
    this.invalidateRestore(options.resourceOwnerId ?? null);
    const runtime = this.resolveRuntime(options.hostId);
    const session = runtime.resources.terminal.open({
      resourceOwnerId: options.resourceOwnerId, command: DEFAULT_TERMINAL_COMMAND, threadId: options.threadId, projectId: options.projectId,
      cwd: options.cwd,
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
    });
    const sessionId = JSON.stringify([options.hostId, session.processId]);
    this.register(sessionId, {
      openOptions: { ...options },
      ownerId: options.resourceOwnerId ?? null,
      hostId: options.hostId,
      cwd: options.cwd ?? "",
      shell: DEFAULT_TERMINAL_COMMAND[0],
      title: "Terminal",
      session,
    });
    let announced = false;
    const announce = () => { if (!announced && !this.disposed && this.sessions.has(sessionId) && session.getSnapshot().phase === "running") { announced = true; this.directoryChanged?.(options.hostId); } };
    const stop = session.subscribe(announce);
    const entry = this.sessions.get(sessionId)!;
    this.sessions.set(sessionId, { ...entry, unsubscribe: () => { stop(); entry.unsubscribe(); } });
    announce();
    return sessionId;
  }

  get(sessionId: string): AppServerTerminalSession | null {
    return this.sessions.get(sessionId)?.session ?? null;
  }

  canOpen(hostId: string): boolean {
    try {
      const runtime = this.resolveRuntime(hostId);
      return runtime.getSnapshot().phase === "ready" && runtime.resources.host.canRequest?.("process/spawn") !== false;
    } catch { return false; }
  }

  /** Explicit user action: the previous terminal and its output remain intact. */
  openAnother(sessionId: string): string {
    this.ensureOpen();
    const entry = this.sessions.get(sessionId);
    if (!entry) throw new Error("Terminal session is unavailable");
    return this.open(entry.openOptions);
  }

  listForOwner(ownerId: string): readonly string[] {
    return this.getConversationSnapshot(ownerId).sessionIds;
  }

  getConversationSnapshot(ownerId: string): ConversationTerminalDirectorySnapshot {
    const cached = this.ownerSnapshots.get(ownerId);
    if (cached !== undefined) return cached;
    const owner = this.owners.get(ownerId);
    const sessionIds = owner?.sessionIds ?? [];
    const snapshot = Object.freeze({
      revision: owner?.revision ?? 0,
      ownerId,
      sessionIds: Object.freeze([...sessionIds]),
      activeSessionId: owner?.activeSessionId ?? null,
      sessions: Object.freeze(sessionIds.flatMap((sessionId) => {
        const entry = this.sessions.get(sessionId);
        return entry === undefined ? [] : [this.summary(sessionId, entry)];
      })),
    });
    this.ownerSnapshots.set(ownerId, snapshot);
    return snapshot;
  }

  getSnapshotForConversation(ownerId: string): ConversationTerminalReadSnapshot | null {
    const activeSessionId = this.owners.get(ownerId)?.activeSessionId;
    if (activeSessionId === null || activeSessionId === undefined) return null;
    const entry = this.sessions.get(activeSessionId);
    if (entry === undefined || entry.ownerId !== ownerId) return null;
    return Object.freeze({
      ...this.summary(activeSessionId, entry),
      ...terminalBuffer(entry.session.getSnapshot(), this.bufferLimit),
    });
  }

  setActive(sessionId: string): void {
    this.ensureOpen();
    const entry = this.sessions.get(sessionId);
    if (entry?.ownerId === null || entry === undefined) return;
    const owner = this.owners.get(entry.ownerId);
    if (owner === undefined || owner.activeSessionId === sessionId) return;
    owner.activeSessionId = sessionId;
    this.publish(entry.ownerId, owner);
  }

  subscribe(ownerId: string, listener: () => void): () => void {
    this.ensureOpen();
    const listeners = this.ownerListeners.get(ownerId) ?? new Set<() => void>();
    listeners.add(listener);
    this.ownerListeners.set(ownerId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.ownerListeners.delete(ownerId);
    };
  }

  releaseOwner(ownerId: string): void {
    this.invalidateRestore(ownerId);
    for (const [key, request] of this.restoreRequests) if (request.ownerId === ownerId) this.restoreRequests.delete(key);
    for (const sessionId of [...this.listForOwner(ownerId)]) this.release(sessionId);
    this.owners.delete(ownerId);
    this.ownerSnapshots.delete(ownerId);
    this.ownerListeners.delete(ownerId);
  }

  async restore(hostId: string, ownerId?: string, scope?: { threadId?: string | null; projectId?: string | null }, ownerAliases: readonly string[] = []): Promise<string[]> {
    this.ensureOpen();
    this.restoreRequests.set(JSON.stringify([hostId, ownerId ?? null]), { hostId, ownerId, scope, aliases: ownerAliases });
    const terminal = this.resolveRuntime(hostId).resources.terminal;
    this.invalidateRestore(ownerId ?? null);
    const revision = ownerId === undefined ? this.restoreRevision : this.ownerRestoreRevisions.get(ownerId) ?? 0;
    const owned = new Set(ownerId === undefined ? [] : [ownerId, ...ownerAliases]);
    const known = new Set([...this.sessions].filter(([, entry]) => entry.hostId === hostId && entry.ownerId === (ownerId ?? null) && entry.session.getSnapshot().phase !== "starting").map(([id]) => id));
    const listed = await terminal.list(scope);
    let processes = listed.processes;
    let complete = true;
    if (ownerId !== undefined && scope?.threadId) {
      // A PTY opened before Draft promotion still has a null Thread. Its
      // authenticated Host owns it; known conversation aliases only locate it.
      // Never adopt an unrelated bound Thread via this broader metadata read.
      try {
        const drafts = (await terminal.list()).processes.filter(process =>
          process.context?.threadId === null && owned.has(process.context.resourceOwnerId ?? ''));
        processes = [...new Map([...processes, ...drafts].map(process => [process.processHandle, process])).values()];
      } catch { complete = false; /* Partial reads cannot retire a previously adopted Draft PTY. */ }
    }
    const currentRevision = ownerId === undefined ? this.restoreRevision : this.ownerRestoreRevisions.get(ownerId) ?? 0;
    if (this.disposed || revision !== currentRevision) return [];
    const present = new Map(processes.map(process => [JSON.stringify([hostId, process.processHandle]), process]));
    for (const id of known) {
      if (this.disposed || revision !== (ownerId === undefined ? this.restoreRevision : this.ownerRestoreRevisions.get(ownerId) ?? 0)) return [];
      const entry = this.sessions.get(id); if (!entry) continue;
      const process = present.get(id);
      if (!process && complete) this.detach(id);
      else if (process?.phase === "exited" && entry.session.getSnapshot().phase !== "exited")
        await entry.session.refresh?.();
    }
    if (this.disposed || revision !== (ownerId === undefined ? this.restoreRevision : this.ownerRestoreRevisions.get(ownerId) ?? 0)) return [];
    const runningIds = new Set(processes.filter(process => process.phase === "running").map(process => JSON.stringify([hostId, process.processHandle])));
    for (const [id, retired] of this.retiredSessions) {
      if (ownerId !== undefined && retired.hostId === hostId && retired.ownerId === ownerId && !runningIds.has(id))
        this.retiredSessions.delete(id);
    }
    return processes.filter((process) => process.phase === "running"
      && !this.retiredSessions.has(JSON.stringify([hostId, process.processHandle]))
      && (ownerId === undefined || owned.has(process.context?.resourceOwnerId ?? ''))
      && (!scope?.threadId || process.context?.threadId === null || process.context?.threadId === scope.threadId)).map((process) => {
      const sessionId = JSON.stringify([hostId, process.processHandle]);
      if (!this.sessions.has(sessionId)) {
        this.register(sessionId, {
          openOptions: { hostId, resourceOwnerId: ownerId ?? process.context?.resourceOwnerId ?? undefined,
            threadId: scope?.threadId ?? process.context?.threadId, projectId: scope?.projectId ?? process.context?.projectId, cwd: process.context?.cwd ?? null },
          ownerId: ownerId ?? process.context?.resourceOwnerId ?? null,
          hostId,
          cwd: process.context?.cwd ?? "",
          shell: process.context?.shell ?? "unknown",
          title: "Terminal",
          session: terminal.attach(process.processHandle, { threadId: process.context?.threadId, projectId: process.context?.projectId }),
        });
      }
      return sessionId;
    });
  }

  /** Broadcast/digest hints only schedule authoritative Host reads; they cannot
   * fabricate a PTY, submit input, interrupt work or kill a remote resource. */
  async refreshDirectories(hostId?: string): Promise<void> {
    if (this.disposed) return;
    await Promise.all([...this.restoreRequests.values()].filter(request => (!hostId || request.hostId === hostId) && (request.ownerId === undefined || this.ownerListeners.has(request.ownerId)))
      .map(request => this.restore(request.hostId, request.ownerId, request.scope, request.aliases)));
  }

  /** A successful authoritative read removed this resource. Detach the reader,
   * never echo a kill or a directory mutation from a remote notification. */
  private detach(sessionId: string): void {
    const entry = this.sessions.get(sessionId); if (!entry) return;
    this.sessions.delete(sessionId); entry.unsubscribe();
    if (entry.ownerId !== null) {
      const owner = this.owners.get(entry.ownerId);
      if (owner) { owner.sessionIds = owner.sessionIds.filter(id => id !== sessionId); if (owner.activeSessionId === sessionId) owner.activeSessionId = owner.sessionIds.at(-1) ?? null; this.publish(entry.ownerId, owner); }
    }
    void entry.session.dispose().catch(() => {});
  }

  release(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry === undefined) return;
    this.invalidateRestore(entry.ownerId);
    this.retiredSessions.set(sessionId, { hostId: entry.hostId, ownerId: entry.ownerId });
    this.sessions.delete(sessionId);
    entry.unsubscribe();
    if (entry.ownerId !== null) {
      const owner = this.owners.get(entry.ownerId);
      if (owner !== undefined) {
        owner.sessionIds = owner.sessionIds.filter((candidate) => candidate !== sessionId);
        if (owner.activeSessionId === sessionId) {
          owner.activeSessionId = owner.sessionIds.at(-1) ?? null;
        }
        this.publish(entry.ownerId, owner);
      }
    }
    void entry.session.terminate().then(async () => {
      this.directoryChanged?.(entry.hostId);
      await entry.session.dispose();
    }).catch(() => {
      void entry.session.dispose();
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const entries = [...this.sessions.values()];
    this.sessions.clear();
    this.owners.clear();
    this.ownerSnapshots.clear();
    this.ownerListeners.clear();
    this.retiredSessions.clear();
    this.ownerRestoreRevisions.clear(); this.restoreRequests.clear();
    entries.forEach((entry) => entry.unsubscribe());
    await Promise.allSettled(entries.map(({ session }) => session.dispose()));
  }

  private invalidateRestore(ownerId: string | null): void {
    ++this.restoreRevision;
    if (ownerId !== null) this.ownerRestoreRevisions.set(ownerId, (this.ownerRestoreRevisions.get(ownerId) ?? 0) + 1);
  }

  private register(
    sessionId: string,
    input: Omit<OwnedTerminalSession, "unsubscribe">,
  ): void {
    if (this.sessions.has(sessionId)) return;
    const unsubscribe = input.session.subscribe(() => {
      if (input.ownerId !== null) {
        const owner = this.owners.get(input.ownerId);
        if (owner !== undefined) this.publish(input.ownerId, owner);
      }
    });
    this.sessions.set(sessionId, { ...input, unsubscribe });
    if (input.ownerId === null) return;
    const owner = this.owners.get(input.ownerId) ?? {
      revision: 0,
      sessionIds: [],
      activeSessionId: null,
    };
    owner.sessionIds.push(sessionId);
    owner.activeSessionId = sessionId;
    this.owners.set(input.ownerId, owner);
    this.publish(input.ownerId, owner);
  }

  private summary(
    sessionId: string,
    entry: OwnedTerminalSession,
  ): ConversationTerminalSessionSummary {
    const snapshot = entry.session.getSnapshot();
    return Object.freeze({
      sessionId,
      hostId: entry.hostId,
      processId: entry.session.processId,
      cwd: entry.cwd,
      shell: entry.shell,
      title: entry.title,
      phase: snapshot.phase,
      exitCode: snapshot.exitCode,
    });
  }

  private publish(ownerId: string, owner: OwnerState): void {
    owner.revision += 1;
    this.ownerSnapshots.delete(ownerId);
    this.getConversationSnapshot(ownerId);
    for (const listener of this.ownerListeners.get(ownerId) ?? []) listener();
  }

  private ensureOpen(): void {
    if (this.disposed) throw new Error("Conversation terminal registry is disposed");
  }
}
