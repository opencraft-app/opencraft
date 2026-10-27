// Isolated native renderer experiment. DOM access below belongs only to the
// fixture and assertions; the bridge itself uses Mojo and Blink native APIs.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const profile = fs.mkdtempSync(join(tmpdir(), 'opencraft-target-ime-'));
app.setPath('userData', profile);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('ozone-platform', 'headless');
app.commandLine.appendSwitch('site-per-process');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const timeout = setTimeout(() => { console.error('Native IME probe timed out'); app.exit(1); }, 60000);
const cases = [];
let window;
let wc;
let frame;
const fixture = `<!doctype html><meta charset="utf-8">
  <input id="a"><input id="b"><textarea id="t"></textarea>
  <div id="rich" contenteditable></div>
  <script>window.events=[];window.cleanup=()=>{};
  for(const el of document.querySelectorAll('input,textarea,[contenteditable]'))
    for(const type of ['compositionstart','compositionupdate','compositionend','beforeinput','input','textInput'])
      el.addEventListener(type,e=>events.push({type,target:el.id,data:e.data??null,
        trusted:e.isTrusted,isComposing:e.isComposing??false}));
  </script>`;

async function load() {
  await wc.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(fixture));
  frame = wc.mainFrame;
  await wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
}
const run = code => wc.executeJavaScript(code);
async function context() {
  for (let i = 0; i < 50; i++) {
    const state = await frame.getNativeImeContextForTesting();
    if (state.available) {
      assert.equal(state.productionReady, false);
      assert.equal(Object.hasOwn(state, 'value'), false);
      assert.equal(Object.hasOwn(state, 'text'), false);
      return state;
    }
    await delay(10);
  }
  throw new Error('Native editable context unavailable');
}
async function reset(value = '') {
  const {result:global} = await wc.debugger.sendCommand('Runtime.evaluate', {expression:'globalThis'});
  const result = await wc.debugger.sendCommand('Runtime.callFunctionOn', {
    objectId:global.objectId,
    functionDeclaration:"function(value){cleanup();cleanup=()=>{};a.value=value;b.value='保留B';a.focus();a.setSelectionRange(a.value.length,a.value.length);events=[];}",
    arguments:[{value}], returnByValue:true,
  });
  if (result.exceptionDetails) throw new Error('Fixture reset failed');
  return context();
}
const apply = (state, type, text = '', extra = {}) => frame.applyNativeImeForTesting({
  token: state.token, compositionId: state.compositionId,
  type, text, selectionStart: text.length, selectionEnd: text.length, ...extra,
});
async function values() { return run('({a:a.value,b:b.value})'); }
async function test(name, fn) {
  await fn();
  cases.push({ name, passed: true });
}
function rejected(result) {
  assert.notEqual(result.status, 'processed');
  assert.equal(result.dispatched, false);
}

