// Synthetic assertions read fixture DOM; production editing uses only native APIs.
'use strict';
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { installIme } = require('../../scripts/remote-browser/ime.cjs');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'opencraft-form-input-')));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('ozone-platform', 'headless');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const cases = [];
let window, port;
const timeout = setTimeout(() => app.exit(1), 60000);
app.whenReady().then(async () => { try {
  window = new BrowserWindow({show:false,width:640,height:700,webPreferences:{offscreen:true,sandbox:true,contextIsolation:true,nodeIntegration:false}});
  const wc = window.webContents;
  wc.setWindowOpenHandler(() => ({action:'deny'}));
  wc.session.setPermissionRequestHandler((_wc,_permission,callback) => callback(false));
  wc.session.on('will-download', event => event.preventDefault());
  const html = '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    ['text','search','password','email','url','tel','number','date','color','file'].map(t=>`<input id="${t}" type="${t}">`).join('') +
    '<textarea id="textarea"></textarea><div id="rich" contenteditable></div><input id="readonly" readonly><input id="disabled" disabled>' +
    '<input id="none" inputmode="none"><input id="decimal" inputmode="decimal" enterkeyhint="done">' +
    '<script>window.keys=[];for(const t of ["keydown","keyup"])document.addEventListener(t,e=>keys.push({type:t,key:e.key,trusted:e.isTrusted}));</script>';
  await wc.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(html));
  wc.debugger.attach('1.3');
  await wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
  const run = code => wc.executeJavaScript(code);
  const fixtureGlobal = (await wc.debugger.sendCommand('Runtime.evaluate', {expression:'globalThis'})).result.objectId;
  async function callFixture(functionDeclaration, ...values) {
    const result = await wc.debugger.sendCommand('Runtime.callFunctionOn', {
      objectId:fixtureGlobal, functionDeclaration, arguments:values.map(value=>({value})), returnByValue:true,
    });
    if (result.exceptionDetails) throw new Error('Fixture function failed');
    return result.result.value;
  }
  const events=[];
  const page={window,visible:true,closed:false,id:'probe',document:'doc'};
  port=installIme(page,event=>events.push(event));
  async function focus(id) {
    await callFixture('function(id){document.activeElement.blur();document.getElementById(id).focus()}', id);
    await delay(100);port.observe();return events.at(-1);
  }
  let serial=0;
  const transaction = () => `aaaaaaaa-aaaa-aaaa-aaaa-${String(++serial).padStart(12,'0')}`;
  for (const [id,type,kind] of [['text',1,'text'],['search',3,'search'],['password',2,'password'],['email',4,'email'],['url',7,'url'],['tel',6,'tel'],['number',5,'number'],['textarea',14,'textarea'],['rich',15,'contenteditable']]) {
    const state=await focus(id), native=await wc.focusedFrame.getNativeImeContextForTesting(), observed=wc.getNativeTextInputState();
    assert.equal(observed.type,type);assert.equal(native.available,true,id);
    assert.equal(native.targetIdentity,observed.targetIdentity,id+' native identity');assert.equal(native.inputType,type);
    assert.equal(state.editable,true);assert.equal(state.keyboard.kind,kind);assert.equal(state.keyboard.secure,id==='password');
    const tid=transaction(), text=id==='number'?'42.5':id==='password'?'synthetic-9!':'中文';
    await port.apply({id:tid,type:'begin',editor:state.editor});
    await port.apply({id:tid,type:'compose',text:id==='number'?'4':id==='password'?'s':'zhong'});
    await port.apply({id:tid,type:'commit',text});
    assert.equal(await callFixture('function(id){const e=document.getElementById(id);return e.value??e.textContent}', id),text,id+' final value');
    assert(!JSON.stringify(events).includes('synthetic-9!'));assert(!JSON.stringify(events).includes(native.token));
    assert(!JSON.stringify(events).includes(observed.targetIdentity));
    cases.push({name:id+' native composition/commit/metadata',passed:true});
  }
  for(const id of ['date','color','file','readonly','disabled']) assert.equal((await focus(id)).editable,false,id);
  cases.push({name:'non-text pickers readonly disabled excluded',passed:true});
  assert.equal((await focus('none')).keyboard.autoKeyboard,false);
  const decimal=await focus('decimal');assert.equal(decimal.keyboard.inputMode,'decimal');assert.equal(decimal.keyboard.enterKeyHint,'done');
  cases.push({name:'native inputmode and action',passed:true});
  const password=await focus('password'), old=transaction();
  await port.apply({id:old,type:'begin',editor:password.editor});await port.apply({id:old,type:'compose',text:'x'});
  await focus('search');await assert.rejects(port.apply({id:old,type:'commit',text:'must-not-retarget'}));
  assert.equal(await run('document.getElementById("search").value'),'中文');
  cases.push({name:'late password composition cannot retarget search',passed:true});
  await run('document.activeElement.blur();keys=[]');
  for(const keyCode of ['a','Left','Tab','Escape']) { wc.sendInputEvent({type:'keyDown',keyCode});wc.sendInputEvent({type:'keyUp',keyCode}); }
  await delay(100);const keys=await run('keys');
  for(const key of ['a','ArrowLeft','Tab','Escape']) for(const type of ['keydown','keyup']) assert(keys.some(e=>e.key===key&&e.type===type&&e.trusted),key+' '+type);
  cases.push({name:'native page keydown/keyup outside editor',passed:true});
  console.log(JSON.stringify({probe:'native-form-input',passed:true,cases,passwordValuesLogged:false,physicalMobileKeyboardValidated:false}));
  port.dispose();window.destroy();clearTimeout(timeout);app.quit();
} catch(error) { console.error(error.stack);port?.dispose();window?.destroy();app.exit(1); } });
