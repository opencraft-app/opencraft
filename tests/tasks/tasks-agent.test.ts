import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { DatabaseSync } from "node:sqlite";
import { openManagedDatabase } from "@opencraft/sqlite-node";
import { TasksSqliteStore, tasksMigrations } from "../../plugins/tasks/src/sqlite";
import { TasksService } from "../../plugins/tasks/src/server";
import { startTasksAgent } from "../../plugins/tasks/src/agent";
import { TASKS, type TaskDetail } from "@opencraft/appserver-protocol";

const content = {title:"Preserved title",description:"Preserved details",projectServerId:null,projectId:null};

test("v1 migration preserves task rows, tombstones, links and CAS; legacy content edits retain new attributes", async () => {
  const directory = await mkdtemp(join(tmpdir(),"oc-task-upgrade-"));
  const path = join(directory,"tasks.sqlite");
  try {
    const old = openManagedDatabase({path,legacyPolicy:"reject",migrations:[tasksMigrations[0]!]});
    old.database.prepare("INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?,?,?)").run("keep",content.title,content.description,"todo",null,null,7,3,11,12,null);
    old.database.prepare("INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?,?,?)").run("deleted","Tombstone","","done",null,null,8,5,10,12,12);
    old.database.prepare("INSERT INTO task_conversations VALUES(?,?,?,?)").run("keep","server-a","thread-b",11);
    const before = old.database.prepare("SELECT * FROM tasks ORDER BY id").all();
    old.database.close();
    const store = new TasksSqliteStore(path);
    try {
      const read = new DatabaseSync(path,{readOnly:true});
      assert.deepEqual(read.prepare("SELECT id,title,description,status,project_server_id,project_id,sort_order,revision,created_at,updated_at,deleted_at FROM tasks ORDER BY id").all(),before);
      assert.equal(read.prepare("SELECT count(*) AS n FROM task_conversations").get()?.n,1);
      read.close();
      assert.equal(store.read("keep").assigneeId,null);
      store.member({id:"employee:alex",name:"Alex",expectedRevision:null});
      store.properties({id:"keep",expectedRevision:3,assigneeId:"employee:alex",priority:"urgent",dueDate:"2026-12-15"});
      store.update({...content,id:"keep",expectedRevision:4,title:"Changed by legacy client"});
      assert.equal(store.read("keep").assigneeId,"employee:alex");
      assert.equal(store.read("keep").priority,"urgent");
      assert.equal(store.read("keep").dueDate,"2026-12-15");
      assert.throws(()=>store.properties({id:"keep",expectedRevision:4,assigneeId:null,priority:"none",dueDate:null}),{code:-32051});
      assert.throws(()=>store.member({id:"employee:alex",name:"Collision",expectedRevision:null}),{code:-32051});
      store.member({id:"employee:alex",name:"Alex updated",expectedRevision:1});
      assert.equal(store.list().members?.[0]?.name,"Alex updated");
    } finally { store.close(); }
  } finally { await rm(directory,{recursive:true,force:true}); }
});

test("properties validate dates and member identity and commit content plus properties atomically",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"oc-task-fields-"));
  const service=new TasksService(join(dir,"tasks.sqlite"));
  try {
    service.handle(TASKS.create,{...content,id:"a",status:"todo"});
    const original=service.handle(TASKS.read,{id:"a"});
    for(const fields of [{assigneeId:"unknown",priority:"high",dueDate:null},{assigneeId:null,priority:"urgent",dueDate:"2026-02-30"},{assigneeId:null,priority:"fake",dueDate:null}]) {
      assert.throws(()=>service.handle(TASKS.update,{...content,id:"a",expectedRevision:1,title:"Must roll back",...fields}));
      assert.deepEqual(service.handle(TASKS.read,{id:"a"}),original);
    }
    service.handle(TASKS.members,{id:"a@example.test",name:"Alex",expectedRevision:null});
    service.handle(TASKS.update,{...content,id:"a",expectedRevision:1,assigneeId:"a@example.test",priority:"high",dueDate:"2028-02-29"});
    const changed=service.handle(TASKS.read,{id:"a"}) as TaskDetail;
    assert.equal(changed.revision,2);
    assert.equal(changed.assigneeId,"a@example.test");
    service.handle(TASKS.properties,{id:"a",expectedRevision:2,assigneeId:null});
    const partial=service.handle(TASKS.read,{id:"a"}) as TaskDetail;
    assert.equal(partial.assigneeId,null);assert.equal(partial.priority,"high");assert.equal(partial.dueDate,"2028-02-29");
    service.handle(TASKS.update,{...content,id:"a",expectedRevision:3,priority:"low"});
    const contentPatch=service.handle(TASKS.read,{id:"a"}) as TaskDetail;
    assert.equal(contentPatch.priority,"low");assert.equal(contentPatch.dueDate,"2028-02-29");assert.equal(contentPatch.assigneeId,null);
    assert.throws(()=>service.handle(TASKS.properties,{id:"a",expectedRevision:4}));
    assert.deepEqual(service.handle(TASKS.read,{id:"a"}),contentPatch);
  } finally {service.close();await rm(dir,{recursive:true,force:true});}
});

