import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openServerDatabase } from "@opencraft/storage-node/server";
import { ConversationHistory } from "../../packages/app-host-server/src/conversation-history.js";
import { InvalidSearch,searchSnippet,searchableText } from "../../packages/app-host-server/src/conversation-search.js";
import { ConversationHistoryTransport } from "../../packages/app-host-server/src/conversation-history-transport.js";
type Value=Record<string,any>;
async function fixture(t:test.TestContext){
 const directory=mkdtempSync(join(tmpdir(),"conversation-search-"));let storage=await openServerDatabase(directory);
 t.after(async()=>{await storage.close();rmSync(directory,{recursive:true,force:true});});
 return {get storage(){return storage;},history:new ConversationHistory(storage.database,"local-codex"),async reopen(){await storage.close();storage=await openServerDatabase(directory);return new ConversationHistory(storage.database,"local-codex");}};
}
const metadata=(id:string,updatedAt=1)=>({id,cwd:"/synthetic",name:"Unrelated title",preview:"",createdAt:1,updatedAt,ephemeral:false});
const item=(id:string,text:string)=>({id,type:"agentMessage",text,phase:"final_answer"});
function seed(h:ConversationHistory,id:string,text:string,updatedAt=1,items=[item("answer",text)]){
 assert.ok(h.importResult("thread/read",{threadId:id,includeTurns:true},{thread:{...metadata(id,updatedAt),turns:[{id:"turn",status:"completed",itemsView:"full",items}]}},h.revision(id)));
}
const search=(h:ConversationHistory,term:string,params:Value={},allowed:(id:string)=>boolean=()=>true)=>h.read("thread/search",{searchTerm:term,...params},allowed);

test("generated image search indexes the prompt rather than binary image bytes", () => {
 const image={type:"imageGeneration",revisedPrompt:"A sidebar layout",result:"aW1hZ2U=".repeat(250_000),savedPath:"/generated/image.png"};
 assert.equal(searchableText(image),"A sidebar layout");
 assert.equal(searchableText({...image,revisedPrompt:null}),"");
});

