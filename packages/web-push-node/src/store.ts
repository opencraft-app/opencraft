import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { openManagedDatabase, type DatabaseOutcome } from '@opencraft/sqlite-node';
import type { ActorContext } from '@opencraft/identity-core/actors';

export interface PushSubscriptionData { endpoint: string; keys: { p256dh: string; auth: string } }
export type NotificationTarget = {kind:'bark';url:string} | {kind:'webhook';url:string;authorization?:string} | {kind:'im';channelId:string;senderId:string;label:string;methodId?:string;methodLabel?:string};
export interface PushBinding { context: ActorContext; loginDigest?: string }
export interface PushDevice {
  id: string; actorId: string; bindingId: string; authorization: PushBinding;
  subscription: PushSubscriptionData | null; target?: NotificationTarget; enabled: boolean; origin: string; basePath: string; locale: string; messages: Record<string,string>;
}
export interface PushWatch {
  id: string; actorId: string; serverId: string; hostId: string; threadId: string;
  inputId: string; turnId: string | null; createdAt: number;
}
export interface PushDelivery { id: string; device: PushDevice; hostId: string; threadId: string; turnId: string; status: string; attempts: number }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const SCHEMA = `
CREATE TABLE push_keys (id INTEGER PRIMARY KEY CHECK(id=1), public_key TEXT NOT NULL, private_key TEXT NOT NULL) STRICT;
CREATE TABLE push_devices (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, binding_id TEXT NOT NULL, authorization TEXT NOT NULL, subscription TEXT NOT NULL, origin TEXT NOT NULL, base_path TEXT NOT NULL, locale TEXT NOT NULL, messages TEXT NOT NULL) STRICT;
CREATE INDEX push_devices_actor ON push_devices(actor_id);
CREATE TABLE push_watches (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, server_id TEXT NOT NULL, host_id TEXT NOT NULL, thread_id TEXT NOT NULL, input_id TEXT NOT NULL, turn_id TEXT, created_at INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0) STRICT;
CREATE INDEX push_watches_pending ON push_watches(done,created_at);
CREATE TABLE push_deliveries (id TEXT PRIMARY KEY, device_id TEXT NOT NULL, binding_id TEXT NOT NULL, host_id TEXT NOT NULL, thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, created_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending') STRICT;
CREATE INDEX push_deliveries_due ON push_deliveries(state,next_at);
`.trim();

const targetKey = (target: NotificationTarget) => hash(target.kind==='im' ? ['im',target.channelId,target.senderId] : target);