app.whenReady().then(async () => {
  window = new BrowserWindow({ width: 640, height: 480, show: false,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  wc = window.webContents;
  assert.equal(typeof wc.mainFrame.getNativeImeContextForTesting, 'function',
    'The selected runtime has no target-bound native IME API. Stock Electron cannot pass this probe.');
  assert.equal(typeof wc.mainFrame.applyNativeImeForTesting, 'function');
  wc.debugger.attach('1.3');
  await load();

  await test('native composition and commit, ordered DOM events', async () => {
    // Compare with Chromium's own native input path; do not invent trust flags
    // for scoped events (compositionend is currently untrusted upstream too).
    await reset();
    await wc.debugger.sendCommand('Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 });
    await wc.debugger.sendCommand('Input.insertText', { text: '你' });
    const nativeEvents = await run('events');
    const state = await reset();
    const preedit = await apply(state, 'compose', 'ni');
    assert.equal(preedit.status, 'processed');
    assert.ok(preedit.context.compositionId);
    assert.equal((await values()).a, 'ni');
    assert.equal(preedit.context.compositionStart, 0);
    assert.equal(preedit.context.compositionEnd, 2);
    const committed = await apply(preedit.context, 'commit', '你');
    assert.equal(committed.status, 'processed');
    assert.deepEqual(await values(), { a: '你', b: '保留B' });
    const names = await run("events.filter(e=>e.target==='a').map(e=>e.type)");
    assert.ok(names.includes('compositionstart'));
    assert.ok(names.includes('compositionupdate'));
    assert.ok(names.includes('compositionend'));
    assert.ok(names.includes('beforeinput') && names.includes('input'));
    assert.ok(names.indexOf('compositionstart') < names.indexOf('compositionend'));
    assert.deepEqual(await run('events'), nativeEvents);
    assert.ok(await run("events.some(e=>e.type==='input'&&e.isComposing)"));
    assert.equal(committed.context.compositionId, '');
  });
  await test('single-use operation capability rejects replay', async () => {
    const state = await reset();
    assert.equal((await apply(state, 'commit', '一次')).status, 'processed');
    rejected(await apply(state, 'commit', '一次'));
    assert.equal((await values()).a, '一次');
  });
  await test('delayed A operation cannot write B', async () => {
    const state = await reset();
    await run('b.focus();b.select()');
    rejected(await apply(state, 'commit', '不应插入'));
    assert.deepEqual(await values(), { a: '', b: '保留B' });
  });
  await test('A to B to A expires native focus generation', async () => {
    const state = await reset();
    await run('b.focus();a.focus();a.setSelectionRange(0,0)');
    rejected(await apply(state, 'commit', '不应插入'));
    assert.deepEqual(await values(), { a: '', b: '保留B' });
  });
  await test('a focus change ends old composition ownership and permits fresh input', async () => {
    const preedit = await apply(await reset(), 'compose', 'pin');
    assert.equal(preedit.status, 'processed');
    await run('b.focus();b.setSelectionRange(b.value.length,b.value.length)');
    rejected(await apply(preedit.context, 'commit', '旧提交'));
    const fresh = await context();
    assert.equal(fresh.compositionId, '');
    rejected(await apply(fresh, 'cancel', '', { compositionId: preedit.context.compositionId }));
    assert.equal((await values()).b, '保留B');
    assert.equal((await apply(await context(), 'commit', '继续')).status, 'processed');
    assert.equal((await values()).b, '保留B继续');
  });
  await test('same editor changed selection expires context', async () => {
    const state = await reset('原文');
    await run('a.select()');
    rejected(await apply(state, 'commit', '覆盖'));
    assert.equal((await values()).a, '原文');
  });
  await test('cancel without an owned composition cannot delete a selection', async () => {
    await reset('不能删');
    await run('a.select()');
    const state = await context();
    rejected(await apply(state, 'cancel'));
    assert.equal((await values()).a, '不能删');
  });
  await test('cancel owns and removes only its live composition', async () => {
    const preedit = await apply(await reset(), 'compose', 'zhong');
    assert.equal(preedit.status, 'processed');
    const canceled = await apply(preedit.context, 'cancel');
    assert.equal(canceled.status, 'processed');
    assert.deepEqual(await values(), { a: '', b: '保留B' });
  });
  await test('old composition id cannot cancel a selected committed result', async () => {
    const preedit = await apply(await reset(), 'compose', 'hao');
    const oldId = preedit.context.compositionId;
    assert.equal((await apply(preedit.context, 'commit', '好')).status, 'processed');
    await run('a.select()');
    const state = await context();
    rejected(await apply(state, 'cancel', '', { compositionId: oldId }));
    assert.deepEqual(await values(), { a: '好', b: '保留B' });
  });
  await test('a foreign native composition cannot be canceled by the bridge', async () => {
    await reset();
    await wc.debugger.sendCommand('Input.imeSetComposition', {
      text: 'wai', selectionStart: 3, selectionEnd: 3,
    });
    const state = await context();
    assert.ok(state.compositionStart >= 0);
    assert.equal(state.compositionId, '');
    rejected(await apply(state, 'cancel'));
    assert.equal((await values()).a, 'wai');
    await wc.debugger.sendCommand('Input.insertText', { text: '外部' });
  });
  await test('beforeinput refocus stops subsequent bridge insertion', async () => {
    const state = await reset();
    await run("a.addEventListener('beforeinput',()=>b.focus(),{once:true})");
    const result = await apply(state, 'commit', '不能串框');
    assert.equal(result.status, 'target-changed-during-operation');
    assert.equal(result.dispatched, true);
    assert.deepEqual(await values(), { a: '', b: '保留B' });
    assert.ok(await run("events.some(e=>e.type==='beforeinput')"));
  });
  await test('the website can reject a native commit in beforeinput', async () => {
    const state = await reset();
    await run("a.addEventListener('beforeinput',e=>e.preventDefault(),{once:true})");
    const result = await apply(state, 'commit', '不接受');
    assert.equal(result.status, 'editor-rejected');
    assert.equal(result.dispatched, true);
    assert.deepEqual(await values(), { a: '', b: '保留B' });
  });
  await test('beforeinput focus roundtrip cannot evade the guard', async () => {
    const state = await reset();
    await run("a.addEventListener('beforeinput',()=>{b.focus();a.focus()},{once:true})");
    const result = await apply(state, 'commit', '不能插入');
    assert.equal(result.status, 'target-changed-during-operation');
    assert.deepEqual(await values(), { a: '', b: '保留B' });
  });
  await test('a replacement editor with the same DOM id is a different target', async () => {
    const state = await reset();
    await run(`a.addEventListener('beforeinput',()=>{
      const replacement=a.cloneNode();a.replaceWith(replacement);replacement.focus();
    },{once:true})`);
    const result = await apply(state, 'commit', '不能转移');
    assert.equal(result.status, 'target-changed-during-operation');
    assert.deepEqual(await values(), { a: '', b: '保留B' });
    // Restore fixture listeners after replacing the original element.
    await load();
  });
  await test('compositionstart refocus cannot compose into B', async () => {
    const state = await reset();
    await run("a.addEventListener('compositionstart',()=>b.focus(),{once:true})");
    const result = await apply(state, 'compose', 'pin');
    assert.equal(result.status, 'target-changed-during-operation');
    assert.deepEqual(await values(), { a: '', b: '保留B' });
  });
  await test('legacy textInput refocus cannot insert into B', async () => {
    const state = await reset();
    await run("a.addEventListener('textInput',()=>b.focus(),{once:true})");
    const result = await apply(state, 'commit', '不能串框');
    assert.equal(result.status, 'target-changed-during-operation');
    assert.ok(await run("events.some(e=>e.type==='textInput')"));
    assert.deepEqual(await values(), { a: '', b: '保留B' });
  });
  await test('post-input focus change reports dispatch without claiming rollback', async () => {
    const state = await reset();
    await run("a.addEventListener('input',()=>b.focus(),{once:true})");
    const result = await apply(state, 'commit', '写入A');
    assert.equal(result.status, 'target-changed-during-operation');
    assert.equal(result.dispatched, true);
    assert.deepEqual(await values(), { a: '写入A', b: '保留B' });
  });
  await test('navigation rejects a previous document capability', async () => {
    const state = await reset();
    await load();
    await run("a.focus();b.value='保留B'");
    rejected(await apply(state, 'commit', '旧文档'));
    assert.deepEqual(await values(), { a: '', b: '保留B' });
  });
  await test('textarea and contenteditable use native editing', async () => {
    await run("t.value='';t.focus();events=[]");
    assert.equal((await apply(await context(), 'commit', '多行\n中文')).status, 'processed');
    assert.equal(await run('t.value'), '多行\n中文');
    await run("rich.textContent='';rich.focus();events=[]");
    assert.equal((await apply(await context(), 'compose', 'ni')).status, 'processed');
    assert.equal((await apply(await context(), 'commit', '富文本')).status, 'processed');
    assert.equal(await run('rich.textContent'), '富文本');
  });

  console.log(JSON.stringify({ versions: process.versions, cases,
    nativeTargetProbePassed: true, fullNativeImePassed: false,
    physicalOsImeTested: false, multitouchTested: false, productionReady: false }, null, 2));
  clearTimeout(timeout);
  window.destroy();
  app.quit();
}).catch(error => {
  console.error(JSON.stringify({ cases, nativeTargetProbePassed: false,
    physicalOsImeTested: false, productionReady: false }));
  console.error(error);
  app.exit(1);
});

process.on('exit', () => fs.rmSync(profile, { recursive: true, force: true }));
