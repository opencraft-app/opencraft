import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { RemoteBrowserSurfaceHost } from '../../apps/workbench-web/src/browser/remote-browser-surface-host';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function event(type: string, properties: Record<string, unknown>) {
  return Object.assign(new Event(type, { cancelable: true }), properties);
}
function fixture(t: TestContext) {
  const document = Object.assign(new EventTarget(), { hidden: false, activeElement: null as unknown });
  const window = new EventTarget();
  const restore: (() => void)[] = [];
  for (const [key, value] of Object.entries({ document, window, cancelAnimationFrame() {} })) {
    const prior = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    restore.push(() => { if (prior) Object.defineProperty(globalThis, key, prior); else delete (globalThis as any)[key]; });
  }
  const captured = new Set<number>();
  const canvas = Object.assign(new EventTarget(), {
    clientHeight: 720, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }),
    setPointerCapture: (id: number) => { captured.add(id); }, hasPointerCapture: (id: number) => captured.has(id),
    releasePointerCapture: (id: number) => { captured.delete(id); },
  });
  const receiver = Object.assign(new EventTarget(), { value: '', inputMode: 'none', setAttribute() {},
    focus() { document.activeElement = this; }, blur() { document.activeElement = null; this.dispatchEvent(new Event('blur')); } });
  const host: any = new RemoteBrowserSurfaceHost('mse', { getItem: () => null, setItem() {} }, 'keys-proof');
  host.root = {};
  const p: any = { canvas, receiver, container: { style: { pointerEvents: 'auto' } }, closed: false, opened: true, visible: true, blocked: false,
    width: 1280, height: 720, document: 'document-before-grant', connection: 1, controlGeneration: 1,
    control: { epoch: 0, active: false, controller: false, kind: null }, acquiring: null, interaction: 0,
    nativeIme: false, nativeEdits: false, multiTouch: false, adaptiveInput: false, editor: null, keyboardIntent: null,
    viewport: { width: 1280, height: 720 }, sentViewport: JSON.stringify({ width: 1280, height: 720 }), events: { onError() {} } };
  let grant: (state: unknown) => void = () => {}, reject: (error: Error) => void = () => {};
  const pending = new Promise((resolve, fail) => { grant = resolve; reject = fail; }); void pending.catch(() => {});
  const inputs: any[] = [], controls: string[] = [], compositions: any[] = [], errors: string[] = [];
  p.events.onError = (message: string) => errors.push(message);
  // Only the RPC boundary is replaced; actual capture, acquireControl, token
  // validation, queue and call barriers execute unchanged.
  host.rawCall = (_page: unknown, method: string, input: any, token: string, document: string) => {
    if (method === 'control') { controls.push(input.action); return input.action === 'human' ? pending : Promise.resolve({ epoch: 2, controller: false, active: false, kind: null }); }
    if (method === 'input') { inputs.push({ ...input, token, document }); return Promise.resolve(); }
    if (method === 'ime') { compositions.push({ ...input, token, document }); return Promise.resolve(); }
    throw Error('Unexpected RPC: ' + method);
  };
  const dispose = host.bindInput(p);
  t.after(async () => { try { p.closed = true; dispose(); reject(Object.assign(Error('fixture disposed'), { code: 'PAGE_CLOSED' })); await tick(); } finally { for (const run of restore.reverse()) run(); } });
  const pointer = { pointerType: 'mouse', isPrimary: true, pointerId: 1, button: 0, buttons: 1, detail: 1, clientX: 170, clientY: 47 };
  return { host, p, inputs, controls, receiver, compositions, errors,
    rejectGrant() { reject(Object.assign(Error("control denied"), { code: "CONTROL_LOST" })); },
    composition(text: string) { receiver.dispatchEvent(event("compositionstart", {data:""})); receiver.dispatchEvent(event("compositionupdate", {data:text})); receiver.dispatchEvent(event("compositionend", {data:text})); },
    click() { canvas.dispatchEvent(event('pointerdown', pointer)); canvas.dispatchEvent(event('pointerup', { ...pointer, buttons: 0 })); },
    key(type: string, key: string, extra = {}) { const input = event(type, { key, ...extra }); receiver.dispatchEvent(input); return input; },
    grant() { grant({ epoch: 1, controller: true, active: true, kind: 'human', token: 'granted-token' }); },
  };
}

