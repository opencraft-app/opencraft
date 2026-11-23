import { parentPort, workerData } from 'node:worker_threads';
import { statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { nodeSqlDatabase } from '@opencraft/sqlite-node';
import { openServerDatabase,installServerMigrationComposition } from '@opencraft/storage-node/server';
import { ActorStore } from './actors.js';
import { serverSpacesDomain } from './server-spaces-domain.js';
import type { ActorContext } from '@opencraft/identity-core/actors';

// Standalone Server space storage: the local Host owns its own installation
// (`directory`), and tests may borrow a migrated file (`path`). Headless serves
// the same domain on its Server core owner connection instead.
if (!parentPort) throw new Error('Server space storage needs a Worker');
const port = parentPort;
// Trusted parent-owned data only; no request/module path selects migration code.
if(workerData.directory&&workerData.serverMigrationComposition!==undefined)installServerMigrationComposition(workerData.serverMigrationComposition);
const owner = workerData.directory ? await openServerDatabase(workerData.directory) : null;
if(!owner&&!statSync(workerData.path).isFile())throw new Error('Managed Server database unavailable');
const connection = owner ? null : new DatabaseSync(workerData.path);
const db = owner?.database ?? nodeSqlDatabase(connection!);
if(!owner&&db.prepare('PRAGMA journal_mode').get()?.journal_mode!=='wal')throw new Error('Server storage requires managed WAL');
// A borrowed file has other writers; wait for their locks inside this Worker.
db.exec('PRAGMA busy_timeout=5000');
let localContext: ActorContext | undefined;
let actors: ActorStore | undefined;
if (owner) {
  actors = new ActorStore(owner);
  // Trusted local bootstrap only. No request body or browser chooses this identity.
  localContext = actors.resolveHuman({provider:'desktop',subject:'development-owner',displayName:'Local user',expiresAt:Number.MAX_SAFE_INTEGER}) ?? undefined;
  if (!localContext) throw new Error('Local human could not be established');
}
const domain = serverSpacesDomain(db, workerData, localContext);
let tail = Promise.resolve();
port.on('message', request => {
  tail = tail.then(async () => {
    if (request.method === 'close') {
      try {
        actors?.close();
        if (owner) await owner.close(); else connection!.close();
        port.postMessage({id:request.id,result:null}); port.close();
      } catch (error) {
        const e=error as Error & {rpcCode?:number;reason?:string};
        port.postMessage({id:request.id,error:{rpcCode:e.rpcCode ?? -32004,reason:e.reason ?? 'unavailable',message:'Server action unavailable'}});
      }
      return;
    }
    // Owner entry: the parent `ServerSpacesRuntime` is the only writer to this port.
    port.postMessage({id:request.id,...domain.receive(request)});
  });
});
port.postMessage({type:'ready',projection:domain.projection(),localContext,outcome:owner?.outcome??null});