/** One server process owns this private store. No browser credentials are stored. */
export class PushStore {
  readonly outcome: DatabaseOutcome;
  private readonly db: DatabaseSync;
  constructor(path: string, private readonly now = Date.now) {
    const managed = openManagedDatabase({schemaId: 'web-push-node', path, migrations:[{version:1,name:'web-push-subscriptions-and-outbox',sql:SCHEMA}]});
    this.db = managed.database; this.outcome = managed.outcome;
  }
  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  keys(create: () => {publicKey:string;privateKey:string}) {
    const row = this.db.prepare('SELECT * FROM push_keys WHERE id=1').get();
    if (row) return {publicKey:String(row.public_key),privateKey:String(row.private_key)};
    const keys = create(); this.db.prepare('INSERT INTO push_keys VALUES(1,?,?)').run(keys.publicKey,keys.privateKey); return keys;
  }
  private device(row: Record<string, any>): PushDevice {
    return {id:row.id,actorId:row.actor_id,bindingId:row.binding_id,authorization:JSON.parse(row.authorization),
      subscription:JSON.parse(row.subscription),target:row.target ? JSON.parse(row.target) : undefined,enabled:row.enabled !== 0,origin:row.origin,basePath:row.base_path,locale:row.locale,messages:JSON.parse(row.messages)};
  }
  get(id: string): PushDevice | null {
    const row = this.db.prepare('SELECT * FROM push_devices WHERE id=?').get(id); return row ? this.device(row) : null;
  }
  register(authorization: PushBinding, subscription: PushSubscriptionData, origin: string, basePath: string, locale: string, messages: Record<string,string>): PushDevice {
    const actorId = authorization.context.actorId, id = hash(subscription.endpoint), previous = this.get(id);
    if (!previous && Number(this.db.prepare('SELECT count(*) n FROM push_devices WHERE actor_id=?').get(actorId)!.n) >= 16) throw new Error('device_limit');
    const bindingId = previous?.actorId === actorId && JSON.stringify(previous.subscription) === JSON.stringify(subscription)
      && previous.origin === origin && previous.basePath === basePath ? previous.bindingId : randomUUID();
    this.db.prepare(`INSERT INTO push_devices(id,actor_id,binding_id,authorization,subscription,origin,base_path,locale,messages) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      actor_id=excluded.actor_id,binding_id=excluded.binding_id,authorization=excluded.authorization,subscription=excluded.subscription,origin=excluded.origin,base_path=excluded.base_path,locale=excluded.locale,messages=excluded.messages`)
      .run(id,actorId,bindingId,JSON.stringify(authorization),JSON.stringify(subscription),origin,basePath,locale,JSON.stringify(messages));
    return this.get(id)!;
  }
  master(actorId: string): boolean { return this.db.prepare('SELECT enabled FROM push_preferences WHERE actor_id=?').get(actorId)?.enabled !== 0; }
  setMaster(actorId: string, enabled: boolean) {
    this.transaction(() => {
      this.db.prepare('INSERT INTO push_preferences(actor_id,enabled,defaults_blocked) VALUES(?,?,?) ON CONFLICT(actor_id) DO UPDATE SET enabled=excluded.enabled,defaults_blocked=MAX(defaults_blocked,excluded.defaults_blocked)').run(actorId, enabled?1:0, enabled?0:1);
      if (!enabled) {
        this.db.prepare("UPDATE push_deliveries SET state='dead' WHERE device_id IN (SELECT id FROM push_devices WHERE actor_id=?) AND state='pending'").run(actorId);
        this.db.prepare('UPDATE push_watches SET done=1 WHERE actor_id=?').run(actorId);
      }
    });
  }
  setEnabled(id: string, actorId: string, enabled: boolean) {
    this.transaction(() => {
      this.db.prepare('UPDATE push_devices SET enabled=? WHERE id=? AND actor_id=?').run(enabled?1:0,id,actorId);
      if (!enabled && this.get(id)?.actorId===actorId) {
        this.rememberOptOut(actorId,this.get(id)?.target);
        this.db.prepare("UPDATE push_deliveries SET state='dead' WHERE device_id=? AND state='pending'").run(id);
      }
    });
  }
  private rememberOptOut(actorId: string, target?: NotificationTarget) {
    if(target)this.db.prepare('INSERT OR IGNORE INTO push_target_opt_outs VALUES(?,?)').run(actorId,targetKey(target));
  }
  /** Decision and target creation share the Worker's transaction. Policy IDs never impersonate Actors. */
  initializeDefault(authorization: PushBinding, policyId: string, target: Extract<NotificationTarget,{kind:'im'}>, origin: string, basePath: string, locale: string, messages: Record<string,string>): void {
    if(!/^[a-zA-Z0-9._:-]{1,128}$/u.test(policyId))throw Error('invalid_default_policy');
    const actorId=authorization.context.actorId;
    this.transaction(() => {
      const decided=!!this.db.prepare('SELECT 1 FROM push_default_decisions WHERE actor_id=? AND policy_id=?').get(actorId,policyId);
      const blocked=this.db.prepare('SELECT defaults_blocked FROM push_preferences WHERE actor_id=?').get(actorId)?.defaults_blocked===1
        || this.db.prepare('SELECT 1 FROM push_target_opt_outs WHERE actor_id=? AND target_key=?').get(actorId,targetKey(target));
      const existing=this.devices(actorId).find(device=>device.target && targetKey(device.target)===targetKey(target));
      // Refresh only the same enabled verified destination, never recreate a removed
      // one, retarget it, overwrite its route or undo a master/channel opt-out.
      if(existing?.enabled && this.master(actorId))this.saveTarget(authorization,existing.target!,existing.origin,existing.basePath,existing.locale,existing.messages,existing.id);
      else if(!decided && !blocked && !existing)this.saveTarget(authorization,target,origin,basePath,locale,messages);
      if(!decided)this.db.prepare('INSERT INTO push_default_decisions VALUES(?,?)').run(actorId,policyId);
    });
  }
  saveTarget(authorization: PushBinding, target: NotificationTarget, origin: string, basePath: string, locale: string, messages: Record<string,string>, existingId?: string, creationId?: string): PushDevice {
    const actorId=authorization.context.actorId;
    const proposedId=creationId?hash([actorId,'notification-target',creationId]):randomUUID();
    const previous=this.get(existingId??proposedId);
    if (existingId && (!previous?.target || previous.actorId!==actorId)) throw Error('destination_not_found');
    if (!previous && this.devices(actorId).length>=16) throw Error('device_limit');
    const id=previous?.id??proposedId;
    const bindingId=previous && JSON.stringify(previous.target)===JSON.stringify(target) && previous.origin===origin && previous.basePath===basePath ? previous.bindingId : randomUUID();
    if(previous?.target && targetKey(previous.target)!==targetKey(target))this.rememberOptOut(actorId,previous.target);
    this.db.prepare(`INSERT INTO push_devices(id,actor_id,binding_id,authorization,subscription,origin,base_path,locale,messages,target,enabled) VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET binding_id=excluded.binding_id,authorization=excluded.authorization,origin=excluded.origin,base_path=excluded.base_path,locale=excluded.locale,messages=excluded.messages,target=excluded.target`)
      .run(id,actorId,bindingId,JSON.stringify(authorization),'null',origin,basePath,locale,JSON.stringify(messages),JSON.stringify(target),previous?.enabled===false?0:1);
    return this.get(id)!;
  }
  remove(id: string, actorId: string): void {
    this.transaction(() => {
      if (this.get(id)?.actorId !== actorId) return;
      this.rememberOptOut(actorId,this.get(id)?.target);
      this.db.prepare('DELETE FROM push_devices WHERE id=?').run(id);
      this.db.prepare('DELETE FROM push_deliveries WHERE device_id=?').run(id);
    });
  }
  hasActor(actorId: string): boolean { return !!this.db.prepare('SELECT 1 FROM push_devices WHERE actor_id=? LIMIT 1').get(actorId); }
  devices(actorId: string): PushDevice[] { return this.db.prepare('SELECT * FROM push_devices WHERE actor_id=?').all(actorId).map(row => this.device(row)); }
  watch(actorId: string, serverId: string, hostId: string, threadId: string, inputId: string): void {
    if (!this.master(actorId) || !this.devices(actorId).some(device=>device.enabled)) return;
    const id = hash([actorId,serverId,threadId,inputId]);
    // Notification pressure must not become unbounded execution pressure.
    if (Number(this.db.prepare('SELECT count(*) n FROM push_watches WHERE done=0').get()!.n) >= 4096) return;
    this.db.prepare('INSERT OR IGNORE INTO push_watches(id,actor_id,server_id,host_id,thread_id,input_id,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(id,actorId,serverId,hostId,threadId,inputId,this.now());
  }
  watches(): PushWatch[] {
    return this.db.prepare('SELECT * FROM push_watches WHERE done=0 ORDER BY created_at LIMIT 4096').all().map(r => ({
      id:String(r.id),actorId:String(r.actor_id),serverId:String(r.server_id),hostId:String(r.host_id),threadId:String(r.thread_id),
      inputId:String(r.input_id),turnId:r.turn_id === null ? null : String(r.turn_id),createdAt:Number(r.created_at),
    }));
  }
  retireWatch(id: string) { this.db.prepare('UPDATE push_watches SET done=1 WHERE id=?').run(id); }
  bindTurn(id: string, turnId: string) { this.db.prepare('UPDATE push_watches SET turn_id=? WHERE id=? AND done=0').run(turnId,id); }
  finish(watch: PushWatch, turnId: string, status: 'completed'|'failed'|'interrupted') {
    this.transaction(() => {
      const changed = this.db.prepare('UPDATE push_watches SET done=1,turn_id=? WHERE id=? AND done=0').run(turnId,watch.id);
      if (!changed.changes) return;
      if (!this.master(watch.actorId)) return;
      for (const r of this.db.prepare('SELECT id,binding_id FROM push_devices WHERE actor_id=? AND enabled=1').all(watch.actorId)) {
        this.db.prepare('INSERT OR IGNORE INTO push_deliveries(id,device_id,binding_id,host_id,thread_id,turn_id,status,next_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
          .run(hash([r.id,watch.actorId,watch.serverId,watch.threadId,turnId]),r.id!,r.binding_id!,watch.hostId,watch.threadId,turnId,status,this.now(),this.now());
      }
    });
  }
  due(): PushDelivery[] {
    return this.db.prepare(`SELECT p.*,d.authorization,d.actor_id,d.subscription,d.origin,d.base_path,d.locale,d.messages,d.id device_key,d.target,d.enabled
      FROM push_deliveries p JOIN push_devices d ON d.id=p.device_id AND d.binding_id=p.binding_id
      WHERE p.state='pending' AND d.enabled=1 AND NOT EXISTS (SELECT 1 FROM push_preferences pref WHERE pref.actor_id=d.actor_id AND pref.enabled=0) AND p.next_at<=? ORDER BY p.next_at LIMIT 8`).all(this.now()).map(r => ({
        id:String(r.id),hostId:String(r.host_id),threadId:String(r.thread_id),turnId:String(r.turn_id),status:String(r.status),attempts:Number(r.attempts),
        device:this.device({...r,id:r.device_key}),
      }));
  }
  settled(id: string, state: 'sent'|'dead') { this.db.prepare('UPDATE push_deliveries SET state=? WHERE id=?').run(state,id); }
  retry(id: string, attempts: number) {
    this.db.prepare('UPDATE push_deliveries SET attempts=?,next_at=?,state=? WHERE id=?')
      .run(attempts,this.now()+Math.min(300_000,5_000*2**attempts),attempts>=6?'dead':'pending',id);
  }
  prune() {
    this.db.prepare('DELETE FROM push_watches WHERE created_at<? OR actor_id NOT IN (SELECT actor_id FROM push_devices)').run(this.now()-86400_000);
    this.db.prepare(`DELETE FROM push_deliveries WHERE created_at<? OR NOT EXISTS
      (SELECT 1 FROM push_devices d WHERE d.id=device_id AND d.binding_id=push_deliveries.binding_id)`).run(this.now()-7*86400_000);
    this.db.prepare("UPDATE push_deliveries SET state='dead' WHERE state='pending' AND created_at<?").run(this.now()-3600_000);
  }
  close() { this.db.close(); }
}
