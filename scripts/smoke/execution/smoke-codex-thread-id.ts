import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { zstdDecompressSync, gunzipSync } from "node:zlib";
const executable = process.env.OPENCRAFT_CODEX_EXECUTABLE;
if (!executable) throw new Error("Set OPENCRAFT_CODEX_EXECUTABLE to the fixed native CLI under test");
const root = await mkdtemp(join(tmpdir(), "codex-thread-id-"));
await mkdir(join(root,"home")); const marker = join(root,"thread-id");
let count = 0;
const server = createServer(async (request,response) => {
  try {
    const chunks:Buffer[]=[]; for await (const chunk of request) chunks.push(chunk);
    if (!request.url?.endsWith("/responses")) { response.writeHead(404); response.end(); return; }
    const raw=Buffer.concat(chunks),encoding=request.headers["content-encoding"];
    const body=JSON.parse((encoding==="zstd"?zstdDecompressSync(raw):encoding==="gzip"?gunzipSync(raw):raw).toString());
    const tool = !(body.input??[]).some((item:any)=>item.type==="function_call_output");
    const id=`fixture-${++count}`;
    const item=tool?{type:"function_call",id:"thread-probe",call_id:"thread-probe",name:"exec_command",
      arguments:JSON.stringify({cmd:`printf '%s' "$CODEX_THREAD_ID" > '${marker}'`,yield_time_ms:1000,max_output_tokens:100})}:
      {type:"message",id,role:"assistant",status:"completed",content:[{type:"output_text",text:"done",annotations:[]}]};
    response.writeHead(200,{"content-type":"text/event-stream"});
    for(const event of [{type:"response.created",response:{id,object:"response",status:"in_progress",output:[]}},
      {type:"response.output_item.added",output_index:0,item:{...item,...(tool?{arguments:""}:{content:[],status:"in_progress"})}},
      {type:"response.output_item.done",output_index:0,item},
      {type:"response.completed",response:{id,object:"response",status:"completed",output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}])
      response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end();
  } catch { response.writeHead(500); response.end(); }
});
await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
const port=(server.address() as import("node:net").AddressInfo).port;
const child=spawn(executable,["app-server","-c",'model="gpt-test"',"-c",'model_provider="fixture"',
  "-c",'model_providers.fixture.name="Fixture"',"-c",`model_providers.fixture.base_url="http://127.0.0.1:${port}"`,
  "-c",'model_providers.fixture.wire_api="responses"',"-c","model_providers.fixture.requires_openai_auth=false",
  "-c","model_providers.fixture.supports_websockets=false"],{
  cwd:root,env:{PATH:process.env.PATH,HOME:join(root,"home"),CODEX_HOME:join(root,"home"),TMPDIR:root,RUST_LOG:"error"},stdio:["pipe","pipe","pipe"]});
const pending=new Map<number,{resolve(v:any):void;reject(e:Error):void}>(); let seq=0;
let resolveDone!:(v:any)=>void;const done=new Promise<any>(resolve=>resolveDone=resolve);
const lines=createInterface({input:child.stdout});
lines.on("line",line=>{try{const v=JSON.parse(line);if(v.method==="turn/completed")resolveDone(v.params.turn);
  if(typeof v.id==="number"&&pending.has(v.id)){const p=pending.get(v.id)!;pending.delete(v.id);v.error?p.reject(new Error("Native fixture RPC rejected")):p.resolve(v.result);}}catch{}});
child.stderr.resume();
const rpc=(method:string,params:unknown)=>new Promise<any>((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});child.stdin.write(JSON.stringify({id,method,params})+"\n");});
const timeout=setTimeout(()=>{for(const p of pending.values())p.reject(new Error("Native fixture timeout"));resolveDone({status:"timeout"});child.kill();},30000);
try{
  await rpc("initialize",{clientInfo:{name:"thread-id-fixture",version:"1"},capabilities:{experimentalApi:true}});
  child.stdin.write('{"method":"initialized","params":{}}\n');
  const {thread}=await rpc("thread/start",{cwd:root,model:"gpt-test",approvalPolicy:"never",sandbox:"danger-full-access"});
  await rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"Run the local environment probe",text_elements:[]}]});
  assert.equal((await done).status,"completed");
  assert.equal(await readFile(marker,"utf8"),thread.id);
  console.log(JSON.stringify({passed:true,cli:execFileSync(executable,["--version"],{encoding:"utf8"}).trim(),threadIdInjected:true,model:"synthetic-loopback"}));
}finally{clearTimeout(timeout);lines.close();child.kill();await new Promise<void>(resolve=>child.exitCode!==null?resolve():child.once("exit",()=>resolve()));
  server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});}
