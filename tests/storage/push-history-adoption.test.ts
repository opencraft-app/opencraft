import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {openManagedDatabase,resolveStoreMigrations} from '../../packages/sqlite-node/src/index.js';
import {PushStore} from '../../packages/web-push-node/src/store.js';
// Exact deployed SQL copied before registry migration, not generated output.
const history=[
  {
    "version": 1,
    "name": "web-push-subscriptions-and-outbox",
    "sql": "CREATE TABLE push_keys (id INTEGER PRIMARY KEY CHECK(id=1), public_key TEXT NOT NULL, private_key TEXT NOT NULL) STRICT;\nCREATE TABLE push_devices (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, binding_id TEXT NOT NULL, authorization TEXT NOT NULL, subscription TEXT NOT NULL, origin TEXT NOT NULL, base_path TEXT NOT NULL, locale TEXT NOT NULL, messages TEXT NOT NULL) STRICT;\nCREATE INDEX push_devices_actor ON push_devices(actor_id);\nCREATE TABLE push_watches (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, server_id TEXT NOT NULL, host_id TEXT NOT NULL, thread_id TEXT NOT NULL, input_id TEXT NOT NULL, turn_id TEXT, created_at INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0) STRICT;\nCREATE INDEX push_watches_pending ON push_watches(done,created_at);\nCREATE TABLE push_deliveries (id TEXT PRIMARY KEY, device_id TEXT NOT NULL, binding_id TEXT NOT NULL, host_id TEXT NOT NULL, thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, created_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending') STRICT;\nCREATE INDEX push_deliveries_due ON push_deliveries(state,next_at);"
  },
  {
    "version": 2,
    "name": "notification-destinations",
    "sql": "ALTER TABLE push_devices ADD COLUMN target TEXT;\nALTER TABLE push_devices ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;\nCREATE TABLE push_preferences (actor_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL) STRICT;"
  },
  {
    "version": 3,
    "name": "notification-default-decisions",
    "sql": "ALTER TABLE push_preferences ADD COLUMN defaults_blocked INTEGER NOT NULL DEFAULT 0;\nUPDATE push_preferences SET defaults_blocked=1 WHERE enabled=0;\nCREATE TABLE push_default_decisions (actor_id TEXT NOT NULL, policy_id TEXT NOT NULL, PRIMARY KEY(actor_id,policy_id)) STRICT;\nCREATE TABLE push_target_opt_outs (actor_id TEXT NOT NULL, target_key TEXT NOT NULL, PRIMARY KEY(actor_id,target_key)) STRICT;"
  }
] as const;
assert.deepEqual(resolveStoreMigrations('web-push-node',history.slice(0,1)),history);
async function fixture(t:test.TestContext,version?:1|2|3){const root=await mkdtemp(join(tmpdir(),'push-history-'));t.after(()=>rm(root,{recursive:true,force:true}));const path=join(root,'push.sqlite');
 if(version){const old=openManagedDatabase({path,migrations:history.slice(0,version)});old.database.exec("INSERT INTO push_keys VALUES(1,'fixture-public','fixture-private')");if(version>=2)old.database.exec("INSERT INTO push_preferences(actor_id,enabled) VALUES('actor',0)");if(version===3)old.database.exec("UPDATE push_preferences SET defaults_blocked=1 WHERE actor_id='actor'");old.database.close();}return{path};}
for(const version of [undefined,1,2,3] as const)test(`push adopts exact history from ${version??'fresh'}`,async t=>{const f=await fixture(t,version);let before:unknown[]=[];if(version){const db=new DatabaseSync(f.path);before=db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();db.close();}
 const owner=new PushStore(f.path);try{assert.equal(owner.outcome.appliedVersion,3);if(version)assert.equal(owner.master('actor'),version===1);}finally{owner.close();}
 const db=new DatabaseSync(f.path);try{assert.deepEqual(db.prepare('SELECT * FROM schema_migrations WHERE version<=? ORDER BY version').all(version??0),before);assert.equal(db.prepare('SELECT count(*) n FROM schema_migrations').get()!.n,3);if(version){assert.equal(db.prepare('SELECT public_key FROM push_keys').get()!.public_key,'fixture-public');if(version>=2)assert.equal(db.prepare("SELECT defaults_blocked FROM push_preferences WHERE actor_id='actor'").get()!.defaults_blocked,1);} }finally{db.close();}
 const again=new PushStore(f.path);try{assert.equal(again.outcome.status,'up-to-date');}finally{again.close();}
});
for(const damage of ['name','checksum','schema'] as const)test(`push refuses changed ${damage}`,async t=>{const f=await fixture(t,3),db=new DatabaseSync(f.path);if(damage==='schema')db.exec('ALTER TABLE push_keys ADD COLUMN unexpected TEXT');else db.prepare(`UPDATE schema_migrations SET ${damage}=? WHERE version=3`).run('changed');db.close();assert.throws(()=>new PushStore(f.path),(e:any)=>e.kind==='history-mismatch');const check=new DatabaseSync(f.path);try{assert.equal(check.prepare('SELECT public_key FROM push_keys').get()!.public_key,'fixture-public');}finally{check.close();}});
