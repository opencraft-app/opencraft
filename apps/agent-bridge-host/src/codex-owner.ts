import { refreshCodexExecutionConfiguration } from "@opencraft/codex-execution";
import WebSocket from 'ws';
import { CodexCoreControlClient } from '@opencraft/account-pool-host';
import { codexDeclaration } from './codex-declaration.js';
import { CodexBridgeError, type CodexOwnerPort } from './codex.js';

/** An attachment, never a launcher. Account refresh, proxy and execution remain
 * in the existing Core/AppServer process. Mutations are never retried. */
export class CodexOwnerConnection implements CodexOwnerPort {
  private brokerAuth?: { accessToken: string; chatgptAccountId: string };
  private socket?: WebSocket;
  private sequence = 0;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; method: string }>();
  private failed = false;
  serverInfo: unknown;
  constructor(private endpoint: string, private token: string,
    private notify: (method: string, params: unknown) => void,
    private interaction: (id: string | number, method: string, params: unknown) => void,
    private lost: (fault?: { method: string; reason: 'invalid-frame' | 'translation' | 'connection' }) => void) {}
  async connect(): Promise<void> {
    if (this.socket || this.failed) throw new Error('Connection already used');
    const control = new CodexCoreControlClient(this.endpoint, this.token);
    const [health, auth] = await Promise.all([control.health(), control.brokerAuth()]);
    this.brokerAuth = auth;
    this.socket = new WebSocket(`ws+unix://${health.nativeSocket}:/`, { maxPayload: 1_048_576, handshakeTimeout: 5000 });
    const socket = this.socket;
    socket.on('message', data => {
      let frame: unknown;
      try { frame = JSON.parse(String(data)); }
      catch { this.fail({ method: 'unknown', reason: 'invalid-frame' }); return; }
      try { this.receive(frame); }
      catch {
        const rawMethod = frame && typeof frame === 'object' ? (frame as Record<string, unknown>).method : undefined;
        const method = ['turn/started', 'turn/completed', 'item/started', 'item/completed', 'thread/tokenUsage/updated', 'item/agentMessage/delta', 'item/reasoning/textDelta', 'item/plan/delta'].includes(String(rawMethod)) ? String(rawMethod) : 'unknown';
        this.fail({ method, reason: 'translation' });
      }
    });
    socket.on('close', () => this.fail());
    socket.on('error', () => this.fail());
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', () => reject(new Error('Core native attachment failed')));
      socket.once('close', () => reject(new Error('Core closed during attachment')));
    });
    this.serverInfo = await this.request('initialize', { clientInfo: { name: 'opencraft-codex-bridge', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    const version = /\/(\d+)\.(\d+)\.(\d+)\b/.exec(String((this.serverInfo as { userAgent?: unknown })?.userAgent ?? ''));
    const minimum = codexDeclaration.minNativeVersion.split('.').map(Number);
    if (!version || version.slice(1).map(Number).reduce((order, value, i) => order || Math.sign(value - minimum[i]!), 0) < 0) {
      this.socket.terminate(); throw new CodexBridgeError('unsupported', 'Native Codex version is not supported by this bridge');
    }
    this.write({ method: 'initialized', params: {} });
  }
  private readonly uncertainConfigurations=new Set<string>();
  private readonly retirements = new Map<string,Record<string,any>>();
  async configureExecution(threadId:string,environment:Readonly<Record<string,string>>,preparationDeadlineMs=Date.now()+10000,sessionMcp?:Record<string,unknown>|null):Promise<void> {
    if(!Number.isSafeInteger(preparationDeadlineMs)||preparationDeadlineMs<=Date.now()||this.uncertainConfigurations.has(threadId))throw new CodexBridgeError('unsupported','cliUnavailable');
    const deadline=performance.now()+Math.min(10000,preparationDeadlineMs-Date.now());
    const current=()=>{if(this.failed||performance.now()>=deadline)throw new CodexBridgeError('unsupported','cliUnavailable');};
    await refreshCodexExecutionConfiguration(threadId,{
      ...(Object.keys(environment).length?{'shell_environment_policy.set':environment}:{}),
      ...(sessionMcp!==undefined?{'mcp_servers.opencraft_session':sessionMcp??{enabled:false,url:'http://127.0.0.1:1/mcp'}}:{}),
    },{
      request:async(method,params)=>{
        current();
        try {return await this.request(method,params,Math.max(1,deadline-performance.now()));}
        catch(error){if(method!=='thread/read'&&error instanceof CodexBridgeError&&error.kind==='unknown-outcome')this.uncertainConfigurations.add(threadId);throw error;}
      },current,
      stage:()=>{},nativeStatus:()=>{},ephemeral:()=>{throw new CodexBridgeError('unsupported','cliUnavailable');},
      cancelRelease:()=>{},retirement:()=>this.retirements.get(threadId),waitForRetirement:true,retirementTimeoutMs:Math.max(1,deadline-performance.now()),
      pending:()=>new CodexBridgeError('unsupported','cliUnavailable: native runtime has not retired'),invalidate:()=>{},
      retire:live=>{this.retirements.set(threadId,live);},unsubscribed:()=>{},clearRetirement:()=>{this.retirements.delete(threadId);},
    });
  }
  private receive(frame: unknown): void {
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw Error('Invalid native frame');
    const p = frame as Record<string, unknown>;
    if (p.method === 'account/chatgptAuthTokens/refresh' && (typeof p.id === 'string' || typeof p.id === 'number')) {
      if (!this.brokerAuth) throw Error('Broker authentication unavailable');
      this.resolve(p.id, this.brokerAuth); return;
    }
    if (typeof p.method === 'string') {
      if (typeof p.id === 'number' || typeof p.id === 'string') this.interaction(p.id, p.method, p.params);
      else this.notify(p.method, p.params);
      return;
    }
    if (typeof p.id !== 'number') return;
    const pending = this.pending.get(p.id);
    if (!pending) return;
    this.pending.delete(p.id); clearTimeout(pending.timer);
    if ('result' in p) { pending.resolve(p.result); return; }
    const error = p.error as { code?: number; message?: string } | undefined;
    const message = typeof error?.message === 'string' ? error.message : '';
    // Fixed native stale diagnostics; no substring inference for auth/quota or
    // transport failures. A native stale reply is a definitive rejection.
    const stale = pending.method === 'turn/steer' && (/^no active turn to steer[.!]?$/i.test(message) || /^expected active turn id\b/i.test(message));
    pending.reject(new CodexBridgeError(stale ? 'stale-target' : [-32600, -32601, -32602].includes(error?.code ?? 0) ? 'explicit-reject' : 'unknown-outcome', stale ? 'Target turn is no longer active' : 'Native request refused; query its outcome'));
  }
  private write(value: unknown): void {
    if (this.failed || this.socket?.readyState !== WebSocket.OPEN) throw new CodexBridgeError('unknown-outcome', 'Core connection unavailable');
    this.socket.send(JSON.stringify(value));
  }
  request(method: string, params: Record<string, unknown>,timeoutMs=30_000): Promise<unknown> {
    if (this.pending.size >= 256) return Promise.reject(new CodexBridgeError('explicit-reject', 'Native request capacity reached'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new CodexBridgeError('unknown-outcome', 'Native request outcome unknown')); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.write({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  reject(id: string | number): void { this.write({ id, error: { code: -32601, message: 'Native method is not supported by this bridge' } }); }
  resolve(id: string | number, result: unknown): void { this.write({ id, result }); }
  private fail(fault?: { method: string; reason: 'invalid-frame' | 'translation' | 'connection' }): void {
    if (this.failed) return;
    this.failed = true;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new CodexBridgeError('unknown-outcome', 'Native connection lost')); }
    this.pending.clear(); this.socket?.terminate(); this.lost(fault ?? { method: 'unknown', reason: 'connection' });
  }
  close(): void { this.fail(); }
}
