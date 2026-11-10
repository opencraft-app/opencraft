import type { BridgeDelta, BridgeErrorKind, ItemShape } from '@opencraft/agent-bridge-protocol';

/** The connection is supplied by the existing Core owner. This adapter never
 * launches Codex, opens CODEX_HOME, or owns account/exec-server lifecycle. */
export interface CodexOwnerPort {
  configureExecution?(threadId:string,environment:Readonly<Record<string,string>>):Promise<void>;
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
}
export class CodexBridgeError extends Error {
  constructor(readonly kind: BridgeErrorKind, message: string) { super(message); }
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CodexBridgeError('invalid', 'Expected object');
  return value as Record<string, unknown>;
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 512) throw new CodexBridgeError('invalid', 'Expected identifier');
  return value;
}
interface Input { inputId: string; clientRequestId: string; turnId: string; nativeId: string; state: 'dispatching' | 'accepted' | 'unknown' | 'rejected'; evidence?: string }
interface Session { nativeId: string; starting?: boolean; activeTurn?: string; uncertainStart?: boolean; endedTurns: Set<string>; openedTurns: Set<string>; inputs: Map<string, Input> }
/** Provider-native translation only; canonical IDs and event ordering belong to assembler. */
export class CodexBridge {
  private sessions = new Map<string, Session>();
  constructor(private owner: CodexOwnerPort, private emit: (threadId: string, deltas: BridgeDelta[]) => void) {}
  bind(threadId: string, nativeId: string): void {
    id(threadId); id(nativeId);
    if (this.sessions.has(threadId) || [...this.sessions.values()].some(s => s.nativeId === nativeId)) throw new CodexBridgeError('explicit-reject', 'Session already bound');
    this.sessions.set(threadId, { nativeId, endedTurns: new Set(), openedTurns: new Set(), inputs: new Map() });
  }
  private session(threadId: string): Session {
    const session = this.sessions.get(threadId);
    if (!session) throw new CodexBridgeError('explicit-reject', 'Session is not bound');
    return session;
  }
  boundThreads(): readonly string[] { return [...this.sessions.keys()]; }
  nativeSession(threadId: string): string { return this.session(threadId).nativeId; }
  route(nativeId: string): string | undefined { return [...this.sessions].find(([, s]) => s.nativeId === nativeId)?.[0]; }
  async stop(threadId: string, expectedTurnId: string): Promise<unknown> {
    const session = this.session(threadId);
    if (session.activeTurn !== expectedTurnId) throw new CodexBridgeError('stale-target', 'Target turn is no longer active');
    return this.owner.request('turn/interrupt', { threadId: session.nativeId, turnId: expectedTurnId });
  }
  async close(threadId: string): Promise<void> {
    const session = this.session(threadId);
    if (session.activeTurn || session.starting || session.uncertainStart) throw new CodexBridgeError('explicit-reject', 'Active session cannot close');
    if ([...session.inputs.values()].some(input => input.state === 'unknown' || input.state === 'dispatching' || input.state === 'accepted' && !input.evidence)) throw new CodexBridgeError('explicit-reject', 'Input outcome requires reconciliation before closing');
    await this.owner.request('thread/unsubscribe', { threadId: session.nativeId });
    this.sessions.delete(threadId);
    this.emit(threadId, [{ op: 'session.ended', scope: { threadId } }]);
  }
  async start(threadId: string, params: Record<string, unknown>, cliEnvironment?: Readonly<Record<string,string>>): Promise<unknown> {
    const session = this.session(threadId);
    if (session.activeTurn || session.starting || session.uncertainStart) throw new CodexBridgeError('explicit-reject', 'Turn already active');
    if (!Array.isArray(params.input) || params.input.length === 0 || !params.input.every(value => {
      const content = record(value); return content.type === 'text' && typeof content.text === 'string';
    }) || Buffer.byteLength(JSON.stringify(params.input)) > 65536) throw new CodexBridgeError('unsupported', 'Only bounded text input is available');
    // Permission/environment preparation remains the existing owner's responsibility.
    session.starting = true;
    let nativeStartAttempted=false;
    try {
      if(cliEnvironment){if(!this.owner.configureExecution)throw new CodexBridgeError('unsupported','cliUnavailable');await this.owner.configureExecution(session.nativeId,cliEnvironment);}
      nativeStartAttempted=true;
      const result = await this.owner.request('turn/start', { ...params, threadId: session.nativeId });
      const nativeTurnId = id(record(record(result).turn).id);
      if (!session.endedTurns.has(nativeTurnId)) {
        session.activeTurn = nativeTurnId;
        if (!session.openedTurns.has(nativeTurnId)) {
          session.openedTurns.add(nativeTurnId);
          this.emit(threadId, [{ op: 'turn.open', scope: { threadId }, nativeTurnId }]);
        }
      }
      return result;
    } catch (error) {
      if(!nativeStartAttempted)throw new CodexBridgeError('unsupported','cliUnavailable');
      if (!(error instanceof CodexBridgeError) || !['explicit-reject', 'stale-target', 'invalid'].includes(error.kind)) session.uncertainStart = true;
      throw error;
    }
    finally { session.starting = false; }
  }
  async steer(threadId: string, raw: unknown): Promise<unknown> {
    const p = record(raw), session = this.session(threadId);
    const inputId = id(p.inputId), clientRequestId = id(p.clientRequestId), expectedTurnId = id(p.expectedTurnId);
    if (expectedTurnId !== session.activeTurn) throw new CodexBridgeError('stale-target', 'Target turn is no longer active');
    if (p.deliveryMethod !== undefined && p.deliveryMethod !== 'native-inject') throw new CodexBridgeError('unsupported', 'Only native injection is available');
    if (!Array.isArray(p.input) || p.input.length !== 1) throw new CodexBridgeError('invalid', 'One text input required');
    const content = record(p.input[0]);
    if (content.type !== 'text' || typeof content.text !== 'string' || Buffer.byteLength(content.text) > 65536) throw new CodexBridgeError('unsupported', 'Unsupported steer content');
    if (session.inputs.has(inputId) || [...session.inputs.values()].some(i => i.clientRequestId === clientRequestId) || [...session.inputs.values()].some(i => i.state !== 'rejected' && !i.evidence)) throw new CodexBridgeError('explicit-reject', 'Input already pending; query its status');
    // Native client identity, rather than text matching, joins events even if
    // the input event arrives before the RPC response.
    const input: Input = { inputId, clientRequestId, turnId: expectedTurnId, nativeId: clientRequestId, state: 'dispatching' };
    session.inputs.set(inputId, input);
    try {
      const result = await this.owner.request('turn/steer', { threadId: session.nativeId, expectedTurnId, clientUserMessageId: clientRequestId, input: p.input });
      input.state = 'accepted';
      this.emit(threadId, [
        { op: 'input.accepted', scope: { threadId }, nativeTurnId: expectedTurnId, inputId, clientRequestId, expectedTurnId, targetNativeSession: session.nativeId, allowedPaths: ['native-inject'], fallbackPolicy: 'reject-unknown' },
        { op: 'input.delivery', scope: { threadId }, nativeTurnId: expectedTurnId, inputId, deliveryMethod: 'native-inject', admitted: true, version: 1 },
      ]);
      return result;
    } catch (error) {
      // Only the owner's typed rejection can establish non-delivery. Transport
      // failures and unrecognized native errors remain unknown, never resent.
      input.state = error instanceof CodexBridgeError && (error.kind === 'stale-target' || error.kind === 'explicit-reject') ? 'rejected' : 'unknown';
      this.emit(threadId, [{ op: 'input.outcome', scope: { threadId }, inputId, state: input.state, reason: input.state === 'unknown' ? 'Native outcome unknown' : 'Native input rejected', version: 1 }]);
      throw error;
    }
  }
  query(threadId: string, inputId: string): Readonly<Input> | null {
    const input = this.session(threadId).inputs.get(inputId);
    return input ? { ...input } : null;
  }
  /** Consume the native stream once. Foreign/legacy sessions are ignored. */
  notification(method: string, raw: unknown): void {
    if (!['turn/started', 'turn/completed', 'item/started', 'item/completed', 'thread/tokenUsage/updated', 'item/agentMessage/delta', 'item/reasoning/textDelta', 'item/plan/delta'].includes(method)) return;
    const p = record(raw);
    const entry = [...this.sessions].find(([, s]) => s.nativeId === p.threadId);
    if (!entry) return;
    const [threadId, session] = entry, scope = { threadId };
    if (method === 'turn/started') {
      const nativeTurnId = id(record(p.turn).id);
      if (session.endedTurns.has(nativeTurnId)) return;
      session.uncertainStart = false; session.activeTurn = nativeTurnId;
      if (!session.openedTurns.has(nativeTurnId)) {
        session.openedTurns.add(nativeTurnId);
        this.emit(threadId, [{ op: 'turn.open', scope, nativeTurnId }]);
      }
    } else if (method === 'turn/completed') {
      const turn = record(p.turn), nativeTurnId = id(turn.id);
      session.endedTurns.add(nativeTurnId);
      if (session.activeTurn === nativeTurnId) session.activeTurn = undefined;
      const status = turn.status === 'failed' ? 'failed' : turn.status === 'interrupted' ? 'interrupted' : 'completed';
      this.emit(threadId, [{ op: 'turn.close', scope, nativeTurnId, status }]);
    } else if (method === 'item/started' || method === 'item/completed') {
      const item = record(p.item), nativeKey = id(item.id), nativeTurnId = id(p.turnId);
      let shape: ItemShape;
      if (item.type === 'agentMessage' && typeof item.text === 'string') shape = { kind: 'agentMessage', text: item.text };
      else if (item.type === 'plan' && typeof item.text === 'string') shape = { kind: 'plan', text: item.text };
      else if (item.type === 'reasoning' && Array.isArray(item.content)) shape = { kind: 'reasoning', text: item.content.filter((v): v is string => typeof v === 'string').join('\n') };
      else if (item.type === 'dynamicToolCall' && typeof item.tool === 'string') shape = { kind: 'tool', name: item.tool, status: item.status === 'completed' ? 'completed' : item.status === 'failed' ? 'failed' : 'inProgress', output: item.contentItems ? JSON.stringify(item.contentItems) : null };
      else if (item.type === 'userMessage' && Array.isArray(item.content)) {
        shape = { kind: 'userMessage', text: item.content.map(c => { const value = record(c); return value.type === 'text' && typeof value.text === 'string' ? value.text : ''; }).join(''), clientId: typeof item.clientId === 'string' ? item.clientId : undefined };
        // Only an explicit echoed client ID is usable. Native item IDs and
        // identical text alone do not identify an injected input.
        const input = [...session.inputs.values()].find(i => i.nativeId === item.clientId && i.turnId === nativeTurnId);
        if (input && !input.evidence) {
          input.evidence = nativeKey;
          this.emit(threadId, [{ op: 'input.evidence', scope, nativeTurnId, inputId: input.inputId, evidenceKind: 'native-input-id', evidenceRef: nativeKey, nativeInputId: nativeKey, runId: nativeTurnId, version: 1 }]);
        }
      } else if (item.type === 'commandExecution' && typeof item.command === 'string' && typeof item.cwd === 'string') shape = { kind: 'command', command: item.command, cwd: item.cwd, status: item.status === 'completed' ? 'completed' : item.status === 'failed' ? 'failed' : 'inProgress', output: typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : null };
      else { this.emit(threadId, [{ op: 'unhandled', scope, nativeTurnId, nativeKey, reason: 'Unsupported native item' }]); return; }
      this.emit(threadId, [{ op: method === 'item/started' ? 'item.open' : 'item.close', scope, nativeTurnId, nativeKey, shape }]);
    } else if (method === 'thread/tokenUsage/updated') {
      const usage = record(p.tokenUsage);
      const tokens = (raw: unknown) => {
        const value = record(raw);
        const read = (key: string) => { if (!Number.isSafeInteger(value[key]) || Number(value[key]) < 0) throw new CodexBridgeError('invalid', 'Invalid token usage'); return Number(value[key]); };
        return { totalTokens: read('totalTokens'), inputTokens: read('inputTokens'), cachedInputTokens: read('cachedInputTokens'), cacheWriteInputTokens: read('cacheWriteInputTokens'), outputTokens: read('outputTokens'), reasoningOutputTokens: read('reasoningOutputTokens') };
      };
      this.emit(threadId, [{ op: 'usage', scope, nativeTurnId: id(p.turnId), total: tokens(usage.total), last: tokens(usage.last), modelContextWindow: typeof usage.modelContextWindow === 'number' ? usage.modelContextWindow : null }]);
    } else if (['item/agentMessage/delta', 'item/reasoning/textDelta', 'item/plan/delta'].includes(method)) {
      if (typeof p.delta !== 'string') throw new CodexBridgeError('invalid', 'Invalid text delta');
      this.emit(threadId, [{ op: 'item.textDelta', scope, nativeTurnId: id(p.turnId), nativeKey: id(p.itemId), channel: method === 'item/plan/delta' ? 'plan' : method === 'item/reasoning/textDelta' ? 'reasoning' : 'agentMessage', text: p.delta }]);
    }
  }
}