test('first-click modifiers and characters wait behind native focus instead of losing keyDown before human grant', async t => {
  const f = fixture(t); f.click();
  assert.equal(f.key('keydown', 'Control', { ctrlKey: true }).defaultPrevented, true);
  assert.equal(f.key('keydown', 'A', { ctrlKey: true }).defaultPrevented, true);
  f.key('keyup', 'A', { ctrlKey: true }); f.key('keyup', 'Control');
  assert.equal(f.key('keydown', 'H').defaultPrevented, true); f.key('keyup', 'H');
  await tick(); assert.deepEqual(f.controls, ['human']); assert.equal(f.inputs.length, 0);
  f.grant(); assert.equal(await f.p.inputQueue.idle(), true);
  assert.deepEqual(f.inputs.map(input => [input.type, input.keyCode]), [
    ['mouseDown', undefined], ['mouseUp', undefined], ['keyDown', 'Control'], ['keyDown', 'A'],
    ['keyUp', 'A'], ['keyUp', 'Control'], ['keyDown', 'H'], ['char', 'H'], ['keyUp', 'H'],
  ]);
  assert(f.inputs.every(input => input.token === 'granted-token' && input.document === 'document-before-grant'));
});

for (const end of ['reset', 'blur', 'hidden', 'generation', 'connection', 'closed']) {
  test(`${end} before a late human grant cannot replay captured keys into the next interaction`, async t => {
    const f = fixture(t); f.click(); assert.equal(f.key('keydown', 'H').defaultPrevented, true); f.key('keyup', 'H'); await tick();
    if (end === 'reset') f.p.resetInput();
    else if (end === 'blur') f.receiver.blur();
    else if (end === 'hidden') f.p.visible = false;
    else if (end === 'generation') f.p.controlGeneration++;
    else if (end === 'connection') f.p.connection++;
    else f.p.closed = true;
    f.grant(); await tick(); await tick(); assert.equal(f.inputs.length, 0);
  });
}

for (const intent of ['none', 'agent', 'obsolete-human']) {
  test(`${intent} intent never captures keys or implicitly acquires control`, async t => {
    const f = fixture(t);
    if (intent !== 'none') f.p.acquiring = { kind: intent === 'agent' ? 'agent' : 'human', generation: 0, promise: Promise.resolve('obsolete') };
    assert.equal(f.key('keydown', 'H').defaultPrevented, false);
    await tick(); assert.equal(f.inputs.length, 0); assert.equal(f.controls.length, 0);
  });
}

test('pending human ownership does not translate native IME sentinel events into raw keys', async t => {
  const f = fixture(t); f.click();
  assert.equal(f.key('keydown', 'Process', { keyCode: 229 }).defaultPrevented, false);
  assert.equal(f.key('keydown', 'H', { isComposing: true }).defaultPrevented, false);
  f.grant(); await f.p.inputQueue.idle(); assert.deepEqual(f.inputs.map(input => input.type), ['mouseDown', 'mouseUp']);
});


for (const mode of ['composition', 'direct-text', 'paste'] as const) {
  test(`${mode} captured during explicit human handoff waits for its grant and native target`, async t => {
    const f=fixture(t); f.p.nativeIme=true; f.p.editor='native-field'; f.click();
    if (mode==='composition') f.composition('你好');
    else if(mode==='direct-text') {
      f.receiver.dispatchEvent(event('beforeinput',{inputType:'insertText',data:'你',isComposing:false}));
      f.receiver.dispatchEvent(event('beforeinput',{inputType:'insertText',data:'好',isComposing:false}));
    } else f.receiver.dispatchEvent(event('paste',{clipboardData:{getData:()=> '你好'}}));
    await tick(); assert.equal(f.compositions.length,0);
    f.grant(); assert.equal(await f.p.inputQueue.idle(),true); await tick();
    assert.deepEqual(f.compositions.map(c=>[c.type,c.text]), mode==='direct-text'
      ? [['begin',undefined],['commit','你'],['begin',undefined],['commit','好']]
      : [['begin',undefined],['commit','你好']]);
    assert(f.compositions.every(c=>c.token==='granted-token'&&c.document==='document-before-grant'&&c.editor==='native-field'));
    assert.deepEqual(f.errors,[]);
  });
}

for (const boundary of ['reset','blur','hidden','generation','connection','document','editor','closed','denied'] as const) {
  test(`${boundary} before composition admission cannot retarget or replay committed Chinese`, async t => {
    const f=fixture(t); f.p.nativeIme=true; f.p.editor='native-field'; f.click(); f.composition('你好'); await tick();
    if(boundary==='reset')f.p.resetInput();
    else if(boundary==='blur')f.receiver.blur();
    else if(boundary==='hidden')f.p.visible=false;
    else if(boundary==='generation')f.p.controlGeneration++;
    else if(boundary==='connection')f.p.connection++;
    else if(boundary==='document')f.p.document='replacement-document';
    else if(boundary==='editor')f.p.editor='replacement-native-field';
    else if(boundary==='closed')f.p.closed=true;
    if(boundary==='denied')f.rejectGrant();else f.grant();
    await f.p.inputQueue.idle();await tick();await tick();
    assert(!f.compositions.some(c=>c.type!=='cancel'));
    if(boundary==='document'||boundary==='editor')assert(f.errors.length>0,'target change must not silently succeed');
  });
}

