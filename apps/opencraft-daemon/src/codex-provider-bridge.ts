import { createHash, randomUUID } from 'node:crypto';
import { OPENCRAFT_DESKTOP_ATTACH } from '@opencraft/appserver-protocol/desktop';
import { BridgeGateway, type BridgeGatewayOptions } from '@opencraft/agent-bridge-host/gateway';
import { LOGICAL_CLIENT_FIELD } from '@opencraft/app-host-protocol';
import type { DuplexTransport, TransportStatus, TransportSubmissionContext } from '@opencraft/appserver-client/transport';
import { OPENCRAFT_STEER_EVIDENCE_NOTIFICATION, OPENCRAFT_STEER_EVIDENCE_EXTENSION, OPENCRAFT_THREAD_GOAL_EXTENSION, OPENCRAFT_THREAD_QUEUE_EXTENSION } from '@opencraft/appserver-protocol';
import { CODEX_MAINTENANCE_READ, codexMaintenanceError, isCodexAdmission } from './codex-maintenance.js';
const object = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {};

/** Opt-in composition around the existing Core path. No gateway child/owner. */
/** Turn notifications usage collection follows (see the local Host's token usage runtime). */
const USAGE_NOTIFICATIONS = new Set(['turn/started', 'turn/completed', 'thread/tokenUsage/updated', 'thread/status/changed']);

