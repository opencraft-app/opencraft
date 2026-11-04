import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const { installIme, keyboardPolicy } = createRequire(import.meta.url)('../../scripts/remote-browser/ime.cjs');
const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', other = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
function fixture(options = {}) {
  const wc = new EventEmitter(), calls = [], events = [], observations = []; let reads = 0;
  let result, observed = { active: true, type: 1, targetIdentity:'document:1', caretBounds: {x:10,y:20,width:0,height:18}, value: 'must-not-leave-worker' };
  const frame = { async getNativeImeContextForTesting() { return { available: true, targetIdentity:observed.targetIdentity, inputType:observed.type, token: 'first', compositionId: '' }; },
    async applyNativeImeForTesting(input) { calls.push(input); return result ?? { status: 'processed', context: { available: true, token: 'next', compositionId: input.type === 'compose' ? 'owned' : '' } }; } };
  wc.focusedFrame = wc.mainFrame = frame; wc.getNativeTextInputState = () => { reads++; return observed; };
  if (options.notifications) wc.setNativeTextInputStateObservation = enabled => { observations.push(enabled); return typeof options.notifications === 'function' ? options.notifications(enabled) : true; };
  if (options.focusIdentity) {
    frame.nativeImeContextVersionForTesting=2; wc.sendInputEventWithNativeInputTicket=()=>{};
    frame.getNativeImeFocusForTesting=async()=>({available:observed.active===true,targetIdentity:observed.targetIdentity,inputType:observed.type,focusIdentity:observed.focusIdentity});
    frame.getNativeImeFocusForInputForTesting=frame.getNativeImeFocusForTesting;
    frame.getNativeImeContextForTesting=async()=>({available:true,targetIdentity:observed.targetIdentity,inputType:observed.type,focusIdentity:observed.focusIdentity,token:'first',compositionId:''});
    observed={...observed,focusIdentity:'focus-A-1'};
  }
  const p = { window: {webContents:wc}, visible: true, closed: false, document:'doc', id:'page' };
  const port = installIme(p, event => events.push(event));
  return {wc,p,frame,port,calls,events,observations,reads:()=>reads,result(value) {result=value},state(value){observed=value}};
}
test('composition stays on captured native frame and consumes each returned context', async () => {
  const f=fixture();try {
    assert.equal(await f.port.apply({id,type:'begin'}),undefined);
    await f.port.apply({id,type:'compose',text:'ni'});
    await f.port.apply({id,type:'commit',text:'你'});
    assert.equal(f.calls[0].token,'first');assert.equal(f.calls[1].token,'next');assert.equal(f.calls[1].compositionId,'owned');
    await assert.rejects(f.port.apply({id,type:'commit',text:'重复'}),/target changed/);
  }finally{f.port.dispose()}
});

test('semantic edits use bounded Chromium commands after retiring owned preedit',async()=>{
 const f=fixture(),commands=[];f.wc.debugger={sendCommand:async(method,input)=>commands.push([method,input])};
 try {
  f.port.observe();const editor=f.events.at(-1).editor;
  await f.port.apply({id,type:'begin',editor});await f.port.apply({id,type:'compose',text:'ni'});
  for(const [command,native] of [['undo','Undo'],['redo','Redo'],['deleteWordBackward','DeleteWordBackward'],['deleteWordForward','DeleteWordForward']]) {
   await f.port.edit({editor,command});assert.deepEqual(commands.at(-1),['Input.dispatchKeyEvent',{type:'rawKeyDown',commands:[native]}]);
  }
  assert.equal(f.calls.at(-1).type,'cancel');
  await assert.rejects(f.port.apply({id,type:'commit',text:'old'}),/target changed/);
  await assert.rejects(f.port.edit({editor,command:'__proto__'}),/Invalid editing/);
  await assert.rejects(f.port.edit({editor:'stale',command:'undo'}),/target changed/);
  assert.equal(commands.length,4);
 }finally{f.port.dispose()}
});