test("real FTS5 BM25 relevance beats recency and returns one best document per thread",async t=>{
 const {history,storage}=await fixture(t);seed(history,"best","neutrino neutrino",1);seed(history,"recent","filler ".repeat(1000)+"neutrino",1000);
 history.observe("item/completed",{threadId:"best",turnId:"turn",item:item("second","neutrino")});
 const result=search(history,"neutrino");assert.deepEqual(result.data.map((r:Value)=>r.thread.id),["best","recent"]);
 assert.ok(result.data[0].rank<result.data[1].rank);assert.equal(result.searchCoverage.indexedOnly,true);
 assert.ok(storage.database.prepare("SELECT sql FROM sqlite_master WHERE name='conversation_search'").get()!.sql!.toString().includes("fts5"));
 assert.equal(search(history,"neutrino",{sortKey:"updated_at"}).data[0].thread.id,"recent");
});
test("Chinese short queries, code punctuation and literal verification have useful recall",async t=>{
 const {history}=await fixture(t);seed(history,"zh","全文搜索支持数据库与BM25，执行foo-bar命令");
 seed(history,"false","数据 unrelated 据库");
 assert.deepEqual(search(history,"搜索").data.map((r:Value)=>r.thread.id),["zh"]);
 assert.deepEqual(search(history,"数据库").data.map((r:Value)=>r.thread.id),["zh"]);
 assert.equal(search(history,"库").data.length,2);assert.equal(search(history,"foo-bar").data.length,1);
 seed(history,"mixed","数据库",2,[item("false","数据 unrelated 据库"),item("true","数据库")]);
 assert.ok(search(history,"数据库").data.some((r:Value)=>r.thread.id==="mixed"));
 assert.throws(()=>search(history,'***'),InvalidSearch);assert.deepEqual(search(history,'neutrino" OR "secret').data,[]);
});
test("literal verification only visits FTS candidates in a newly backfilled database",async t=>{
 const {history,storage}=await fixture(t);seed(history,"hit","数据库");seed(history,"false-positive","数据 unrelated 据库");
 for(let i=0;i<50;i++)seed(history,"unrelated-"+i,"unrelated body");
 let verified=0;storage.database.function("opencraft_search_contains",{deterministic:true},(value,term)=>{verified++;return String(value).includes(String(term))?1:0;});
 assert.deepEqual(search(history,"数据库").data.map((r:Value)=>r.thread.id),["hit"]);
 assert.equal(verified,1,"unmatched bodies must not reach the literal verifier");
});
test("indexing title, tool output and structured text excludes binary payloads",async t=>{
 const {history}=await fixture(t);seed(history,"thread","unused",1,[{id:"tool",type:"mcpToolCall",result:{content:[{type:"text",text:"toolneedle"},{type:"image",data:"binaryneedle"}],structuredContent:{custom:"structuredevidence"}}}]);
 assert.equal(search(history,"toolneedle").data.length,1);assert.equal(search(history,"structuredevidence").data.length,1);
 assert.equal(search(history,"binaryneedle").data.length,0);
 history.metadata({...metadata("thread"),name:"titleevidence"});assert.equal(search(history,"titleevidence").data.length,1);
});
test("scope, archived/source filters and ACL apply before output pagination",async t=>{
 const {history,storage}=await fixture(t);seed(history,"private","needle needle",1);seed(history,"allowed-a","needle",2);seed(history,"allowed-b","needle",3);
 const peer=new ConversationHistory(storage.database,"opencraft-server");seed(peer,"peer","needle");
 const allowed=(id:string)=>id!=="private";
 const first=search(history,"needle",{limit:1},allowed);assert.equal(first.data.length,1);assert.notEqual(first.data[0].thread.id,"private");assert.ok(first.nextCursor);
 assert.ok(!Buffer.from(first.nextCursor.slice(20),"base64url").toString().includes("private"));
 const next=search(history,"needle",{limit:1,cursor:first.nextCursor},allowed);assert.equal(next.data.length,1);assert.notEqual(first.data[0].thread.id,next.data[0].thread.id);assert.equal(next.nextCursor,null);
 history.observe("thread/archived",{threadId:"allowed-b"});assert.equal(search(history,"needle",{},allowed).data.length,1);assert.equal(search(history,"needle",{archived:true},allowed).data[0].thread.id,"allowed-b");
 history.metadata({...metadata("allowed-a"),source:"cli"});assert.equal(search(history,"needle",{sourceKinds:["cli"]},allowed).data.length,1);
 assert.equal(search(peer,"needle").data.length,1);
});
test("externally tagged native session sources retain interactive defaults and explicit subagent filters",async t=>{
 const {history}=await fixture(t);
 for(const [id,source] of Object.entries({interactive:"cli",review:{subAgent:"review"},compact:{subAgent:"compact"},spawn:{subAgent:{thread_spawn:{parent_thread_id:"interactive",depth:1}}},legacy:{subagent:{other:"legacy"}},custom:{custom:"analytics"}})) {
  seed(history,id,"sourceneedle");history.metadata({...metadata(id),source,threadSource:"unrelated-analytics"});
 }
 assert.deepEqual(search(history,"sourceneedle").data.map((r:Value)=>r.thread.id).sort(),["custom","interactive"]);
 assert.equal(search(history,"sourceneedle",{sourceKinds:["subAgent"]}).data.length,4);
 assert.deepEqual(search(history,"sourceneedle",{sourceKinds:["subAgentThreadSpawn"]}).data.map((r:Value)=>r.thread.id),["spawn"]);
 assert.deepEqual(search(history,"sourceneedle",{sourceKinds:["unknown"]}).data.map((r:Value)=>r.thread.id),["custom"]);
});
test("search cursors bind to query, scope and committed index version",async t=>{
 const {history,storage}=await fixture(t);seed(history,"a","needle");seed(history,"b","needle");
 const first=search(history,"needle",{limit:1});assert.ok(first.nextCursor);
 assert.throws(()=>search(history,"other",{cursor:first.nextCursor}),InvalidSearch);
 assert.throws(()=>search(new ConversationHistory(storage.database,"other"),"needle",{cursor:first.nextCursor}),InvalidSearch);
 history.observe("item/completed",{threadId:"b",turnId:"turn",item:item("answer","changed")});
 assert.throws(()=>search(history,"needle",{cursor:first.nextCursor}),InvalidSearch);
 assert.deepEqual(search(history,"changed").data.map((r:Value)=>r.thread.id),["b"]);
});
test("removal, whole-thread deletion and trigger failure preserve atomic search facts",async t=>{
 const {history,storage}=await fixture(t);seed(history,"thread","oldterm",1,[item("a","survivor"),item("b","oldterm")]);
 const rev=history.revision("thread");seed(history,"thread","",1,[item("a","survivor")]);assert.ok(history.revision("thread")>rev);assert.equal(search(history,"oldterm").data.length,0);
 storage.database.exec("CREATE TRIGGER reject_search BEFORE INSERT ON conversation_search_documents BEGIN SELECT RAISE(ABORT,'search fault'); END");
 const before=history.revision("thread"),catalog=history.catalogRevision();
 assert.throws(()=>history.observe("item/completed",{threadId:"thread",turnId:"turn",item:item("x","rollbackterm")}),/search fault/);
 assert.equal(history.revision("thread"),before);assert.equal(history.catalogRevision(),catalog);assert.equal(search(history,"rollbackterm").data.length,0);
 storage.database.exec("DROP TRIGGER reject_search");history.delete("thread");assert.equal(search(history,"survivor").data.length,0);
 assert.equal(storage.database.prepare("SELECT count(*) AS n FROM conversation_search_documents").get()!.n,0);
});
test("index survives reopen and is rebuildable in bounded owner batches",async t=>{
 const f=await fixture(t);seed(f.history,"thread","needle",1,[item("a","needle"),item("b","otherneedle")]);
 const history=await f.reopen();assert.equal(search(history,"needle").data.length,1);
 history.rebuild("thread");assert.equal(search(history,"needle").data.length,0);
 const first=history.reindex("thread",1);assert.equal(first.indexed,1);assert.equal(first.complete,false);
 assert.equal(history.reindex("thread",1).complete,true);assert.equal(search(history,"needle").data.length,1);
 assert.equal(f.storage.database.prepare("SELECT search_revision=revision AS valid FROM conversation_threads WHERE id='thread'").get()!.valid,1);
});
test("occurrence UTF-16 ranges and inclusive platform locators agree with stored content",async t=>{
 const {history}=await fixture(t);seed(history,"thread","",1,[item("z","😀 café needle"),item("a","second needle"),{...item("hidden","needle"),phase:"commentary"}]);
 const first=history.read("thread/searchOccurrences",{threadId:"thread",searchTerm:"needle",limit:1});
 assert.equal(first.data[0].itemId,"z");assert.equal(first.data[0].snippet.slice(first.data[0].snippetMatchRange.start,first.data[0].snippetMatchRange.end),"needle");
 const second=history.read("thread/searchOccurrences",{threadId:"thread",searchTerm:"needle",limit:1,cursor:first.nextCursor});assert.equal(second.data[0].itemId,"a");assert.ok(second.nextCursor);
 const activity=history.read("thread/searchOccurrences",{threadId:"thread",searchTerm:"needle",limit:1,cursor:second.nextCursor});assert.equal(activity.data[0].itemId,"hidden");assert.equal(activity.nextCursor,null);
 assert.equal(history.read("thread/turns/list",{threadId:"thread",cursor:first.data[0].turnCursor}).data[0].id,"turn");
 const accent=searchSnippet("😀 café needle","cafe");assert.equal(accent.snippet.slice(accent.snippetMatchRange.start,accent.snippetMatchRange.end),"café");
});
test("search locates retained isolated records without joining unverified ranges",async t=>{
 const {history}=await fixture(t);seed(history,"thread","oldneedle");
 assert.ok(history.importResult("thread/turns/list",{threadId:"thread",itemsView:"full"},{data:[{id:"latest",itemsView:"full",items:[item("new","newneedle")]}],nextCursor:"native-next"},history.revision("thread")));
 const hit=history.read("thread/searchOccurrences",{threadId:"thread",searchTerm:"oldneedle"}).data[0];
 const page=history.read("thread/turns/list",{threadId:"thread",cursor:hit.turnCursor});
 assert.deepEqual(page.data.map((g:Value)=>g.id),["turn"]);assert.equal(page.historyCoverage.state,"partial");assert.equal(page.historyCoverage.evidence,"unknown");
 assert.equal(history.sourceCursor("thread",page.nextCursor),"__history_gap__");
 assert.throws(()=>history.read("thread/turns/list",{threadId:"thread",cursor:page.nextCursor}),/isolated/);
 assert.equal(history.read("thread/turns/list",{threadId:"thread"}).data[0].id,"latest");
});
test("large tool snippets keep accurate Unicode offsets without whole-body offset arrays",()=>{
 const text="filler ".repeat(200000)+"😀 ﬃ Cafe\u0301";
 const ligature=searchSnippet(text,"ffi");assert.equal(ligature.snippet.slice(ligature.snippetMatchRange.start,ligature.snippetMatchRange.end),"ﬃ");assert.ok(ligature.snippet.length<300);
 const accent=searchSnippet(text,"cafe");assert.equal(accent.snippet.slice(accent.snippetMatchRange.start,accent.snippetMatchRange.end),"Cafe\u0301");
});
async function rpc(transport:ConversationHistoryTransport,id:number,method:string,params:Value={}) {
 let reply:Value|undefined;const remove=transport.subscribeMessage(frame=>{const p=JSON.parse(frame);if(p.id===id)reply=p;});
 try{await transport.send(JSON.stringify({id,method,params}));return reply;}finally{remove();}
}
test("offline search does not call the engine and the trusted visibility predicate is used",async t=>{
 const f=await fixture(t);seed(f.history,"allowed","needle");seed(f.history,"private","needle");const history=await f.reopen();let sends=0;
 const transport=new ConversationHistoryTransport({status:{state:"idle"},async connect(){},async send(){sends++;throw Error("offline");},subscribeMessage(){return()=>{};},subscribeStatus(){return()=>{};},async close(){}},history,undefined,50,undefined,id=>id!=="private");t.after(()=>transport.close());
 await transport.connect();await rpc(transport,1,"initialize");const before=sends;
 const result=await rpc(transport,2,"thread/search",{searchTerm:"needle"});assert.deepEqual(result!.result.data.map((r:Value)=>r.thread.id),["allowed"]);assert.equal(sends,before);
 assert.ok((await rpc(transport,3,"thread/searchOccurrences",{threadId:"private",searchTerm:"needle"}))!.error);
});
test("sync acknowledges source pages only after a durable import and never invokes execution",async t=>{
 const f=await fixture(t);const messages=new Set<(f:string)=>void>(),methods:string[]=[];
 let sourceText="syncedneedle";
 const native={status:{state:"open" as const},async connect(){},async send(frame:string){const r=JSON.parse(frame);methods.push(r.method);if(r.id===undefined)return;
 const result=r.method==="initialize"?{capabilities:{extensions:{}}}:r.method==="thread/read"?{thread:{...metadata("thread"),turns:[]}}:{data:[{id:"turn",itemsView:"full",items:[item("answer",sourceText)]}],nextCursor:null};
 for(const listener of messages)listener(JSON.stringify({id:r.id,result}));},subscribeMessage(l:(f:string)=>void){messages.add(l);return()=>messages.delete(l);},subscribeStatus(){return()=>{};},async close(){}};
 const transport=new ConversationHistoryTransport(native,f.history,undefined,100);t.after(()=>transport.close());await transport.connect();await rpc(transport,1,"initialize");
 const result=await rpc(transport,2,"opencraft/history/sync",{threadId:"thread"});assert.ok(result?.result,JSON.stringify({result,methods}));assert.equal(result!.result.imported,1);assert.equal(result!.result.index.complete,true);assert.equal(search(f.history,"syncedneedle").data.length,1);
 f.storage.database.exec("CREATE TRIGGER reject_sync BEFORE INSERT ON conversation_events BEGIN SELECT RAISE(ABORT,'sync fault'); END");
 // Force a source content update so the transaction cannot be a no-op.
 f.history.searchIndex.invalidate("thread");
 const original=native.send.bind(native);
 sourceText="changedneedle";
 const fault=await rpc(transport,30,"opencraft/history/sync",{threadId:"thread"});assert.ok(fault!.error);assert.ok(!fault!.result);
 assert.equal(search(f.history,"changedneedle").data.length,0);
 f.storage.database.exec("DROP TRIGGER reject_sync");
 native.send=async frame=>{if(JSON.parse(frame).method==="thread/turns/list")f.storage.database.exec("UPDATE conversation_threads SET revision=revision+1 WHERE id='thread'");await original(frame);};
 const rejected=await rpc(transport,3,"opencraft/history/sync",{threadId:"thread"});assert.ok(rejected!.error);assert.ok(!rejected!.result);
 native.send=async frame=>{const r=JSON.parse(frame);if(r.method!=="thread/turns/list")return original(frame);for(const listener of messages)listener(JSON.stringify({id:r.id,result:{data:[{id:"missing-full-items",itemsView:"notLoaded"}],nextCursor:null}}));};
 const incomplete=await rpc(transport,4,"opencraft/history/sync",{threadId:"thread"});assert.ok(incomplete!.error);assert.ok(!incomplete!.result);
 assert.ok(methods.every(m=>["initialize","initialized","thread/read","thread/turns/list"].includes(m)));
});

