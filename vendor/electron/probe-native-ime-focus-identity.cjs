// Native dispatch receipts must name the editor identity from that dispatch task.
// DOM access below is synthetic fixture setup/assertion, never input routing.
const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { initializeNativeFocus } = require('../../scripts/remote-browser/focus.cjs');
const profile = mkdtempSync(join(tmpdir(), 'opencraft-native-causal-input-'));
app.setPath('userData', profile); app.disableHardwareAcceleration();
app.commandLine.appendSwitch('site-per-process');
app.commandLine.appendSwitch('force-device-scale-factor','1');
app.commandLine.appendSwitch('ozone-override-screen-size','1920,1080');
app.commandLine.appendSwitch('disable-features', 'SyntheticPointerActions');
app.on('window-all-closed', () => {});
const cases = [], errors = [], windows = new Set();
let window, server, disposeFocus;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = setTimeout(() => { console.error('Native causality probe timed out'); app.exit(1); }, 120000);
async function until(read, accept, label) {
  const expires = Date.now() + 5000;
  while (Date.now() < expires) { const value = await read(); if (accept(value)) return value; await delay(5); }
  throw new Error(label);
}
function fixture(child, port) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <style>body{margin:0;min-height:1200px;${child ? 'background:rgb(214,255,224)' : ''}}
  input,button{position:absolute;left:20px;width:300px;height:40px;font:20px sans-serif}
  #a{top:20px}#b{top:80px}#redirect{top:140px}#picker{position:absolute;left:20px;top:560px;width:300px;height:40px;font:20px sans-serif}iframe{position:absolute;left:20px;top:220px;width:600px;height:300px;border:0}</style>
  <input id="a"><input id="b" type="password"><button id="redirect">Fixture action</button><select id="picker"><option>One</option><option>Two</option><option>Three</option><option>Four</option></select>
  ${child ? '' : `<iframe src="http://localhost:${port}/child"></iframe>`}
  <script>globalThis.events=[];for(const e of document.querySelectorAll('input'))for(const name of ['focus','blur','beforeinput','input'])
  e.addEventListener(name,event=>events.push({type:name,target:e.id,trusted:event.isTrusted}));</script>`;
}
const run = (frame, text) => frame.executeJavaScript(text);
async function reset(wc) {
  await run(wc.mainFrame, `scrollTo(0,0);a.type='text';a.value='';b.value='';redirect.onclick=null;a.onbeforeinput=null;document.activeElement.blur();events=[]`);
  for (const frame of wc.mainFrame.frames) await run(frame, `scrollTo(0,0);a.type='text';a.value='';b.value='';document.activeElement.blur();events=[]`);
  await wc.capturePage();
}
async function activation(wc, kind, x, y) {
  if (kind === 'touch') {
    await wc.debugger.sendCommand('Input.dispatchTouchEventWithNativeInputTicket', { type:'touchStart', touchPoints:[{id:0,x,y}] });
    return wc.debugger.sendCommand('Input.dispatchTouchEventWithNativeInputTicket', { type:'touchEnd', touchPoints:[] });
  }
  wc.sendInputEvent({type:'mouseDown',button:'left',modifiers:['leftButtonDown'],clickCount:1,x,y});
  return wc.sendInputEventWithNativeInputTicket({type:'mouseUp',button:'left',clickCount:1,x,y});
}
async function causal(frame, receipt) {
  assert.equal(typeof receipt.nativeInputTicket,'string');
  return frame.getNativeImeContextForInputForTesting(receipt.nativeInputTicket);
}
async function noContext(frame, receipt) {
  const context = await causal(frame,receipt);
  assert.equal(context.available,false); assert.equal(context.token,'');
}
const apply = (frame, context, text, type='commit') => frame.applyNativeImeForTesting({
  token:context.token,compositionId:context.compositionId,type,text,
  selectionStart:text.length,selectionEnd:text.length,
});
async function test(name, fn) { try { const detail = await fn(); cases.push({name,passed:true,...detail}); } catch (error) { error.message = name + ": " + error.message; console.error(JSON.stringify({completedCases:cases.map(item=>item.name),failedCase:name})); throw error; } }
app.whenReady().then(async () => {
  await session.defaultSession.setProxy({mode:'direct'});
  server=createServer((request,response)=>{response.setHeader('Content-Type','text/html; charset=utf-8');response.end(fixture(request.url==='/child',server.address().port))});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  window=new BrowserWindow({show:false,frame:false,width:720,height:640,webPreferences:{offscreen:true,sandbox:true,contextIsolation:true,nodeIntegration:false}});windows.add(window);
  const wc=window.webContents;
  wc.on('render-process-gone',(_event,detail)=>errors.push(detail));
  assert.equal(typeof wc.sendInputEventWithNativeInputTicket,'function');
  await wc.loadURL('about:blank');disposeFocus=await initializeNativeFocus(wc,()=>errors.push('Native focus failed'));
  await wc.loadURL(origin+'/');
  await until(async()=>{try{const image=await wc.capturePage(),size=image.getSize(),pixels=image.toBitmap(),at=(222*size.width+22)*4;return size.width===720&&size.height===640&&pixels[at]===224&&pixels[at+1]===255&&pixels[at+2]===214}catch{return false}},Boolean,'Child compositor not displayed');
  let child=wc.mainFrame.frames.find(frame=>frame.url.includes('localhost'));
  assert(child);assert.notEqual(child.processId,wc.mainFrame.processId);
  assert.equal(typeof child.getNativeImeContextForInputForTesting,'function');
  await wc.debugger.sendCommand('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:10});
  for(const location of ['root','child'])for(const field of ['a','b']) {
    await test(`${location} ${field==='b'?'password':'text'} focus binding grants current website edits`,async()=>{
      await reset(wc);const frame=location==='root'?wc.mainFrame:child;
      assert.equal(frame.nativeImeContextVersionForTesting,2);
      const receipt=await activation(wc,'mouse',100,(field==='a'?40:100)+(location==='child'?220:0));
      const bound=await causal(frame,receipt);assert(bound.available,bound.reason);assert.equal(typeof bound.focusIdentity,'string');assert(bound.focusIdentity);
      // Discard the first edit grant. Binding editor focus must not freeze the
      // website's text/selection while a later local transaction is starting.
      await run(frame,`${field}.value='website';${field}.setSelectionRange(0,0)`);
      const current=await frame.getNativeImeContextForTesting();assert(current.available,current.reason);assert.equal(current.focusIdentity,bound.focusIdentity);assert.equal(current.targetIdentity,bound.targetIdentity);assert.notEqual(current.token,bound.token);
      const edited=await apply(frame,current,'当前');
      assert.equal(edited.status,'processed',JSON.stringify({status:edited.status,reason:edited.reason,dispatched:edited.dispatched,focusStable:edited.context.focusIdentity===current.focusIdentity,typeStable:edited.context.inputType===current.inputType,beforeSelection:[current.selectionStart,current.selectionEnd],afterSelection:[edited.context.selectionStart,edited.context.selectionEnd],beforeComposition:[current.compositionStart,current.compositionEnd],afterComposition:[edited.context.compositionStart,edited.context.compositionEnd]}));
      assert.equal(await run(frame,`${field}.value`),'当前website');
      return {bindingNotWriteAuthority:true,websiteBeforeGrantAuthoritative:true};
    });
  }
  for(const location of ['root','child']) {
    await test(`${location} A B A changes focus identity while node identity returns`,async()=>{
      await reset(wc);const frame=location==='root'?wc.mainFrame:child;
      const receipt=await activation(wc,'mouse',100,40+(location==='child'?220:0));const before=await causal(frame,receipt);assert(before.available);
      await run(frame,'b.focus();a.focus()');const after=await frame.getNativeImeContextForTesting();assert(after.available);assert.equal(after.targetIdentity,before.targetIdentity);assert.notEqual(after.focusIdentity,before.focusIdentity);
      assert.equal(await run(frame,'a.value+b.value'),'');return {sameNodeDifferentNativeFocus:true};
    });
  }
  await test('owned composition and commit keep editor focus identity',async()=>{
    await reset(wc);const receipt=await activation(wc,'touch',100,40),before=await causal(wc.mainFrame,receipt);assert(before.available);
    const composed=await apply(wc.mainFrame,before,'预编辑','compose');assert.equal(composed.status,'processed');assert.equal(composed.context.focusIdentity,before.focusIdentity);
    const committed=await apply(wc.mainFrame,composed.context,'提交');assert.equal(committed.status,'processed');assert.equal(committed.context.focusIdentity,before.focusIdentity);
    assert.equal((await wc.mainFrame.getNativeImeContextForTesting()).focusIdentity,before.focusIdentity);
  });
  await test('same native editor key navigation supersedes receipt without invalidating focus binding',async()=>{
    await reset(wc);const receipt=await activation(wc,'mouse',100,40),before=await causal(wc.mainFrame,receipt);assert(before.available);
    await run(wc.mainFrame,`a.value='ab';a.setSelectionRange(0,0)`);
    await wc.sendInputEventWithNativeInputTicket({type:'keyDown',keyCode:'Right'});wc.sendInputEvent({type:'keyUp',keyCode:'Right'});
    const after=await wc.mainFrame.getNativeImeContextForTesting();assert(after.available);assert.equal(after.focusIdentity,before.focusIdentity);assert.equal(after.selectionStart,1);
    assert.equal((await apply(wc.mainFrame,after,'中')).status,'processed');assert.equal(await run(wc.mainFrame,'a.value'),'a中b');
  });
  await test('input type changes native focus identity even when DOM node is retained',async()=>{
    await reset(wc);const receipt=await activation(wc,'mouse',100,40),before=await causal(wc.mainFrame,receipt);assert(before.available);
    await run(wc.mainFrame,`a.type='password'`);const after=await wc.mainFrame.getNativeImeContextForTesting();assert(after.available);assert.equal(after.targetIdentity,before.targetIdentity);assert.notEqual(after.focusIdentity,before.focusIdentity);assert.equal(after.inputType,2);
  });
  await test('unfocused editor cannot fabricate a focus binding',async()=>{
    await reset(wc);const unavailable=await wc.mainFrame.getNativeImeContextForTesting();assert.equal(unavailable.available,false);assert.equal(unavailable.focusIdentity,'');
  });
  await test('replacement document receives a new native focus binding',async()=>{
    await reset(wc);const receipt=await activation(wc,'mouse',100,40),before=await causal(wc.mainFrame,receipt);assert(before.available);
    await wc.loadURL(origin+'/?binding-navigation');const next=await activation(wc,'mouse',100,40),after=await causal(wc.mainFrame,next);assert(after.available);assert.notEqual(after.focusIdentity,before.focusIdentity);
  });
  for(const location of ['root','child'])for(const field of ['a','b']) {
    await test(`${location} ${field==='b'?'password':'text'} native mouseDown focuses before release`,async()=>{
      await reset(wc);const frame=location==='root'?wc.mainFrame:wc.mainFrame.frames.find(frame=>frame.url.includes('localhost'));
      const x=100,y=(field==='a'?40:100)+(location==='child'?220:0);
      const receipt=await wc.sendInputEventWithNativeInputTicket({type:'mouseDown',button:'left',modifiers:['leftButtonDown'],clickCount:1,x,y});
      assert.equal(wc.focusedFrame,frame);const focus=await frame.getNativeImeFocusForInputForTesting(receipt.nativeInputTicket);assert(focus.available,focus.reason);assert(!Object.hasOwn(focus,'token'));assert(!Object.hasOwn(focus,'selectionStart'));assert.equal(focus.inputType,field==='a'?1:2);
      const context=await frame.getNativeImeContextForTesting();assert(context.available);assert.equal(context.focusIdentity,focus.focusIdentity);assert.equal((await apply(frame,context,'按下阶段')).status,'processed');assert.equal(await run(frame,`${field}.value`),'按下阶段');
      await wc.sendInputEventWithNativeInputTicket({type:'mouseUp',button:'left',clickCount:1,x,y});
    });
  }
  await test('mouseUp may establish a different editor after mouseDown input already completed',async()=>{
    await reset(wc);await run(wc.mainFrame,'a.onmouseup=()=>b.focus()');
    try {
      const down=await wc.sendInputEventWithNativeInputTicket({type:'mouseDown',button:'left',modifiers:['leftButtonDown'],clickCount:1,x:100,y:40});
      const initial=await wc.mainFrame.getNativeImeFocusForInputForTesting(down.nativeInputTicket);assert(initial.available);const context=await wc.mainFrame.getNativeImeContextForTesting();assert.equal((await apply(wc.mainFrame,context,'旧框')).status,'processed');
      const up=await wc.sendInputEventWithNativeInputTicket({type:'mouseUp',button:'left',clickCount:1,x:100,y:40});const next=await wc.mainFrame.getNativeImeFocusForInputForTesting(up.nativeInputTicket);assert(next.available);assert.equal(next.inputType,2);assert.notEqual(next.focusIdentity,initial.focusIdentity);assert.equal(await run(wc.mainFrame,'a.value'),'旧框');assert.equal(await run(wc.mainFrame,'b.value'),'');
    } finally {await run(wc.mainFrame,'a.onmouseup=null')}
  });
  await test('touchStart preserves old focus and tapEnd establishes the new editor',async()=>{
    await reset(wc);await run(wc.mainFrame,'a.focus()');
    await wc.debugger.sendCommand('Input.dispatchTouchEventWithNativeInputTicket',{type:'touchStart',touchPoints:[{id:0,x:100,y:100}]});
    assert.equal(await run(wc.mainFrame,'document.activeElement.id'),'a');const before=await wc.mainFrame.getNativeImeContextForTesting();assert(before.available);assert.equal((await apply(wc.mainFrame,before,'触前')).status,'processed');
    const end=await wc.debugger.sendCommand('Input.dispatchTouchEventWithNativeInputTicket',{type:'touchEnd',touchPoints:[]});const after=await wc.mainFrame.getNativeImeFocusForInputForTesting(end.nativeInputTicket);assert(after.available);assert.equal(after.inputType,2);assert.notEqual(after.focusIdentity,before.focusIdentity);assert.equal(await run(wc.mainFrame,'a.value'),'触前');assert.equal(await run(wc.mainFrame,'b.value'),'');
  });
  await test('read-only activation focus neither steals a composition nor invalidates its edit token',async()=>{
    await reset(wc);const receipt=await activation(wc,'mouse',100,40),initial=await causal(wc.mainFrame,receipt);assert(initial.available);
    const composed=await apply(wc.mainFrame,initial,'pin','compose');assert.equal(composed.status,'processed');
    const key=await wc.sendInputEventWithNativeInputTicket({type:'keyDown',keyCode:'Shift',modifiers:['shift']});
    const focus=await wc.mainFrame.getNativeImeFocusForInputForTesting(key.nativeInputTicket);assert(focus.available,focus.reason);assert.equal(focus.focusIdentity,initial.focusIdentity);assert(!Object.hasOwn(focus,'token'));assert(!Object.hasOwn(focus,'compositionId'));
    const replay=await wc.mainFrame.getNativeImeFocusForInputForTesting(key.nativeInputTicket);assert.equal(replay.available,false);
    wc.sendInputEvent({type:'keyUp',keyCode:'Shift'});
    const updated=await apply(wc.mainFrame,composed.context,'pinyin','compose');assert.equal(updated.status,'processed');assert.equal((await apply(wc.mainFrame,updated.context,'拼音')).status,'processed');assert.equal(await run(wc.mainFrame,'a.value'),'拼音');
  });
  await test('read-only current focus does not consume a receipt or invalidate owned preedit',async()=>{
    await reset(wc);const receipt=await activation(wc,'mouse',100,40);
    const metadata=await wc.mainFrame.getNativeImeFocusForTesting();assert(metadata.available);assert(!Object.hasOwn(metadata,'token'));assert(!Object.hasOwn(metadata,'compositionId'));assert(!Object.hasOwn(metadata,'selectionStart'));
    const context=await causal(wc.mainFrame,receipt);assert(context.available);assert.equal(context.focusIdentity,metadata.focusIdentity);
    const composed=await apply(wc.mainFrame,context,'pin','compose');assert.equal(composed.status,'processed');
    const observed=await wc.mainFrame.getNativeImeFocusForTesting();assert.equal(observed.focusIdentity,context.focusIdentity);
    assert.equal((await apply(wc.mainFrame,composed.context,'拼')).status,'processed');assert.equal(await run(wc.mainFrame,'a.value'),'拼');
  });
  await test('read-only current focus distinguishes ABA and exposes no unfocused editor',async()=>{
    await reset(wc);assert.equal((await wc.mainFrame.getNativeImeFocusForTesting()).available,false);
    await run(wc.mainFrame,'a.focus()');const before=await wc.mainFrame.getNativeImeFocusForTesting();assert(before.available);
    await run(wc.mainFrame,'b.focus();a.focus()');const after=await wc.mainFrame.getNativeImeFocusForTesting();assert.equal(after.targetIdentity,before.targetIdentity);assert.notEqual(after.focusIdentity,before.focusIdentity);
  });
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:true,cases,errors,physicalOsIme:false,unknownFirstInputWireEnabled:false,nativeImeContextVersion:2,focusIdentityProved:true,readOnlyFocusQueryProved:true,mouseDownPhaseProved:true}));
}).catch(error=>{console.error(error);process.exitCode=1}).finally(async()=>{
  clearTimeout(deadline);disposeFocus?.();for(const candidate of windows)if(!candidate.isDestroyed())candidate.destroy();
  if(server)await new Promise(resolve=>server.close(resolve));rmSync(profile,{recursive:true,force:true});app.exit(process.exitCode||0);
});