export class CodexProviderBridge implements DuplexTransport {
  private gateway: BridgeGateway;
  private listeners = new Set<(frame: string) => void>();
  private clients = new Map<string, { evidence: boolean; epoch: number }>();
  private clientEpoch = 0;
  private subscriptions = new Map<string, Set<string>>();
  private pending = new Map<string, { method: string; client: string }>();
  private interactions = new Map<string, { threadId: string; clients: Map<string, number> }>();
  private poll?: ReturnType<typeof setInterval>;
  private closed = false;
  private connecting?: Promise<void>;
  private creations = new Set<Promise<unknown>>();
  // Bridge admissions are invisible to the legacy Host's maintenance snapshot; merge them in.
  private admissionsInFlight = 0;
  private rejectedAdmissions = 0;
  /** `admissionPaused` is the same maintenance switch the legacy Host obeys. */
  constructor(private legacy: DuplexTransport, options: BridgeGatewayOptions, private readonly policy: {
    admissionPaused?: () => boolean;
    /** Stage attachments into model-readable input, recording them for display under this client message. */
    prepareInput?: (threadId: string, clientId: string | undefined, input: readonly unknown[], context: TransportSubmissionContext) => Promise<unknown[]>;
    /** Add recorded attachments to history results. */
    projectHistory?: (method: string, params: Record<string, unknown>, result: unknown) => unknown;
    /**
     * Trusted Host dispatcher for dynamic tools (as the local Host's nativeTool). Null leaves a
     * tool to the clients; domain authorization and effect receipts belong to the dispatcher.
     */
    nativeTool?: (context: { threadId: string; turnId: string; callId: string },
      tool: { namespace: string | null; name: string }, args: unknown, signal: AbortSignal) => Promise<unknown> | null;
    /**
     * Token usage of bridge Threads, recorded under their native session and turns as the
     * local Host records its own: submissions before they are sent, their outcome once the
     * native turn is known, and the turn notifications usage collection follows.
     */
    usage?: {
      notification(method: string, params: Record<string, unknown>): void;
      begin(nativeThreadId: string, publicThreadId: string, inputId: string, mode: 'start' | 'steer', context: TransportSubmissionContext): Promise<string | undefined>;
      settle(attemptId: string, outcome: 'accepted' | 'rejected' | 'unknown', nativeThreadId: string, inputId: string, nativeTurnId?: string): void;
    };
    /** Dynamic tools every new bridge Thread declares (replacing same-named client declarations). */
    creationTools?: () => readonly Record<string, unknown>[];
    /** Live notifications of a bridge Thread, enriched as projectHistory enriches reads. */
    projectNotification?: (frame: Record<string, any>) => Record<string, any>;
    /** Whether prepareInput records verified senders (and projectHistory restores them) now. */
    senderAttribution?: () => boolean;
    /**
     * Collaboration checks of a queue request (Actor input, receipts, authorization), with
     * a finder over this Thread's queue. A reply answers the request here; null forwards it.
     */
    queueGuard?: (threadId: string, method: string, params: Record<string, unknown>, context: TransportSubmissionContext,
      find: (by: { queuedSubmissionId: string } | { clientUserMessageId: string }) => Promise<{ id: string; clientUserMessageId: string; state: string; targetTurnId: string | null } | null>)
      => Promise<{ result: Record<string, unknown> } | null>;
    /** Translate an OpenCraft permission mode into the provider's own permission fields. */
    resolvePermissions?: (selection: string, cwd: unknown) => Promise<Record<string, unknown>>;
    /** A new private directory for a Thread created without a workspace ("temporary workspace"). */
    projectlessWorkspace?: () => Promise<string>;
    /** Create every new Thread through the bridge, also for clients that do not ask for it. Off by default. */
    newThreads?: boolean;
    /**
     * The bridge owns every Thread (no legacy Host underneath): new Threads are
     * created here, and any other Thread moves here on its first Thread request.
     * One it cannot adopt is only read by the layer below. Implies newThreads.
     */
    exclusive?: boolean;
    /** Move an existing local Thread to the bridge on its next turn/start, keeping its ID. Off by default. */
    adoptExisting?: boolean;
    /** The local Host releases an idle Thread for adoption, or declines. */
    releaseForAdoption?: (threadId: string) => Promise<boolean>;
    /** Let the local title generator see a bridge Thread's creation and first turn, by native identity. */
    observeTitle?: (method: string, params: Record<string, unknown>, result: unknown) => void;
  } = {}) {
    this.gateway = new BridgeGateway(options, (threadId, value) => {
      const frame = object(value);
      this.observeEvent(threadId, frame);
      if (frame.method === 'interaction/resolved') {
        const id = object(frame.params).interactionId;
        this.interactions.delete(id);
        // Resolved elsewhere (the Turn ended): a Host tool still running stops and answers nothing.
        this.hostTools.get(id)?.abort(); this.hostTools.delete(id);
        for (const client of this.subscriptions.get(threadId) ?? []) this.emit({ method: 'serverRequest/resolved', params: { threadId, requestId: id } }, client);
        return;
      }
      if (frame.method === 'interaction/request') {
        this.offerInteraction(threadId, frame);
        return;
      }
      if (this.policy.usage && USAGE_NOTIFICATIONS.has(frame.method)) this.observeUsage(threadId, frame.method, object(frame.params));
      // Forwarded native notifications name native turns; clients know public ones.
      const params = object(frame.params);
      if (typeof params.turnId === 'string') frame.params = { ...params, turnId: this.gateway.canonicalTurn(threadId, params.turnId) ?? params.turnId };
      // Live user messages carry their recorded sender, as history reads do.
      const outgoing = this.policy.projectNotification ? this.policy.projectNotification(frame) : frame;
      for (const client of this.subscriptions.get(threadId) ?? []) {
        if (outgoing.method === OPENCRAFT_STEER_EVIDENCE_NOTIFICATION && !this.clients.get(client)?.evidence) continue;
        this.emit(outgoing, client);
      }
    });
    legacy.subscribeMessage(frame => { void this.receiveLegacy(frame).catch(() => {}); });
  }
  /**
   * Settle whether `method` on `threadId` runs on the bridge: an existing local Thread this
   * bridge would adopt for it is adopted now. Execution admission asks before it admits.
   */
  async prepareRoute(method: string, threadId: string): Promise<boolean> {
    const adopting = this.policy.exclusive ? !['thread/history/cancel', 'thread/unsubscribe'].includes(method) : method === 'turn/start' && this.policy.adoptExisting;
    if (adopting && threadId && !threadId.startsWith('bridge:codex:') && !this.gateway.owns(threadId)) await this.adopt(threadId);
    return threadId.startsWith('bridge:codex:') || this.gateway.owns(threadId);
  }
  /** Submissions whose native turn is not known yet, by public Thread and canonical turn. */
  private readonly usageAwaitingTurn = new Map<string, { attemptId: string; inputId: string; nativeThreadId: string }>();
  /** The native turn behind a canonical turn ID; a command result may already name the native turn. */
  private nativeTurnOf(threadId: string, turnId: unknown): string | undefined {
    if (typeof turnId !== 'string' || !turnId) return undefined;
    if (this.gateway.canonicalTurn(threadId, turnId) !== undefined) return turnId;
    try { return this.gateway.nativeTurn(threadId, turnId); } catch { return undefined; }
  }
  /** Turn notifications for usage collection, named by native session and turn. */
  private observeUsage(threadId: string, method: string, params: Record<string, unknown>): void {
    const nativeThreadId = this.gateway.nativeThread(threadId);
    if (!nativeThreadId) return;
    const turn = object(params.turn), canonicalTurn = typeof turn.id === 'string' ? turn.id : params.turnId;
    const nativeTurnId = this.nativeTurnOf(threadId, canonicalTurn);
    // A submission waits under the turn ID its command returned: canonical or already native.
    const awaitingKey = [canonicalTurn, nativeTurnId].filter((value): value is string => typeof value === 'string')
      .map(value => JSON.stringify([threadId, value])).find(key => this.usageAwaitingTurn.has(key));
    const awaiting = awaitingKey ? this.usageAwaitingTurn.get(awaitingKey) : undefined;
    if (awaiting && nativeTurnId) {
      this.usageAwaitingTurn.delete(awaitingKey!);
      this.policy.usage!.settle(awaiting.attemptId, 'accepted', awaiting.nativeThreadId, awaiting.inputId, nativeTurnId);
    }
    this.policy.usage!.notification(method, { ...params, threadId: nativeThreadId,
      ...(typeof params.turnId === 'string' ? { turnId: this.nativeTurnOf(threadId, params.turnId) ?? params.turnId } : {}),
      ...(typeof turn.id === 'string' ? { turn: { ...turn, id: nativeTurnId ?? turn.id } } : {}) });
  }
  /** Record a submission's usage attribution around its command, as the local Host does. */
  private async withUsage<T>(threadId: string, inputId: string, mode: 'start' | 'steer', context: TransportSubmissionContext,
    send: () => Promise<T>, acceptedTurn: (result: T) => unknown): Promise<T> {
    // A new bridge Thread's native identity may not have been pulled yet.
    if (this.policy.usage && !this.gateway.nativeThread(threadId)) await this.gateway.pull().catch(() => {});
    const nativeThreadId = this.policy.usage ? this.gateway.nativeThread(threadId) : undefined;
    const attemptId = nativeThreadId ? await this.policy.usage!.begin(nativeThreadId, threadId, inputId, mode, context) : undefined;
    let result: T;
    try { result = await send(); }
    catch (error) {
      const kind = object(error).kind;
      if (attemptId) this.policy.usage!.settle(attemptId, ['explicit-reject', 'invalid', 'stale-target'].includes(String(kind)) ? 'rejected' : 'unknown', nativeThreadId!, inputId);
      throw error;
    }
    if (attemptId) {
      const canonical = acceptedTurn(result), nativeTurnId = this.nativeTurnOf(threadId, canonical);
      if (nativeTurnId) this.policy.usage!.settle(attemptId, 'accepted', nativeThreadId!, inputId, nativeTurnId);
      else if (typeof canonical === 'string' && canonical) this.usageAwaitingTurn.set(JSON.stringify([threadId, canonical]), { attemptId, inputId, nativeThreadId: nativeThreadId! });
      else this.policy.usage!.settle(attemptId, 'unknown', nativeThreadId!, inputId);
    }
    return result;
  }
  /** Dynamic tool calls the trusted Host dispatcher answers itself, by interaction ID. */
  private readonly hostTools = new Map<string, AbortController>();
  /**
   * Offer a dynamic tool call to the Host's dispatcher first, as the local Host
   * does for its own Threads; a tool it does not own goes on to the clients.
   */
  private claimHostTool(threadId: string, frame: Record<string, any>): boolean {
    const params = object(frame.params), interactionId = params.interactionId;
    if (typeof interactionId !== 'string') return false;
    if (this.hostTools.has(interactionId)) return true;
    if (params.kind !== 'codex/dynamic-tool' || !this.policy.nativeTool) return false;
    const call = object(this.gateway.history(threadId, object(params.payload).params));
    const abort = new AbortController();
    let operation: Promise<unknown> | null;
    try {
      operation = this.policy.nativeTool({ threadId, turnId: String(call.turnId ?? ''), callId: String(call.callId ?? '') },
        { namespace: typeof call.namespace === 'string' ? call.namespace : null, name: String(call.tool ?? '') }, call.arguments, abort.signal);
    } catch (error) { operation = Promise.reject(error); }
    if (operation === null) return false;
    this.hostTools.set(interactionId, abort);
    void operation
      .catch(() => ({ success: false, contentItems: [{ type: 'inputText', text: 'Tool execution unavailable or unauthorized. Inspect the existing result before retrying.' }] }))
      .then(result => abort.signal.aborted ? undefined
        : this.gateway.command(threadId, `interaction:${interactionId}`, 'interaction/resolve', { interactionId, result }))
      .catch(() => {})
      .finally(() => { if (this.hostTools.get(interactionId) === abort) this.hostTools.delete(interactionId); });
    return true;
  }
  private offerInteraction(threadId: string, frame: Record<string, any>, onlyClient?: string): void {
    if (this.claimHostTool(threadId, frame)) return;
    const params = object(frame.params), payload = object(params.payload);
    const interaction = this.interactions.get(params.interactionId) ?? { threadId, clients: new Map<string, number>() };
    this.interactions.set(params.interactionId, interaction);
    for (const client of onlyClient ? [onlyClient] : this.subscriptions.get(threadId) ?? []) {
      const identity = this.clients.get(client);
      if (!identity || !this.subscriptions.get(threadId)?.has(client) || interaction.clients.get(client) === identity.epoch) continue;
      interaction.clients.set(client, identity.epoch);
      this.emit({ id: params.interactionId, method: payload.method, params: { ...object(this.gateway.history(threadId, payload.params)), threadId } }, client);
    }
  }
  private eventObservers = new Set<(method: string, params: Record<string, unknown>) => void>();
  /** Every Thread event the bridge delivers, whether or not a client watches that Thread (Host duties). */
  observeEvents(listener: (method: string, params: Record<string, unknown>) => void): () => void {
    this.eventObservers.add(listener);
    return () => { this.eventObservers.delete(listener); };
  }
  private observeEvent(threadId: string, frame: Record<string, any>): void {
    if (typeof frame.method !== 'string' || frame.id !== undefined || !this.eventObservers.size) return;
    const params = object(frame.params);
    const projected = object(this.gateway.history(threadId, params));
    const visible = { ...projected, threadId, ...(typeof params.turnId === 'string' ? { turnId: this.gateway.canonicalTurn(threadId, params.turnId) ?? params.turnId } : {}) };
    for (const listener of this.eventObservers) { try { listener(frame.method, visible); } catch { /* observers never affect delivery */ } }
  }
  private adoptions = new Map<string, Promise<void>>();
  /** Recently declined adoptions; retried after a while, not on every read. */
  private declined = new Map<string, number>();
  /**
   * Move an idle local Thread to the bridge under its own ID. The local Host
   * releases it first; if it declines or the Host refuses, the Thread simply
   * stays local. Nothing is executed before the Host has bound it.
   */
  private adopt(threadId: string): Promise<void> {
    const pending = this.adoptions.get(threadId);
    if (pending) return pending;
    if ((this.declined.get(threadId) ?? 0) > Date.now()) return Promise.resolve();
    const operation = (async () => {
      if (!(await this.policy.releaseForAdoption?.(threadId))) return;
      try { await this.gateway.command(threadId, `bridge-adopt:${randomUUID()}`, 'session/adopt', { providerThreadId: threadId }); this.declined.delete(threadId); }
      catch (error) {
        if (this.declined.size > 4096) this.declined.clear();
        this.declined.set(threadId, Date.now() + 30_000);
        console.warn('[codex-bridge]', JSON.stringify({ event: 'adoption-declined', reason: error instanceof Error ? error.message : 'unknown' }));
      }
    })().finally(() => this.adoptions.delete(threadId));
    this.adoptions.set(threadId, operation);
    return operation;
  }
  /** What this bridge and its Host still hold, for the Host's maintenance snapshot. */
  async maintenance(): Promise<{ pendingAdmissions: number; rejectedAdmissions: number; queued: number; unknown: number; pendingApprovals: number }> {
    const host = await this.gateway.maintenance();
    return { pendingAdmissions: this.admissionsInFlight + host.inFlight, rejectedAdmissions: this.rejectedAdmissions,
      queued: host.queued, unknown: host.unknown, pendingApprovals: this.interactions.size };
  }
  /** Public and native identities of bridge Threads, for Host services that address native Codex directly. */
  threadIdentities(): { toNative(threadId: string): string | undefined; toPublic(nativeId: string): string | undefined } {
    return { toNative: threadId => this.gateway.owns(threadId) ? this.gateway.nativeThread(threadId) : undefined, toPublic: nativeId => this.gateway.publicThread(nativeId) };
  }
  /** Rewrite native turn IDs in queue results to the public ones clients know. */
  private publicTurns(threadId: string, value: unknown): unknown {
    if (Array.isArray(value)) return value.map(entry => this.publicTurns(threadId, entry));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key,
      (key === 'targetTurnId' || key === 'turnId') && typeof entry === 'string' ? this.gateway.canonicalTurn(threadId, entry) ?? entry
        : key === 'turn' && entry && typeof entry === 'object' ? object(this.gateway.history(threadId, { turn: entry })).turn
        : this.publicTurns(threadId, entry)]));
  }
  /** Native sends lifecycle notifications only to the bridge's own connection; mirror them for subscribers. */
  private notify(threadId: string, method: string, params: Record<string, unknown>): void {
    for (const client of this.subscriptions.get(threadId) ?? []) this.emit({ method, params }, client);
  }
  private revokeClient(client: string, threadId?: string): void {
    for (const [thread, subscribers] of this.subscriptions) if (!threadId || thread === threadId) subscribers.delete(client);
    for (const interaction of this.interactions.values()) if (!threadId || interaction.threadId === threadId) interaction.clients.delete(client);
  }
  get status() { return this.legacy.status; }
  subscribeStatus(listener: (status: TransportStatus) => void) { return this.legacy.subscribeStatus(listener); }
  subscribeMessage(listener: (frame: string) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  connect(signal?: AbortSignal): Promise<void> {
    if (this.closed) return Promise.reject(Error('Bridge gateway is closed'));
    return this.connecting ??= (async () => {
      await this.gateway.open(); await this.legacy.connect(signal);
      this.poll = setInterval(() => { void this.gateway.pull().catch(() => {}); }, 100);
    })();
  }
  private emit(frame: unknown, client?: string): void {
    if (this.closed) return;
    const value = JSON.stringify({ jsonrpc: '2.0', ...object(frame), ...(client ? { [LOGICAL_CLIENT_FIELD]: client } : {}) });
    for (const listener of this.listeners) listener(value);
  }
  private async receiveLegacy(raw: string): Promise<void> {
    // Native creation can broadcast before the create response binds its public
    // identity. Await only those local creates, then filter by durable ownership.
    if (this.creations.size) await Promise.allSettled([...this.creations]);
    const frame = object(JSON.parse(raw)), params = object(frame.params);
    if (frame.method === 'account/chatgptAuthTokens/refresh') return; // existing Core account owner handles broker authentication
    const bridgeThread = typeof params.threadId === 'string' ? this.gateway.publicThread(params.threadId) : undefined;
    // Pins and generated titles of bridge Threads are written by the local Host by native identity.
    if (bridgeThread && ['thread/name/updated', 'thread/pins/updated'].includes(String(frame.method))) {
      this.emit({ ...frame, params: { ...params, threadId: bridgeThread } });
      return;
    }
    if (bridgeThread) return;
    if (typeof object(params.thread).id === 'string' && this.gateway.publicThread(params.thread.id)) return;
    const key = JSON.stringify([frame[LOGICAL_CLIENT_FIELD], frame.id]), pending = this.pending.get(key);
    if (pending && ('result' in frame || 'error' in frame)) {
      this.pending.delete(key);
      if (pending.method === CODEX_MAINTENANCE_READ && frame.result && typeof frame.result === 'object') {
        frame.result.pendingAdmissions = (Number(frame.result.pendingAdmissions) || 0) + this.admissionsInFlight;
        frame.result.rejectedAdmissions = (Number(frame.result.rejectedAdmissions) || 0) + this.rejectedAdmissions;
      }
      if (pending.method === 'initialize' && frame.result) {
        const capabilities = object(frame.result.capabilities);
        const extensions = object(capabilities.extensions), evidence = this.clients.get(pending.client)?.evidence === true;
        const inputCapability = { version: 1, perInputEvidence: true, deliveryMethods: ['native-inject'], evidenceKinds: ['admission', 'native-input-id'], withdrawal: 'none', query: true };
        const threadCapabilities = {
          'opencraft/thread-follow-up': { version: 1, queue: true, steer: evidence },
          // Host-owned queue on the shared thread-queue core.
          [OPENCRAFT_THREAD_QUEUE_EXTENSION]: { version: 2, reorder: true, atomicSteer: true, unconfirmedSteerDiscard: true, unconfirmedDeliveryRetry: true, perItemPause: true },
          'opencraft/thread-lifecycle': { version: 1, fork: true, ephemeral: false, injectItems: false, rename: true, archive: true, unsubscribe: true, delete: true },
          [OPENCRAFT_THREAD_GOAL_EXTENSION]: { version: 1, read: true, write: true },
          ...(evidence ? { [OPENCRAFT_STEER_EVIDENCE_EXTENSION]: inputCapability } : {}),
        };
        frame.result.capabilities = { ...capabilities, extensions: { ...extensions,
          // Owning every Thread, the bridge's Thread capabilities are the Host's.
          ...(this.policy.exclusive ? threadCapabilities : {}),
          'opencraft/agent-bridge': { version: 1, providerId: 'codex', threadOptIn: true, threadPrefix: 'bridge:codex:' },
          ...(evidence ? { [OPENCRAFT_STEER_EVIDENCE_EXTENSION]: inputCapability } : {}),
          'opencraft/execution-engines': { ...object(extensions['opencraft/execution-engines']), version: 1,
            providers: [...(Array.isArray(object(extensions['opencraft/execution-engines']).providers) ? object(extensions['opencraft/execution-engines']).providers : []), {
              // A provider entry is the complete capability set of its Threads; owning every Thread, it is the Host's.
              id: 'codex-bridge', label: 'Codex', threadPrefix: 'bridge:codex:', extensions: this.policy.exclusive
                ? { ...Object.fromEntries(Object.entries(extensions).filter(([key]) => !['opencraft/execution-engines', 'opencraft/agent-bridge'].includes(key))), ...threadCapabilities }
                : threadCapabilities,
            }],
          },
        } };
      }
      if ((pending.method === 'thread/list' || pending.method === 'opencraft/thread-pins/list') && Array.isArray(frame.result?.data)) frame.result.data = frame.result.data.map((thread: any) => {
        const route = this.gateway.publicThread(thread.id); return route ? this.gateway.history(route, thread) : thread;
      });
    }
    this.emit(frame);
  }
  send(frame: string): Promise<void> { return this.sendWithContext(frame, { sender: null }); }
  async sendWithContext(raw: string, context: TransportSubmissionContext): Promise<void> {
    context.resourceOwner?.assertCurrent();
    if (context.validUntil !== undefined && context.validUntil <= Date.now()) throw Error('Execution authorization expired');
    const frame = object(JSON.parse(raw)), client = String(frame[LOGICAL_CLIENT_FIELD] ?? '');
    let p = object(frame.params);
    // The bridge owns new Threads: one request is one creation, as a native thread/start is.
    if ((this.policy.newThreads || this.policy.exclusive) && frame.method === 'thread/start' && p.agentBridge === undefined && frame.id !== undefined)
      p = { ...p, agentBridge: { threadId: randomUUID(), clientRequestId: `implicit:${randomUUID()}` } };
    if (!client) throw Error('Logical client identity required');
    if (frame.method === 'initialize') { this.revokeClient(client); this.clients.set(client, { evidence: !!object(object(p.capabilities).extensions)[OPENCRAFT_STEER_EVIDENCE_EXTENSION], epoch: ++this.clientEpoch }); }
    if (frame.method === 'runtime/client/disconnect') {
      this.clients.delete(client); this.revokeClient(client);
      return this.legacy.send(raw);
    }
    if (frame.method === undefined && typeof frame.id === 'string' && frame.id.startsWith('codex-interaction:') && !this.interactions.has(frame.id)) throw Error('Interaction subscription required');
    if (frame.method === undefined && typeof frame.id === 'string' && this.interactions.has(frame.id)) {
      const interaction = this.interactions.get(frame.id)!;
      if (interaction.clients.get(client) !== this.clients.get(client)?.epoch || !this.clients.has(client) || !this.subscriptions.get(interaction.threadId)?.has(client) || !('result' in frame)) throw Error('Interaction subscription required');
      await this.gateway.command(interaction.threadId, `interaction:${frame.id}`, 'interaction/resolve', { interactionId: frame.id, result: frame.result });
      this.interactions.delete(frame.id); return;
    }
    if (frame.method === 'opencraft/thread-pins/set' && typeof p.threadId === 'string' && this.gateway.owns(p.threadId)) {
      const native = this.gateway.nativeThread(p.threadId);
      if (!native) throw Error('Bridge thread has no native session yet');
      if (frame.id !== undefined) this.pending.set(JSON.stringify([client, frame.id]), { method: frame.method, client });
      const pinned = JSON.stringify({ ...frame, params: { ...p, threadId: native } });
      return this.legacy.sendWithContext ? this.legacy.sendWithContext(pinned, context) : this.legacy.send(pinned);
    }
    // The local Host's desktop serves bridge Threads too: it reads the Thread by its native session.
    if (frame.method === OPENCRAFT_DESKTOP_ATTACH && typeof p.threadId === 'string' && this.gateway.owns(p.threadId)) {
      if (frame.id !== undefined) this.pending.set(JSON.stringify([client, frame.id]), { method: frame.method, client });
      return this.legacy.sendWithContext ? this.legacy.sendWithContext(raw, context) : this.legacy.send(raw);
    }
    // Thread orchestration control is a trusted lane of the local Host over Core's orchestration
    // channel, independent of Thread routing: a bridge parent is named by its native session.
    if (typeof frame.method === 'string' && frame.method.startsWith('opencraft/orchestration/')) {
      const parent = typeof p.threadId === 'string' && this.gateway.owns(p.threadId) ? this.gateway.nativeThread(p.threadId) : undefined;
      if (typeof p.threadId === 'string' && this.gateway.owns(p.threadId) && !parent) throw Error('Bridge thread has no native session yet');
      const routed = parent ? JSON.stringify({ ...frame, params: { ...p, threadId: parent } }) : raw;
      if (frame.id !== undefined) this.pending.set(JSON.stringify([client, frame.id]), { method: frame.method, client });
      return this.legacy.sendWithContext ? this.legacy.sendWithContext(routed, context) : this.legacy.send(routed);
    }
    const optIn = frame.method === 'thread/start' && p.agentBridge !== undefined;
    const seed = String(p.agentBridge?.threadId ?? '');
    const threadId = optIn ? seed ? seed.startsWith('bridge:codex:') ? seed : `bridge:codex:${seed}` : '' : String(p.threadId ?? '');
    // A native ID behind a different public bridge ID never reaches the legacy writer; an adopted one is its own public ID.
    const behind = this.gateway.publicThread(threadId);
    if (!optIn && behind !== undefined && behind !== threadId) throw Error('Use the bridge thread identity; native owner bypass refused');
    if (!optIn) await this.prepareRoute(String(frame.method), threadId);
    // Maintenance pauses new work on bridge threads exactly as on legacy ones;
    // steering, reads and approvals of admitted work continue.
    const admission = (optIn || this.gateway.owns(threadId)) && isCodexAdmission(frame.method, p);
    if (admission && this.policy.admissionPaused?.()) {
      this.rejectedAdmissions++;
      console.warn('[codex-admission-audit]', JSON.stringify({ event: 'codex-admission-rejected', reason: 'maintenance', route: 'bridge', method: frame.method, rejectedAdmissions: this.rejectedAdmissions }));
      if (frame.id !== undefined) this.emit({ id: frame.id, error: codexMaintenanceError() }, client);
      return;
    }
    if (optIn && threadId) this.gateway.reserve(threadId);
    // A fork of a bridge Thread is a new bridge Thread; native fork is not idempotent either.
    const forkedId = frame.method === 'thread/fork' && !optIn && this.gateway.owns(threadId) ? `bridge:codex:${randomUUID()}` : undefined;
    if (forkedId) this.gateway.reserve(forkedId);
    if (!optIn && !this.gateway.owns(threadId)) {
      if (threadId.startsWith('bridge:codex:')) throw Error('Bridge thread has no retained owner; native fallback refused');
      if (frame.id !== undefined) this.pending.set(JSON.stringify([client, frame.id]), { method: frame.method, client });
      if (this.legacy.sendWithContext) return this.legacy.sendWithContext(raw, context);
      return this.legacy.send(raw);
    }
    const identity = this.clients.get(client);
    if (!identity || frame.id === undefined) throw Error('Initialized client and request ID required');
    const subscribers = this.subscriptions.get(threadId) ?? new Set<string>(); this.subscriptions.set(threadId, subscribers);
    // Opening, sending and thread operations (which a list may issue without opening) subscribe the client.
    if (optIn || ['thread/resume', 'thread/read', 'thread/turns/list', 'thread/items/list', 'turn/start', 'thread/fork', 'thread/name/set',
      'thread/archive', 'thread/unarchive', 'thread/delete', 'thread/goal/get', 'thread/goal/set', 'thread/goal/clear'].includes(frame.method)
      || String(frame.method).startsWith('thread/queue/') || ['thread/settings/update', 'thread/history/cancel'].includes(frame.method)) subscribers.add(client);
    if (forkedId) { const forked = new Set<string>([client]); this.subscriptions.set(forkedId, forked); }
    if (!subscribers.has(client)) throw Error('Conversation subscription required');
    const requestKey = optIn ? p.agentBridge?.clientRequestId : p.clientUserMessageId;
    const commandId = typeof requestKey === 'string' && requestKey ? `bridge-mutation:${createHash('sha256').update(JSON.stringify([threadId, frame.method, requestKey])).digest('hex')}` : `bridge-query:${randomUUID()}`;
    const command = (method: string, params: Record<string, unknown>) => this.gateway.command(threadId, commandId, method, params);
    // A verified sender is recorded with the input by the Host that owns attribution; without
    // one, attributed input is refused rather than run unattributed.
    if (context.sender !== null && !(this.policy.senderAttribution?.() && this.policy.prepareInput))
      throw Error('Codex core mode does not support verified sender attribution');
    const prepare = async (input: unknown, clientId: string | undefined) =>
      this.policy.prepareInput && Array.isArray(input) ? this.policy.prepareInput(threadId, clientId, input, context) : input;
    const execute = async () => {
      let result: unknown;
      if (typeof p.permissions === 'string' && this.policy.resolvePermissions) {
        try { p = { ...p, ...await this.policy.resolvePermissions(p.permissions, p.cwd) }; }
        catch (error) { throw Object.assign(Error(error instanceof Error ? error.message : 'Permission mode unavailable'), { code: -32602, kind: 'invalid' }); }
      }
      if (optIn) {
        if (!threadId || typeof requestKey !== 'string' || !requestKey) throw Error('Bridge thread and client request identities required');
        const { agentBridge: _, ...declared } = p;
        const owned = this.policy.creationTools?.() ?? [];
        const names = new Set(owned.map(tool => String(tool.name)));
        const native = owned.length ? { ...declared, dynamicTools: [
          ...(Array.isArray(declared.dynamicTools) ? declared.dynamicTools.filter((tool: unknown) => !names.has(String(object(tool).name))) : []), ...owned] } : declared;
        // A conversation without a workspace gets its own private one, as on the local Host.
        if (native.cwd == null && this.policy.projectlessWorkspace) {
          const cwd = await this.policy.projectlessWorkspace();
          Object.assign(native, { cwd, runtimeWorkspaceRoots: [cwd] });
        }
        result = await command('session/create', { native });
        this.policy.observeTitle?.('thread/start', native, result);
      } else if (frame.method === 'turn/start') {
        if (!requestKey) throw Error('Stable client input identity required');
        const { threadId: _, opencraftExecutionAdmission,opencraftSessionMcp, ...native } = p;
        native.input = await prepare(native.input, String(requestKey));
        result = await this.withUsage(threadId, String(requestKey), 'start', context,
          () => command('turn/start', { native, executionSource:opencraftExecutionAdmission,...(opencraftSessionMcp!==undefined?{sessionMcp:opencraftSessionMcp}:{}) }),
          value => object(object(value).turn).id);
        const nativeThread = this.gateway.nativeThread(threadId);
        if (nativeThread) this.policy.observeTitle?.('turn/start', { ...native, threadId: nativeThread }, result);
      } else if (frame.method === 'turn/steer') {
        if (!identity.evidence) throw Object.assign(Error('This client cannot represent native input admission; use a client with per-input evidence support'), { code: -32601 });
        if (!requestKey) throw Error('Stable client input identity required');
        const steerInput = await prepare(p.input, String(requestKey)), expectedTurnId = this.gateway.nativeTurn(threadId, p.expectedTurnId);
        result = await this.withUsage(threadId, String(requestKey), 'steer', context,
          () => command('turn/steer', { inputId: requestKey, clientRequestId: requestKey, expectedTurnId, input: steerInput }),
          () => p.expectedTurnId);
        // Existing consumers cannot represent admission-only injection as success.
        result = { ...object(result), disposition: 'steered' };
      } else if (frame.method === 'turn/interrupt') result = await command('turn/stop', { expectedTurnId: this.gateway.nativeTurn(threadId, p.turnId) });
      else if (frame.method === 'thread/resume') result = await command('session/resume', {});
      else if (frame.method === 'thread/read') result = await this.gateway.observe(threadId, { view: 'thread', includeTurns: p.includeTurns === true });
      else if (frame.method === 'thread/turns/list') result = await this.gateway.observe(threadId, { cursor: p.cursor ?? null,
        ...(p.limit !== undefined ? { limit: p.limit } : {}),
        ...(p.sortDirection !== undefined ? { sortDirection: p.sortDirection } : {}),
        ...(p.itemsView !== undefined ? { itemsView: p.itemsView } : {}),
      });
      else if (frame.method === 'thread/items/list') result = await this.gateway.observe(threadId, { turnId: this.gateway.nativeTurn(threadId, p.turnId), cursor: p.cursor ?? null,
        ...(p.limit !== undefined ? { limit: p.limit } : {}),
      });
      else if (frame.method === 'thread/fork') {
        const { threadId: _, ...native } = p;
        result = await this.gateway.command(forkedId!, commandId, 'session/fork', { sourceThreadId: threadId, native });
      } else if (frame.method === 'thread/name/set') {
        result = await command('session/rename', { name: p.name });
        this.notify(threadId, 'thread/name/updated', { threadId, threadName: p.name });
      } else if (frame.method === 'thread/archive') { result = await command('session/archive', {}); this.notify(threadId, 'thread/archived', { threadId }); }
      else if (frame.method === 'thread/unarchive') { result = await command('session/unarchive', {}); this.notify(threadId, 'thread/unarchived', { threadId }); }
      else if (frame.method === 'thread/delete') { result = await command('session/delete', {}); this.notify(threadId, 'thread/deleted', { threadId }); }
      else if (frame.method === 'thread/goal/get') result = await command('goal/get', { native: {} });
      else if (frame.method === 'thread/goal/set') {
        const { threadId: _, ...native } = p;
        result = await command('goal/set', { native });
        const goal = object(result).goal;
        if (goal !== undefined) this.notify(threadId, 'thread/goal/updated', { threadId, goal });
      } else if (frame.method === 'thread/goal/clear') { result = await command('goal/clear', { native: {} }); this.notify(threadId, 'thread/goal/cleared', { threadId }); }
      else if (frame.method === 'thread/settings/update') { const { threadId: _, ...native } = p; result = await command('session/settings', { native }); }
      // Bridge history reads have no cancellable in-flight work in this Host.
      else if (frame.method === 'thread/history/cancel') result = { cancelled: false };
      else if (String(frame.method).startsWith('thread/queue/')) {
        const { threadId: _, ...params } = p;
        const guarded = this.policy.queueGuard ? await this.policy.queueGuard(threadId, frame.method, params, context, async by => {
          const found = object(this.publicTurns(threadId, await this.gateway.queue(threadId, 'thread/queue/find', by))).queuedSubmission;
          return found ? found as { id: string; clientUserMessageId: string; state: string; targetTurnId: string | null } : null;
        }).catch((error: Error & { code?: number }) => { throw Object.assign(error, { kind: 'explicit-reject' }); }) : null;
        // Clients name public turns; the Host queue records native ones.
        if (typeof params.expectedTurnId === 'string' && params.expectedTurnId !== 'unknown') params.expectedTurnId = this.gateway.nativeTurn(threadId, params.expectedTurnId);
        // The Host sends queued input on its own later, so attachments are staged now.
        if (params.input !== undefined) params.input = await prepare(params.input, typeof params.clientUserMessageId === 'string' ? params.clientUserMessageId : undefined);
        result = guarded ? guarded.result : this.publicTurns(threadId, await this.gateway.queue(threadId, frame.method, params));
      }
      else if (frame.method === 'thread/unsubscribe') { this.revokeClient(client, threadId); result = {}; }
      else if (frame.method === 'opencraft/steer/status') result = await this.gateway.status(threadId, p.inputIds);
      else throw Object.assign(Error('Method unavailable for this bridge thread'), { code: -32601 });
      const pendingInteractions = ['thread/resume', 'thread/read'].includes(frame.method) ? await this.gateway.pendingInteractions(threadId) : [];
      if (this.clients.get(client) === identity) {
        const visible = this.gateway.history(forkedId ?? threadId, result);
        this.emit({ id: frame.id, result: this.policy.projectHistory && ['thread/read', 'thread/turns/list', 'thread/items/list'].includes(frame.method)
          ? this.policy.projectHistory(frame.method, { ...p, threadId }, visible) : visible }, client);
        for (const pending of pendingInteractions) {
          if (this.clients.get(client) !== identity) break;
          this.offerInteraction(threadId, object(pending), client);
        }
      }
    };
    if (admission) this.admissionsInFlight++;
    const task = execute().finally(() => { if (admission) this.admissionsInFlight--; });
    if (optIn || forkedId) this.creations.add(task);
    try { await task; }
    catch (cause) {
      const error = cause as Error & { code?: number; kind?: string; commandId?: string };
      const rejected = ['explicit-reject','stale-target','invalid','unsupported'].includes(error.kind ?? '') || [-32002,-32601,-32602].includes(error.code ?? 0);
      if (this.clients.get(client) === identity) this.emit({ id: frame.id, error: { code: error.code ?? -32005, message: error.message, data: { submissionOutcome: rejected ? 'rejected' : 'unknown', retryable: false, bridgeErrorKind: error.kind ?? (rejected ? 'explicit-reject' : 'unknown-outcome'), bridgeCommandId: error.commandId } } }, client);
    }
    finally { this.creations.delete(task); }
  }
  async close() {
    for (const abort of this.hostTools.values()) abort.abort();
    this.hostTools.clear();
    this.closed = true; if (this.poll) clearInterval(this.poll);
    await this.legacy.close(); await this.gateway.close();
  }
}