test('editing intent cannot cross async preedit retirement into a replacement focus or document',async()=>{
 for(const change of [f=>f.p.document='new',f=>f.p.visible=false,f=>f.wc.focusedFrame={},f=>f.state({active:true,type:1,targetIdentity:'new'})]) {
  const f=fixture(),commands=[];f.wc.debugger={sendCommand:async(...x)=>commands.push(x)};
  try {
   f.port.observe();const editor=f.events.at(-1).editor;
   await f.port.apply({id,type:'begin',editor});await f.port.apply({id,type:'compose',text:'ni'});
   const apply=f.frame.applyNativeImeForTesting;
   f.frame.applyNativeImeForTesting=async input=>{if(input.type==='cancel')change(f);return apply(input)};
   await assert.rejects(f.port.edit({editor,command:'undo'}),/target changed/);assert.equal(commands.length,0);
  }finally{f.port.dispose()}
 }
});
test('new begin cancels owned composition; delayed old cancellation cannot cancel the new one', async () => {
  const f=fixture();try {
    await f.port.apply({id,type:'begin'});await f.port.apply({id,type:'compose',text:'ni'});
    await f.port.apply({id:other,type:'begin'});assert.equal(f.calls.at(-1).type,'cancel');
    const before=f.calls.length;await f.port.apply({id,type:'cancel'});assert.equal(f.calls.length,before);
    await f.port.apply({id:other,type:'commit',text:'好'});assert.equal(f.calls.at(-1).text,'好');
  }finally{f.port.dispose()}
});
test('hidden and replaced documents cannot write or reacquire a new target', async () => {
  for(const mutate of [f=>f.p.visible=false,f=>f.p.document='replacement']) {
    const f=fixture();try {await f.port.apply({id,type:'begin'});mutate(f);await assert.rejects(f.port.apply({id,type:'commit',text:'错误'}));assert.equal(f.calls.length,0);}finally{f.port.dispose()}
  }
});
test('native rejection ends the transaction instead of retrying another editor', async () => {
  const f=fixture();try {await f.port.apply({id,type:'begin'});f.result({status:'target-changed-during-operation'});
    await assert.rejects(f.port.apply({id,type:'commit',text:'拒绝'}),/target changed|rejected/);
    await assert.rejects(f.port.apply({id,type:'commit',text:'不重试'}));assert.equal(f.calls.length,1);
  }finally{f.port.dispose()}
});
test('observations expose bounded geometry and editability, never text or native capabilities', () => {
  const f=fixture();try {f.port.observe();const state=f.events.at(-1);assert.equal(state.editable,true);assert.deepEqual(state.caret,{x:10,y:20,width:0,height:18});assert.equal(state.keyboard.kind,'text');assert.equal(typeof state.editor,'string');assert(!JSON.stringify(state).includes('must-not-leave-worker'));assert(!JSON.stringify(state).includes('document:1'));assert(!JSON.stringify(state).includes('token'));
    f.state({active:true,type:2,password:true});f.port.observe();assert.equal(f.events.at(-1).editable,false);
  }finally{f.port.dispose()}
});
test('invalid commands and oversized text never dispatch native edits', async () => {
  const f=fixture();try {await assert.rejects(f.port.apply({id:'bad',type:'begin'}));await f.port.apply({id,type:'begin'});
    await assert.rejects(f.port.apply({id,type:'commit',text:'x'.repeat(16385)}));assert.equal(f.calls.length,0);
  }finally{f.port.dispose()}
});

test('all native text entry kinds expose keyboard traits; non-text pickers do not', () => {
  for(const [type,kind,mode] of [[1,'text','text'],[2,'password','text'],[3,'search','search'],[4,'email','email'],[5,'number','decimal'],[6,'tel','tel'],[7,'url','url'],[14,'textarea','text'],[15,'contenteditable','text']]) {
    const state={active:true,targetIdentity:'doc:1',type,password:type===2};
    const p=keyboardPolicy(state);assert.equal(p.kind,kind);assert.equal(p.inputMode,mode);assert.equal(p.secure,type===2);
    assert.equal(keyboardPolicy({...state,mode:1}).autoKeyboard,false);
    assert.equal(keyboardPolicy({...state,mode:7,action:6}).enterKeyHint,'search');
    assert.equal(keyboardPolicy({...state,virtualKeyboardPolicy:1}).autoKeyboard,false);
  }
  for(const type of [0,8,9,10,11,12,13,16,17]) assert.equal(keyboardPolicy({active:true,targetIdentity:'d:1',type}),null);
  assert.equal(keyboardPolicy({active:false,type:1,targetIdentity:'d:1'}),null);
  assert.equal(keyboardPolicy({active:true,type:1,targetIdentity:'d:1',flags:1<<12}).secure,true);
});
test('new form editors require the observed opaque id and reject delayed password input', async () => {
  const f=fixture();try {
    f.state({active:true,type:2,password:true,targetIdentity:'doc:password'});f.port.observe();const password=f.events.at(-1).editor;
    await assert.rejects(f.port.apply({id,type:'begin'}),/target changed/);
    await f.port.apply({id,type:'begin',editor:password});await f.port.apply({id,type:'compose',text:'fake'});
    f.state({active:true,type:3,targetIdentity:'doc:search'});f.port.observe();const search=f.events.at(-1).editor;
    assert.notEqual(search,password);await assert.rejects(f.port.apply({id,type:'commit',text:'fake'}));
    await assert.rejects(f.port.apply({id:other,type:'begin',editor:password}));
    await f.port.apply({id:other,type:'begin',editor:search});await f.port.apply({id:other,type:'commit',text:'查询'});
    assert.equal(f.calls.at(-1).text,'查询');assert(f.calls.some(c=>c.type==='cancel'));
  }finally{f.port.dispose()}
});
test('native capture must match observed document, node and input kind', async () => {
  for(const native of [{targetIdentity:'other:1',inputType:1},{targetIdentity:'document:1',inputType:2}]) {
    const f=fixture();try{f.frame.getNativeImeContextForTesting=async()=>({available:true,token:'safe',...native});
      await assert.rejects(f.port.apply({id,type:'begin'}));assert.equal(f.calls.length,0);
    }finally{f.port.dispose()}
  }
});

