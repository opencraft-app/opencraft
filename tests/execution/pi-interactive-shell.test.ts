import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { PiDurableSession } from "../../plugins/pi-engine/src/session.js";
import { PiShellWorker, shellText } from "../../plugins/pi-engine/src/shell.js";
import { projectPiSnapshot } from "../../plugins/pi-engine/src/projection.js";
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(check: () => Promise<boolean>, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (!await check()) { if (Date.now() > deadline) assert.fail("Expected condition did not arrive"); await pause(20); }
}
async function fixture(t: test.TestContext, responses: any[]) {
  const directory = await mkdtemp(join(tmpdir(), "pi-shell-integration-"));
  const faux = fauxProvider({ tokensPerSecond: 100000 }); faux.setResponses(responses);
  const models = createModels(); models.setProvider(faux.provider);
  const faults: Error[] = [];
  const native = await PiDurableSession.open({ threadId: "fixture", cwd: directory, file: join(directory,"native.sqlite"), agentDirectory: directory,
    models: models as unknown as ModelRuntime, tools: [], onSnapshot() {}, onTool: async () => { throw new Error("Unexpected platform call"); }, onExit: error => faults.push(error) });
  await native.configure({ model: { provider: "faux", modelId: "faux-1" }, cwd: directory });
  t.after(async () => { await native.close(); await rm(directory, { recursive: true, force: true }); assert.deepEqual(faults, []); });
  return { native, faux, directory };
}
const inputData = { turnId: "original", clientId: "human", input: [{ type:"text", text:"run" }], createdAtMs:Date.now() };

test("yielding bash admits steer before command completion and completion wakes a system continuation exactly once", async t => {
  let entered!: () => void, release!: () => void;
  const enteredPromise = new Promise<void>(r => entered = r), released = new Promise<void>(r => release = r);
  let steerSeen = false, resultSeen = false;
  const f = await fixture(t, [
    fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 3; printf shell-finished", yield_time_ms: 20 }), { stopReason: "toolUse" }),
    async () => { entered(); await released; return fauxAssistantMessage("command is still running"); },
    (ctx: any) => { steerSeen = JSON.stringify(ctx).includes("change-direction"); assert.ok(steerSeen); return fauxAssistantMessage("steer acknowledged"); },
    (ctx: any) => { resultSeen = ctx.messages.some((message: any) => message.role === "user" && JSON.stringify(message.content).includes("shell-finished")); assert.ok(resultSeen); return fauxAssistantMessage("result acknowledged"); },
  ]);
  const initial = await f.native.submit("run",inputData,"original");
  await enteredPromise;
  await f.native.steer([{ type:"text", text:"change-direction" }], { turnId:"steering", steerTurnId:"original", clientId:"steer-human", input:[{type:"text",text:"change-direction"}], createdAtMs:Date.now() }, "steering", "original");
  release(); await initial.wait(context);
  await eventually(async () => steerSeen);
  assert.equal(resultSeen, false, "steer must be processed before the command completes");
  await eventually(async () => resultSeen);
  await eventually(async () => !(await f.native.snapshot()).live.run);
  const snapshot = await f.native.snapshot();
  assert.equal(snapshot.submissions.filter(s => s.requestId?.startsWith("pi-shell:")).length, 1);
  const turns = projectPiSnapshot({ id:"fixture",cwd:f.directory,tools:[] },snapshot);
  assert.equal(turns.flatMap(turn => turn.items).filter(item => item.type === "userMessage").length, 2, "system completion must never fabricate a human row");
  assert.equal(f.faux.state.callCount,4);
});

test("short bash returns its result inline without an extra model continuation", async t => {
  let output = "";
  const f = await fixture(t,[
    fauxAssistantMessage(fauxToolCall("bash",{command:"printf inline-result"}),{stopReason:"toolUse"}),
    (ctx:any) => { output=JSON.stringify(ctx.messages.filter((message: any) => message.role === "toolResult")); return fauxAssistantMessage("done"); },
  ]);
  await f.native.submit("run",inputData,"original");
  await eventually(async () => f.faux.state.callCount === 2 && !(await f.native.snapshot()).live.run);
  assert.match(output,/inline-result/);
  assert.equal((await f.native.snapshot()).submissions.length,1);
});

