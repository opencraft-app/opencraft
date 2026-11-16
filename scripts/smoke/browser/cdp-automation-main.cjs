'use strict';
const { app, BrowserWindow } = require('electron');
const { createServer } = require('node:http');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const { createElectronCdpOwner } = require('../../../packages/browser-cdp/src/electron/owner.cjs');
const { createCdpAutomation } = require('../../../packages/browser-cdp/src/automation/index.cjs');

let port;
const events = `<script>globalThis.events=[];for(const type of ['input','click','keydown'])document.addEventListener(type,e=>events.push({type,id:e.target.id,trusted:e.isTrusted,x:e.clientX,y:e.clientY}));</script>`;
const server = createServer((request, response) => {
  response.setHeader('content-type', 'text/html');
  if (request.url === '/same') return response.end(`<input id="same" aria-label="Same frame"><button id="sameButton">Same button</button>${events}`);
  if (request.url === '/child') return response.end(`<input id="child" aria-label="Child field"><button id="childButton">Child button</button><iframe style="display:block;width:250px;height:140px" src="http://deep.test:${port}/deep"></iframe>${events}`);
  if (request.url === '/deep') return response.end(`<input id="deep" aria-label="Deep field"><button id="deepButton">Deep button</button>${events}`);
  if (request.url === '/next') return response.end('<h1>Replacement document</h1>');
  response.end(`<style>iframe{border:3px solid black;width:340px;height:260px}body{margin:20px}</style>
    <input id="first" aria-label="First field"><input id="second" aria-label="Second field">
    <button id="save">Save</button><input id="credential" type="password" value="do-not-expose">
    <div id="shadow"></div><div id="editable" contenteditable aria-label="Draft">old draft</div>
    <form onsubmit="event.preventDefault();document.querySelector('#submitted').textContent='Form submitted:'+event.isTrusted"><input aria-label="Submit field"><button>Go</button></form><output id="submitted"></output>
    <iframe src="/same"></iframe><iframe id="cross" src="http://frame.test:${port}/child"></iframe>
    <div style="height:1400px">Tall page</div>${events}
    <script>shadow.attachShadow({mode:'open'}).innerHTML='<button id="shadowButton">Shadow button</button>';
    globalThis.renders=[];first.addEventListener('input',()=>{renders.push(first.value);});</script>`);
});

