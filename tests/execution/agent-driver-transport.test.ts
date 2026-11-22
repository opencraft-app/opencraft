import assert from "node:assert/strict";
import test from "node:test";
import { AgentDriverTransport } from "../../apps/opencraft-daemon/src/agent-driver-transport.js";
import type { DuplexTransport } from "../../packages/appserver-client/src/transport.js";
import type { Collaboration } from "../../packages/access-control/src/collaboration.js";

function fixture() {
  const frames: any[] = [], grants: any[] = [];
  const inner: DuplexTransport = { status: { state: "open" }, async connect() {}, async send(frame) { frames.push(JSON.parse(frame)); },
    subscribeMessage: () => () => {}, subscribeStatus: () => () => {}, async close() {} };
  const collaboration = { authorizeExecution(...args: unknown[]) { grants.push(args); } } as unknown as Collaboration;
  return { frames, grants, transport: new AgentDriverTransport(inner, collaboration, () => "server:machine:pi") };
}

test("Renderer control forgery cannot create native children, even with a matching wire operation id", async () => {
  const f = fixture(), frame = JSON.stringify({ id: 1, method: "opencraft/orchestration/create", params: { operationId: "spoofed", settings: { driver: "pi" } } });
  await assert.rejects(f.transport.send(frame), /Trusted orchestration admission/);
  await assert.rejects(f.transport.sendWithContext(frame, { sender: null, orchestrationOperationId: "spoofed", orchestrationCanAdmit: () => false }), /Trusted orchestration admission/);
  assert.equal(f.frames.length, 0);
  await f.transport.sendWithContext(frame, { sender: null, orchestrationOperationId: "spoofed", orchestrationCanAdmit: () => true });
  assert.equal(f.frames.length, 1);
});

test("verified human Pi input receives its own scoped delegation before remote native admission", async () => {
  const f = fixture(), actor = { actorId: "human:synthetic", generation: 4, credentialId: null, expiresAt: Date.now() + 10_000 };
  await f.transport.sendWithContext(JSON.stringify({ id: 1, method: "turn/start", params: { threadId: "pi_test", input: [{ type: "text", text: "Delegate this task" }] } }),
    { sender: null, actorContext: actor });
  assert.equal(f.grants.length, 1); assert.equal(f.grants[0][0], actor); assert.equal(f.grants[0][1], "pi_test");
  assert.equal(f.grants[0][4], "server:machine:pi"); assert.equal(f.grants[0][2], f.frames[0].params.clientUserMessageId);
  assert.match(f.frames[0].params.clientUserMessageId, /^human-input:/);
  assert.equal(JSON.stringify(f.frames).includes("human:synthetic"), false, "private ingress authority is never serialized to the engine");
  await f.transport.sendWithContext(JSON.stringify({ id: 2, method: "thread/queue/add", params: { threadId: "pi_test", clientUserMessageId: "human-explicit", input: [] } }),
    { sender: null, actorContext: actor });
  assert.equal(f.grants[1][2], "human-explicit");
});


test("execution context crosses the authorized port once and rejected admission cannot capture it", async () => {
  const forwarded: any[] = [];
  const inner: DuplexTransport = { status: {state:"open"}, async connect(){}, async close(){}, async send(){throw new Error("context lost");},
    async sendWithContext(frame,context){forwarded.push([JSON.parse(frame),context]);},subscribeMessage:()=>()=>{},subscribeStatus:()=>()=>{} };
  const context={sender:null,executionPrincipal:{provider:"employee",subject:"A"},validUntil:Date.now()+10000,
    actorContext:{actorId:"human:A",generation:1,credentialId:null,expiresAt:Date.now()+10000}};
  const transport=new AgentDriverTransport(inner,{authorizeExecution(){throw new Error("denied");}} as any,()=>"server");
  await assert.rejects(transport.sendWithContext(JSON.stringify({id:1,method:"turn/start",params:{threadId:"pi_x",input:[]}}),context),/denied/);
  assert.equal(forwarded.length,0);
  await new AgentDriverTransport(inner,{authorizeExecution(){}} as any,()=>"server").sendWithContext(JSON.stringify({id:2,method:"turn/start",params:{threadId:"pi_x",input:[]}}),context);
  assert.equal(forwarded[0][1],context); assert.ok(forwarded[0][0].params.clientUserMessageId);
  assert.equal(JSON.stringify(forwarded[0][0]).includes('"subject"'),false);
});

