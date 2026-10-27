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
  for(const kind of ['mouse','touch'])for(const location of ['root','child'])for(const field of ['a','b']) {
    await test(`${kind} ${location} ${field==='b'?'password':'text'} exact native context`,async()=>{
      await reset(wc);const frame=location==='root'?wc.mainFrame:child;
      const receipt=await activation(wc,kind,100,(field==='a'?40:100)+(location==='child'?220:0));
      assert.equal(wc.focusedFrame,frame,'Native frame selection must be ready at receipt ACK');
      const context=await causal(wc.focusedFrame,receipt);assert(context.available,context.reason);assert.equal(context.inputType,field==='b'?2:1);
      await noContext(frame,receipt); // The activation receipt cannot be consumed twice.
      const result=await apply(frame,context,'因果中文');assert.equal(result.status,'processed');
      assert.equal(await run(frame,`${field}.value`),'因果中文');
      assert(await run(frame,`events.some(e=>e.type==='input'&&e.target==='${field}'&&e.trusted)`));
      const replay=await apply(frame,context,'重复');assert.notEqual(replay.status,'processed');
      assert.equal(await run(frame,`${field}.value`),'因果中文');
      return {singleUseReceipt:true,singleUseEdit:true,physicalOsIme:false};
    });
  }
  await test('native Tab binds the resulting password editor',async()=>{
    await reset(wc);await run(wc.mainFrame,'a.focus()');
    const receipt=await wc.sendInputEventWithNativeInputTicket({type:'keyDown',keyCode:'Tab'});
    wc.sendInputEvent({type:'keyUp',keyCode:'Tab'});
    const context=await causal(wc.mainFrame,receipt);assert(context.available,context.reason);assert.equal(context.inputType,2);
    const result=await apply(wc.mainFrame,context,'键盘');assert.equal(result.status,'processed');assert.equal(await run(wc.mainFrame,'b.value'),'键盘');
  });
  for(const kind of ['mouse','touch']) {
    await test(`${kind} delayed focus redirect cannot be recaptured`,async()=>{
      await reset(wc);await run(wc.mainFrame,`redirect.onclick=()=>{a.focus();setTimeout(()=>b.focus(),0)}`);
      const receipt=await activation(wc,kind,100,160);
      await until(()=>run(wc.mainFrame,'document.activeElement.id'),id=>id==='b','Delayed redirect did not run');
      await noContext(wc.mainFrame,receipt);assert.equal(await run(wc.mainFrame,'a.value+b.value'),'');
    });
  }
  await test('focus created after the activation cannot acquire its receipt',async()=>{
    await reset(wc);await run(wc.mainFrame,`redirect.onclick=()=>setTimeout(()=>a.focus(),0)`);
    const receipt=await activation(wc,'touch',100,160);await until(()=>run(wc.mainFrame,'document.activeElement.id'),id=>id==='a','Delayed focus missing');await noContext(wc.mainFrame,receipt);
  });
  await test('A B A cannot revive a native activation',async()=>{
    await reset(wc);const receipt=await activation(wc,'touch',100,40);await run(wc.mainFrame,'b.focus();a.focus()');await noContext(wc.mainFrame,receipt);
  });
  await test('same editor website value update remains authoritative',async()=>{
    await reset(wc);const receipt=await activation(wc,'mouse',100,40);await run(wc.mainFrame,`a.value='script replacement';a.setSelectionRange(a.value.length,a.value.length)`);const context=await causal(wc.mainFrame,receipt);assert(context.available,context.reason);assert.equal((await apply(wc.mainFrame,context,'当前')).status,'processed');assert.equal(await run(wc.mainFrame,'a.value'),'script replacement当前');
  });
  await test('same editor website selection remains authoritative',async()=>{
    await reset(wc);await run(wc.mainFrame,`a.value='selection fixture'`);const receipt=await activation(wc,'mouse',100,40);await run(wc.mainFrame,'a.setSelectionRange(0,0)');const context=await causal(wc.mainFrame,receipt);assert(context.available,context.reason);assert.equal((await apply(wc.mainFrame,context,'首')).status,'processed');assert.equal(await run(wc.mainFrame,'a.value'),'首selection fixture');
  });
  await test('text mutation after the native grant rejects the stale edit',async()=>{
    await reset(wc);const receipt=await activation(wc,'mouse',100,40),context=await causal(wc.mainFrame,receipt);assert(context.available);await run(wc.mainFrame,`a.value='later website edit'`);const result=await apply(wc.mainFrame,context,'禁止迟到');assert.notEqual(result.status,'processed');assert.equal(result.dispatched,false);assert.equal(await run(wc.mainFrame,'a.value'),'later website edit');
  });
  await test('selection mutation after the native grant rejects the stale edit',async()=>{
    await reset(wc);await run(wc.mainFrame,`a.value='selection after grant'`);const receipt=await activation(wc,'mouse',100,40),context=await causal(wc.mainFrame,receipt);assert(context.available);await run(wc.mainFrame,'a.setSelectionRange(a.selectionStart===0?1:0,a.selectionStart===0?1:0)');const result=await apply(wc.mainFrame,context,'禁止迟到');assert.notEqual(result.status,'processed');assert.equal(result.dispatched,false);assert.equal(await run(wc.mainFrame,'a.value'),'selection after grant');
  });
  await test('same focused node changing input type expires its snapshot',async()=>{
    await reset(wc);const receipt=await activation(wc,'touch',100,40);await run(wc.mainFrame,`a.type='password'`);await noContext(wc.mainFrame,receipt);
  });
  await test('new native interaction supersedes an older receipt in the same editor',async()=>{
    await reset(wc);const first=await activation(wc,'mouse',100,40),second=await activation(wc,'mouse',120,40);await noContext(wc.mainFrame,first);const context=await causal(wc.mainFrame,second);assert(context.available,context.reason);assert.equal((await apply(wc.mainFrame,context,'当前')).status,'processed');
  });
  await test('rejected causal query does not cancel an ordinary native composition',async()=>{
    await reset(wc);const receipt=await activation(wc,'touch',100,40);const ordinary=await wc.mainFrame.getNativeImeContextForTesting();assert(ordinary.available);
    const composed=await apply(wc.mainFrame,ordinary,'预编辑','compose');assert.equal(composed.status,'processed');await noContext(wc.mainFrame,receipt);
    assert.equal((await apply(wc.mainFrame,composed.context,'继续')).status,'processed');assert.equal(await run(wc.mainFrame,'a.value'),'继续');
  });
  await test('touch scroll cannot mint a tap editor context',async()=>{
    await reset(wc);
    for(const packet of [{type:'touchStart',touchPoints:[{id:0,x:680,y:480}]},{type:'touchMove',touchPoints:[{id:0,x:680,y:350}]},{type:'touchMove',touchPoints:[{id:0,x:680,y:260}]}])await wc.debugger.sendCommand('Input.dispatchTouchEventWithNativeInputTicket',packet);
    const receipt=await wc.debugger.sendCommand('Input.dispatchTouchEventWithNativeInputTicket',{type:'touchEnd',touchPoints:[]});await noContext(wc.focusedFrame??wc.mainFrame,receipt);
  });
  await test('two-finger pinch cannot mint a tap editor context',async()=>{
    await reset(wc);
    for(const packet of [{type:'touchStart',touchPoints:[{id:0,x:500,y:420}]},{type:'touchStart',touchPoints:[{id:1,x:600,y:420}]},{type:'touchMove',touchPoints:[{id:0,x:450,y:420},{id:1,x:650,y:420}]},{type:'touchEnd',touchPoints:[{id:0,x:450,y:420}]}])await wc.debugger.sendCommand('Input.dispatchTouchEventWithNativeInputTicket',packet);
    const receipt=await wc.debugger.sendCommand('Input.dispatchTouchEventWithNativeInputTicket',{type:'touchEnd',touchPoints:[]});await noContext(wc.focusedFrame??wc.mainFrame,receipt);
    await wc.debugger.sendCommand('Emulation.setPageScaleFactor',{pageScaleFactor:1});
  });
  await test('simultaneous dispatch rejects extra input without changing the first target',async()=>{
    await reset(wc);wc.sendInputEvent({type:'mouseDown',button:'left',modifiers:['leftButtonDown'],clickCount:1,x:100,y:40});
    const first=wc.sendInputEventWithNativeInputTicket({type:'mouseUp',button:'left',clickCount:1,x:100,y:40});
    const rejected=assert.rejects(wc.sendInputEventWithNativeInputTicket({type:'mouseUp',button:'left',clickCount:1,x:100,y:100}),/already pending/);
    const receipt=await first;await rejected;const context=await causal(wc.mainFrame,receipt);assert(context.available,context.reason);assert.equal(context.inputType,1);
  });
  await test('native select popup input completes without inventing an editor grant',async()=>{
    await reset(wc);await wc.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,x:100,y:580});
    const before=Date.now(),receipt=await wc.sendInputEventWithNativeInputTicket({type:'mouseUp',button:'left',clickCount:1,x:100,y:580});assert(Date.now()-before<1500);
    if(receipt.nativeInputTicket)await noContext(wc.mainFrame,receipt);
    wc.sendInputEvent({type:'keyDown',keyCode:'Escape'});wc.sendInputEvent({type:'keyUp',keyCode:'Escape'});await wc.loadURL(origin+'/?after-picker');
    return {nativePopupReceipt:receipt.nativeInputTicket!==null};
  });
  await test('navigation cannot reuse the old document activation',async()=>{
    await reset(wc);const frame=wc.mainFrame,receipt=await activation(wc,'touch',100,40);await wc.loadURL(origin+'/?navigation');let context;
    try{context=await causal(frame,receipt)}catch{context={available:false}}assert.equal(context.available,false);assert.equal(await run(wc.mainFrame,'a.value+b.value'),'');
  });
  await test('native ACK timeout has unknown outcome and cannot complete a later receipt',async()=>{
    await reset(wc);
    const issued=Date.now();let mark;const started=new Promise(resolve=>{mark=event=>{if(event.message==='owned-native-causal-busy'){wc.off('console-message',mark);resolve()}};wc.on('console-message',mark)});
    const busy=run(wc.mainFrame,`console.info('owned-native-causal-busy');{const end=performance.now()+3200;while(performance.now()<end){}};true`);
    await started;assert(Date.now()-issued<1500,'Busy marker must arrive while the renderer is actually blocked');
    const before=Date.now();await assert.rejects(wc.sendInputEventWithNativeInputTicket({type:'mouseUp',button:'left',clickCount:1,x:100,y:40}),/timed out/);const elapsed=Date.now()-before;assert(elapsed>=1800&&elapsed<7000);
    await busy;
    const receipt=await activation(wc,'mouse',100,40),context=await causal(wc.mainFrame,receipt);assert(context.available,context.reason);assert.equal((await apply(wc.mainFrame,context,'恢复')).status,'processed');
    assert.equal(await run(wc.mainFrame,'a.value'),'恢复');return {timeoutMs:elapsed,noAutomaticReplay:true};
  });
  await test('destroying WebContents retires a pending native acknowledgement',async()=>{
    const temporary=new BrowserWindow({show:false,width:400,height:300,webPreferences:{offscreen:true,sandbox:true}});windows.add(temporary);
    const twc=temporary.webContents;await twc.loadURL('about:blank');
    const dispose=await initializeNativeFocus(twc,()=>errors.push('Temporary native focus failed'));
    try {
      await twc.loadURL(origin+'/child');await twc.capturePage();
      const ready=await activation(twc,'mouse',100,40);assert((await causal(twc.mainFrame,ready)).available);
      const issued=Date.now();let mark;const started=new Promise(resolve=>{mark=event=>{if(event.message==='owned-native-causal-destroy-busy'){twc.off('console-message',mark);resolve()}};twc.on('console-message',mark)});
      // Prove this request cannot already be ACKed before destruction. A bare
      // dispatch may complete synchronously and is not a pending-ACK fixture.
      void run(twc.mainFrame,`console.info('owned-native-causal-destroy-busy');{const end=performance.now()+3200;while(performance.now()<end){}}`).catch(()=>{});
      await started;assert(Date.now()-issued<1500,'Destroy marker must precede the blocked renderer task completion');
      const pending=twc.sendInputEventWithNativeInputTicket({type:'mouseUp',button:'left',clickCount:1,x:100,y:40});
      const rejected=assert.rejects(pending,/destroyed|superseded|timed out/);temporary.destroy();await rejected;
      return {rendererWasBlocked:true};
    } finally {dispose();}
  });
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:true,cases,errors,physicalOsIme:false,unknownFirstInputWireEnabled:false,nativeReceiptIsNotWriteAuthority:true}));
}).catch(error=>{console.error(error);process.exitCode=1}).finally(async()=>{
  clearTimeout(deadline);disposeFocus?.();for(const candidate of windows)if(!candidate.isDestroyed())candidate.destroy();
  if(server)await new Promise(resolve=>server.close(resolve));rmSync(profile,{recursive:true,force:true});app.exit(process.exitCode||0);
});
