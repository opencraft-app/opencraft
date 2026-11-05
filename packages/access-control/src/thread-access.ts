import { PermissionReadCache, withPermissionWrite } from "./permission-read-cache.js";
import { AppServerRpcError, threadUnavailableReason } from '@opencraft/appserver-client';
import type { DatabaseSync } from 'node:sqlite';
import { openServerRepository, type ServerDatabaseSource } from "@opencraft/storage-node/server-repository";
import type { ActorContext } from '@opencraft/identity-core/actors';
import type { ActorStore } from './actors.js';

import { THREAD_NOTE_EXCHANGE, THREAD_ACCESS_READ, THREAD_ACCESS_SET, THREAD_ACCESS_CHANGED, THREAD_ACCESS_REVOKED } from '@opencraft/appserver-protocol';
export { THREAD_ACCESS_READ, THREAD_ACCESS_SET, THREAD_ACCESS_CHANGED, THREAD_ACCESS_REVOKED };
type Value = Record<string, unknown>;
const object = (v: unknown): Value => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Value : {};
export interface ThreadAccessPolicy {
  serverId: string; threadId: string; creatorActorId: string | null;
  accessMode: 'shared' | 'private'; revision: number;
}
export class ThreadAccessError extends Error {
  constructor(readonly code: number, message: string) { super(message); }
}
const missing = () => new ThreadAccessError(-32004, 'Conversation not found or unavailable');
const validId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 4096;

/** Hub-owned access policy. Presentation visibility and derivation are independent. */
export class ThreadAccessStore {
  private readonly closeRepository: () => void;
  private readonly db: DatabaseSync;
  private readonly readCache: PermissionReadCache;
  private readonly readPolicy: ReturnType<DatabaseSync["prepare"]>;
  readonly outcome;
  private readonly listeners = new Set<(policy: ThreadAccessPolicy) => void>();
  constructor(path: ServerDatabaseSource, readonly actors: ActorStore, options: { permissionOwner?: object } = {}) {
    const managed = openServerRepository(path, "thread-access");
    this.closeRepository = managed.close;
    this.db = managed.database; this.outcome = managed.outcome;
    this.readCache = new PermissionReadCache(function* (this: ThreadAccessStore) {
      for (const row of this.db.prepare('SELECT * FROM thread_access').iterate()) yield [JSON.stringify([row.server_id,row.thread_id]),row] as const;
    }.bind(this), { enabled: true, owner: options.permissionOwner ?? this });
    this.readPolicy = this.db.prepare('SELECT * FROM thread_access WHERE server_id=? AND thread_id=?');
  }
  read(serverId: string, threadId: string): ThreadAccessPolicy {
    if (!validId(serverId) || !validId(threadId)) throw new ThreadAccessError(-32602,'Invalid conversation');
    const row = this.readCache.get(JSON.stringify([serverId,threadId]), () => this.readPolicy.get(serverId,threadId));
    return {serverId,threadId,creatorActorId:row?.creator_actor_id as string | null ?? null,
      accessMode:row?.access_mode as 'shared' | 'private' ?? 'shared',revision:Number(row?.revision ?? 0)};
  }
  created(serverId: string, threadId: string, context?: ActorContext): void {
    this.read(serverId,threadId);
    // Null is durable too: a later viewer cannot claim an anonymous creation.
    const creator = context && this.actors.isCurrent(context) && this.actors.get(context.actorId)?.kind === 'human' ? context.actorId : null;
    withPermissionWrite(() => this.db.prepare("INSERT OR IGNORE INTO thread_access VALUES(?,?,?,'shared',1,?)").run(serverId,threadId,creator,Date.now()), this.readCache);
  }
  readablePolicy(serverId: string, threadId: string, context?: ActorContext): ThreadAccessPolicy | null {
    const policy = this.read(serverId,threadId);
    return policy.accessMode === 'shared' || !!context && context.actorId === policy.creatorActorId && this.actors.isCurrent(context) ? policy : null;
  }
  allows(serverId: string, threadId: string, context?: ActorContext): boolean {
    return this.readablePolicy(serverId,threadId,context) !== null;
  }
  allowsActor(serverId: string, threadId: string, actorId: string): boolean {
    const policy = this.read(serverId,threadId);
    return policy.accessMode === 'shared' || policy.creatorActorId === actorId && this.actors.get(actorId)?.enabled === true;
  }
  projection(serverId: string, threadId: string, context?: ActorContext) {
    const policy = this.readablePolicy(serverId,threadId,context);
    if (!policy) throw missing();
    return {...policy, canChangeAccess:!!context && context.actorId === policy.creatorActorId && this.actors.isCurrent(context)};
  }
  set(serverId: string, threadId: string, mode: unknown, expected: unknown, context?: ActorContext) {
    if (!['shared','private'].includes(String(mode)) || !Number.isSafeInteger(expected) || Number(expected) < 1) throw new ThreadAccessError(-32602,'Invalid access policy');
    const policy = this.projection(serverId,threadId,context);
    if (!policy.canChangeAccess) throw missing();
    const next = withPermissionWrite(() => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const result = this.db.prepare('UPDATE thread_access SET access_mode=?,revision=revision+1,updated_at=? WHERE server_id=? AND thread_id=? AND creator_actor_id=? AND revision=?')
          .run(String(mode),Date.now(),serverId,threadId,context!.actorId,Number(expected));
        if (!result.changes) throw new ThreadAccessError(-32009,'Access policy changed; refresh and retry');
        const next = this.read(serverId,threadId);
        this.db.prepare('INSERT INTO thread_access_audit(server_id,thread_id,actor_id,access_mode,revision,at) VALUES(?,?,?,?,?,?)')
          .run(serverId,threadId,context!.actorId,next.accessMode,next.revision,Date.now());
        this.db.exec('COMMIT');
        return next;
      } catch (error) { if (this.db.isTransaction) this.db.exec('ROLLBACK'); throw error; }
    }, this.readCache);
    for (const listener of this.listeners) { try { listener(next); } catch { /* Observers cannot undo a committed policy. */ } }
    return this.projection(serverId,threadId,context);
  }
  subscribe(listener: (policy: ThreadAccessPolicy) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  close() { this.readCache.close(); this.listeners.clear(); this.closeRepository(); }
}