test("headless worker supports output, input and cancellation; workers isolate sessions and exit without retained timers", async t => {
  const directory=await mkdtemp(join(tmpdir(),"pi-shell-pty-"));
  const events:any[]=[];
  const a=new PiShellWorker({cwd:directory,directory:join(directory,"a"),threadId:"a",onNotification:e=>events.push(e),onLost:()=>assert.fail("Unexpected worker loss")});
  const b=new PiShellWorker({cwd:directory,directory:join(directory,"b"),threadId:"b",onNotification() {},onLost:()=>assert.fail("Unexpected worker loss")});
  t.after(async()=>{await Promise.all([a.stop(),b.stop()]);await rm(directory,{recursive:true,force:true})});
  const launched=await a.call({command:"read value; printf 'input:%s' \"$value\"",mode:"dispatch",background:true,handsFree:{autoExitOnQuiet:false}});
  assert.ok(!launched.isError);const id=launched.details!.sessionId;assert.equal(typeof id,"string");
  const foreign=await b.call({sessionId:id});assert.equal(foreign.isError,true);
  const sent=await a.call({sessionId:id,input:"test-input",submit:true});assert.ok(!sent.isError);
  await eventually(async()=>events.length===1);assert.match(events[0].message.content,/input:test-input/);
  const pidFile=join(directory,"pid");
  const long=await a.call({command:`echo $$ > '${pidFile}'; exec sleep 20`,mode:"dispatch",background:true,handsFree:{autoExitOnQuiet:false}});
  assert.ok(!long.isError);await eventually(async()=>{try{await access(pidFile);return true}catch{return false}});
  const pid=Number(await readFile(pidFile,"utf8"));
  await a.stop();
  await eventually(async()=>{try{process.kill(pid,0);return false}catch{return true}});
});

test("stop cancels background work after the original turn settles and does not wake a new run", async t => {
  let finished=false;
  const f=await fixture(t,[fauxAssistantMessage(fauxToolCall("bash",{command:"sleep 3; printf should-not-run",yield_time_ms:0}),{stopReason:"toolUse"}),
    ()=>{finished=true;return fauxAssistantMessage("background started")},fauxAssistantMessage("unexpected continuation")]);
  await f.native.submit("run",inputData,"original");
  await eventually(async()=>finished&&!(await f.native.snapshot()).live.run);
  await f.native.abort();await pause(200);
  assert.equal(f.faux.state.callCount,2);assert.equal((await f.native.snapshot()).submissions.length,1);
});

test("restart reports interruption without replaying a side effect and retains queryable session state", async t => {
  let firstFinished=false;
  const f=await fixture(t,[fauxAssistantMessage(fauxToolCall("bash",{command:"printf once >> launches; sleep 20",yield_time_ms:0}),{stopReason:"toolUse"}),
    ()=>{firstFinished=true;return fauxAssistantMessage("background") }]);
  await f.native.submit("run",inputData,"original");
  await eventually(async()=>firstFinished&&!(await f.native.snapshot()).live.run);
  await f.native.close();
  let interrupted=false;
  const faux=fauxProvider({tokensPerSecond:100000});faux.setResponses([(ctx:any)=>{interrupted=JSON.stringify(ctx).includes("previous command was interrupted");return fauxAssistantMessage("interruption acknowledged")}]);
  const models=createModels();models.setProvider(faux.provider);
  const reopened=await PiDurableSession.open({threadId:"fixture",cwd:f.directory,file:join(f.directory,"native.sqlite"),agentDirectory:f.directory,models:models as unknown as ModelRuntime,tools:[],onSnapshot(){},onTool:async()=>{throw new Error("Unexpected tool")},onExit:error=>assert.fail(error.message)});
  t.after(()=>reopened.close());
  await eventually(async()=>interrupted);
  assert.equal(await readFile(join(f.directory,"launches"),"utf8"),"once");
  const snapshot=await reopened.snapshot();
  assert.equal(snapshot.submissions.filter(s=>s.requestId?.startsWith("pi-shell:")).length,1);
  const notification=snapshot.submissions.find(s=>s.requestId?.startsWith("pi-shell:"))!;
  const id=notification.requestId!.split(":").slice(2).join(":");
  await (reopened as any).shellNotification({triggerTurn:true,message:{customType:"interactive-shell-transfer",details:{sessionId:id},content:"duplicate completion must not run"}});
  assert.equal((await reopened.snapshot()).submissions.length,snapshot.submissions.length);
});

test("structured monitor events retain a live session until its separate completion notification", async t => {
  const observed:string[]=[];
  const f=await fixture(t,[fauxAssistantMessage(fauxToolCall("interactive_shell",{command:"printf 'READY\\n'; sleep 1; printf 'DONE\\n'",mode:"monitor",monitor:{strategy:"stream",triggers:[{id:"ready",literal:"READY"}]}}),{stopReason:"toolUse"}),
    fauxAssistantMessage("monitor started"),
    (ctx:any)=>{observed.push(JSON.stringify(ctx.messages.filter((m:any)=>m.role==="user")));return fauxAssistantMessage("monitor event")},
    (ctx:any)=>{observed.push(JSON.stringify(ctx.messages.filter((m:any)=>m.role==="user")));return fauxAssistantMessage("monitor completed")},
  ]);
  await f.native.submit("run",inputData,"original");
  await eventually(async()=>f.faux.state.callCount>=4&&!(await f.native.snapshot()).live.run);
  assert.equal((await f.native.snapshot()).submissions.filter(s=>s.requestId?.startsWith("pi-shell:")).length,2);
  assert.match(observed.join("\n"),/READY/);assert.match(observed.join("\n"),/DONE|stream-ended/);
});