test('unrelated and same-document navigation preserve IME; replacement of the owned frame retires it', async () => {
  const f=fixture();f.frame.processId=11;f.frame.routingId=22;
  try {
    await f.port.apply({id,type:'begin'});await f.port.apply({id,type:'compose',text:'ni'});
    f.wc.emit('did-start-navigation',{},'https://example.test/ad',false,false,33,44);
    f.wc.emit('did-start-navigation',{},'https://example.test/#section',true,true,11,22);
    await f.port.apply({id,type:'commit',text:'你'});assert.equal(f.calls.at(-1).type,'commit');
    await f.port.apply({id:other,type:'begin'});await f.port.apply({id:other,type:'compose',text:'hao'});
    f.wc.emit('did-start-navigation',{},'https://example.test/changed',false,false,11,22);
    await assert.rejects(f.port.apply({id:other,type:'commit',text:'好'}));
    assert.equal(f.calls.at(-1).type,'cancel');
  }finally{f.port.dispose()}
});

test('empty preedit clears only an owned native composition and continues the same bound transaction',async()=>{
 const f=fixture();try {
  await f.port.apply({id,type:'begin'});await f.port.apply({id,type:'compose',text:''});assert.equal(f.calls.length,0);
  await f.port.apply({id,type:'compose',text:'ni'});await f.port.apply({id,type:'compose',text:''});
  assert.equal(f.calls[1].type,'cancel');assert.equal(f.calls[1].compositionId,'owned');assert.equal(f.calls[1].token,'next');
  assert.equal(f.calls[1].text,'');
  await f.port.apply({id,type:'compose',text:'hao'});assert.equal(f.calls[2].type,'compose');assert.equal(f.calls[2].compositionId,'');
  await f.port.apply({id,type:'commit',text:'好'});assert.equal(f.calls.at(-1).text,'好');
 }finally{f.port.dispose()}
});


test('native state notifications update policy without periodic reads and never export text', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = fixture({notifications:true});
  try {
    f.port.observe(); const editor = f.events.at(-1).editor, before = f.reads();
    t.mock.timers.tick(2000); assert.equal(f.reads(), before);
    f.state({active:true,type:2,password:true,targetIdentity:'document:password',caretBounds:{x:30,y:40,width:0,height:18},value:'private-password'});
    f.wc.emit('native-text-input-state-changed');
    assert.notEqual(f.events.at(-1).editor, editor);
    assert.equal(f.events.at(-1).keyboard.secure, true);
    assert.deepEqual(f.events.at(-1).caret, {x:30,y:40,width:0,height:18});
    assert.equal(JSON.stringify(f.events).includes('private-password'), false);
    assert.deepEqual(f.observations, [true]);
  } finally { f.port.dispose(); }
  assert.deepEqual(f.observations, [true,false]);
});

test('native focus notification retires the previous composition without retargeting it', async () => {
  const f = fixture({notifications:true});
  try {
    f.port.observe(); await f.port.apply({id,type:'begin'});
    await f.port.apply({id,type:'compose',text:'ni'});
    f.state({active:true,type:2,password:true,targetIdentity:'document:other-password'});
    f.wc.emit('native-text-input-state-changed');
    await Promise.resolve(); await Promise.resolve();
    assert.equal(f.calls.at(-1).type, 'cancel');
    await assert.rejects(f.port.apply({id,type:'commit',text:'不得转投'}));
    assert.equal(f.calls.some(call=>call.text==='不得转投'), false);
  } finally { f.port.dispose(); }
});