test("materialized CLI uses authenticated shared authority, compact pagination, assignment and multi-conversation links; retirement revokes it",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"oc-task-agent-"));
  const service=new TasksService(join(dir,"tasks.sqlite"));
  let agent:Awaited<ReturnType<typeof startTasksAgent>>|undefined;
  const run=async(command:string,p:unknown={})=>{
    const child=spawn(process.execPath,[join(dir,"agent/opencraft-tasks/scripts/tasks.mjs"),command,JSON.stringify(p)],{stdio:["ignore","pipe","pipe"]});
    let out="",err="";child.stdout.on("data",b=>out+=b);child.stderr.on("data",b=>err+=b);
    const code=await new Promise<number|null>((resolve,reject)=>{child.once("error",reject);child.once("exit",resolve);});
    return {code,out,err};
  };
  try {
    // Exercise the release transform as well as the generated standalone CLI:
    // materialization must not capture bundler helpers or source-tree imports.
    const bundle=join(dir,"task-agent.mjs");
    await build({entryPoints:[new URL("../../plugins/tasks/src/agent.ts",import.meta.url).pathname],outfile:bundle,bundle:true,platform:"node",format:"esm",target:"node26",logLevel:"silent"});
    const packaged=await import(pathToFileURL(bundle).href) as {startTasksAgent:typeof startTasksAgent};
    agent=await packaged.startTasksAgent({directory:join(dir,"agent"),skillRoots:[join(dir,"engine/skills")],service,catalog:async(_search,_limit,_serverId,cursor)=>({conversations:[{serverId:"server-a",threadId:cursor?"t2":"t1",title:"Design"}],nextCursor:cursor?null:"page-2"})});
    const cli=async(command:string,p:unknown={})=>{const result=await run(command,p);assert.equal(result.code,0,result.err+result.out);return JSON.parse(result.out);};
    assert.ok((await readFile(join(dir,"engine/skills/opencraft-tasks/SKILL.md"),"utf8")).includes("description:"));
    const connection=JSON.parse(await readFile(join(dir,"agent/opencraft-tasks/scripts/connection.json"),"utf8"));
    assert.equal((await fetch(connection.url,{method:"POST",body:"{}"})).status,401);
    for(let i=0;i<24;i++) await cli("create",{id:`task-${i}`,title:`Task ${i}`,description:"Long detail must stay out of list"});
    const page=await cli("list");assert.equal(page.tasks.length,20);assert.equal(page.nextOffset,20);assert.equal(page.total,24);assert.ok(!JSON.stringify(page).includes("Long detail"));
    assert.equal((await cli("list",{offset:20})).tasks.length,4);
    assert.equal((await run("list",{owner:"alex"})).code,1);
    assert.equal((await run("list",{search:22})).code,1);
    assert.equal((await cli("list",{search:"Long detail"})).total,24);
    const unicodeDescription="任".repeat(16384);
    await cli("create",{id:"unicode",title:"Unicode description",description:unicodeDescription});
    assert.equal((await cli("read",{id:"unicode"})).description,unicodeDescription);
    await cli("member",{id:"alex",name:"Alex",expectedRevision:null});
    const profile = { kind: "employee", id: "employee.alex" };
    assert.deepEqual((await cli("member",{id:"alex",name:"Alex",expectedRevision:1,identity:profile})).member.identity,profile);
    await cli("member",{id:"alex",name:"Alex",expectedRevision:2});
    assert.deepEqual((await cli("members",{search:"alex"})).members[0].identity,profile);
    assert.equal((await cli("member",{id:"alex",name:"Alex",expectedRevision:3,identity:null})).member.identity,null);
    const report=await cli("progress",{taskId:"task-0",eventId:"agent-report",text:"Evidence ready"});
    assert.equal(report.channel,"agent");assert.equal(report.actor,null);
    assert.deepEqual(await cli("event",{taskId:"task-0",eventId:"agent-report"}),report);
    assert.deepEqual(await cli("progress",{taskId:"task-0",eventId:"agent-report",text:"Evidence ready"}),report);
    assert.equal((await cli("read",{id:"task-0"})).revision,1);
    assert.equal((await cli("events",{taskId:"task-0",limit:1})).events[0].eventId,"agent-report");
    await cli("properties",{id:"task-0",expectedRevision:1,assigneeId:"alex",priority:"high",dueDate:"2026-12-15"});
    assert.equal((await cli("list",{assigneeId:"alex"})).total,1);
    assert.equal((await cli("conversations")).conversations[0].serverId,"server-a");
    assert.equal((await cli("conversations",{serverId:"server-a",cursor:"page-2"})).conversations[0].threadId,"t2");
    for (const [revision,serverId,threadId] of [[2,"server-a","t1"],[3,"server-b","t2"]] as const) await cli("link",{id:"task-0",expectedRevision:revision,serverId,threadId});
    const read=await cli("read",{id:"task-0"});assert.equal(read.conversations.length,2);assert.equal(read.assigneeId,"alex");
    await cli("link",{id:"task-1",expectedRevision:1,serverId:"server-a",threadId:"t1"});
    const related=await cli("for-conversation",{serverId:"server-a",threadId:"t1",limit:1});
    assert.equal(related.total,2);assert.equal(related.nextOffset,1);
    const next=await cli("for-conversation",{serverId:"server-a",threadId:"t1",limit:1,offset:1});
    assert.equal(next.tasks.length,1);assert.notEqual(next.tasks[0].id,related.tasks[0].id);assert.equal(next.nextOffset,null);
    assert.equal((await run("remove",{id:"task-0",expectedRevision:1})).code,1);
    assert.equal((await cli("read",{id:"task-0"})).conversations.length,2);
    const beforeArchive = await cli("read", {id:"task-0"});
    assert.deepEqual(await cli("archive", {id:"task-0",expectedRevision:beforeArchive.revision}), {id:"task-0",archived:true});
    const archived = await cli("archived", {search:"Task 0",limit:1});
    assert.equal(archived.tasks[0].id,"task-0"); assert.equal(archived.tasks[0].conversationCount,2); assert.ok(!JSON.stringify(archived).includes("Long detail"));
    assert.equal((await cli("list",{search:"Task 0"})).total,0);
    await cli("unarchive",{id:"task-0",expectedRevision:archived.tasks[0].revision});
    assert.equal((await cli("read",{id:"task-0"})).archivedAt,null);
    await cli("properties",{id:"task-2",expectedRevision:1,aiResearch:"proactive",aiResearchReason:"Read-only repository investigation has a clear scope."});
    assert.equal((await cli("list",{aiResearch:"proactive"})).total,1);
    assert.equal((await cli("read",{id:"task-2"})).aiResearchReason,"Read-only repository investigation has a clear scope.");
    assert.equal((await run("list",{aiResearch:"invalid"})).code,1);
    await agent.close();agent=undefined;
    await assert.rejects(access(join(dir,"engine/skills/opencraft-tasks")));
    await assert.rejects(access(join(dir,"agent/opencraft-tasks/scripts/connection.json")));
    assert.equal((await run("list")).code,1);
  }finally {await agent?.close();service.close();await rm(dir,{recursive:true,force:true});}
});
