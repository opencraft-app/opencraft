import { browserMetadataValueLimit, browserMetadataWireLimit } from '@opencraft/browser-core/metadata-limits';
import type { BrowserMetadataStorage, RemoteBrowserCatalog, BrowserRecordPort, BrowserRecordCollection, BrowserMetadataRecord } from './desktop-browser-storage';
import { serverStorageKey, serverUrl } from '../runtime/server-context';
import { browserMetadataKeys, readBrowserMetadataValue } from '@opencraft/workbench-runtime/browser-metadata-identity';

const identity = (key: string) => key;
const remoteStorageKey = 'opencraft.remote-browser-storage.v1';
const entries = [
  [browserMetadataKeys.pages, 'pages', identity],
  [browserMetadataKeys.tabs, 'tabs', identity],
  [remoteStorageKey, 'storage', serverStorageKey],
  [browserMetadataKeys.bindings, 'bindings', serverStorageKey],
] as const;
// The remote surface uses a stable API key; only its former local copy is scoped.
const apiKey = (key: string, scope: (key: string) => string) => key === remoteStorageKey ? key : scope(key);
const keys: Record<string, string> = Object.fromEntries(entries.map(([key, field, scope]) => [apiKey(key, scope), field]));
interface InitialState {
  scope: string; revision: number; values: Record<string, string>; keyRevisions?: Record<string, number>;
}
function initialState(value: unknown): InitialState {
  const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
  const revision = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
  const fields = new Set(Object.values(keys));
  if (!record(value) || typeof value.scope !== 'string' || !value.scope.length || value.scope.length > 128
    || !revision(value.revision) || !record(value.values)
    || Object.entries(value.values).some(([key, data]) => !fields.has(key) || typeof data !== 'string' || data.length > browserMetadataValueLimit(key))
    || value.keyRevisions !== undefined && (!record(value.keyRevisions)
      || Object.entries(value.keyRevisions).some(([key, data]) => !fields.has(key) || !revision(data))))
    throw Object.assign(new Error('Invalid browser state response'), { code: 'PROTOCOL_ERROR' });
  return value as unknown as InitialState;
}
/** Synchronous projection for existing tab owners; the authenticated Server is
 * the durable owner. Revision checks reject concurrent replacement by another
 * client. This contains browser metadata, never webpage editor contents. */
