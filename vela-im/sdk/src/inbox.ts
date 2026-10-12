import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import type {InboxEvent,IMMessage} from './index.ts';

const digest=(text:string)=>createHash('sha256').update(text).digest('hex');
const MESSAGE_EVENTS=['MESSAGE_RECEIVED','MESSAGE_MODIFIED','MESSAGE_REVOKED'];

/** Durable, de-duplicated event log for one identity. The Agent keeps a cursor (seq) and resumes after restarts. */
export class Inbox {
 private db:DatabaseSync;
 readonly signals=new EventEmitter();
 constructor(path:string) {
  this.db=new DatabaseSync(path);
  this.db.exec(`
   PRAGMA journal_mode=WAL;
   CREATE TABLE IF NOT EXISTS inbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL, dedup TEXT, message_id TEXT, data TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(event,dedup));
   CREATE INDEX IF NOT EXISTS inbox_message ON inbox(message_id);
   CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  this.signals.setMaxListeners(100);
 }
 save(event:string,data:any) {
  const entries=MESSAGE_EVENTS.includes(event)?(Array.isArray(data)?data:[data]):[data];
  const insert=this.db.prepare('INSERT OR IGNORE INTO inbox (event,dedup,message_id,data,created_at) VALUES (?,?,?,?,?)');
  let added=0;
  this.db.exec('BEGIN');
  try {
   for(let entry of entries) {
    // V4 revocations identify the message by conversation + sequence only.
    if(event==='MESSAGE_REVOKED'&&!entry?.ID&&entry?.conversationID&&entry?.sequence!==undefined){
     const original=this.db.prepare("SELECT message_id FROM inbox WHERE event='MESSAGE_RECEIVED' AND json_extract(data,'$.conversationID')=? AND json_extract(data,'$.sequence')=? ORDER BY seq DESC LIMIT 1").get(entry.conversationID,entry.sequence) as any;
     if(original?.message_id)entry={...entry,ID:original.message_id};
    }
    const json=JSON.stringify(entry??null);
    // 修改可多次推送：按 ID + 内容去重；接收/撤回按 ID 去重。
    const dedup=entry?.ID?`${entry.ID}${event==='MESSAGE_MODIFIED'?':'+digest(json):''}`:null;
    added+=Number(insert.run(event,dedup,entry?.ID??null,json,Date.now()).changes);
   }
   this.db.exec('COMMIT');
  }catch(e){this.db.exec('ROLLBACK');throw e}
  if(added)this.signals.emit('event');
  return added;
 }
 events(after:number,limit=100):InboxEvent[] {
  return (this.db.prepare('SELECT seq,event,data,created_at AS createdAt FROM inbox WHERE seq>? ORDER BY seq LIMIT ?').all(after,limit) as any[]).map(r=>({...r,data:JSON.parse(r.data)}));
 }
 lastSeq():number {return Number((this.db.prepare('SELECT MAX(seq) AS seq FROM inbox').get() as any).seq??0)}
 /** Latest known state of a received message: modifications applied, revocation flagged. */
 message(id:string):IMMessage|undefined {
  const rows=this.db.prepare("SELECT event,data FROM inbox WHERE message_id=? AND event IN ('MESSAGE_RECEIVED','MESSAGE_MODIFIED','MESSAGE_REVOKED') ORDER BY seq").all(id) as any[];
  const original=rows.find(r=>r.event==='MESSAGE_RECEIVED');
  if(!original)return undefined;
  const message=JSON.parse(original.data);
  for(const r of rows)if(r.event==='MESSAGE_MODIFIED')Object.assign(message,JSON.parse(r.data));
  if(rows.some(r=>r.event==='MESSAGE_REVOKED'))message.isRevoked=true;
  return message;
 }
 meta(key:string):string|undefined {return (this.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as any)?.value}
 setMeta(key:string,value:string) {this.db.prepare('INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,value)}
 /** First start syncs from "now": a new worker never replays messages an earlier runtime already handled. */
 /** Backfill watermark (seconds). The first run starts at `initial` (e.g. when the identity was created), else now. */
 syncTime(initial?:number):number {
  const value=this.meta('synced_at');
  if(value)return Number(value);
  const start=initial??Math.floor(Date.now()/1000);this.setMeta('synced_at',String(start));return start;
 }
 synced(time:number) {this.setMeta('synced_at',String(time))}
 prune(days=14) {this.db.prepare('DELETE FROM inbox WHERE created_at<?').run(Date.now()-days*86400000)}
 close() {this.db.close()}
}