test('native hidden notifications avoid reads and reveal observes the latest policy', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = fixture({notifications:true});
  try {
    f.port.observe(); const before = f.reads(), count = f.events.length;
    f.p.visible=false; f.port.observe();
    assert.deepEqual(f.observations,[true,false]);
    f.state({active:true,type:2,password:true,targetIdentity:'document:hidden-password'});
    f.wc.emit('native-text-input-state-changed'); t.mock.timers.tick(3000);
    assert.equal(f.reads(), before); assert.equal(f.events.length, count);
    f.p.visible=true; f.port.observe(); assert.equal(f.events.at(-1).keyboard.secure, true);
    assert.deepEqual(f.observations,[true,false,true]);
  } finally { f.port.dispose(); }
});

test('dispose removes native observation and fences an already queued callback', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f=fixture({notifications:true}), late=f.wc.listeners('native-text-input-state-changed')[0];
  f.port.observe(); const before=f.reads(), count=f.events.length;
  f.port.dispose(); late(); f.wc.emit('native-text-input-state-changed'); t.mock.timers.tick(3000);
  assert.equal(f.reads(),before); assert.equal(f.events.length,count);
  assert.equal(f.wc.listenerCount('native-text-input-state-changed'),0);
  assert.deepEqual(f.observations,[true,false]);
});

test('legacy observation pauses while hidden and can promote to native notification after startup', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let ready=false; const f=fixture({notifications:enabled=>!enabled||ready});
  try {
    f.port.observe(); const first=f.reads(); t.mock.timers.tick(150); assert.equal(f.reads(),first+1);
    f.p.visible=false; f.port.observe(); const hidden=f.reads(); t.mock.timers.tick(2000); assert.equal(f.reads(),hidden);
    f.p.visible=true; f.port.observe(); ready=true; f.port.observe(); const native=f.reads();
    t.mock.timers.tick(2000); assert.equal(f.reads(),native);
    f.state({active:false,type:0}); f.wc.emit('native-text-input-state-changed'); assert.equal(f.events.at(-1).editable,false);
  } finally { f.port.dispose(); }
});

test('canceling old preedit cannot authorize a begin under a replacement controller',async()=>{
 const f=fixture();f.p.controlToken='controller-A';try{
  await f.port.apply({id,type:'begin'});await f.port.apply({id,type:'compose',text:'ni'});
  const original=f.frame.applyNativeImeForTesting;f.frame.applyNativeImeForTesting=async input=>{if(input.type==='cancel')f.p.controlToken='controller-B';return original(input)};
  await assert.rejects(f.port.apply({id:other,type:'begin'}),/control|changed|field/);
  await assert.rejects(f.port.apply({id:other,type:'commit',text:'late'}));assert(!f.calls.some(x=>x.type==='commit'));
 }finally{f.port.dispose()}
});
test('canceling old preedit cannot execute editing commands for a replacement controller',async()=>{
 const f=fixture(),commands=[];f.p.controlToken='controller-A';f.wc.debugger={sendCommand:async(...value)=>commands.push(value)};
 try{
  f.port.observe();const editor=f.events.at(-1).editor;await f.port.apply({id,type:'begin',editor});await f.port.apply({id,type:'compose',text:'ni'});
  const original=f.frame.applyNativeImeForTesting;f.frame.applyNativeImeForTesting=async input=>{if(input.type==='cancel')f.p.controlToken='controller-B';return original(input)};
  await assert.rejects(f.port.edit({editor,command:'undo'}),/control|changed/);assert.equal(commands.length,0);
 }finally{f.port.dispose()}
});

