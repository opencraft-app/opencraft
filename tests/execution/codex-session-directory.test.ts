import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {ConnectedAgentHistory} from '../../apps/local-agent-host/src/connected-agent-history';

test('native resume directory preserves names, all pages, scope and read-only Worker isolation',async t=>{
 const home=await mkdtemp(join(tmpdir(),'oc-resume-directory-'));t.after(()=>rm(home,{recursive:true,force:true}));
 const db=new DatabaseSync(join(home,'state_5.sqlite'));
 // Upstream mirror fixture, never an OpenCraft-owned migration.
 db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,cwd TEXT,title TEXT,name TEXT,first_user_message TEXT,updated_at INTEGER,created_at INTEGER,archived INTEGER,source TEXT,attached_thread_parent_id TEXT)');
 const insert=db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?,?)');
 const id=(n:number)=>'11111111-2222-4333-8444-'+String(n).padStart(12,'0');
 for(let n=1;n<=207;n++)insert.run(id(n),'/workspace/project','Original very long prompt','Session '+n,'first prompt',1700000000+n,1700000000,n===207?1:0,'cli',null);
 insert.run(id(208),'/workspace/project','child','Internal worker','context',1700000400,1700000000,0,JSON.stringify({subagent:{thread_spawn:{}}}),null);
 insert.run(id(209),'/workspace/project','attached','Attached worker','context',1700000400,1700000000,0,'cli',id(1));
 db.close();
 const reader=new ConnectedAgentHistory('codex',home);t.after(()=>reader.close());
 const first=await reader.directory();assert.equal(first.available,true);assert.equal(first.sessions.length,200);assert.equal(first.sessions[0]!.title,'Session 206');assert.ok(first.nextCursor);
 const second=await reader.directory(first.nextCursor!);assert.equal(second.sessions.length,6);assert.equal(second.nextCursor,null);
 assert.equal(new Set([...first.sessions,...second.sessions].map(s=>s.sessionId)).size,206);
 const archived=await reader.directory(undefined,true);assert.deepEqual(archived.sessions.map(s=>s.title),['Session 207']);
 await assert.rejects(reader.directory(first.nextCursor!,true));
 const check=new DatabaseSync(join(home,'state_5.sqlite'),{readOnly:true});assert.equal((check.prepare('SELECT count(*) AS n FROM threads').get() as any).n,209);check.close();
});

test('older native schemas use stored titles and seconds, absence is an explicit ACP fallback',async t=>{
 const home=await mkdtemp(join(tmpdir(),'oc-resume-old-'));t.after(()=>rm(home,{recursive:true,force:true}));
 const reader=new ConnectedAgentHistory('codex',home);t.after(()=>reader.close());assert.equal((await reader.directory()).available,false);
 const db=new DatabaseSync(join(home,'state_4.sqlite'));db.exec("CREATE TABLE threads(id TEXT,cwd TEXT,title TEXT,updated_at INTEGER,created_at INTEGER,archived INTEGER)");
 db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?)').run('11111111-2222-4333-8444-555555555555','/workspace',' A\n title ',1700000000,1600000000,0);db.close();
 const result=await reader.directory();assert.equal(result.sessions[0]!.title,'A title');assert.equal(result.sessions[0]!.updatedAt,'2023-11-14T22:13:20.000Z');
 await writeFile(join(home,'session_index.jsonl'),JSON.stringify({id:'11111111-2222-4333-8444-555555555555',thread_name:'Renamed resume title',updated_at:'2026-11-16T00:00:00Z'})+'\n'+JSON.stringify({id:'11111111-2222-4333-8444-555555555555',thread_name:'Latest native title'})+'\n{"id":');
 assert.equal((await reader.directory()).sessions[0]!.title,'Latest native title');
});
