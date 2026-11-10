import { randomUUID } from 'node:crypto';
import { negotiateHandshake, type BridgeWireMessage, type BridgeRequest, type BridgeInitializeParams, type BridgeErrorKind } from '@opencraft/agent-bridge-protocol';
import { CodexBridge, CodexBridgeError, type CodexOwnerPort } from './codex.js';
import { codexDeclaration } from './codex-declaration.js';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CodexBridgeError('invalid', 'Expected parameters');
  return value as Record<string, unknown>;
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 512) throw new CodexBridgeError('invalid', 'Expected identifier');
  return value;
}
export interface CodexRuntimeOwner extends CodexOwnerPort { resolve(id: string | number, result: unknown): void; reject?(id: string | number): void }
/** One pinned generation; the Host keeps command/outbox durability. */
export class CodexBridgeRuntime {
  readonly adapter: CodexBridge;
  private initialized = false;
  private creating = new Set<string>();
  private interactions = new Map<string, { threadId: string; nativeId: string | number }>();
  constructor(private owner: CodexRuntimeOwner, private send: (message: BridgeWireMessage) => void) {
    this.adapter = new CodexBridge(owner, (threadId, deltas) => this.callback('thread/delta', { threadId, deltas }));
  }
  private callback(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', id: `codex-event:${randomUUID()}`, method, params });
  }
  lost(): void {
    for (const threadId of this.adapter.boundThreads()) this.callback('provider/recovery', { threadId, kind: 'restartRecommended', message: 'Codex connection lost; native outcome requires reconciliation', retryable: false });
  }
  notification(method: string, params: unknown): void { this.adapter.notification(method, params); }
  interaction(nativeId: string | number, method: string, raw: unknown): void {
    if (!['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/tool/requestUserInput', 'mcpServer/elicitation/request'].includes(method)) { this.owner.reject?.(nativeId); return; }
    const params = object(raw);
    const threadId = typeof params.threadId === 'string' ? this.adapter.route(params.threadId) : undefined;
    if (!threadId) { this.owner.reject?.(nativeId); return; }
    const interactionId = `codex-interaction:${randomUUID()}`;
    this.interactions.set(interactionId, { threadId, nativeId });
    this.callback('interaction/request', { threadId, interactionId, kind: method.endsWith('/requestApproval') ? 'approval' : 'question', payload: { method, params }, providerNativeIds: true });
  }
  async handle(request: BridgeRequest): Promise<void> {
    try { this.send({ jsonrpc: '2.0', id: request.id, result: await this.command(request.method, request.params) }); }
    catch (error) {
      const kind: BridgeErrorKind = error instanceof CodexBridgeError ? error.kind : 'unknown-outcome';
      const code = kind === 'stale-target' ? -32002 : kind === 'invalid' ? -32602 : kind === 'unsupported' ? -32001 : kind === 'explicit-reject' ? -32006 : -32005;
      this.send({ jsonrpc: '2.0', id: request.id, error: { code, kind, message: error instanceof CodexBridgeError ? error.message : 'Native command outcome unknown' } });
    }
  }
  private async command(method: string, raw: unknown): Promise<unknown> {
    const p = object(raw);
    if (method === 'initialize') {
      if (this.initialized) throw new CodexBridgeError('explicit-reject', 'Bridge already initialized');
      const grammar = object(p.grammarRange);
      if (!Number.isInteger(grammar.min) || !Number.isInteger(grammar.max)) throw new CodexBridgeError('invalid', 'Invalid grammar range');
      const outcome = negotiateHandshake(p as unknown as BridgeInitializeParams, codexDeclaration);
      if (!outcome.ok) throw new CodexBridgeError('unsupported', outcome.error.message);
      this.initialized = true; return outcome.result;
    }
    if (!this.initialized) throw new CodexBridgeError('explicit-reject', 'Initialize first');
    if (method === 'model/list') return this.owner.request('model/list', {});
    if (method === 'maintenance/probe') return { providerId: 'codex', attached: true };
    const threadId = identifier(p.threadId);
    switch (method) {
      case 'session/create': {
        if (this.creating.has(threadId)) throw new CodexBridgeError('explicit-reject', 'Session creation already pending');
        try { this.adapter.nativeSession(threadId); throw new CodexBridgeError('explicit-reject', 'Session already exists'); }
        catch (error) { if (!(error instanceof CodexBridgeError) || error.message !== 'Session is not bound') throw error; }
        const native = object(p.native);
        if (typeof native.cwd !== 'string' || !native.cwd.startsWith('/')) throw new CodexBridgeError('invalid', 'Explicit absolute workspace required');
        this.creating.add(threadId);
        try {
          const result = object(await this.owner.request('thread/start', native));
          const nativeId = identifier(object(result.thread).id);
          this.adapter.bind(threadId, nativeId);
          this.callback('thread/identity', { threadId, providerThreadId: nativeId, sessionRestorable: true });
          return result;
        } finally { this.creating.delete(threadId); }
      }
      case 'session/resume': {
        const nativeId = this.adapter.nativeSession(threadId);
        // Only this generation's bound session can resume; old legacy sessions
        // cannot be adopted by asking for an arbitrary native session ID.
        return this.owner.request('thread/resume', { threadId: nativeId, excludeTurns: true });
      }
      case 'session/close': await this.adapter.close(threadId); return {};
      case 'turn/start': return this.adapter.start(threadId, object(p.native));
      case 'turn/steer': return this.adapter.steer(threadId, p);
      case 'turn/stop': return this.adapter.stop(threadId, identifier(p.expectedTurnId));
      case 'input/query': return this.adapter.query(threadId, identifier(p.inputId));
      case 'input/withdraw': throw new CodexBridgeError('unsupported', 'Native input withdrawal is unavailable');
      case 'history/read': {
        if (p.view === 'thread') return this.owner.request('thread/read', { threadId: this.adapter.nativeSession(threadId), includeTurns: p.includeTurns === true });
        const nativeId = this.adapter.nativeSession(threadId);
        if (p.turnId !== undefined) return this.owner.request('thread/items/list', { threadId: nativeId, turnId: identifier(p.turnId), limit: 100, cursor: p.cursor ?? null });
        return this.owner.request('thread/turns/list', { threadId: nativeId, limit: 100, cursor: p.cursor ?? null, itemsView: 'full' });
      }
      case 'interaction/resolve': {
        const key = identifier(p.interactionId), interaction = this.interactions.get(key);
        if (!interaction || interaction.threadId !== threadId) throw new CodexBridgeError('explicit-reject', 'Interaction unavailable');
        this.owner.resolve(interaction.nativeId, p.result);
        this.interactions.delete(key); return {};
      }
      default: throw new CodexBridgeError('unsupported', 'Unsupported bridge method');
    }
  }
}