test("Pi Host WebSocket exposes the installed shell and accepts steer while its real PTY continues", async t => {
  const { PiEngine, piModel }=await import('../../plugins/pi-engine/src/index.js');
  const { startEngineHost }=await import('../../apps/local-agent-host/src/engine-host.js');
  const { default: WebSocket }=await import('ws');
  const directory=await mkdtemp(join(tmpdir(),'pi-shell-wire-'));
  const faux=fauxProvider({tokensPerSecond:100000});const models=createModels();models.setProvider(faux.provider);
  let entered!:()=>void, release!:()=>void;const enteredPromise=new Promise<void>(r=>entered=r),released=new Promise<void>(r=>release=r);
  let steered=false,completed=false;
  faux.setResponses([fauxAssistantMessage(fauxToolCall('bash',{command:'sleep 2; printf wire-complete',yield_time_ms:10}),{stopReason:'toolUse'}),
    async()=>{entered();await released;return fauxAssistantMessage('running')},
    (ctx:any)=>{steered=JSON.stringify(ctx.messages).includes('wire-steer');return fauxAssistantMessage('steered')},
    (ctx:any)=>{completed=ctx.messages.some((m:any)=>m.role==='user'&&JSON.stringify(m.content).includes('wire-complete'));return fauxAssistantMessage('completed')},
  ]);
  const engine=new PiEngine({directory,cwd:directory,models:Object.assign(models,{getAvailableSnapshot:()=>faux.models}) as unknown as ModelRuntime});
  const host=await startEngineHost({providers:[engine],defaultEngine:'pi'});
  const socket=new WebSocket(host.websocketUrl);
  t.after(async()=>{socket.terminate();await host.close();await engine.close();await rm(directory,{recursive:true,force:true})});
  await new Promise<void>((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject)});
  let next=0;
  const call=(method:string,params:any={})=>new Promise<any>((resolve,reject)=>{const id=++next;
    const listener=(raw:any)=>{const message=JSON.parse(raw.toString());if(message.id!==id)return;socket.off('message',listener);message.error?reject(new Error(message.error.message)):resolve(message.result)};
    socket.on('message',listener);socket.send(JSON.stringify({jsonrpc:'2.0',id,method,params}));
  });
  const initialized=await call('initialize');
  const provider=initialized.capabilities.extensions['opencraft/execution-engines'].providers.find((p:any)=>p.id==='pi');
  assert.equal(provider.extensions['opencraft/pi-shell'].extensionVersion,'0.17.1');
  const {thread}=await call('thread/start',{model:piModel('faux','faux-1'),cwd:directory});
  const {turn}=await call('turn/start',{threadId:thread.id,input:[{type:'text',text:'wire run'}],clientUserMessageId:'wire-human'});
  await enteredPromise;
  await call('turn/steer',{threadId:thread.id,expectedTurnId:turn.id,input:[{type:'text',text:'wire-steer'}],clientUserMessageId:'wire-steer-human'});
  release();await eventually(async()=>steered);assert.equal(completed,false);
  await eventually(async()=>completed);
  const history=await call('thread/read',{threadId:thread.id,includeTurns:true});
  assert.equal(history.thread.turns.flatMap((t:any)=>t.items).filter((i:any)=>i.type==='userMessage').length,2);
});

test("killing one shell marks its durable handle interrupted without waking a completion turn", async t => {
  let checked=false, result:any;
  const f=await fixture(t,[
    fauxAssistantMessage(fauxToolCall('interactive_shell',{command:'sleep 20',name:'kill-state',mode:'dispatch'}),{stopReason:'toolUse'}),
    fauxAssistantMessage(fauxToolCall('interactive_shell',{sessionId:'kill-state',kill:true}),{stopReason:'toolUse'}),
    fauxAssistantMessage(fauxToolCall('interactive_shell',{sessionId:'kill-state'}),{stopReason:'toolUse'}),
    (ctx:any)=>{result=ctx.messages.filter((m:any)=>m.role==='toolResult').at(-1);checked=true;return fauxAssistantMessage('cancelled')},
  ]);
  await f.native.submit('run',inputData,'original');
  await eventually(async()=>checked&&!(await f.native.snapshot()).live.run);
  assert.equal(result.isError,true,JSON.stringify(result));assert.match(JSON.stringify(result.content),/interrupted/);
  assert.equal((await f.native.snapshot()).submissions.length,1);
});
