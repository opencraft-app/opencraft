import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const { installIme, keyboardPolicy } = createRequire(import.meta.url)('../../scripts/remote-browser/ime.cjs');
const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', other = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
function fixture() {
  const wc = new EventEmitter(), calls = [], events = [];
  let result, observed = { active: true, type: 1, targetIdentity:'document:1', caretBounds: {x:10,y:20,width:0,height:18}, value: 'must-not-leave-worker' };
  const frame = { async getNativeImeContextForTesting() { return { available: true, targetIdentity:observed.targetIdentity, inputType:observed.type, token: 'first', compositionId: '' }; },
    async applyNativeImeForTesting(input) { calls.push(input); return result ?? { status: 'processed', context: { available: true, token: 'next', compositionId: input.type === 'compose' ? 'owned' : '' } }; } };
  wc.focusedFrame = wc.mainFrame = frame; wc.getNativeTextInputState = () => observed;
  const p = { window: {webContents:wc}, visible: true, closed: false, document:'doc', id:'page' };
  const port = installIme(p, event => events.push(event));
  return {wc,p,frame,port,calls,events,result(value) {result=value},state(value){observed=value}};
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