app.whenReady().then(async () => {
  let window, owner, automation;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); port = server.address().port;
    window = new BrowserWindow({ show: true, width: 1100, height: 850,
      webPreferences: { offscreen: true, backgroundThrottling: false, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await window.loadURL('about:blank');
    owner = createElectronCdpOwner(window.webContents, { initializeTarget: send => send('Emulation.setFocusEmulationEnabled', { enabled: true }) });
    await owner.ready;
    await owner.configure(send => send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 850, deviceScaleFactor: 1, mobile: false }));
    automation = createCdpAutomation({ transport: owner, sessions: () => owner.targetSessions(), instanceId: randomUUID(), platform: process.platform, acquireDrawing() { window.webContents.startPainting(); return () => {}; } });
    await window.loadURL(`http://127.0.0.1:${port}/`);
    const evaluate = async (expression, session) => (await owner.send('Runtime.evaluate', { expression, returnByValue: true }, session)).result.value;
    let inspection = await automation.inspect();
    const find = name => {
      const element = inspection.elements.find(element => element.name === name);
      assert(element, `Inspection must include ${name}`); return { ref: element.ref, expectedRevision: inspection.revision };
    };
    const original = find('First field');
    assert(find('Same frame')); assert(find('Child field')); assert(find('Deep field')); assert(find('Shadow button'));
    assert(!JSON.stringify(inspection).includes('do-not-expose'));
    assert(!(await automation.readContext()).content.includes('do-not-expose'));
    // Inspecting again and unrelated DOM mutations preserve references.
    await automation.inspect();
    await evaluate('document.body.append(document.createElement("p"))');
    await automation.fill({ ...original, value: '  native draft  ' });
    assert.equal(await evaluate('first.value'), '  native draft  ');
    assert.deepEqual(await evaluate('renders'), ['  native draft  ']);
    await automation.fill({ ...original, value: 'replacement' });
    assert.equal(await evaluate('first.value'), 'replacement', 'fill replaces existing value');
    await automation.fill({ ...original, value: '' });
    assert.equal(await evaluate('first.value'), '', 'empty fill deletes selection');
    await automation.press({ key: 'Tab' });
    assert.equal(await evaluate('document.activeElement.id'), 'second');
    await automation.fill({ ...find('Submit field'), value: 'submit by keyboard' });
    await automation.press({ key: 'Enter' });
    await automation.wait({ text: 'Form submitted:true', timeoutMs: 2000 });
    for (const name of ['Save', 'Shadow button', 'Same button', 'Child button', 'Deep button']) {
      console.log(`click ${name}`); await automation.click(find(name));
    }
    for (const name of ['Same frame', 'Child field', 'Deep field', 'Draft']) {
      console.log(`fill ${name}`); await automation.fill({ ...find(name), value: `native ${name}` });
    }
    assert.equal(await evaluate('frames[0].document.querySelector("#same").value'), 'native Same frame');
    assert.equal(await evaluate('frames[0].events.filter(e=>e.type==="click"&&e.id==="sameButton").length'), 1);
    for (const target of owner.targetSessions()) {
      const path = await evaluate('location.pathname', target.sessionId), id = path === '/deep' ? 'deep' : 'child';
      assert.equal(await evaluate(`document.querySelector('#${id}').value`, target.sessionId), `native ${id === 'deep' ? 'Deep' : 'Child'} field`);
      assert.equal(await evaluate(`events.filter(e=>e.type==='click'&&e.id==='${id}Button').length`, target.sessionId), 1);
    }
    assert.equal(await evaluate('editable.textContent'), 'native Draft');
    for (const target of [{ sessionId: undefined }, ...owner.targetSessions()]) {
      assert((await evaluate('events', target.sessionId)).every(event => event.trusted));
    }
    const credential = inspection.elements.find(element => element.value?.includes('redacted'));
    assert(credential);
    await assert.rejects(automation.fill({ ref: credential.ref, expectedRevision: inspection.revision, value: 'blocked' }), { code: 'POLICY_BLOCKED', outcome: 'not-dispatched' });
    await evaluate('save.outerHTML="<button id=save>Save</button>"');
    await assert.rejects(automation.click(find('Save')), { code: 'STALE_REF' });
    await evaluate('first.setAttribute("aria-label","Changed meaning")');
    await assert.rejects(automation.fill({ ...original, value: 'blocked' }), { code: 'STALE_REF' });

    // Ancestor overlays must not turn a child-frame click into a different click.
    await evaluate('const cover=document.createElement("div");cover.id="cover";cover.style="position:fixed;inset:0;z-index:999;background:white";document.body.append(cover)');
    await assert.rejects(automation.click(find('Deep button')), { code: 'ELEMENT_OBSCURED' });
    await evaluate('cover.remove()');
    await window.webContents.setZoomFactor(1.25);
    inspection = await automation.inspect();
    await automation.click(find('Save')); await automation.click(find('Same button'));
    await automation.click(find('Child button')); await automation.click(find('Deep button'));
    await window.webContents.setZoomFactor(1);
    await evaluate('document.querySelector("#cross").style.transform="scale(0.85) rotate(5deg)"');
    await automation.click(find('Save')); await automation.click(find('Same button'));
    await automation.click(find('Child button')); await automation.click(find('Deep button'));
    await owner.configure(send => send('Emulation.setDeviceMetricsOverride', { width: 430, height: 932, deviceScaleFactor: 1, mobile: true }));
    await automation.click(find('Save')); await automation.click(find('Same button'));
    await automation.click(find('Child button')); await automation.click(find('Deep button'));
    assert.equal(await evaluate('events.filter(e=>e.type==="click"&&e.id==="save").length'), 4);
    assert.equal(await evaluate('frames[0].events.filter(e=>e.type==="click"&&e.id==="sameButton").length'), 4);
    for (const target of owner.targetSessions()) {
      const id = await evaluate('location.pathname', target.sessionId) === '/deep' ? 'deep' : 'child';
      assert.equal(await evaluate(`events.filter(e=>e.type==='click'&&e.id==='${id}Button').length`, target.sessionId), 4);
    }
    await owner.configure(send => send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 850, deviceScaleFactor: 1, mobile: false }));
    await automation.scroll({ x: 0, y: 500 });
    assert(await evaluate('scrollY > 0'), 'native wheel must scroll the actual page');
    await automation.wait({ text: 'Tall page', timeoutMs: 2000 });
    let valid = true;
    const guarded = automation.invoke('wait', { text: 'never appears', timeoutMs: 2000 }, { validate() { if (!valid) throw Object.assign(new Error('Control revoked'), { code: 'CONTROL_LOST' }); } });
    setTimeout(() => { valid = false; }, 40);
    await assert.rejects(guarded, { code: 'CONTROL_LOST' });
    const oldChild = find('Deep button'), stableRoot = find('Save');
    await owner.send('Runtime.evaluate', { expression: 'new Promise(resolve=>{cross.onload=()=>resolve(true);cross.src="/next"})', awaitPromise: true, returnByValue: true });
    await assert.rejects(automation.click(oldChild), { code: 'STALE_REF' });
    await automation.click(stableRoot);
    await window.loadURL(`http://127.0.0.1:${port}/next`);
    await assert.rejects(automation.click(original), { code: 'STALE_REF' });
    automation.dispose();
    await assert.rejects(automation.inspect(), { code: 'PAGE_CLOSED' });
    console.log(`CDP_AUTOMATION_SMOKE_OK Electron ${process.versions.electron}: native events, fill replacement, stable references, isolated worlds, shadow DOM, same-process and nested cross-site frames, zoom, overlays, sensitive controls and navigation`);
  } finally {
    automation?.dispose(); owner?.dispose(); window?.destroy(); server.close();
  }
}).then(() => app.exit(0), error => { console.error(error); server.close(); app.exit(1); });