test("execution CLI credentials come from authenticated admission and Renderer/anonymous fields are stripped", async () => {
  const frames:any[]=[], signed:any[]=[];
  const inner:any={status:{state:'open'},subscribeMessage:()=>()=>{},async send(frame:string){frames.push(JSON.parse(frame));}};
  const transport=new AgentDriverTransport(inner,{authorizeExecution(){}} as any,()=> 'server',session=>{signed.push(session);return 'signed-execution';});
  const frame=JSON.stringify({id:1,method:'turn/start',params:{threadId:'thread',clientUserMessageId:'input',input:[],__opencraftExecutionCli:'forged'}});
  await transport.send(frame);
  assert.equal(frames[0].params.__opencraftExecutionCli,undefined);assert.equal(signed.length,0);
  await transport.sendWithContext(frame,{sender:null,actorContext:{actorId:'owner',generation:1,expiresAt:Date.now()+10000,credentialId:null}});
  assert.equal(frames[1].params.__opencraftExecutionCli,'signed-execution');
  assert.equal(signed[0].threadId,'thread');assert.equal(signed[0].execution.inputId,'input');assert.ok(signed[0].execution.executionId);
});

test('connected Host reference RPC uses authenticated collaboration authority instead of the native engine',async()=>{
  let receive!:(frame:string)=>void;const native:any[]=[],responses:any[]=[],actors:any[]=[];
  const inner:any={status:{state:'open'},subscribeMessage(listener:(frame:string)=>void){receive=listener;return()=>{};},async send(frame:string){native.push(JSON.parse(frame));}};
  const service:any={capabilities:{version:1,read:true,createLookup:true},async command(actor:unknown,params:any){actors.push(actor);assert.equal(params.action,'reference');return {reference:'opencraft://conversation/v1/server/private-source'};}};
  const transport=new AgentDriverTransport(inner,service,()=> 'server');transport.subscribeMessage(frame=>responses.push(JSON.parse(frame)));
  await transport.send(JSON.stringify({id:1,method:'initialize',params:{}}));receive(JSON.stringify({id:1,result:{capabilities:{extensions:{'opencraft/method-access':{methods:['initialize']}}}}}));
  assert.equal(responses[0].result.capabilities.extensions['opencraft/collaboration'].read,true);
  assert.equal(responses[0].result.capabilities.extensions['opencraft/collaboration'].createLookup,true);
  const message=JSON.stringify({id:2,method:'opencraft/collaboration',params:{action:'reference',threadId:'private-source'}});
  await transport.send(message);assert.equal(responses.at(-1).error.data.code,'actor_authentication_required');
  const actor={actorId:'owner',generation:1,expiresAt:Date.now()+1000,credentialId:null};
  await transport.sendWithContext(message,{sender:null,actorContext:actor});
  assert.equal(responses.at(-1).result.reference,'opencraft://conversation/v1/server/private-source');
  assert.deepEqual(actors,[actor]);assert.equal(native.length,1,'reference RPC is not forwarded to an unrelated native protocol');
});


test('only the native started event binds the admitted input to its actual Turn for CLI access',async()=>{
  let receive!:(frame:string)=>void;const starts:unknown[][]=[];
  const inner:any={status:{state:'open'},subscribeMessage(listener:(frame:string)=>void){receive=listener;return()=>{};},async send(){}};
  const transport=new AgentDriverTransport(inner,{authorizeExecution(){},executionStarted(...args:unknown[]){starts.push(args);}} as any,()=> 'server');
  await transport.sendWithContext(JSON.stringify({id:1,method:'turn/start',params:{threadId:'target',clientUserMessageId:'input',turnId:'forged',input:[]}}),
    {sender:null,actorContext:{actorId:'owner',generation:1,expiresAt:Date.now()+10000,credentialId:null}});
  assert.deepEqual(starts,[]);
  receive(JSON.stringify({method:'turn/started',params:{threadId:'target',turn:{id:'actual-turn',items:[{type:'userMessage',clientId:'input'}]}}}));
  assert.deepEqual(starts,[['target','input','actual-turn']]);
  receive(JSON.stringify({id:1,result:{turn:{id:'actual-turn'}}}));
  assert.equal(starts.length,1,'response and notification bind once');
  receive(JSON.stringify({method:'turn/started',params:{threadId:'queue',clientMessageId:'original-queued-input',turn:{id:'queued-turn',items:[]}}}));
  assert.deepEqual(starts.at(-1),['queue','original-queued-input','queued-turn']);
});
