// DOM access here is fixture setup/assertion only. Actual copy dispatch,
// selection validation and clipboard data capture use native Chromium APIs.
const { app, BrowserWindow, clipboard, ClipboardItem } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const profile = fs.mkdtempSync(join(tmpdir(), 'opencraft-native-copy-'));
app.setPath('userData', profile);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('ozone-platform', 'headless');
app.commandLine.appendSwitch('site-per-process');
app.commandLine.appendSwitch('opencraft-remote-clipboard');
let window;
const cases = [];
const timeout = setTimeout(() => { console.error('Native clipboard probe timed out'); app.exit(1); }, 60000);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const fixture = `<!doctype html><meta charset="utf-8"><input id="a" value="输入中文A"><input id="b" value="保留B">
<input id="secret" type="password" value="must-not-export"><textarea id="t">多行中文</textarea>
<div id="rich" contenteditable>编辑<b>加粗</b>内容</div><p id="body">正文<b>选择</b>中文</p>
<script>window.cleanup=()=>{};window.copies=[];document.addEventListener('copy',e=>copies.push({trusted:e.isTrusted,target:e.target.id}));</script>`;
app.whenReady().then(async () => {
  window = new BrowserWindow({ show: false, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const wc = window.webContents;
  assert.equal(typeof wc.mainFrame.getNativeClipboardContextForTesting, 'function', 'Stock Electron cannot pass the native clipboard probe');
  assert.equal(typeof wc.mainFrame.copyNativeClipboardForTesting, 'function');
  wc.debugger.attach('1.3');
  const run = code => wc.executeJavaScript(code);
  async function load() {
    await wc.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(fixture));
    await wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
  }
  async function context() {
    for (let i = 0; i < 50; i++) {
      const value = await wc.focusedFrame?.getNativeClipboardContextForTesting();
      if (value?.available) {
        assert.equal(Object.hasOwn(value, 'text'), false);
        assert.equal(Object.hasOwn(value, 'html'), false);
        return { frame: wc.focusedFrame, token: value.token };
      }
      await delay(10);
    }
    throw new Error('Native copy selection unavailable');
  }
  const copy = state => state.frame.copyNativeClipboardForTesting(state.token);
  async function reset(code = 'a.focus();a.select()') { await run('cleanup();cleanup=()=>{};copies=[];' + code); return context(); }
  async function test(name, fn) { await fn(); cases.push({ name, passed: true }); }
  await clipboard.write([new ClipboardItem({ 'text/plain': new Blob(['host-sentinel'], { type: 'text/plain' }) })]);
  await load();
  await test('native input copy is trusted and leaves host clipboard untouched', async () => {
    const result = await copy(await reset());
    assert.equal(result.status, 'ok'); assert.equal(result.text, '输入中文A');
    assert.equal((await run('copies'))[0].trusted, true);
    assert.equal(await clipboard.readText(), 'host-sentinel');
  });
  await test('one-shot context rejects replay', async () => {
    const state = await reset(); assert.equal((await copy(state)).status, 'ok');
    const rejected = await copy(state); assert.equal(rejected.status, 'stale-context'); assert.equal(rejected.dispatched, false);
  });
  await test('body and contenteditable copy preserve native text and HTML', async () => {
    for (const id of ['body', 'rich']) {
      const state = await reset(`document.activeElement.blur();var range=document.createRange();range.selectNodeContents(${id});getSelection().removeAllRanges();getSelection().addRange(range)`);
      const result = await copy(state); assert.equal(result.status, 'ok');
      assert(result.text.includes(id === 'body' ? '正文' : '编辑'));
      assert.equal(await run(`new DOMParser().parseFromString(${JSON.stringify(result.html)}, 'text/html').querySelector('b')?.textContent`), id === 'body' ? '选择' : '加粗');
    }
  });
  await test('textarea follows native copy', async () => {
    const result = await copy(await reset('t.focus();t.select()'));
    assert.equal(result.status, 'ok'); assert.equal(result.text, '多行中文');
  });
  await test('website copy handler controls final text and HTML', async () => {
    const state = await reset();
    await run(`let handler=e=>{e.preventDefault();e.clipboardData.setData('text/plain','网站最终结果');e.clipboardData.setData('text/html','<b>网站最终结果</b>')};a.addEventListener('copy',handler);cleanup=()=>a.removeEventListener('copy',handler);undefined`);
    const result = await copy(state); assert.equal(result.status, 'ok');
    assert.equal(result.text, '网站最终结果'); assert.equal(result.html, '<b>网站最终结果</b>');
  });
  await test('preventDefault with no data is not a successful copy', async () => {
    const state = await reset(); await run("a.addEventListener('copy',e=>e.preventDefault(),{once:true})");
    const result = await copy(state); assert.equal(result.status, 'no-data'); assert.equal(Object.hasOwn(result, 'text'), false);
  });
  await test('an unrelated DOM update in a copy handler preserves the native copy', async () => {
    const state = await reset();
    await run("a.addEventListener('copy',()=>{const toast=document.createElement('aside');toast.textContent='Copied';document.body.append(toast)},{once:true})");
    const result = await copy(state); assert.equal(result.status, 'ok'); assert.equal(result.text, '输入中文A');
  });
  await test('unsupported custom formats fail without replacing host clipboard', async () => {
    const state = await reset();
    await run("a.addEventListener('copy',e=>{e.preventDefault();e.clipboardData.setData('application/x-custom','private')},{once:true})");
    const result = await copy(state); assert.equal(result.status, 'unsupported-format');
    assert.equal(await clipboard.readText(), 'host-sentinel');
  });
  await test('selection A to B to A invalidates the native capability', async () => {
    const state = await reset(); await run('a.setSelectionRange(0,1);a.select()');
    const result = await copy(state); assert.equal(result.status, 'stale-context'); assert.equal(result.dispatched, false);
  });
  await test('focus round trip rejects a stale context', async () => {
    const state = await reset(); await run('b.focus();a.focus();a.select()');
    assert.equal((await copy(state)).status, 'stale-context');
  });
  await test('copy handler refocus returns no clipboard payload', async () => {
    const state = await reset(); await run("a.addEventListener('copy',()=>b.focus(),{once:true})");
    const result = await copy(state); assert.equal(result.status, 'stale-context'); assert.equal(result.dispatched, true);
    assert.equal(Object.hasOwn(result, 'text'), false); assert.equal(await run('b.value'), '保留B');
  });
  await test('password selection has no copy capability', async () => {
    await run('secret.focus();secret.select()');
    assert.equal((await wc.focusedFrame.getNativeClipboardContextForTesting()).available, false);
  });
  await test('document replacement invalidates a captured context', async () => {
    const state = await reset(); await load(); await run('a.focus();a.select()');
    const result = await wc.mainFrame.copyNativeClipboardForTesting(state.token);
    assert.equal(result.status, 'stale-context'); assert.equal(result.dispatched, false);
  });
  await test('same-origin child frame copies through its own native endpoint', async () => {
    await run(`let child=document.createElement('iframe');child.srcdoc='<input id="childInput" value="子页面中文">';document.body.append(child);new Promise(resolve=>child.onload=()=>resolve())`);
    const child = wc.mainFrame.frames[0];
    await child.executeJavaScript('childInput.focus();childInput.select()');
    const native = await child.getNativeClipboardContextForTesting(); assert.equal(native.available, true);
    const result = await child.copyNativeClipboardForTesting(native.token); assert.equal(result.status, 'ok'); assert.equal(result.text, '子页面中文');
  });
  assert.equal(await clipboard.readText(), 'host-sentinel');
  console.log(JSON.stringify({ versions: process.versions, cases, nativeCopyProbePassed: true,
    physicalDesktopMenuTested: false, physicalTouchTested: false, productionReady: false }, null, 2));
  clearTimeout(timeout); window.destroy(); app.quit();
}).catch(error => { console.error(JSON.stringify({ cases, nativeCopyProbePassed: false })); console.error(error); app.exit(1); });
process.on('exit', () => fs.rmSync(profile, { recursive: true, force: true }));
