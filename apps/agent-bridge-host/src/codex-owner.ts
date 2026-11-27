import { refreshCodexExecutionConfiguration } from "@opencraft/codex-execution";
import WebSocket from 'ws';
import { stat } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { CodexCoreControlClient, openCodexNativeSocket } from '@opencraft/account-pool-host';
import { CodexCoreReadIsolation } from '@opencraft/account-pool-host/codex-core-read-isolation';
import { BRIDGE_MAX_FRAME_BYTES } from '@opencraft/agent-bridge-protocol';
import { codexDeclaration } from './codex-declaration.js';
import { CodexBridgeError, type CodexOwnerPort } from './codex.js';
import { nativeCreateDiagnostic } from './codex-create-diagnostic.js';

type InitialConfiguration = {
  config: Record<string, unknown>;
  settings: Record<string, unknown>;
};

/** An attachment, never a launcher. Account refresh, proxy and execution remain
 * in the existing Core/AppServer process. Mutations are never retried. */
export class CodexOwnerConnection implements CodexOwnerPort {
  private control?: CodexCoreControlClient;
  private brokerAuth?: { accessToken: string; chatgptAccountId: string };
  private socket?: WebSocket;
  private historyReads?: CodexCoreReadIsolation;
  private sequence = 0;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer?: ReturnType<typeof setTimeout>; method: string; threadId?:unknown; includeTurns?:unknown; initial?:InitialConfiguration; observedTurn?:boolean }>();
  private failed = false;
  serverInfo: unknown;
  constructor(private endpoint: string, private token: string,
    private notify: (method: string, params: unknown) => void,
    private interaction: (id: string | number, method: string, params: unknown) => void,
    private lost: (fault?: { method: string; reason: 'invalid-frame' | 'translation' | 'connection' }) => void,
    /** Native socket named by the deployment; otherwise the Core's health reports it. */
    private nativeSocket?: string) {}
  async connect(): Promise<void> {
    if (this.socket || this.failed) throw new Error('Connection already used');
    const control = new CodexCoreControlClient(this.endpoint, this.token);
    this.control = control;
    // An accounts-only Core serves broker auth but no runtime health.
    const [nativeSocket, auth] = await Promise.all([
      this.nativeSocket ?? control.health().then(health => health.nativeSocket), control.brokerAuth()]);
    this.brokerAuth = auth;
    this.initialAuthFresh = true;
    this.socket = openCodexNativeSocket(nativeSocket, { maxPayload: BRIDGE_MAX_FRAME_BYTES, handshakeTimeout: 5000 });
    this.historyReads = new CodexCoreReadIsolation(async () => ({ nativeSocket }), {
      maxPayload: BRIDGE_MAX_FRAME_BYTES, concurrency: 4, queue: 64, timeoutMs: 30_000,
    });
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
  private readonly initialConfigurations = new Map<string, InitialConfiguration>();
  private readonly uncertainConfigurations = new Set<string>();
  private readonly retirements = new Map<string, Record<string, any>>();
  private readonly pendingSettings = new Map<string, Record<string, any>>();
  private initialAuthFresh = false;
  async configureExecution(threadId:string,environment:Readonly<Record<string,string>>,preparationDeadlineMs=Date.now()+25000,sessionMcp?:Record<string,unknown>|null):Promise<void> {
    if(!Number.isSafeInteger(preparationDeadlineMs)||preparationDeadlineMs<=Date.now())throw new CodexBridgeError('unsupported','cliUnavailable');
    const deadline=performance.now()+Math.min(25000,preparationDeadlineMs-Date.now());
    const current=()=>{if(this.failed||performance.now()>=deadline)throw new CodexBridgeError('unsupported','cliUnavailable');};
    if(this.uncertainConfigurations.has(threadId))this.initialConfigurations.delete(threadId);
    const initial=this.initialConfigurations.get(threadId);
    let initialSettings: Record<string, unknown> | undefined;
    if(initial) {
      current();
      const read=await this.request('thread/read',{threadId,includeTurns:false},Math.max(1,deadline-performance.now())) as any;
      current();
      if(read?.thread?.status?.type!=='idle'||read.thread.ephemeral===true)throw new CodexBridgeError('unsupported','cliUnavailable');
      try {
        await this.request('thread/read',{threadId,includeTurns:true},Math.max(1,deadline-performance.now()));
        // A materialized history defeats creation evidence, even if no event was observed.
        this.initialConfigurations.delete(threadId);
      } catch(error) {
        current();
        // Native cannot list turns yet: no first message is recorded, as when it is unmaterialized.
        if(!(error instanceof CodexBridgeError)||!['unmaterialized','turns-unavailable'].includes(error.nativeReason??''))throw error;
        if(this.initialConfigurations.get(threadId)===initial) {
          const mcp=sessionMcp??{enabled:false,url:'http://127.0.0.1:1/mcp'};
          const installed=initial.config['shell_environment_policy.set']??{};
          if (isDeepStrictEqual(installed, { ...(installed as Record<string, unknown>), ...environment })
            && (sessionMcp === undefined || isDeepStrictEqual(initial.config['mcp_servers.opencraft_session'] ?? { enabled: false, url: 'http://127.0.0.1:1/mcp' }, mcp))) {
            // The admitted one-shot namespace was installed by native creation.
            return;
          }
          // A paginated history read can flush an empty rollout before
          // reporting that listing turns is unsupported. Verify that Native
          // persisted it before releasing the only live subscription.
          const path: unknown = read.thread.path;
          const persisted = error.nativeReason === 'turns-unavailable' && typeof path === 'string'
            && await stat(path).then(value => value.isFile() && value.size > 0, () => false);
          current();
          if (!persisted || this.initialConfigurations.get(threadId) !== initial)
            throw new CodexBridgeError('unsupported', 'cliUnavailable');
          // A live resume can still try to read unindexed history. The Native
          // creation reply already attested these settings on this empty Thread.
          initialSettings = initial.settings;
        }
      }
    }
    await refreshCodexExecutionConfiguration(threadId,{
      ...(Object.keys(environment).length?{'shell_environment_policy.set':environment}:{}),
      ...(sessionMcp!==undefined?{'mcp_servers.opencraft_session':sessionMcp??{enabled:false,url:'http://127.0.0.1:1/mcp'}}:{}),
    },{
      request:async(method,params)=>{
        current();
        try {return await this.request(method,params,Math.max(1,deadline-performance.now()));}
        catch(error){
          const readOnlyResume=method==='thread/resume'&&params.config===undefined;
          if(method!=='thread/read'&&!readOnlyResume&&error instanceof CodexBridgeError&&error.kind==='unknown-outcome'){
            this.initialConfigurations.delete(threadId);
            this.uncertainConfigurations.add(threadId);
          }
          throw error;
        }
      },current,
      initialSettings: initialSettings ?? this.pendingSettings.get(threadId),
      stage:()=>{},nativeStatus:()=>{},ephemeral:()=>{throw new CodexBridgeError('unsupported','cliUnavailable');},
      cancelRelease:()=>{},retirement:()=>this.retirements.get(threadId),waitForRetirement:true,retirementTimeoutMs:Math.max(1,deadline-performance.now()),
      pending:()=>new CodexBridgeError('unsupported','cliUnavailable: native runtime has not retired'),invalidate:()=>{this.initialConfigurations.delete(threadId);},
      retire:live=>{this.retirements.set(threadId,live);this.pendingSettings.set(threadId,live);},unsubscribed:()=>{},clearRetirement:()=>{this.retirements.delete(threadId);},
    });
    this.pendingSettings.delete(threadId);
    this.uncertainConfigurations.delete(threadId);
  }
  private receive(frame: unknown): void {
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw Error('Invalid native frame');
    const p = frame as Record<string, unknown>;
    if (p.method === 'account/chatgptAuthTokens/refresh' && (typeof p.id === 'string' || typeof p.id === 'number')) {
      const requestId = p.id;
      const resolveAuth = this.initialAuthFresh
        ? ((this.initialAuthFresh = false), Promise.resolve(this.brokerAuth))
        : this.control
          ? this.control.brokerAuth().then(fresh => (this.brokerAuth = fresh), () => this.brokerAuth)
          : Promise.resolve(this.brokerAuth);
      void resolveAuth
        .then(auth => {
          if (this.failed) return;
          if (!auth) {
            this.fail({ method: 'unknown', reason: 'connection' });
            return;
          }
          try { this.resolve(requestId, auth); } catch { this.fail(); }
        });
      return;
    }
    if (typeof p.method === 'string') {
      if (p.method === 'thread/settings/updated') {
        const event = p.params as { threadId?: string; threadSettings?: Record<string, unknown> } | undefined;
        const initial = event?.threadId ? this.initialConfigurations.get(event.threadId) : undefined;
        const settings = event?.threadSettings;
        if (initial && settings && Object.hasOwn(settings, 'sandboxPolicy')) {
          // The creation reply is only a baseline. A Native settings update
          // before the first input supersedes its permission and model fields.
          initial.settings = { ...initial.settings, ...settings, sandbox: settings.sandboxPolicy, reasoningEffort: settings.effort };
        }
      }
      if(p.method==='turn/started'){const threadId=(p.params as any)?.threadId;if(typeof threadId==='string'){this.initialConfigurations.delete(threadId);for(const request of this.pending.values())if(request.method==='turn/start'&&request.threadId===threadId)request.observedTurn=true;}}
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
    if (error?.code === -32072) {
      pending.reject(new CodexBridgeError('frame-too-large', 'History response is too large; use a smaller history page'));
      return;
    }
    const message = typeof error?.message === 'string' ? error.message : '';
    // Fixed native stale diagnostics; no substring inference for auth/quota or
    // transport failures. A native stale reply is a definitive rejection.
    const stale = pending.method === 'turn/steer' && (/^no active turn to steer[.!]?$/i.test(message) || /^expected active turn id\b/i.test(message));
    const unmaterialized=pending.method==='thread/read'&&pending.includeTurns===true&&typeof pending.threadId==='string'&&error?.code===-32600
      &&message===`thread ${pending.threadId} is not materialized yet; includeTurns is unavailable before first user message`;
    // Early in a new session native can also report its turn listing as not supported yet
    // (-32601); the history is not readable yet, but this is no evidence the session is new.
    // On Windows the new session's rollout file can exist before its first line is written.
    // Its metadata is unreadable then too, whether or not turns were asked for.
    const turnsUnavailable=!unmaterialized&&pending.method==='thread/read'&&(
      pending.includeTurns===true&&error?.code===-32601&&message==='list_turns is not supported yet'
      ||error?.code===-32603&&/^failed to read thread: thread-store internal error: failed to read session metadata [^\n]+: rollout at [^\n]+ is empty$/.test(message));
    const kind=stale?'stale-target':[-32600,-32601,-32602].includes(error?.code??0)?'explicit-reject':'unknown-outcome';
    if(kind==='explicit-reject'&&pending.initial&&!pending.observedTurn&&typeof pending.threadId==='string')this.initialConfigurations.set(pending.threadId,pending.initial);
    const createFailure = pending.method === "thread/start" ? nativeCreateDiagnostic(error?.code, message) : undefined;
    if (createFailure) {
      try { console.warn("[codex-native]", JSON.stringify({ event: "thread-start-rejected", requestId: p.id, ...createFailure })); }
      catch { /* Diagnostics must not turn a native reply into a transport loss. */ }
    }
    pending.reject(new CodexBridgeError(kind, stale ? 'Target turn is no longer active' : 'Native request refused; query its outcome',unmaterialized?'unmaterialized':turnsUnavailable?'turns-unavailable':undefined,createFailure));
  }
  private write(value: unknown): void {
    if (this.failed || this.socket?.readyState !== WebSocket.OPEN) throw new CodexBridgeError('unknown-outcome', 'Core connection unavailable');
    this.socket.send(JSON.stringify(value));
  }
  readHistory(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.historyReads || this.failed)
      return Promise.reject(new CodexBridgeError('unknown-outcome', 'History read connection is unavailable'));
    return this.requestNative(method, params, 30_000, this.historyReads);
  }
  request(method: string, params: Record<string, unknown>, timeoutMs = 30_000): Promise<unknown> {
    return this.requestNative(method, params, timeoutMs);
  }
  private requestNative(method: string, params: Record<string, unknown>, timeoutMs: number, historyReads?: CodexCoreReadIsolation): Promise<unknown> {
    if (this.pending.size >= 256) return Promise.reject(new CodexBridgeError('explicit-reject', 'Native request capacity reached'));
    const initial=method==='turn/start'&&typeof params.threadId==='string'?this.initialConfigurations.get(params.threadId):undefined;
    if(method==='turn/start'&&typeof params.threadId==='string')this.initialConfigurations.delete(params.threadId);
    const initialConfig=method==='thread/start'&&params.config&&typeof params.config==='object'?structuredClone(params.config) as Record<string,unknown>:undefined;
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = historyReads ? undefined : setTimeout(() => { this.pending.delete(id); reject(new CodexBridgeError('unknown-outcome', 'Native request outcome unknown')); }, timeoutMs);
      this.pending.set(id, { resolve:value=>{
        if(method==='thread/unsubscribe'&&typeof params.threadId==='string')this.initialConfigurations.delete(params.threadId);
        const nativeId=(value as any)?.thread?.id;
        if(initialConfig&&typeof nativeId==='string')this.initialConfigurations.set(nativeId,{config:initialConfig,settings:value as Record<string,unknown>});
        resolve(value);
      }, reject, timer, method,threadId:params.threadId,includeTurns:params.includeTurns,initial });
      const message = { id, method, params };
      if (historyReads) {
        // The dedicated reader owns this read's deadline and frame failure.
        void historyReads.read(message).then(reply => this.receive(JSON.parse(reply))).catch(() => {
          if (this.pending.delete(id)) reject(new CodexBridgeError('unknown-outcome', 'History read connection is unavailable'));
        });
      } else {
        try { this.write(message); }
        catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
      }
    });
  }
  reject(id: string | number): void { this.write({ id, error: { code: -32601, message: 'Native method is not supported by this bridge' } }); }
  resolve(id: string | number, result: unknown): void { this.write({ id, result }); }
  private fail(fault?: { method: string; reason: 'invalid-frame' | 'translation' | 'connection' }): void {
    if (this.failed) return;
    this.failed = true;
    this.historyReads?.close();
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new CodexBridgeError('unknown-outcome', 'Native connection lost')); }
    this.pending.clear(); this.initialConfigurations.clear(); this.socket?.terminate(); this.lost(fault ?? { method: 'unknown', reason: 'connection' });
  }
  close(): void { this.fail(); }
}
