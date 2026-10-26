// Real native editor-state invalidation and teardown regression. Fixture DOM
// access is only setup/assertion; notifications and input use the native fork.
const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { mkdtempSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { initializeNativeFocus } = require('../../scripts/remote-browser/focus.cjs');
const profile = mkdtempSync(join(tmpdir(), 'opencraft-native-input-events-'));
app.setPath('userData', profile);
app.disableHardwareAcceleration();
// Keep the lifecycle assertions alive after the reentrant last-window close.
app.on('window-all-closed', () => {});
app.commandLine.appendSwitch('site-per-process');
let window, server, disposeFocus;
const states = [], cases = [], errors = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = setTimeout(() => { console.error('Native input event probe timed out'); app.exit(1); }, 30000);
async function until(read, accept, label) {
  const expires = Date.now() + 5000;
  while (Date.now() < expires) { const result = await read(); if (accept(result)) return result; await delay(5); }
  throw new Error(label);
}
function fixture(child, port) {
  return `<!doctype html><meta charset="utf-8"><style>body{margin:0;${child ? 'background:rgb(214,255,224)' : ''}}
  input{position:absolute;left:20px;top:20px;width:300px;height:40px;font-size:20px}
  #password{top:80px}iframe{position:absolute;left:20px;top:160px;width:600px;height:260px;border:0}</style>
  <input id="field"><input id="password" type="password" value="private-fixture-password">
  ${child ? '' : `<iframe src="http://localhost:${port}/child"></iframe>`}`;
}
app.whenReady().then(async () => {
  await session.defaultSession.setProxy({ mode:'direct' });
  server = createServer((request, response) => { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(fixture(request.url === '/child', server.address().port)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  window = new BrowserWindow({ width:720, height:540, frame:false, show:false,
    webPreferences:{ offscreen:true, sandbox:true, contextIsolation:true, nodeIntegration:false } });
  const wc = window.webContents;
  assert.equal(typeof wc.setNativeTextInputStateObservation, 'function', 'Native notification fork is required');
  wc.on('render-process-gone', (_event, detail) => errors.push(detail));
  await wc.loadURL('about:blank');
  disposeFocus = await initializeNativeFocus(wc, () => errors.push('Native focus initialization failed'));
  await wc.loadURL(`http://127.0.0.1:${server.address().port}/`);
  await until(async () => {
    try { const image=await wc.capturePage(), size=image.getSize(), pixels=image.toBitmap(), at=(162*size.width+22)*4;
      return size.width===720 && size.height===540 && pixels[at]===224 && pixels[at+1]===255 && pixels[at+2]===214; } catch { return false; }
  }, Boolean, 'Cross-site compositor surface not displayed');
  const child=wc.mainFrame.frames.find(frame=>frame.url.includes('localhost'));
  assert(child); assert.notEqual(child.processId,wc.mainFrame.processId);
  wc.on('native-text-input-state-changed', () => states.push(wc.getNativeTextInputState()));
  const click = (x,y) => { wc.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,modifiers:['leftButtonDown'],x,y}); wc.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x,y}); };
  assert.equal(wc.setNativeTextInputStateObservation(true),true);
  assert.equal(wc.setNativeTextInputStateObservation(true),true);
  click(100,40);
  await until(()=>states.at(-1),state=>state?.active && state.type===1,'Root editor notification missing');
  const rootIdentity=states.at(-1).targetIdentity;
  const context=await wc.mainFrame.getNativeImeContextForTesting(); assert(context.available);
  const committed=await wc.mainFrame.applyNativeImeForTesting({token:context.token,compositionId:context.compositionId,type:'commit',text:'原生通知',selectionStart:4,selectionEnd:4});
  assert.equal(committed.status,'processed');
  await until(()=>states.at(-1),state=>state?.selection?.end===4,'Native edit range notification missing');
  cases.push({type:'root-focus-and-edit',target:rootIdentity});
  click(100,200);
  await until(()=>states.at(-1),state=>state?.active && state.type===1 && state.targetIdentity!==rootIdentity,'Child editor notification missing');
  assert.equal(wc.focusedFrame,child);
  const childIdentity=states.at(-1).targetIdentity;
  click(100,260);
  await until(()=>states.at(-1),state=>state?.active && state.password && state.targetIdentity!==childIdentity,'Child password notification missing');
  assert.equal(wc.focusedFrame,child);
  cases.push({type:'cross-site-focus-and-password'});
  assert.equal(JSON.stringify(states).includes('private-fixture-password'),false);
  for (const state of states) for (const key of ['value','text','surroundingText','token']) assert(!Object.hasOwn(state,key));
  cases.push({type:'observation-no-text-or-capabilities'});
  assert.equal(wc.setNativeTextInputStateObservation(false),true);
  const disabledCount=states.length;
  click(100,40);
  await until(()=>wc.getNativeTextInputState(),state=>state.active && state.targetIdentity===rootIdentity,'Root focus after disabling missing');
  await delay(60); assert.equal(states.length,disabledCount);
  cases.push({type:'disabled-and-pending-callback-fence'});
  assert.equal(wc.setNativeTextInputStateObservation(true),true);
  await wc.loadURL('about:blank');
  await until(()=>states.at(-1),state=>state && !state.active,'Navigation invalidation missing');
  cases.push({type:'navigation-and-destroyed-child'});
  await wc.loadURL(`http://127.0.0.1:${server.address().port}/`);
  let disabled=false;
  wc.once('native-text-input-state-changed',()=>{ disabled=true; wc.setNativeTextInputStateObservation(false); });
  click(100,40);
  await until(()=>disabled,Boolean,'Reentrant observation disable missing');
  cases.push({type:'reentrant-disable'});
  wc.setNativeTextInputStateObservation(true);
  wc.once('native-text-input-state-changed',()=>window.destroy());
  click(100,100);
  await until(()=>window.isDestroyed(),Boolean,'Reentrant WebContents destruction missing');
  await delay(50); assert.deepEqual(errors,[]);
  cases.push({type:'reentrant-destroy'});
  console.log(JSON.stringify({passed:true,cases,notifications:states.length,errors,physicalOsIme:false}));
}).catch(error=>{console.error(error);process.exitCode=1}).finally(async()=>{
  clearTimeout(deadline);disposeFocus?.();if(window&&!window.isDestroyed())window.destroy();
  if(server)await new Promise(resolve=>server.close(resolve));rmSync(profile,{recursive:true,force:true});app.exit(process.exitCode||0);
});
