import assert from 'node:assert/strict';
import test from 'node:test';
import {readReadyNativeAgents} from '../../apps/workbench-web/src/runtime/ready-native-agents';
import type {AgentRuntimeAccess} from '@opencraft/workbench-runtime';
const agent={id:'codex',installed:true,authenticated:true};
const model={id:'codex:current',model:'codex:current',agentId:'codex',displayName:'Codex',hidden:false,defaultReasoningEffort:null};
function request(status:unknown,pages:unknown[],calls:string[]):AgentRuntimeAccess['request'] {
 return (async(host:string,method:string)=>{assert.equal(host,'remote');calls.push(method);if(method==='opencraft/agents/onboarding/status')return status;return pages.shift();}) as AgentRuntimeAccess['request'];
}
test('a logged-in native Agent and its advertised model yield a choice on the correct Host',async()=>{
 const calls:string[]=[];const choices=await readReadyNativeAgents(request({agents:[agent]},[{data:[{...model,id:'other',model:'other'},model],nextCursor:'p2'},{data:[{...model,id:'default',model:'default',isDefault:true}],nextCursor:null}],calls),'remote',new AbortController().signal);
 assert.equal(choices[0]!.modelId,'default');assert.equal(choices[0]!.agentName,'Codex');assert.deepEqual(calls,['opencraft/agents/onboarding/status','model/list','model/list']);
});
test('cached native metadata never substitutes for current installation/login or selectable models',async()=>{
 for(const status of [{...agent,authenticated:false},{...agent,authenticated:null},{...agent,installed:false},{...agent,workspaceTrusted:false},{...agent,connectionRequired:true}]){const calls:string[]=[];assert.deepEqual(await readReadyNativeAgents(request({agents:[status]},[{data:[model]}],calls),'remote',new AbortController().signal),[]);assert.deepEqual(calls,['opencraft/agents/onboarding/status']);}
 for(const changed of [{...model,hidden:true},{...model,policyRestricted:true},{...model,agentId:'dsh'}])assert.deepEqual(await readReadyNativeAgents(request({agents:[agent]},[{data:[changed],nextCursor:null}],[]),'remote',new AbortController().signal),[]);
});
test('cancelled discovery and cyclic cursors cannot publish a ready Agent',async()=>{
 const controller=new AbortController();const fn=(async()=>{controller.abort();return {agents:[agent]};}) as AgentRuntimeAccess['request'];await assert.rejects(readReadyNativeAgents(fn,'remote',controller.signal));
 await assert.rejects(readReadyNativeAgents(request({agents:[agent]},[{data:[],nextCursor:'x'},{data:[],nextCursor:'x'}],[]),'remote',new AbortController().signal),/Repeated/);
});
