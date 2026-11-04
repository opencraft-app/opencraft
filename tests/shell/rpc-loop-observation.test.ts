import test from "node:test";
import assert from "node:assert/strict";
import {observePendingRpcLoop} from "../../apps/workbench-web/src/runtime/rpc-loop-observation";
function fixture() {
 let now=0,visible=true;const tasks=new Map<number,()=>void>();let next=0;const delays:{delay:number;pending:number}[]=[];
 const loop=observePendingRpcLoop({now:()=>now,isVisible:()=>visible,schedule:run=>{const id=++next;tasks.set(id,run);return()=>tasks.delete(id);},onDelay:(delay,pending)=>delays.push({delay,pending})});
 return {loop,tasks,delays,time:(value:number)=>now=value,visible:(value:boolean)=>visible=value,fire(){const [id,run]=tasks.entries().next().value!;tasks.delete(id);run();}};
}
test("an overdue probe is sampled before the final response clears it",()=>{
 const f=fixture();f.loop.setPending(1);assert.equal(f.tasks.size,1);
 f.time(1180);f.loop.setPending(0);assert.deepEqual(f.delays,[{delay:930,pending:1}]);assert.equal(f.tasks.size,0);f.loop.dispose();
});
test("hidden time, ordinary scheduling, idle and disposal do not produce false delay",()=>{
 const f=fixture();f.visible(false);f.loop.setPending(4);assert.equal(f.tasks.size,0);
 f.time(10000);f.visible(true);f.loop.setPending(4);f.time(10260);f.fire();assert.equal(f.delays.length,0);assert.equal(f.tasks.size,1);
 f.visible(false);f.loop.setPending(4);f.time(90000);f.visible(true);f.loop.setPending(4);assert.equal(f.delays.length,0);
 f.loop.dispose();assert.equal(f.tasks.size,0);f.time(100000);f.loop.setPending(1);assert.equal(f.tasks.size,0);
});