export class RemoteBrowserStorage implements BrowserMetadataStorage {
  private values: Record<string, string> = {};
  private revision = 0;
  private keyRevisions: Record<string, number> = {};
  private scope = '';
  private socket: WebSocket | null = null;
  private connecting: Promise<void> | null = null;
  private cancelConnect: ((error: Error) => void) | null = null;
  private pending = new Map<string, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private queued = new Map<string, { value: string; version: number }>();
  private versions: Record<string, number> = {};
  private acknowledged: Record<string, number> = {};
  private flushing = false;
  private fences = new Set<{ target: Record<string, number>; resolve(): void; reject(error: Error): void }>();
  private retryWait: { timer: ReturnType<typeof setTimeout>; wake(): void } | null = null;
  private closed = false;
  private failure: Error | null = null;
  private listeners = new Set<(error: Error) => void>();
  private recordMode = false;
  private recordValues = new Map<BrowserRecordCollection,Map<string,BrowserMetadataRecord>>();
  private pendingRecordIntents = new Map<string,{collection:BrowserRecordCollection;id:string;value:unknown}>();
  private recordTabsByPage = new Map<string,Set<string>>();
  private recordVersions = new Map<string,number>();
  private recordJobs = new Map<string,Promise<void>>();
  private recordRetryWaits = new Set<{timer:ReturnType<typeof setTimeout>;wake():void}>();
  readonly records: BrowserRecordPort = {
    rows: collection => [...(this.recordValues.get(collection)?.values()??[])].filter(row=>row.value!==null),
    get: (collection,id) => this.recordValues.get(collection)?.get(id)??null,
    put: (collection,id,value) => this.writeRecord(collection,id,value),
    remove: (collection,id) => this.writeRecord(collection,id,null),
    flushPage: pageId => this.records.flush([
      {collection:'pages',id:pageId},{collection:'storage',id:pageId},
      ...[...(this.recordTabsByPage.get(pageId)??[])].map(id=>({collection:'tabs' as const,id})),
    ]),
    flush: refs => Promise.all(refs?refs.map(ref=>this.recordJobs.get(JSON.stringify([ref.collection,ref.id]))??Promise.resolve()):[...this.recordJobs.values()]).then(()=>{}),
  };
  private recordMap(collection:BrowserRecordCollection){let map=this.recordValues.get(collection);if(!map){map=new Map();this.recordValues.set(collection,map);}return map;}
  private rememberRecord(row:BrowserMetadataRecord){
    const map=this.recordMap(row.collection),old=map.get(row.id);
    if(row.collection==='tabs'){
      if(old?.value?.pageId){const set=this.recordTabsByPage.get(old.value.pageId);set?.delete(row.id);if(!set?.size)this.recordTabsByPage.delete(old.value.pageId);}
      if(row.value?.pageId){const set=this.recordTabsByPage.get(row.value.pageId)??new Set<string>();set.add(row.id);this.recordTabsByPage.set(row.value.pageId,set);}
    }
    map.set(row.id,row);
  }
  private writeRecord(collection:BrowserRecordCollection,id:string,value:unknown){
    if(this.closed)throw new Error('Resource metadata closed');
    if(!this.isReady){this.pendingRecordIntents.set(JSON.stringify([collection,id]),{collection,id,value:structuredClone(value)});return;}
    if(!this.recordMode)throw new Error('Resource record protocol is unavailable');
    const bytes=JSON.stringify(value);if(bytes.length>64*1024)throw Object.assign(new Error('Resource record is too large'),{code:'STATE_TOO_LARGE'});
    const key=JSON.stringify([collection,id]),map=this.recordMap(collection),old=map.get(id);
    if(old&&JSON.stringify(old.value)===bytes)return;
    const immutable=JSON.parse(bytes);
    this.rememberRecord({collection,id,revision:old?.revision??0,value:immutable});
    const previous=this.recordJobs.get(key)??Promise.resolve();
    const job=previous.then(async()=>{
      if(!this.recordVersions.has(key)){
        const current=await this.requestRecord({action:'read',collection,id,scope:this.scope});
        this.recordVersions.set(key,current.revision);
        if(JSON.stringify(current.value)===bytes)return;
      }
      const input={collection,id,value:immutable,expectedRevision:this.recordVersions.get(key)??0,mutationId:crypto.randomUUID(),scope:this.scope};
      const result=await this.requestRecord(input);this.recordVersions.set(key,result.revision);
    });
    this.recordJobs.set(key,job);
    // Entity failure is observed by its flush fence. It cannot poison other resources.
    void job.then(()=>{if(this.recordJobs.get(key)===job)this.recordJobs.delete(key);},()=>{});
  }
  private async requestRecord(input:unknown):Promise<any>{
    for(let attempt=0;;attempt++){
      if(this.closed)throw new Error('Resource metadata closed');
      try{await this.connect();return await this.call(input,'records');}
      catch(error){
        if(this.closed||!this.transient(error))throw error;
        await new Promise<void>(resolve=>{
          const wait={timer:null! as ReturnType<typeof setTimeout>,wake:()=>{clearTimeout(wait.timer);this.recordRetryWaits.delete(wait);resolve();}};
          wait.timer=setTimeout(wait.wake,Math.min(30000,250*2**Math.min(attempt,7)));this.recordRetryWaits.add(wait);
        });
      }
    }
  }
  private initialized = false;
  private initialization: Promise<void> = Promise.resolve();
  get isReady() { return this.initialized && this.scope !== '' && !this.closed && !this.failure; }
  whenReady() { return this.initialization; }
  static async create(signal?: AbortSignal, deferredAdmission?: () => Promise<void>) {
    signal?.throwIfAborted();
    const storage = new RemoteBrowserStorage();
    storage.initialization = storage.initialize(signal, deferredAdmission);
    if (!deferredAdmission) await storage.initialization;
    else void storage.initialization.catch(error => storage.fail(error as Error));
    return storage;
  }
  private async initialize(signal?: AbortSignal, admission?: () => Promise<void>) {
    const abort = () => this.dispose();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      await admission?.(); signal?.throwIfAborted();
      if (this.closed) throw new Error('Browser storage closed');
      let state: InitialState;
      let recordState: any;
      for (let attempt = 0; ; attempt++) {
        signal?.throwIfAborted();
        try {
          await this.connect();
          const response=await this.call(undefined,'records');
          if(response?.protocol===2){
            recordState=response;
            state={scope:response.scope,revision:0,values:{}};
            if(typeof state.scope!=='string'||!state.scope)throw new Error('Invalid resource scope');
          }else state=initialState(response);
          signal?.throwIfAborted();
          break;
        } catch (error) {
          signal?.throwIfAborted();
          if (this.closed || this.failure || !this.transient(error)) throw error;
          await this.waitForRetry(attempt);
        }
      }
      this.values = state.values; this.revision = state.revision; this.scope = state.scope; this.keyRevisions = state.keyRevisions ?? {};
      if(recordState){
        for(const collection of ['pages','tabs','storage','bindings'] as const){
          const rows=recordState.records?.[collection];if(!Array.isArray(rows))throw new Error('Invalid resource records');
          for(const row of rows){if(row.collection!==collection||typeof row.id!=='string'||!Number.isSafeInteger(row.revision)||row.revision<1)throw new Error('Invalid resource record');this.rememberRecord(row);this.recordVersions.set(JSON.stringify([collection,row.id]),row.revision);}
        }
        let cursor=recordState.aliasCursor;
        while(cursor){
          signal?.throwIfAborted();const page=await this.call({action:'list',collection:'bindings',id:cursor,scope:this.scope},'records');
          for(const row of page.records){this.rememberRecord(row);this.recordVersions.set(JSON.stringify(['bindings',row.id]),row.revision);}
          if(page.cursor===cursor)throw new Error('Invalid resource cursor');cursor=page.cursor;
        }
        this.recordMode=true;this.initialized=true;
        if(recordState.legacyLocalImport){
          for(const [key,collection,scope] of entries){
            let bytes:string|null=null;try{bytes=readBrowserMetadataValue(localStorage,key,scope);}catch{}
            if(bytes===null)continue;
            let parsed:any;try{parsed=JSON.parse(bytes);}catch{continue;}
            const rows:[string,any][]=collection==='storage'?Object.entries(parsed):Array.isArray(parsed)?parsed.map(row=>[collection==='bindings'?row.scopeId:row.id,row]):[];
            for(const [id,value]of rows){
              if(typeof id!=='string'||!id)continue;
              const current=await this.requestRecord({action:'read',collection,id,scope:this.scope});
              if(current.revision!==0)continue;
              this.recordVersions.set(JSON.stringify([collection,id]),0);
              this.writeRecord(collection as BrowserRecordCollection,id,value);
            }
          }
          await this.flush(AbortSignal.timeout(25000));
          await this.requestRecord({action:'legacy-import-complete',scope:this.scope});
        }
        for(const intent of this.pendingRecordIntents.values())this.writeRecord(intent.collection,intent.id,intent.value);
        this.pendingRecordIntents.clear();
        return;
      }
      // One-time promotion preserves existing tabs on upgraded installations.
      // These records carry no authority; the Server still scopes every tab
      // partition/command to the authenticated owner.
      if (state.revision === 0 && Object.keys(state.values).length === 0) {
        for (const [key, , scope] of entries) {
          let legacy: string | null = null;
          try { legacy = readBrowserMetadataValue(localStorage, key, scope); } catch {}
          if (legacy !== null) this.writeItem(apiKey(key, scope), legacy);
        }
        await this.flush(AbortSignal.timeout(25000));
      }
      signal?.throwIfAborted(); this.initialized = true;
    } catch (error) { this.dispose(); signal?.throwIfAborted(); throw error; }
    finally { signal?.removeEventListener('abort', abort); }
  }
  getItem(key: string) {
    if(this.recordMode){const collection=keys[key] as BrowserRecordCollection;if(!collection)return null;const rows=this.records.rows(collection);return JSON.stringify(collection==='storage'?Object.fromEntries(rows.map(r=>[r.id,r.value])):rows.map(r=>r.value));}
    return this.values[keys[key]]??null;
  }
  setItem(key: string, value: string) {
    if (!this.isReady) throw this.failure ?? Object.assign(new Error('Browser metadata awaits authenticated initialization'), { code: 'BROWSER_UNAVAILABLE', retryable: true });
    if(this.recordMode){
      const collection=keys[key] as BrowserRecordCollection,parsed=JSON.parse(value);
      const entries:[string,unknown][]=collection==='storage'?Object.entries(parsed):parsed.map((v:any)=>[collection==='bindings'?v.scopeId:v.id,v]);
      const next=new Set(entries.map(([id])=>id));for(const row of this.records.rows(collection))if(!next.has(row.id))this.records.remove(collection,row.id);
      for(const [id,row] of entries)this.records.put(collection,id,row);return;
    }
    this.writeItem(key, value);
  }
  private writeItem(key: string, value: string) {
    const field = keys[key];
    if (!field) throw new Error('Unknown remote browser storage key');
    if (this.failure) throw this.failure;
    if (this.closed) throw new Error('Browser storage closed');
    if (!this.scope) throw Object.assign(new Error('Browser metadata awaits authenticated initialization'), { code: 'BROWSER_UNAVAILABLE', retryable: true });
    if (this.values[field] === value) return;
    if (typeof value !== 'string' || value.length > browserMetadataValueLimit(field)) {
      const error = Object.assign(new Error('Browser metadata is too large'), { code: 'STATE_TOO_LARGE' });
      throw error;
    }
    this.values[field] = value;
    const version = this.versions[field] = (this.versions[field] ?? 0) + 1;
    // Only unsent snapshots supersede one another. An uncertain in-flight
    // mutation retains its exact id, content and CAS until its outcome is known.
    this.queued.set(field, { value, version });
    void this.drain();
  }
  private async drain() {
    if (this.flushing || this.closed || this.failure) return;
    this.flushing = true;
    try {
      while (this.queued.size && !this.closed && !this.failure) {
        const [key, job] = this.queued.entries().next().value!;
        this.queued.delete(key);
        const input = { key, value: job.value, mutationId: crypto.randomUUID(), scope: this.scope,
          expectedRevision: this.revision, expectedKeyRevision: this.keyRevisions[key] ?? 0 };
        for (let attempt = 0; ; attempt++) {
          if (this.closed) throw new Error('Browser storage closed');
          try {
            await this.connect();
            const result = await this.call(input);
            if (this.closed) throw new Error('Browser storage closed');
            this.revision = Math.max(this.revision, result.revision); this.keyRevisions[key] = result.keyRevision;
            this.acknowledged[key] = job.version; this.settleFences(); break;
          } catch (error) {
            if (this.closed || !this.transient(error)) throw error;
            await this.waitForRetry(attempt);
          }
        }
      }
    } catch (error) { if (!this.closed) this.fail(error as Error); }
    finally { this.flushing = false; }
  }
  private transient(error: unknown) {
    const value = error as { code?: string; retryable?: boolean };
    return value?.code === 'DISCONNECTED' || value?.code === 'BROWSER_UNAVAILABLE' && value.retryable === true;
  }
  private waitForRetry(attempt: number) {
    return new Promise<void>(resolve => {
      const wake = () => { clearTimeout(timer); this.retryWait = null; resolve(); };
      const timer = setTimeout(wake, Math.min(30000, 250 * 2 ** Math.min(attempt, 7)));
      this.retryWait = { timer, wake };
    });
  }
  private fail(error: Error) {
    if (this.failure || this.closed) return;
    this.failure = error; this.queued.clear(); this.settleFences(error);
    for (const listener of this.listeners) listener(error);
    console.error('[browser] Remote tab metadata could not be saved');
  }
  private settleFences(error?: Error) {
    for (const fence of this.fences) {
      if (error || Object.entries(fence.target).every(([key, version]) => (this.acknowledged[key] ?? 0) >= version)) {
        this.fences.delete(fence); error ? fence.reject(error) : fence.resolve();
      }
    }
  }
  onError(listener: (error: Error) => void) { this.listeners.add(listener); if (this.failure) listener(this.failure); return () => { this.listeners.delete(listener); }; }
  flush(signal?: AbortSignal): Promise<void> {
    if (this.failure || this.closed) return Promise.reject(this.failure ?? new Error('Browser storage closed'));
    if(this.recordMode){
      if(signal?.aborted)return Promise.reject(new Error('Browser state synchronization was canceled'));
      return new Promise<void>((resolve,reject)=>{
        const abort=()=>{cleanup();reject(new Error('Browser state synchronization was canceled'));};
        const cleanup=()=>signal?.removeEventListener('abort',abort);
        signal?.addEventListener('abort',abort,{once:true});
        this.records.flush().then(()=>{cleanup();resolve();},error=>{cleanup();reject(error);});
      });
    }
    if (signal?.aborted) return Promise.reject(new Error('Browser state synchronization was canceled'));
    const target = { ...this.versions };
    if (Object.entries(target).every(([key, version]) => (this.acknowledged[key] ?? 0) >= version)) return Promise.resolve();
    // A fence captures this caller's versions, not all future page/title writes.
    return new Promise((resolve, reject) => {
      const cleanup = () => signal?.removeEventListener('abort', abort);
      const fence = { target, resolve: () => { cleanup(); resolve(); }, reject: (error: Error) => { cleanup(); reject(error); } };
      const abort = () => { this.fences.delete(fence); fence.reject(new Error('Browser state synchronization was canceled')); };
      this.fences.add(fence); signal?.addEventListener('abort', abort, { once: true });
    });
  }
  async flushAndDispose(): Promise<void> {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 2000);
    try { await this.flush(controller.signal).catch(() => {}); }
    finally { clearTimeout(timer); this.dispose(); }
  }
  async listResources(): Promise<RemoteBrowserCatalog> { await this.whenReady(); await this.connect(); return this.call(undefined, 'catalog'); }
  async closeResource(lease: string): Promise<void> { await this.whenReady(); await this.connect(); await this.call({ lease }, 'discard'); }
  dispose() {
    if (this.closed) return;
    this.closed = true; this.queued.clear(); this.pendingRecordIntents.clear(); for(const wait of this.recordRetryWaits)wait.wake(); this.retryWait?.wake();
    this.settleFences(new Error('Browser storage closed'));
    if (this.socket) this.disconnect(this.socket, new Error('Browser storage closed'));
    this.rejectPending(); this.listeners.clear();
  }
  private disconnect(socket: WebSocket, error: Error) {
    if (this.socket === socket) {
      this.socket = null; this.connecting = null;
      const cancel = this.cancelConnect; this.cancelConnect = null; cancel?.(error);
      this.rejectPending(error);
    }
    socket.close();
  }
  private rejectPending(error: Error = Object.assign(new Error('Browser state disconnected'), { code: 'DISCONNECTED' })) {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
  }
  private connect(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Browser storage closed'));
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.connecting) return this.connecting;
    const url = new URL(serverUrl('/__opencraft_browser/stream'), location.href); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(url); this.socket = ws;
    this.connecting = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.disconnect(ws, Object.assign(new Error('Browser state disconnected'), { code: 'DISCONNECTED' })), 20000);
      this.cancelConnect = error => { clearTimeout(timer); reject(error); };
      ws.onopen = () => {
        clearTimeout(timer);
        if (this.closed || this.socket !== ws) { ws.close(); reject(new Error('Browser storage closed')); return; }
        this.cancelConnect = null; resolve();
      };
      ws.onerror = () => {};
      ws.onmessage = event => {
        if (this.closed || this.socket !== ws) return;
        let message;
        try { if (typeof event.data !== 'string') throw new Error(); message = JSON.parse(event.data); if (!message || typeof message !== 'object') throw new Error(); }
        catch { const error = Object.assign(new Error('Invalid browser state response'), { code: 'PROTOCOL_ERROR' }); this.rejectPending(error); this.fail(error); ws.close(1002); return; }
        if (message.type !== 'result') return;
        const p = this.pending.get(message.id); if (!p) return;
        this.pending.delete(message.id); clearTimeout(p.timer);
        if (message.error) p.reject(Object.assign(new Error(message.error.message), { code: message.error.code, retryable: message.error.retryable === true })); else p.resolve(message.value);
      };
      ws.onclose = event => {
        clearTimeout(timer); if (this.socket !== ws) return;
        const error = event.code === 1008 ? Object.assign(new Error('Browser state authorization expired; reload OpenCraft'), { code: 'AUTHORIZATION_REQUIRED' })
          : event.code === 1009 ? Object.assign(new Error('Browser metadata is too large'), { code: 'STATE_TOO_LARGE' })
          : [1002, 1003].includes(event.code) ? Object.assign(new Error('Browser state protocol is unavailable'), { code: 'PROTOCOL_ERROR' })
          : Object.assign(new Error('Browser state disconnected'), { code: 'DISCONNECTED' });
        this.disconnect(ws, error); reject(error);
        if (error.code !== 'DISCONNECTED') this.fail(error);
      };
    });
    return this.connecting;
  }
  private call(input?: unknown, method = 'state'): Promise<any> {
    if (this.closed) return Promise.reject(new Error('Browser storage closed'));
    const socket = this.socket;
    if (socket?.readyState !== WebSocket.OPEN) return Promise.reject(Object.assign(new Error('Browser state disconnected'), { code: 'DISCONNECTED' }));
    const id = crypto.randomUUID(), payload = JSON.stringify({ id, method, input });
    if (new TextEncoder().encode(payload).byteLength > browserMetadataWireLimit)
      return Promise.reject(Object.assign(new Error('Browser metadata is too large'), { code: 'STATE_TOO_LARGE' }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = Object.assign(new Error('Browser state timed out'), { code: 'DISCONNECTED' });
        this.pending.delete(id); this.disconnect(socket, error); reject(error);
      }, 25000);
      this.pending.set(id, { resolve, reject, timer });
      try { socket.send(payload); } catch {
        clearTimeout(timer); this.pending.delete(id);
        const error = Object.assign(new Error('Browser state disconnected'), { code: 'DISCONNECTED' });
        this.disconnect(socket, error); reject(error);
      }
    });
  }
}