interface Pending { method: string; params: Value }
/** One authenticated logical RPC lane; responses are checked again at delivery. */
export class ThreadAccessSession {
  private readonly pending = new Map<string,Pending>();
  private readonly serverRequests = new Map<string,{id:string;serverId?:string}[]>();
  private readonly seen = new Set<string>();
  private track(id: string, serverId?: string) { this.seen.add(JSON.stringify([this.server(id,serverId),id])); }
  private readonly unsubscribe: () => void;
  constructor(private readonly store: ThreadAccessStore, private readonly server: (threadId: string, serverId?: string) => string,
    private readonly context: ActorContext | undefined, private readonly emit: (frame: string) => void,
    private readonly restoreCreator?: (threadId: string) => Promise<void>,
    private readonly assertCurrent: () => void = () => {},
    private readonly notes?: { exchange(serverId: string, threadId: string, update: string, vector: string): {update: string} },
    private readonly admittedCatalogOwner = false) {
    this.unsubscribe = store.subscribe(policy => {
      const key = JSON.stringify([policy.serverId,policy.threadId]);
      if (this.seen.has(key) && !this.store.allows(policy.serverId,policy.threadId,this.context)) {
        this.seen.delete(key);
        let local = false; try { local = this.server(policy.threadId) === policy.serverId; } catch { /* A foreign engine is not this lane. */ }
        this.emit(JSON.stringify({method:THREAD_ACCESS_REVOKED,params:{threadId:policy.threadId,serverId:policy.serverId,local}}));
      }
      // A title-free invalidation is safe even for viewers who never saw this thread.
      this.emit(JSON.stringify({method:THREAD_ACCESS_CHANGED,params:{}}));
    });
  }
  private key(packet: Value) { return JSON.stringify([packet.__opencraftClient ?? '',packet.id]); }
  private allowed(id: string, serverId?: string) { return this.store.allows(this.server(id,serverId),id,this.context); }
  private denial(packet: Value) { return JSON.stringify({id:packet.id, ...(packet.__opencraftClient === undefined ? {} : {__opencraftClient:packet.__opencraftClient}),error:{code:-32004,message:'Conversation not found or unavailable',data:{code:'THREAD_NOT_FOUND'}}}); }
  private refs(value: unknown, allowServer = true): {id:string;serverId?:string}[] {
    if (Array.isArray(value)) return value.flatMap(v => this.refs(v,allowServer));
    const row = object(value), refs: {id:string;serverId?:string}[] = [];
    const serverId = allowServer && typeof row.serverId === 'string' ? row.serverId : undefined;
    for (const key of ['threadId','thread_id']) if (validId(row[key])) refs.push({id:row[key],serverId});
    if (validId(object(row.thread).id)) refs.push({id:String(object(row.thread).id),serverId});
    if (Array.isArray(row.threadIds)) refs.push(...row.threadIds.filter(validId).map(id => ({id,serverId})));
    for (const [key,v] of Object.entries(row)) if (!['threadId','thread_id','threadIds','thread','input','content','turns','items'].includes(key)
      && v && typeof v === 'object') refs.push(...this.refs(v,allowServer));
    return refs;
  }
  private permits(ref: {id:string;serverId?:string}) { return this.allowed(ref.id,ref.serverId); }
  private requestRefs(method: string, params: Value) {
    // Native Thread RPCs do not take a serverId; an injected field cannot change their authority.
    return this.refs(params,method.startsWith('opencraft/tasks/') || method === 'opencraft/collaboration');
  }
  async receive(frame: string): Promise<boolean> {
    this.assertCurrent();
    const packet = object(JSON.parse(frame)), params = object(packet.params);
    if (typeof packet.method !== 'string') {
      const refs = this.serverRequests.get(this.key(packet));
      this.serverRequests.delete(this.key(packet));
      // Only replies to requests actually delivered on this lane may reach the native owner.
      return !refs || refs.some(ref => !this.permits(ref));
    }
    if ([...this.requestRefs(String(packet.method),params),...['parentThreadId','ancestorThreadId'].map(key => params[key]).filter(validId).map(id=>({id}))].some(ref => !this.permits(ref))) { if (packet.id !== undefined) this.emit(this.denial(packet)); return true; }
    if (packet.method === THREAD_NOTE_EXCHANGE) {
      const envelope = {id:packet.id,...(packet.__opencraftClient === undefined ? {} : {__opencraftClient:packet.__opencraftClient})};
      try {
        if (!this.notes) throw new ThreadAccessError(-32601,'Shared notes unavailable');
        if (!validId(params.threadId) || typeof params.update !== 'string' || typeof params.vector !== 'string'
          || Object.keys(params).some(key => !['threadId','update','vector'].includes(key))) throw new ThreadAccessError(-32602,'Invalid note request');
        const serverId = this.server(params.threadId);
        this.store.projection(serverId,params.threadId,this.context);
        this.track(params.threadId);
        const result = this.notes.exchange(serverId,params.threadId,params.update,params.vector);
        this.assertCurrent();
        this.emit(JSON.stringify({...envelope,result}));
      } catch (error) {
        this.emit(JSON.stringify({...envelope,error:{code:error instanceof ThreadAccessError ? error.code : -32602,message:error instanceof ThreadAccessError ? error.message : 'Invalid or oversized note update'}}));
      }
      return true;
    }
    if (packet.method === THREAD_ACCESS_READ || packet.method === THREAD_ACCESS_SET) {
      try {
        if (!validId(params.threadId) || Object.keys(params).some(key => !(packet.method === THREAD_ACCESS_READ ? ['threadId'] : ['threadId','accessMode','expectedRevision']).includes(key))) throw new ThreadAccessError(-32602,'Invalid access request');
        const serverId = this.server(params.threadId);
        if (this.store.read(serverId,params.threadId).revision === 0) await this.restoreCreator?.(params.threadId);
        this.assertCurrent();
        const result = packet.method === THREAD_ACCESS_READ ? this.store.projection(serverId,params.threadId,this.context)
          : this.store.set(serverId,params.threadId,params.accessMode,params.expectedRevision,this.context);
        this.emit(JSON.stringify({id:packet.id,...(packet.__opencraftClient === undefined ? {} : {__opencraftClient:packet.__opencraftClient}),result}));
      } catch (error) {
        this.emit(JSON.stringify({id:packet.id,error:{code:error instanceof ThreadAccessError ? error.code : -32004,message:error instanceof ThreadAccessError ? error.message : 'Conversation not found or unavailable'}}));
      }
      return true;
    }
    if (packet.id !== undefined) {
      if (this.pending.size >= 4096) throw new Error('Thread access request limit');
      this.pending.set(this.key(packet),{method:packet.method,params});
    }
    return false;
  }
  project(frame: string): string | null {
    this.assertCurrent();
    // Permission rows come from the storage owner's current committed memory projection.
    const servers = new Map<string,string>();
    const policies = new Map<string,ThreadAccessPolicy | null>();
    const serverFor = (id: string, override?: string) => {
      const key=JSON.stringify([id,override]);
      if(!servers.has(key))servers.set(key,this.server(id,override));
      return servers.get(key)!;
    };
    const policyFor = (id: string, override?: string) => {
      const serverId=serverFor(id,override),key=JSON.stringify([serverId,id]);
      if(!policies.has(key))policies.set(key,this.store.readablePolicy(serverId,id,this.context));
      return policies.get(key)!;
    };
    const allowed = (id: string, override?: string) => policyFor(id,override) !== null;
    const track = (id: string, override?: string) => this.seen.add(JSON.stringify([serverFor(id,override),id]));
    const packet = object(JSON.parse(frame));
    const pending = packet.method === undefined ? this.pending.get(this.key(packet)) : undefined;
    // An uncorrelated response has no method-specific projection authority.
    if (packet.id !== undefined && packet.method === undefined && !pending) return null;
    if (pending) {
      this.pending.delete(this.key(packet));
      if (this.requestRefs(pending.method,pending.params).some(ref => !allowed(ref.id,ref.serverId))) return this.denial(packet);
      const error = object(packet.error);
      if (this.requestRefs(pending.method,pending.params).length && typeof error.code === 'number' && typeof error.message === 'string'
        && threadUnavailableReason(new AppServerRpcError({code:error.code,message:error.message,data:error.data})) === 'not-found') return this.denial(packet);
      const threadId = object(object(packet.result).thread).id;
      if (!packet.error && ['thread/start','thread/fork'].includes(pending.method) && validId(threadId)) {
        this.store.created(serverFor(threadId),threadId,this.context);
        policies.clear();
      }
    }
    const result = object(packet.result);
    if (pending?.method === 'initialize' && !packet.error) {
      const capabilities = object(result.capabilities), extensions = object(capabilities.extensions);
      extensions['opencraft/thread-access'] = {version:1};
      // Raw engine summaries can include inaccessible records. Only an admitted
      // history projection may expose a Merkle root through this lane.
      if (!this.admittedCatalogOwner || object(extensions['opencraft/thread-directory-merkle']).admission !== 'reader')
        delete extensions['opencraft/thread-directory-merkle'];
      if (this.notes) extensions['opencraft/thread-note'] = {version:1};
      const access = object(extensions['opencraft/method-access']);
      if (Array.isArray(access.methods)) access.methods = [...new Set([...access.methods,THREAD_ACCESS_READ,THREAD_ACCESS_SET,...(this.notes ? [THREAD_NOTE_EXCHANGE] : [])])];
      capabilities.extensions = extensions; result.capabilities = capabilities;
    }
    // Thread lists/searches use id on each row rather than threadId.
    if (pending?.method === 'thread/list' && result.catalogMerkle !== undefined
      && (!this.admittedCatalogOwner || object(result.catalogMerkle).projected !== true)) {
      result.catalogMerkle = {version:1,mode:'fallback',root:'0'.repeat(64),count:0};
      result.data = [];
      result.nextCursor = null;
    }
    if (pending && ['thread/list','thread/search','thread/loaded/list','opencraft/thread-pins/list'].includes(pending.method)) {
      for (const field of ['data','threads','threadIds','results','matches']) if (Array.isArray(result[field])) {
        result[field] = (result[field] as unknown[]).filter(value => {
          const row = object(value), id = typeof value === 'string' ? value : row.threadId ?? row.id ?? object(row.thread).id;
          if (!validId(id)) return false;
          if (!allowed(id)) return false;
          // Only the trusted policy owner classifies an authorized directory row.
          if (typeof value !== 'string') {
            const target = validId(object(row.thread).id) ? object(row.thread) : row;
            target.accessMode = policyFor(id)!.accessMode;
          }
          track(id); return true;
        });
      }
      // Counts from the shared directory must not reveal hidden rows.
      for (const key of ['total','totalCount','count']) delete result[key];
    }
    const prune = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(prune).filter(v => v !== undefined);
      if (!value || typeof value !== 'object') return value;
      const row = object(value);
      // Catalog upserts/read responses carry the same authoritative metadata.
      if (validId(row.id) && typeof row.cwd === 'string' && typeof row.updatedAt === 'number') {
        if (!allowed(row.id)) return undefined;
        row.accessMode = policyFor(row.id)!.accessMode;
      }
      const own = [row.threadId,row.thread_id,object(row.thread).id].filter(validId);
      const serverId = typeof row.serverId === 'string' ? row.serverId : undefined;
      if (own.some(id => !allowed(id,serverId))) return undefined;
      for (const id of own) track(id,serverId);
      return Object.fromEntries(Object.entries(row).map(([key,v]) => [key, ['turns','items','input','content'].includes(key) ? v : prune(v)]).filter(([,v]) => v !== undefined));
    };
    const projected = prune(packet) as Value | undefined;
    if (projected === undefined || packet.result !== undefined && projected.result === undefined) return packet.id !== undefined && !packet.method ? this.denial(packet) : null;
    if (typeof packet.method === 'string' && this.refs(packet.params).some(ref => !allowed(ref.id,ref.serverId)) && !this.refs(projected.params).length) return null;
    if (packet.id !== undefined && typeof packet.method === 'string') {
      if (this.serverRequests.size >= 4096) throw new Error('Thread access server request limit');
      this.serverRequests.set(this.key(packet),this.refs(packet.params));
    }
    return JSON.stringify(projected);
  }
  close() { this.unsubscribe(); this.pending.clear(); this.serverRequests.clear(); this.seen.clear(); }
}