test("a no-op indexing pass preserves search and occurrence cursors; real repairs invalidate them",async t=>{
 const {history}=await fixture(t);seed(history,"a","needle",1,[item("one","needle"),item("two","needle")]);seed(history,"b","needle",2);
 const page=search(history,"needle",{limit:1}),occurrence=history.read("thread/searchOccurrences",{threadId:"a",searchTerm:"needle",limit:1});
 const version=history.searchIndex.version();assert.equal(history.reindex("a").indexed,0);assert.equal(history.searchIndex.version(),version);
 assert.equal(search(history,"needle",{cursor:page.nextCursor}).data.length,1);
 assert.equal(history.read("thread/searchOccurrences",{threadId:"a",searchTerm:"needle",cursor:occurrence.nextCursor}).data[0].itemId,"two");
 history.searchIndex.invalidate("a");history.reindex("a");assert.throws(()=>search(history,"needle",{cursor:page.nextCursor}),InvalidSearch);
});
test("tool and activity occurrences locate indexed text in the same group without reading unrelated bodies",async t=>{
 const {history,storage}=await fixture(t);seed(history,"thread","",1,[{id:"tool",type:"commandExecution",aggregatedOutput:"prefix ".repeat(10000)+"工具输出 proofneedle"},item("answer","unrelated"),{...item("activity","comment proofneedle"),phase:"commentary"}]);
 assert.equal(search(history,"proofneedle").data.length,1);
 const hits=history.read("thread/searchOccurrences",{threadId:"thread",searchTerm:"proofneedle"});assert.deepEqual(hits.data.map((r:Value)=>r.itemId),["tool","activity"]);
 assert.match(hits.data[0].snippet,/proofneedle/);assert.ok(hits.data[0].snippet.length<300);
 const group=history.read("thread/turns/list",{threadId:"thread",cursor:hits.data[0].turnCursor,itemsView:"full"});assert.ok(group.data[0].items.some((r:Value)=>r.id==="tool"));
 assert.equal(storage.database.prepare("SELECT COUNT(*) AS n FROM conversation_search_documents").get()!.n,4);
});

test("directory continuation rotation preserves search pages when indexed facts are unchanged",async t=>{
 const {history}=await fixture(t);seed(history,"a","needle",1,[item("one","needle"),item("two","needle")]);seed(history,"b","needle",2);
 const data=[metadata("b",2),metadata("a",1)];
 history.importResult("thread/list",{},{data,nextCursor:"source-a"},history.catalogRevision());
 const page=search(history,"needle",{limit:1}),occurrence=history.read("thread/searchOccurrences",{threadId:"a",searchTerm:"needle",limit:1});
 history.importResult("thread/list",{},{data,nextCursor:"source-b"},history.catalogRevision());
 assert.equal(search(history,"needle",{cursor:page.nextCursor}).data.length,1);
 assert.equal(history.read("thread/searchOccurrences",{threadId:"a",searchTerm:"needle",cursor:occurrence.nextCursor}).data[0].itemId,"two");
 history.metadata({...metadata("b",2),name:"changed"});
 assert.throws(()=>search(history,"needle",{cursor:page.nextCursor}),InvalidSearch);
});
