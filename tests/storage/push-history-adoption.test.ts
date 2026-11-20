import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {openManagedDatabase,resolveStoreMigrations} from '../../packages/sqlite-node/src/index.js';
import {PushStore} from '../../packages/web-push-node/src/store.js';
// Exact deployed SQL copied before registry migration, not generated output.
import {publishedPushHistory as history} from '../fixtures/published-push-history';
assert.deepEqual(resolveStoreMigrations('web-push-node',history.slice(0,1)),history);
async function fixture(t:test.TestContext,version?:1|2|3){const root=await mkdtemp(join(tmpdir(),'push-history-'));t.after(()=>rm(root,{recursive:true,force:true}));const path=join(root,'push.sqlite');
 if(version){const old=openManagedDatabase({path,migrations:history.slice(0,version)});old.database.exec("INSERT INTO push_keys VALUES(1,'fixture-public','fixture-private')");if(version>=2)old.database.exec("INSERT INTO push_preferences(actor_id,enabled) VALUES('actor',0)");if(version===3)old.database.exec("UPDATE push_preferences SET defaults_blocked=1 WHERE actor_id='actor'");old.database.close();}return{path};}
for(const version of [undefined,1,2,3] as const)test(`push adopts exact history from ${version??'fresh'}`,async t=>{const f=await fixture(t,version);let before:unknown[]=[];if(version){const db=new DatabaseSync(f.path);before=db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();db.close();}
 const owner=new PushStore(f.path);try{assert.equal(owner.outcome.appliedVersion,3);if(version)assert.equal(owner.master('actor'),version===1);}finally{owner.close();}
 const db=new DatabaseSync(f.path);try{assert.deepEqual(db.prepare('SELECT * FROM schema_migrations WHERE version<=? ORDER BY version').all(version??0),before);assert.equal(db.prepare('SELECT count(*) n FROM schema_migrations').get()!.n,3);if(version){assert.equal(db.prepare('SELECT public_key FROM push_keys').get()!.public_key,'fixture-public');if(version>=2)assert.equal(db.prepare("SELECT defaults_blocked FROM push_preferences WHERE actor_id='actor'").get()!.defaults_blocked,1);} }finally{db.close();}
 const again=new PushStore(f.path);try{assert.equal(again.outcome.status,'up-to-date');}finally{again.close();}
});
for(const damage of ['name','checksum','schema'] as const)test(`push refuses changed ${damage}`,async t=>{const f=await fixture(t,3),db=new DatabaseSync(f.path);if(damage==='schema')db.exec('ALTER TABLE push_keys ADD COLUMN unexpected TEXT');else db.prepare(`UPDATE schema_migrations SET ${damage}=? WHERE version=3`).run('changed');db.close();assert.throws(()=>new PushStore(f.path),(e:any)=>e.kind==='history-mismatch');const check=new DatabaseSync(f.path);try{assert.equal(check.prepare('SELECT public_key FROM push_keys').get()!.public_key,'fixture-public');}finally{check.close();}});
