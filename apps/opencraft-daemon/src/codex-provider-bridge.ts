import { createHash, randomUUID } from 'node:crypto';
import { BridgeGateway, type BridgeGatewayOptions } from '@opencraft/agent-bridge-host/gateway';
import { LOGICAL_CLIENT_FIELD } from '@opencraft/app-host-protocol';
import type { DuplexTransport, TransportStatus, TransportSubmissionContext } from '@opencraft/appserver-client/transport';
import { OPENCRAFT_STEER_EVIDENCE_NOTIFICATION, OPENCRAFT_STEER_EVIDENCE_EXTENSION } from '@opencraft/appserver-protocol';
const object = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {};

/** Opt-in composition around the existing Core path. No gateway child/owner. */
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
  constructor(private legacy: DuplexTransport, options: BridgeGatewayOptions) {
    this.gateway = new BridgeGateway(options, (threadId, value) => {
      const frame = object(value);
      if (frame.method === 'interaction/resolved') {
        const id = object(frame.params).interactionId;
        this.interactions.delete(id);
        for (const client of this.subscriptions.get(threadId) ?? []) this.emit({ method: 'serverRequest/resolved', params: { threadId, requestId: id } }, client);
        return;
      }
      if (frame.method === 'interaction/request') {
        this.offerInteraction(threadId, frame);
        return;
      }
      for (const client of this.subscriptions.get(threadId) ?? []) {
        if (frame.method === OPENCRAFT_STEER_EVIDENCE_NOTIFICATION && !this.clients.get(client)?.evidence) continue;
        this.emit(frame, client);
      }
    });
    legacy.subscribeMessage(frame => { void this.receiveLegacy(frame).catch(() => {}); });
  }
  private offerInteraction(threadId: string, frame: Record<string, any>, onlyClient?: string): void {
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
    if (typeof params.threadId === 'string' && this.gateway.publicThread(params.threadId)) return;
    if (typeof object(params.thread).id === 'string' && this.gateway.publicThread(params.thread.id)) return;
    const key = JSON.stringify([frame[LOGICAL_CLIENT_FIELD], frame.id]), pending = this.pending.get(key);
    if (pending && ('result' in frame || 'error' in frame)) {
      this.pending.delete(key);
      if (pending.method === 'initialize' && frame.result) {
        const capabilities = object(frame.result.capabilities);
        const extensions = object(capabilities.extensions), evidence = this.clients.get(pending.client)?.evidence === true;
        const inputCapability = { version: 1, perInputEvidence: true, deliveryMethods: ['native-inject'], evidenceKinds: ['admission', 'native-input-id'], withdrawal: 'none', query: true };
        frame.result.capabilities = { ...capabilities, extensions: { ...extensions,
          'opencraft/agent-bridge': { version: 1, providerId: 'codex', threadOptIn: true, threadPrefix: 'bridge:codex:' },
          ...(evidence ? { [OPENCRAFT_STEER_EVIDENCE_EXTENSION]: inputCapability } : {}),
          'opencraft/execution-engines': { ...object(extensions['opencraft/execution-engines']), version: 1,
            providers: [...(Array.isArray(object(extensions['opencraft/execution-engines']).providers) ? object(extensions['opencraft/execution-engines']).providers : []), {
              id: 'codex-bridge', label: 'Codex', threadPrefix: 'bridge:codex:', extensions: {
                'opencraft/thread-follow-up': { version: 1, queue: false, steer: evidence },
                'opencraft/thread-lifecycle': { version: 1, fork: false, ephemeral: false, injectItems: false, rename: false, archive: false, unsubscribe: true },
                ...(evidence ? { [OPENCRAFT_STEER_EVIDENCE_EXTENSION]: inputCapability } : {}),
              },
            }],
          },
        } };
      }
      if (pending.method === 'thread/list' && Array.isArray(frame.result?.data)) frame.result.data = frame.result.data.map((thread: any) => {
        const route = this.gateway.publicThread(thread.id); return route ? this.gateway.history(route, thread) : thread;
      });
    }
    this.emit(frame);
  }
  send(frame: string): Promise<void> { return this.sendWithContext(frame, { sender: null }); }
  async sendWithContext(raw: string, context: TransportSubmissionContext): Promise<void> {
    if (context.sender !== null) throw Error('Codex core mode does not support verified sender attribution');
    context.resourceOwner?.assertCurrent();
    if (context.validUntil !== undefined && context.validUntil <= Date.now()) throw Error('Execution authorization expired');
    const frame = object(JSON.parse(raw)), p = object(frame.params), client = String(frame[LOGICAL_CLIENT_FIELD] ?? '');
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
    const optIn = frame.method === 'thread/start' && p.agentBridge !== undefined;
    const seed = String(p.agentBridge?.threadId ?? '');
    const threadId = optIn ? seed ? seed.startsWith('bridge:codex:') ? seed : `bridge:codex:${seed}` : '' : String(p.threadId ?? '');
    if (!optIn && this.gateway.publicThread(threadId)) throw Error('Use the bridge thread identity; native owner bypass refused');
    if (optIn && threadId) this.gateway.reserve(threadId);
    if (!optIn && !this.gateway.owns(threadId)) {
      if (threadId.startsWith('bridge:codex:')) throw Error('Bridge thread has no retained owner; native fallback refused');
      if (frame.id !== undefined) this.pending.set(JSON.stringify([client, frame.id]), { method: frame.method, client });
      if (this.legacy.sendWithContext) return this.legacy.sendWithContext(raw, context);
      return this.legacy.send(raw);
    }
    const identity = this.clients.get(client);
    if (!identity || frame.id === undefined) throw Error('Initialized client and request ID required');
    const subscribers = this.subscriptions.get(threadId) ?? new Set<string>(); this.subscriptions.set(threadId, subscribers);
    if (optIn || ['thread/resume', 'thread/read', 'turn/start'].includes(frame.method)) subscribers.add(client);
    if (!subscribers.has(client)) throw Error('Conversation subscription required');
    const requestKey = optIn ? p.agentBridge?.clientRequestId : p.clientUserMessageId;
    const commandId = typeof requestKey === 'string' && requestKey ? `bridge-mutation:${createHash('sha256').update(JSON.stringify([threadId, frame.method, requestKey])).digest('hex')}` : `bridge-query:${randomUUID()}`;
    const command = (method: string, params: Record<string, unknown>) => this.gateway.command(threadId, commandId, method, params);
    const execute = async () => {
      let result: unknown;
      if (optIn) {
        if (!threadId || typeof requestKey !== 'string' || !requestKey) throw Error('Bridge thread and client request identities required');
        const { agentBridge: _, ...native } = p;
        result = await command('session/create', { native });
      } else if (frame.method === 'turn/start') {
        if (!requestKey) throw Error('Stable client input identity required');
        const { threadId: _, ...native } = p;
        result = await command('turn/start', { native });
      } else if (frame.method === 'turn/steer') {
        if (!identity.evidence) throw Object.assign(Error('This client cannot represent native input admission; use a client with per-input evidence support'), { code: -32601 });
        if (!requestKey) throw Error('Stable client input identity required');
        result = await command('turn/steer', { inputId: requestKey, clientRequestId: requestKey, expectedTurnId: this.gateway.nativeTurn(threadId, p.expectedTurnId), input: p.input });
        // Existing consumers cannot represent admission-only injection as success.
        result = { ...object(result), disposition: 'steered' };
      } else if (frame.method === 'turn/interrupt') result = await command('turn/stop', { expectedTurnId: this.gateway.nativeTurn(threadId, p.turnId) });
      else if (frame.method === 'thread/resume') result = await command('session/resume', {});
      else if (frame.method === 'thread/read') result = await command('history/read', { view: 'thread', includeTurns: p.includeTurns === true });
      else if (frame.method === 'thread/turns/list') result = await command('history/read', { cursor: p.cursor ?? null });
      else if (frame.method === 'thread/items/list') result = await command('history/read', { turnId: this.gateway.nativeTurn(threadId, p.turnId), cursor: p.cursor ?? null });
      else if (frame.method === 'thread/unsubscribe') { this.revokeClient(client, threadId); result = {}; }
      else if (frame.method === 'opencraft/steer/status') result = await this.gateway.status(threadId, p.inputIds);
      else throw Object.assign(Error('Method unavailable for this bridge thread'), { code: -32601 });
      const pendingInteractions = ['thread/resume', 'thread/read'].includes(frame.method) ? await this.gateway.pendingInteractions(threadId) : [];
      if (this.clients.get(client) === identity) {
        this.emit({ id: frame.id, result: this.gateway.history(threadId, result) }, client);
        for (const pending of pendingInteractions) {
          if (this.clients.get(client) !== identity) break;
          this.offerInteraction(threadId, object(pending), client);
        }
      }
    };
    const task = execute();
    if (optIn) this.creations.add(task);
    try { await task; }
    catch (cause) {
      const error = cause as Error & { code?: number; kind?: string; commandId?: string };
      const rejected = ['explicit-reject','stale-target','invalid','unsupported'].includes(error.kind ?? '') || [-32002,-32601,-32602].includes(error.code ?? 0);
      if (this.clients.get(client) === identity) this.emit({ id: frame.id, error: { code: error.code ?? -32005, message: error.message, data: { submissionOutcome: rejected ? 'rejected' : 'unknown', retryable: false, bridgeErrorKind: error.kind ?? (rejected ? 'explicit-reject' : 'unknown-outcome'), bridgeCommandId: error.commandId } } }, client);
    }
    finally { this.creations.delete(task); }
  }
  async close() {
    this.closed = true; if (this.poll) clearInterval(this.poll);
    await this.legacy.close(); await this.gateway.close();
  }
}
