import { sqliteTransaction } from '@opencraft/sqlite-node';
import { parentPort, workerData } from 'node:worker_threads';
import { statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { openServerDatabase } from '@opencraft/storage-node/server';
import { ActorStore } from './actors.js';
import { ServerSpacesLedger } from './server-spaces-ledger.js';
import type { ActorContext } from '@opencraft/identity-core/actors';

if (!parentPort) throw new Error('Server space storage needs a Worker');
const port = parentPort;
const owner = workerData.directory ? await openServerDatabase(workerData.directory) : null;
if(!owner&&!statSync(workerData.path).isFile())throw new Error('Managed Server database unavailable');
const db = owner?.database ?? new DatabaseSync(workerData.path);
if(!owner&&db.prepare('PRAGMA journal_mode').get()?.journal_mode!=='wal')throw new Error('Server storage requires managed WAL');
db.exec('PRAGMA busy_timeout=5000');
let localContext: ActorContext | undefined;
let actors: ActorStore | undefined;
if (owner) {
  actors = new ActorStore(owner);
  // Trusted local bootstrap only. No request body or browser chooses this identity.
  localContext = actors.resolveHuman({provider:'desktop',subject:'development-owner',displayName:'Local user',expiresAt:Number.MAX_SAFE_INTEGER}) ?? undefined;
  if (!localContext) throw new Error('Local human could not be established');
}
const ledger = new ServerSpacesLedger(db);
if (localContext) ledger.bootstrap(localContext.actorId);
else if (workerData.ownerActorId) ledger.bootstrap(workerData.ownerActorId,workerData.members ?? []);
else if(workerData.bootstrapInstance){
  const members=db.prepare("SELECT m.actor_id,m.role FROM actor_members m JOIN actors a ON a.id=m.actor_id WHERE m.enabled=1 AND a.enabled=1 AND a.kind='human' ORDER BY m.actor_id").all();
  const administrator=members.find(member=>member.role==='admin');
  if(administrator)ledger.bootstrap(String(administrator.actor_id),members.map(member=>String(member.actor_id)));
}
let tail = Promise.resolve();
port.on('message', request => {
  tail = tail.then(async () => {
    try {
      if (request.method === 'close') {
        actors?.close();
        if (owner) await owner.close(); else db.close();
        port.postMessage({id:request.id,result:null}); port.close(); return;
      }
      const context = localContext ?? request.context;
      const execute = () => request.method === 'inherit' ? ledger.inherit(request.parent.serverId,request.parent.threadId,request.child.serverId,request.child.threadId) : request.method === 'bootstrap' ? ledger.bootstrap(request.ownerActorId,request.members ?? []) : request.method==='legacy' ? ledger.adoptLegacy(context,request.engineServerId,request.threads) : request.method === 'assign'
        ? ledger.assign(context,request.engineServerId,request.threadId,request.spaceId)
        : ledger.command(context,request.command);
      const mutated=['assign','legacy','bootstrap','inherit'].includes(request.method)||['create','invite','join','remove'].includes(request.command?.action);
      const result=mutated?sqliteTransaction(db,execute):execute();
      port.postMessage({id:request.id,result,...(mutated?{projection:ledger.projection()}:{})});
    } catch (error) {
      const e=error as Error & {rpcCode?:number;reason?:string};
      port.postMessage({id:request.id,error:{rpcCode:e.rpcCode ?? -32004,reason:e.reason ?? 'unavailable',message:'Server action unavailable'}});
    }
  });
});
port.postMessage({type:'ready',projection:ledger.projection(),localContext,outcome:owner?.outcome??null});
