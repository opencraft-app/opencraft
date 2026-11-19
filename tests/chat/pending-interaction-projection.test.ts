import assert from "node:assert/strict";
import test from "node:test";
import { asTurnId, type TimelineSourceItem, type TimelineSourceTurn } from "@opencraft/chat-core";
import type { PendingInteraction } from "../../packages/chat-runtime/src/models";
import { createPendingInteractionProjector } from "../../packages/chat-runtime/src/pending-interaction-projection";
const item=(id:string,type="commandExecution"):TimelineSourceItem=>({id,type,payload:{id,type}});
const turn=(id:string,items:readonly TimelineSourceItem[]=[]):TimelineSourceTurn=>({id:asTurnId(id),status:"streaming",items});
const interaction=(id:string,target:string|null,command:string|null=null,responseState="pending"):PendingInteraction=>({
  requestId:id,turnId:target===null?null:asTurnId(target),method:"item/commandExecution/requestApproval",itemId:command,
  receivedAtMs:1,params:{command:command??"request"},responseState,
} as PendingInteraction);
const project=(request:PendingInteraction)=>({provisionalCommand:request.itemId?item(request.itemId):null,
  request:{id:"server-request:"+request.requestId,type:"request",payload:{responseState:request.responseState,params:request.params}}});
function original(source:readonly TimelineSourceTurn[],requests:readonly PendingInteraction[]):readonly TimelineSourceTurn[]{
  if(!requests.length)return source;
  const turns=[...source];
  for(const request of requests){
    const id=request.turnId??asTurnId("interaction:"+request.requestId);
    let target=turns.find(turn=>turn.id===id);
    if(!target){target={id,status:"pending",items:[]};turns.push(target)}
    const index=turns.indexOf(target),items=[...target.items];target={...target,items};turns[index]=target;
    const p=project(request);if(p.provisionalCommand&&!items.some(item=>item.id===p.provisionalCommand!.id&&item.type==="commandExecution"))items.push(p.provisionalCommand);
    items.push(p.request);
  }return turns;
}
test("grouped projection preserves source order, request order and provisional deduplication",()=>{
  const sources=[[],[turn("a",[item("same"),item("other","note")]),turn("b")],[turn("a"),turn("a",[item("duplicate-source")])]];
  const requests=[interaction("one","a","same"),interaction("two","a","same"),interaction("three","b","other"),interaction("four","missing","same"),interaction("five",null),interaction("six","a",null,"responding")];
  const attach=createPendingInteractionProjector(project);
  for(const source of sources)for(const a of requests)for(const b of requests)for(const c of requests){
    assert.deepEqual(attach(source,[a,b,c]),original(source,[a,b,c]));
  }
});
test("immutable requests reuse artifacts and only currently targeted Turn projections",()=>{
  let calls=0;const attach=createPendingInteractionProjector(request=>{calls++;return project(request)});
  const a=turn("a",[item("native")]),b=turn("b"),x=interaction("one","a","command"),y=interaction("two","b");
  const first=attach([a,b],[x,y]);assert.equal(calls,2);
  const second=attach([a,b],[x,y]);assert.strictEqual(second[0],first[0]);assert.strictEqual(second[1],first[1]);assert.equal(calls,2);
  const updatedA={...a,items:[...a.items,item("tail","agentMessage")]};
  const streamed=attach([updatedA,b],[x,y]);assert.notStrictEqual(streamed[0],first[0]);assert.strictEqual(streamed[1],first[1]);assert.strictEqual(streamed[0]!.items.at(-1),first[0]!.items.at(-1));assert.equal(calls,2);
  const nativeArrival=attach([turn("a",[item("command")]),b],[x,y]);assert.equal(nativeArrival[0]!.items.filter(item=>item.id==="command"&&item.type==="commandExecution").length,1);
  assert.strictEqual(attach([a,b],[])[0],a);
  const restored=attach([a,b],[x,y]);assert.notStrictEqual(restored[1],first[1],"removing requests releases the old Turn projection");
});
test("response changes, cancellation, target rebinding and reordered requests are not cached as authority",()=>{
  const attach=createPendingInteractionProjector(project),a=turn("a"),x=interaction("one","a","command"),y=interaction("two","a");
  const first=attach([a],[x,y]);const responding={...x,responseState:"responding",canRespond:false} as PendingInteraction;
  const second=attach([a],[responding,y]);assert.notDeepEqual(second,first);assert.deepEqual(second,original([a],[responding,y]));
  const retry={...responding,responseState:"pending",canRespond:true,params:{command:"changed"}} as PendingInteraction;
  assert.deepEqual(attach([a],[y,retry]),original([a],[y,retry]));
  assert.deepEqual(attach([a],[retry]),original([a],[retry]));
  const rebound={...retry,turnId:asTurnId("missing")} as PendingInteraction;
  assert.deepEqual(attach([a],[rebound]),original([a],[rebound]));
});
test("synthetic owners persist only while requested and yield to real target Turns",()=>{
  const attach=createPendingInteractionProjector(project),request=interaction("one","missing","command");
  const first=attach([], [request]),second=attach([], [request]);assert.strictEqual(second[0],first[0]);
  const actual=turn("missing",[item("real")]);assert.deepEqual(attach([actual],[request]),original([actual],[request]));
  attach([],[]);assert.notStrictEqual(attach([], [request])[0],first[0]);
});