test('native focus hints distinguish ABA without exporting native identity',async()=>{
 const f=fixture({focusIdentity:true,notifications:true});try{
  await f.port.observe();const editor=f.events.at(-1).editor;
  f.state({active:true,type:1,targetIdentity:'document:1',focusIdentity:'focus-A-3'});await f.port.observe();
  assert.notEqual(f.events.at(-1).editor,editor);assert(!JSON.stringify(f.events).includes('focus-A'));
  await assert.rejects(f.port.apply({id,type:'begin',editor}));assert.equal(f.calls.length,0);
 }finally{f.port.dispose()}
});
test('known scroll fallback requires the client snapshot, while unknown first input needs native receipt',async()=>{
 const f=fixture({focusIdentity:true,notifications:true});try{
  await f.port.observe();const editor=f.events.at(-1).editor;f.port.startActivation(other);
  assert.equal(await f.port.bindActivation(other,{}),false);
  await assert.rejects(f.port.apply({id,type:'begin',activation:other,editor:null}));
  await f.port.apply({id,type:'begin',activation:other,editor});
  f.result({status:'processed',dispatched:true,context:{available:true,focusIdentity:'focus-A-1',targetIdentity:'document:1',inputType:1,token:'next'}});
  await f.port.apply({id,type:'commit',activation:other,text:'继续'});assert.equal(f.calls.at(-1).text,'继续');
 }finally{f.port.dispose()}
});
test('native receipt permits first input before the client has received an editor hint',async()=>{
 const f=fixture({focusIdentity:true,notifications:true});try{
  f.port.startActivation(other);assert.equal(await f.port.bindActivation(other,{nativeInputTicket:'private'}),true);
  await f.port.apply({id,type:'begin',activation:other,editor:null});
  f.result({status:'processed',dispatched:true,context:{available:true,focusIdentity:'focus-A-1',targetIdentity:'document:1',inputType:1,token:'next'}});
  await f.port.apply({id,type:'commit',activation:other,text:'首次'});assert.equal(f.calls.at(-1).text,'首次');
 }finally{f.port.dispose()}
});
test('native focus observation cannot authorize a begin across controller replacement',async()=>{
 const f=fixture({focusIdentity:true,notifications:true});try{
  await f.port.observe();const editor=f.events.at(-1).editor;
  const original=f.frame.getNativeImeFocusForTesting;f.frame.getNativeImeFocusForTesting=async()=>{f.p.controlToken='replacement';return original()};
  await assert.rejects(f.port.apply({id,type:'begin',editor}),/control|document/);assert.equal(f.calls.length,0);
 }finally{f.port.dispose()}
});
test('late native observation from an old frame cannot overwrite a replacement editor',async()=>{
 const f=fixture({focusIdentity:true,notifications:true});try{
  await f.port.observe();const before=f.events.length;let release;
  f.frame.getNativeImeFocusForTesting=()=>new Promise(resolve=>release=resolve);const pending=f.port.observe();
  f.p.document='replacement';f.port.resetActivation();release({available:true,targetIdentity:'document:1',inputType:1,focusIdentity:'focus-A-1'});await pending;
  assert.equal(f.events.length,before);
 }finally{f.port.dispose()}
});

test('a dispatched terminal edit acknowledges website focus change without claiming insertion or replaying text',async()=>{
 const f=fixture({focusIdentity:true,notifications:true});try{
  f.port.startActivation(other);await f.port.bindActivation(other,{nativeInputTicket:'private'});
  await f.port.apply({id,type:'begin',activation:other,editor:null});
  const next={available:true,focusIdentity:'focus-B-2',targetIdentity:'document:2',inputType:2,token:'fresh-after-handler',compositionId:''};
  f.result({status:'target-changed-during-operation',dispatched:true,context:next});
  await f.port.apply({id,type:'commit',activation:other,text:'只派发一次'});
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].text,'只派发一次');
  f.state({active:true,type:2,password:true,targetIdentity:'document:2',focusIdentity:'focus-B-2'});
  await f.port.apply({id:'cccccccc-cccc-cccc-cccc-cccccccccccc',type:'begin',activation:other,editor:null});
  assert.equal(f.calls.length,1,'A fresh begin must not replay the previous terminal text');
 }finally{f.port.dispose()}
});
test('undispatched terminal changes and ongoing preedit focus changes remain refusals',async()=>{
 for(const [type,dispatched]of[['commit',false],['compose',true]]){
  const f=fixture({focusIdentity:true,notifications:true});try{
   f.port.startActivation(other);await f.port.bindActivation(other,{nativeInputTicket:'private'});await f.port.apply({id,type:'begin',activation:other,editor:null});
   f.result({status:'target-changed-during-operation',dispatched,context:{available:true,focusIdentity:'focus-B-2',targetIdentity:'document:2',inputType:2,token:'not-a-new-authority'}});
   await assert.rejects(f.port.apply({id,type,activation:other,text:'不得转交'}),/target changed|rejected/);assert.equal(f.calls.length,1);
  }finally{f.port.dispose()}
 }
});