for (const intent of ['none','agent','obsolete-human','unknown-editor'] as const) {
  test(`${intent} cannot turn local composition into input for a later target`, async t => {
    const f=fixture(t);f.p.nativeIme=true;f.p.editor=intent==='unknown-editor'?null:'native-field';
    if(intent==='unknown-editor')f.click();
    else if(intent!=='none')f.p.acquiring={kind:intent==='agent'?'agent':'human',generation:0,promise:Promise.resolve('wrong-grant')};
    f.composition('你好');await tick();
    f.p.editor='later-field';
    if(intent==='unknown-editor'){f.grant();await f.p.inputQueue.idle();}
    await tick();assert(!f.compositions.some(c=>c.type!=='cancel'));
    if(intent==='unknown-editor')assert(f.errors.some(e=>e.includes('Focus a text field')));
    else assert.deepEqual(f.controls,[],'composition cannot implicitly request control');
  });
}

test('IME phases pipeline within one transaction, fencing the next composition and keys until all ACKs', async t => {
  const f=fixture(t);f.p.nativeIme=true;f.p.editor='native-field';f.click();f.grant();await f.p.inputQueue.idle();
  const order:string[]=[],original=f.host.rawCall.bind(f.host);const acknowledgements:(()=>void)[]=[];
  f.host.rawCall=(p:any,method:string,input:any,...rest:any[])=>{
    if(method==='ime'){
      order.push(input.type+':'+(input.text??''));
      if(order.length<=2){ original(p,method,input,...rest); return new Promise<void>(resolve=>{acknowledgements.push(resolve);}); }
    }else if(method==='input')order.push(input.type+':'+(input.keyCode??''));
    return original(p,method,input,...rest);
  };
  f.composition('你');f.composition('好');f.key('keydown','Return');await tick();
  assert.deepEqual(order,['begin:','commit:你'],'terminal pipelines without waiting a network RTT for begin');
  acknowledgements[1]();await tick();
  assert.deepEqual(order,['begin:','commit:你'],'one late ACK still fences the group');
  acknowledgements[0]();await f.p.inputQueue.idle();await tick();
  assert.deepEqual(order.filter(v=>v!=='cancel:'),['begin:','commit:你','begin:','commit:好','keyDown:Return']);
  assert.equal(f.compositions[0].id,f.compositions[1].id);
  assert(f.compositions.filter(c=>c.type==='cancel').every(c=>c.id===f.compositions[0].id), 'a delayed begin ACK can cancel only its already-finished transaction');
});

test('queue reset while a composition-only grant is pending fences the barrier itself', async t => {
  const f=fixture(t);f.p.nativeIme=true;f.p.editor='native-field';
  const request=f.host.acquireControl(f.p,'human');void request.catch(()=>{});
  f.composition('你好');await tick();f.p.resetInput();f.grant();await tick();await tick();
  assert(!f.compositions.some(c=>c.type!=='cancel'));
});


for(const kind of ['focus','copy','control'] as const)test(`${kind} failures use nonfatal feedback when supplied by the page runtime`,async t=>{
  const f=fixture(t),seen:string[]=[];f.p.events.onInputError=(reason:string)=>seen.push(reason);f.p.nativeIme=true;
  if(kind==='focus'){f.click();f.composition('你好');await tick();f.grant();await f.p.inputQueue.idle();}
  else if(kind==='copy'){f.click();f.grant();await f.p.inputQueue.idle();f.key('keydown','c',{ctrlKey:true});}
  else {f.click();f.rejectGrant();await tick();await tick();}
  assert(seen.includes(kind));assert.deepEqual(f.errors,[],'nonfatal feedback cannot enter the navigation error port');
});

for(const code of ['CONTROL_LOST','CONTROL_BUSY','PAGE_CLOSED'])test(`${code} from a navigation-control operation keeps the correct feedback channel`,async t=>{
  const f=fixture(t),seen:string[]=[];f.p.events.onInputError=(kind:string)=>seen.push(kind);f.p.ready=Promise.resolve();
  f.host.humanCall=async()=>{throw Object.assign(Error('synthetic operation failure'),{code});};
  f.host.run(f.p,'back');await tick();
  assert.deepEqual(seen,code==='PAGE_CLOSED'?[]:['control']);
  assert.deepEqual(f.errors,code==='PAGE_CLOSED'?['synthetic operation failure']:[]);
});
