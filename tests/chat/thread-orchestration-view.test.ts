import assert from 'node:assert/strict';
import test from 'node:test';
import {applyThreadOrchestrationView,createConversationKey,createDefaultTimelineProjectorRegistry,projectTimeline,deriveSubagentActivityGroupPresentation,subagentHeaderCall} from '@opencraft/chat-core';
import {parseThreadOrchestrationView,type ThreadOrchestrationView} from '@opencraft/appserver-protocol/collaboration';
import {projectThreadTopologyResult} from '../../apps/opencraft-daemon/src/thread-orchestration-projection';

function nativeTimeline() {
 return projectTimeline({key:createConversationKey('host','parent'),revision:1,authoritative:true,phase:'ready',turns:[{id:'turn',status:'complete',items:[
  {id:'spawn',type:'dynamicToolCall',payload:{tool:'thread_spawn',namespace:null,status:'completed',success:true,arguments:{prompt:'Review'},contentItems:[{type:'inputText',text:JSON.stringify({threadId:'child',status:'starting'})}]}},
  {id:'wait',type:'dynamicToolCall',payload:{tool:'thread_wait',namespace:null,status:'completed',success:true,arguments:{threadIds:['child']},contentItems:[{type:'inputText',text:JSON.stringify({settled:false,threads:[{threadId:'child',status:'active'}]})}]}}
 ]}]},createDefaultTimelineProjectorRegistry());
}
const view:ThreadOrchestrationView={threadId:'parent',calls:[{turnId:'turn',itemId:'wait',toolCallStatus:'complete',deliveryStatus:null,receiverThreadIds:['child'],childRuntimeStatus:{child:'active'}}]};
const agents=(timeline:ReturnType<typeof nativeTimeline>)=>deriveSubagentActivityGroupPresentation(timeline.frames.flatMap(frame=>frame.blocks).filter(block=>block.type==='subagent'));

test('settled:false cached Native receipt remains working after tool completion and reload',()=>{
 const timeline=nativeTimeline();assert.equal(agents(timeline).agents[0]!.status,'working');
 const restored=applyThreadOrchestrationView(nativeTimeline(),view)!;
 assert.equal(agents(restored).agents[0]!.status,'working');
 assert.equal(agents(restored).groupStatusLabel,'started working');
 const done=applyThreadOrchestrationView(restored,{...view,calls:[{...view.calls[0]!,childRuntimeStatus:{child:'idle'}}]})!;
 assert.equal(agents(done).agents[0]!.status,'done');
 assert.equal(agents(nativeTimeline()).agents[0]!.status,'working');
});

test('delivery failures and a completed tool cannot invent a child runtime outcome',()=>{
 const unknown=applyThreadOrchestrationView(nativeTimeline(),{...view,calls:[{...view.calls[0]!,deliveryStatus:'rejected',childRuntimeStatus:{child:'unknown'}}]})!;
 assert.equal(agents(unknown).agents[0]!.status,'unknown');
 assert.equal(agents(unknown).groupStatusLabel,'unknown');
 const recovery=applyThreadOrchestrationView(unknown,{...view,calls:[{...view.calls[0]!,childRuntimeStatus:{child:'recovering'}}]})!;
 assert.equal(agents(recovery).agents[0]!.status,'working');
 assert.equal(applyThreadOrchestrationView(unknown,{...view,threadId:'other'}),unknown);
});

test('ledger wire validation rejects malformed axes and topology enrichment preserves history',()=>{
 assert.deepEqual(parseThreadOrchestrationView(view),view);
 assert.equal(parseThreadOrchestrationView({...view,calls:[{...view.calls[0],toolCallStatus:'done'}]}),null);
 assert.equal(parseThreadOrchestrationView({...view,calls:[{...view.calls[0],childRuntimeStatus:{child:'invented'}}]}),null);
 const result={thread:{id:'child',parentThreadId:null,turns:[{id:'kept'}]}};
 const projected=projectThreadTopologyResult('thread/read',result,id=>id==='child'?{parentThreadId:'parent',visibility:'hidden'}:null) as any;
 assert.equal(projected.thread.parentThreadId,'parent');assert.equal(projected.thread.visibility,'hidden');
 assert.equal(projected.thread.turns,result.thread.turns);
 assert.deepEqual(projectThreadTopologyResult('thread/list',{data:[result.thread]},()=>({parentThreadId:'parent',visibility:'hidden'})),{data:[projected.thread]});
});


test('a failed creation without a child retains its independent failed call axis',()=>{
 const timeline=projectTimeline({key:createConversationKey('host','parent'),revision:1,authoritative:true,phase:'ready',turns:[{id:'turn',status:'complete',items:[
  {id:'rejected',type:'dynamicToolCall',payload:{tool:'thread_spawn',namespace:null,status:'completed',success:false,arguments:{prompt:'Review'},contentItems:[{type:'inputText',text:'{"status":403}'}]}}
 ]}]},createDefaultTimelineProjectorRegistry());
 const block=timeline.frames.flatMap(frame=>frame.blocks).find(block=>block.type==='subagent')!;
 assert.equal(block.type,'subagent');if(block.type!=='subagent')return;
 assert.equal(block.toolCallStatus,'failed');assert.deepEqual(agents(timeline).agents,[]);
});


test('a childless failure stays in the collapsed group summary after successful calls',()=>{
 const timeline=nativeTimeline(),blocks=timeline.frames.flatMap(frame=>frame.blocks).filter(block=>block.type==='subagent');
 const failed={...blocks[0]!,id:'failed-create' as typeof blocks[number]['id'],agentId:null,receiverThreadIds:[],agentStates:{},childRuntimeStatus:null,toolCallStatus:'failed' as const,status:'failed' as const};
 const mixed=[failed,...blocks];
 assert.equal(subagentHeaderCall(mixed),failed);
 const group=deriveSubagentActivityGroupPresentation(mixed);
 assert.equal(group.actionLabel,'Failed to create');
 assert.equal(group.groupStatusLabel,'started working');
 assert.equal(group.agents[0]!.status,'working');
});
