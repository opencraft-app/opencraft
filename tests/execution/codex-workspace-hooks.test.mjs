import test from 'node:test';
import assert from 'node:assert/strict';
import {createCodexWorkspaceHooks,validateCodexWorkspaceHooks,configuredWorkspaceExecution} from '../../apps/headless-server/src/codex-workspace-hooks.mjs';
const names=['decorateNativeTransport','finalizeNativeCreation','finalizeNativeResume','requiresWorkspaceResume','restoreProvisionalWorkspace'];
test('physical hook factory separates receipts even when request IDs repeat',async()=>{
 let generation=0;const receipts=[];
 const composition={createCodexWorkspaceHooks(input){
   assert.deepEqual(input,{hostId:'local-codex'});assert.equal(Object.isFrozen(input),true);
   const owner=++generation;let closed=false;
   return {
     decorateNativeTransport(native){return {...native,close(){closed=true}}},
     async finalizeNativeCreation(input){if(closed)throw Error('retired');receipts.push([owner,input.requestId]);},
     async finalizeNativeResume(input){if(closed)throw Error('retired');receipts.push([owner,input.requestId]);},
     requiresWorkspaceResume(){return true},async restoreProvisionalWorkspace(){if(closed)throw Error('retired')},
   };
 }};
 validateCodexWorkspaceHooks(composition);assert.equal(generation,0);
 const old=createCodexWorkspaceHooks(composition,'local-codex');
 const next=createCodexWorkspaceHooks(composition,'local-codex');
 const priorTransport=old.decorateNativeTransport({});
 await next.finalizeNativeCreation({requestId:1});await old.finalizeNativeResume({requestId:1});
 assert.deepEqual(receipts,[[2,1],[1,1]]);
 priorTransport.close();
 await assert.rejects(old.finalizeNativeCreation({requestId:1}),/retired/);
 await next.finalizeNativeCreation({requestId:1});
 assert.equal(generation,2);assert.equal(Object.isFrozen(next),true);
});
test('factory cannot mix global handlers, incomplete hooks or adapter overrides',()=>{
 assert.throws(()=>validateCodexWorkspaceHooks({createCodexWorkspaceHooks:()=>({}),finalizeCodexNativeCreation(){}}),/global/);
 for(const value of [null,{},Promise.resolve({}),{coreEndpoint:'/other'}])
   assert.throws(()=>createCodexWorkspaceHooks({createCodexWorkspaceHooks:()=>value},'local-codex'),/hooks/);
 assert.throws(()=>validateCodexWorkspaceHooks({createCodexWorkspaceHooks:1}),/factory/);
});
test('hook snapshot cannot be redirected after construction; legacy behavior remains',()=>{
 const fn=()=>{}, hooks=Object.fromEntries(names.map(name=>[name,fn]));
 const selected=createCodexWorkspaceHooks({createCodexWorkspaceHooks:()=>hooks},'local-codex');
 hooks.finalizeNativeResume=()=>{throw Error('wrong owner')};
 assert.strictEqual(selected.finalizeNativeResume,fn);
 assert.strictEqual(createCodexWorkspaceHooks({restoreCodexProvisionalWorkspace:fn},'local-codex').restoreProvisionalWorkspace,fn);
 assert.equal(createCodexWorkspaceHooks({},'local-codex').decorateNativeTransport,undefined);
});

test('private startup configuration never silently enables or downgrades unmatched routing',()=>{
 assert.equal(configuredWorkspaceExecution({},{}),undefined);
 const options={codexCoreEndpoint:'/private/core.sock',codexCoreAuthToken:'test-private-token-'.repeat(3)};
 const environment={OPENCRAFT_WORKSPACE_AUTHORITY_SOCKET:'/private/workspace.sock'};
 assert.deepEqual(configuredWorkspaceExecution(options,environment),{socketPath:environment.OPENCRAFT_WORKSPACE_AUTHORITY_SOCKET,token:options.codexCoreAuthToken});
 assert.equal(Object.isFrozen(configuredWorkspaceExecution(options,environment)),true);
 for(const path of ['', '/', 'relative.sock','/private/\0sock','/'+ 'a'.repeat(110)])
   assert.throws(()=>configuredWorkspaceExecution(options,{OPENCRAFT_WORKSPACE_AUTHORITY_SOCKET:path}),/matched private Core/);
 assert.throws(()=>configuredWorkspaceExecution({},environment),/matched private Core/);
 assert.throws(()=>configuredWorkspaceExecution({...options,codexCoreAuthToken:'short'},environment),/matched private Core/);
});
