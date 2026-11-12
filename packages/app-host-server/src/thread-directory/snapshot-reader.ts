import { Worker } from "node:worker_threads";
import { createCatalogMerkle, createCatalogMerklePager } from "@opencraft/appserver-protocol";

// A worker owns its read-only connection and every retained metadata snapshot.
// Only page-sized replies cross back to the network event loop. No main-thread
// SQL fallback, migration, long-lived read transaction or transcript access.
const program = String.raw`
const {parentPort,workerData}=require('node:worker_threads');
const {DatabaseSync}=require('node:sqlite');
const {randomUUID}=require('node:crypto');
// tsx/keepNames may emit this annotation inside a serialized function.
const __name=(value)=>value;
const tools=(${createCatalogMerkle.toString()})();
const merklePages=new ((${createCatalogMerklePager.toString()})(tools))(randomUUID);
const merklePrefix='opencraft-catalog-snapshot-v1:merkle:';
const db=new DatabaseSync(workerData.path,{readOnly:true});
db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=0');
const prefix='opencraft-catalog-snapshot-v1:',views=new Map(),cache=new Map();
const expired=()=>Object.assign(new Error('Conversation catalog snapshot expired'),{code:-32086});
parentPort.on('message',request=>{
 try{
  const {cursor,archived,limit,source,base,expectedRevision}=request.params;
  const now=Date.now();for(const [id,view]of views)if(view.expires<=now)views.delete(id);
  let id,offset=0;
  if(cursor.startsWith(merklePrefix)){
   const result=merklePages.list(cursor,archived,limit,()=>{
    db.exec('BEGIN');let revision,state,stored;
    try{
     revision=cache.get(archived)?.revision===expectedRevision?expectedRevision:Number(db.prepare('SELECT MAX(revision) AS revision FROM opencraft_thread_catalog').get().revision??0);
     state=db.prepare('SELECT * FROM opencraft_catalog_sync WHERE archived=?').get(Number(archived));
     if(cache.get(archived)?.revision!==revision)stored=db.prepare('SELECT metadata_json FROM opencraft_thread_catalog WHERE archived=? AND deleted=0 ORDER BY updated_at DESC,thread_id ASC').all(Number(archived));
     db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
    if(stored)cache.set(archived,{revision,rows:stored.map(row=>JSON.parse(row.metadata_json))});
    const entry=cache.get(archived);entry.merkle??=tools.build(entry.rows);
    if(revision<base)throw expired();
    return {root:entry.merkle,checkpoints:[{source,revision:revision-base}],catalog:{lastSuccessAt:state?.last_success_ms??null,state:state?.state==='error'?'error':state?.last_success_ms==null?'warming':state.state,coverage:state?.last_success_ms==null?'unknown':state.state==='error'?'partial':'complete'}};
   });
   parentPort.postMessage({id:request.id,result});return;
  }
  if(cursor===prefix+'start'){
   let revision,state,stored;
   db.exec('BEGIN');
   try{
    revision=cache.get(archived)?.revision===expectedRevision ? expectedRevision
     : Number(db.prepare('SELECT MAX(revision) AS revision FROM opencraft_thread_catalog').get().revision??0);
    state=db.prepare('SELECT * FROM opencraft_catalog_sync WHERE archived=?').get(Number(archived));
    if(cache.get(archived)?.revision!==revision)
     stored=db.prepare('SELECT metadata_json FROM opencraft_thread_catalog WHERE archived=? AND deleted=0 ORDER BY updated_at DESC,thread_id ASC').all(Number(archived));
    db.exec('COMMIT');
   }catch(error){db.exec('ROLLBACK');throw error;}
   if(stored)cache.set(archived,{revision,rows:stored.map(row=>JSON.parse(row.metadata_json))});
   const rows=cache.get(archived).rows;
   const catalog={lastSuccessAt:state?.last_success_ms??null,state:state?.state==='error'?'error':state?.last_success_ms==null?'warming':state.state,
    coverage:state?.last_success_ms==null?'unknown':state.state==='error'?'partial':'complete'};
   if(revision<base)throw expired();
   id=randomUUID();if(views.size>=16)views.delete(views.keys().next().value);
   views.set(id,{rows,archived,catalog,revision:revision-base,source,expires:now+120000});
  }else{
   const value=JSON.parse(cursor.slice(prefix.length));
   if(!Array.isArray(value)||value.length!==2||typeof value[0]!=='string'||!Number.isSafeInteger(value[1])||value[1]<0)throw expired();
   [id,offset]=value;
  }
  const view=views.get(id);if(!view||view.archived!==archived||view.source!==source)throw expired();
  const data=view.rows.slice(offset,offset+limit),next=offset+data.length;
  parentPort.postMessage({id:request.id,result:{data,nextCursor:next<view.rows.length?prefix+JSON.stringify([id,next]):null,backwardsCursor:null,
   catalog:view.catalog,catalogSnapshot:{version:1,id,checkpoints:[{source:view.source,revision:view.revision}]}}});
 }catch(error){parentPort.postMessage({id:request.id,error:{message:error.message,code:error.code}});}
});
`;

export class DirectorySnapshotReader {
  private worker?: Worker;
  private sequence = 0;
  private closed = false;
  private readonly pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  constructor(private readonly path: string) {}
  list(params: { cursor: string; archived: boolean; limit: number; source: string; base: number; expectedRevision: number }): Promise<any> {
    if (this.closed) return Promise.reject(new Error("Directory reader closed"));
    if (this.pending.size >= 64) return Promise.reject(new Error("Directory reader is busy"));
    if (!this.worker) {
      const worker = this.worker = new Worker(program, { eval: true, workerData: { path: this.path }, execArgv: [] });
      worker.on("message", packet => {
        const request = this.pending.get(packet.id); if (!request) return;
        this.pending.delete(packet.id);
        if (packet.error) request.reject(Object.assign(new Error(packet.error.message),
          packet.error.code === -32086 ? { code: -32086, rpcCode: -32086 } : {}));
        else request.resolve(packet.result);
      });
      worker.on("error", error => this.fail(error instanceof Error ? error : new Error(String(error))));
      worker.on("exit", () => { if (this.worker === worker) { this.worker = undefined; this.fail(new Error("Directory reader stopped")); } });
    }
    return new Promise((resolve, reject) => {
      const id = ++this.sequence; this.pending.set(id, { resolve, reject });
      try { this.worker!.postMessage({ id, params }); } catch (error) { this.pending.delete(id); reject(error); }
    });
  }
  private fail(error: Error): void { for (const request of this.pending.values()) request.reject(error); this.pending.clear(); }
  close(): void { this.closed = true; this.fail(new Error("Directory reader closed")); void this.worker?.terminate(); }
}
