import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {createImeActivation}=createRequire(import.meta.url)('../../scripts/remote-browser/activation.cjs');
const id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',other='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
function fixture(){
 let native={available:true,focusIdentity:'focus-A-1',targetIdentity:'node-A',inputType:1,token:'native-write-only',selectionStart:0,selectionEnd:0};
 const frame={nativeImeContextVersionForTesting:2,getNativeImeFocusForTesting:async()=>native,getNativeImeContextForInputForTesting:async()=>native,getNativeImeFocusForInputForTesting:async()=>({available:native.available,focusIdentity:native.focusIdentity,targetIdentity:native.targetIdentity,inputType:native.inputType}),getNativeImeContextForTesting:async()=>native,applyNativeImeForTesting:async()=>{}};
 const wc={mainFrame:frame,focusedFrame:frame,sendInputEventWithNativeInputTicket(){}};const p={window:{webContents:wc},document:'doc',controlToken:'controller-A',visible:true,closed:false};const port=createImeActivation(p);
 return{p,wc,frame,port,set(v){native={...native,...v}},native:()=>native,async bind(){port.start(id);assert.equal(await port.bind(id,{nativeInputTicket:'private-native-receipt'}),true)}};
}
test('native18 presence without native focus identity version cannot advertise reusable activation',()=>{const f=fixture();delete f.frame.nativeImeContextVersionForTesting;assert.equal(f.port.available(),false);assert.throws(()=>f.port.start(id),{code:'INPUT_TARGET_CHANGED'})});
test('activation requires its matching native receipt and exports no write capability',async()=>{const f=fixture();f.port.start(id);assert.equal(await f.port.bind(other,{nativeInputTicket:'private'}),false);await assert.rejects(f.port.capture(id),{code:'INPUT_TARGET_CHANGED'});assert.equal(await f.port.bind(id,{nativeInputTicket:'private'}),true);assert.equal(f.port.observation({targetIdentity:'node-A',type:1},f.native()),id);assert.equal(f.port.observation({targetIdentity:'node-B',type:1},f.native()),undefined)});
test('website text and selection before a later transaction remain authoritative',async()=>{const f=fixture();await f.bind();f.set({token:'fresh-current-write',selectionStart:7,selectionEnd:7});const current=await f.port.capture(id);assert.equal(current.native.token,'fresh-current-write');assert.equal(current.native.selectionStart,7);assert.equal(current.frame,f.frame)});
test('same node after A B A cannot revive an old focus binding',async()=>{const f=fixture();await f.bind();f.set({focusIdentity:'focus-A-3',targetIdentity:'node-A'});await assert.rejects(f.port.capture(id),{code:'INPUT_TARGET_CHANGED'})});
test('native kind change and focus moving to another frame refuse current capture',async()=>{for(const change of [f=>f.set({inputType:2}),f=>f.wc.focusedFrame={}]){const f=fixture();await f.bind();change(f);await assert.rejects(f.port.capture(id),{code:'INPUT_TARGET_CHANGED'})}});
test('hidden closed document and controller lifetimes revoke binding even across delayed native reads',async()=>{for(const change of [f=>f.p.visible=false,f=>f.p.closed=true,f=>f.p.document='other-doc',f=>f.p.controlToken='controller-B',f=>f.port.reset()]){const f=fixture();await f.bind();const original=f.frame.getNativeImeContextForTesting;f.frame.getNativeImeContextForTesting=async()=>{change(f);return original()};await assert.rejects(f.port.capture(id),{code:'INPUT_TARGET_CHANGED'})}});
test('late native receipt cannot replace a new activation',async()=>{const f=fixture();let finish;f.frame.getNativeImeFocusForInputForTesting=()=>new Promise(resolve=>finish=resolve);f.port.start(id);const pending=f.port.bind(id,{nativeInputTicket:'private'});f.port.start(other);finish(f.native());assert.equal(await pending,false);await assert.rejects(f.port.capture(other),{code:'INPUT_TARGET_CHANGED'})});
test('native terminal context can hand future transactions to its causally resulting editor',async()=>{const f=fixture();await f.bind();const next={...f.native(),focusIdentity:'focus-B-2',targetIdentity:'node-B',token:'new-write'};f.port.completed(id,f.frame,'focus-A-1',{dispatched:true,context:next},{document:f.p.document,control:f.p.controlToken});f.set(next);const current=await f.port.capture(id);assert.equal(current.native.targetIdentity,'node-B');f.set({focusIdentity:'unrelated-later-focus'});await assert.rejects(f.port.capture(id),{code:'INPUT_TARGET_CHANGED'})});
test('an undispatched refusal or different focus/controller/document cannot authorize handoff',async()=>{
 for(const [focus,dispatched,control,document]of[['focus-A-1',false,'controller-A','doc'],['older-focus',true,'controller-A','doc'],['focus-A-1',true,'controller-old','doc'],['focus-A-1',true,'controller-A','older-doc']]){
  const f=fixture();await f.bind();const next={...f.native(),focusIdentity:'focus-B',targetIdentity:'node-B'};f.port.completed(id,f.frame,focus,{dispatched,context:next},{control,document});f.set(next);await assert.rejects(f.port.capture(id),{code:'INPUT_TARGET_CHANGED'});
 }
});
test('a later native edge in the same exact editor may follow a preceding terminal native result',async()=>{
 const f=fixture();await f.bind();f.port.start(other);assert.equal(await f.port.bind(other,{nativeInputTicket:'second-private'}),true);
 const next={...f.native(),focusIdentity:'focus-B',targetIdentity:'node-B'};f.port.completed(id,f.frame,'focus-A-1',{dispatched:true,context:next},{control:'controller-A',document:'doc'});f.set(next);assert.equal((await f.port.capture(other)).native.targetIdentity,'node-B');
});
test('an experimental version without read-only native focus cannot advertise safe binding',()=>{
 const f=fixture();delete f.frame.getNativeImeFocusForInputForTesting;assert.equal(f.port.available(),false);
});

test('an unproved scroll may continue its exact previously known focus, never an unknown or ABA target',async()=>{
 const f=fixture();f.port.start(id);assert.equal(await f.port.bind(id,{}),false);
 await assert.rejects(f.port.capture(id),{code:'INPUT_TARGET_CHANGED'});
 const expected={frame:f.frame,focus:'focus-A-1',target:'node-A',type:1};
 assert.equal((await f.port.capture(id,expected)).native.targetIdentity,'node-A');
 f.set({focusIdentity:'focus-A-3'});await assert.rejects(f.port.capture(id,expected),{code:'INPUT_TARGET_CHANGED'});
});
test('a failed receipt cannot use a known hint with a different native focus generation',async()=>{
 const f=fixture();f.port.start(id);f.set({focusIdentity:'focus-A-3'});
 await assert.rejects(f.port.capture(id,{frame:f.frame,focus:'focus-A-1',target:'node-A',type:1}),{code:'INPUT_TARGET_CHANGED'});
});
