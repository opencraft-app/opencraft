import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { AcpEngine, dshAcpCommand } from "../../../plugins/acp-engine/src/index.js";
import { patchDshThreadEnvironment } from "../../patch-dsh-thread-environment.mjs";
const runtime = process.env.OPENCRAFT_DSH_TEST_RUNTIME;
if (!runtime) throw new Error("Set an isolated writable OPENCRAFT_DSH_TEST_RUNTIME copy; never pass a shared toolchain");
const root = await mkdtemp(join(tmpdir(), "oc-dsh-acp-thread-id-"));
let engine: AcpEngine | undefined;
try {
  await patchDshThreadEnvironment(runtime);
  const entry = join(runtime,"node_modules/@deepseek-ai/dsh/lib/bin.js"), routes = join(root,"routes");
  await mkdir(routes);
  const plugin = join(root,"synthetic-model.mjs"), patch = join(root,"patch.json"), marker = join(root,"shell-id");
  const llm = pathToFileURL(resolve(dirname(entry),"../../dsh-llm/lib/index.js")).href;
  await writeFile(plugin, `import {LlmAdapter} from ${JSON.stringify(llm)};
class Synthetic extends LlmAdapter {async *stream(options){
const results=options.messages.filter(m=>m.role==='tool');
if(!results.length){const tool=options.tools.find(t=>t.name==='bash');if(!tool)throw Error('Native bash missing');
const args=JSON.stringify({description:"Verify stable public OpenCraft thread identity",command:${JSON.stringify(`printf '%s' "$OPENCRAFT_THREAD_ID" > '${marker}'`)}});
yield{type:'block-start',index:0,blockType:'tool-call'};yield{type:'tool-call-delta',index:0,id:'shell-id',name:tool.name,argumentsDelta:args};yield{type:'block-end',index:0,block:{type:'tool-call',id:'shell-id',name:tool.name,arguments:args}};yield{type:'finish',reason:{kind:'tool-calls'}};return;}
yield{type:'block-start',index:0,blockType:'text'};yield{type:'text-delta',index:0,text:'done'};yield{type:'block-end',index:0,block:{type:'text',text:'done'}};yield{type:'finish',reason:{kind:'stop'}};}}
export const inject=['llm'];export function apply(ctx){ctx.llm.registerAdapter(['synthetic-thread-id'],new Synthetic());}
`);
  await writeFile(patch,JSON.stringify([
    {id:"llm-deepseek",disabled:true}, {id:"acp",config:{provider:"synthetic-thread-id",model:"fixture"}},
    {insert:[{id:"synthetic-thread-id",name:plugin},{id:"opencraft-execution-environment",name:resolve("apps/local-agent-host/src/dsh-acp-execution-environment.mjs"),config:{routesDirectory:routes}}]},
  ]));
  engine = new AcpEngine({id:"dsh-acp",...dshAcpCommand(entry,[patch]),dataDirectory:routes,cwd:root,permission:"allow-once",
    env:{DSH_HOME:join(root,"native"),DSH_PERMISSION_MODE:"danger-full-access",DEEPSEEK_API_KEY:"synthetic-only"}});
  await engine.start();
  const client={notify(){},async request(){throw new Error("Unexpected callback");}};
  const created=await engine.request("thread/start",{},client);
  const done=new Promise<any>(resolve=>engine!.subscribe((method,params)=>{if(method==="turn/completed")resolve(params);}));
  await engine.request("turn/start",{threadId:created.thread.id,clientUserMessageId:"synthetic-input",input:[{type:"text",text:"run bash"}]},client);
  const completed = await Promise.race([done,new Promise((_,reject)=>setTimeout(()=>reject(new Error("Native tool timeout")),20000).unref())]);
  const shellId=await readFile(marker,"utf8").catch(()=>{throw new Error(JSON.stringify(completed));});
  assert.equal(shellId,created.thread.id);
  const records=JSON.parse(await readFile(join(routes,created.thread.id+".json"),"utf8"));assert.notEqual(records.nativeId,created.thread.id);
  process.stdout.write(JSON.stringify({passed:true,engine:"real-dsh-acp",publicIdInjected:true,nativeIdDistinct:true,model:"synthetic-only"})+"\n");
} finally {await engine?.close();await rm(root,{recursive:true,force:true});}
