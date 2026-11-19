'use strict';
const { app, BrowserWindow } = require('electron');
const { createServer } = require('node:http');
const assert = require('node:assert/strict');
const { createElectronCdpOwner } = require('../../../packages/browser-cdp/src/electron/owner.cjs');

let port;
const server = createServer((request, response) => {
  response.setHeader('content-type', 'text/html');
  if (request.url === '/child') return response.end(`<input id="child"><iframe src="http://deep.test:${port}/deep"></iframe>`);
  if (request.url === '/deep') return response.end('<input id="deep">');
  if (request.url === '/next') return response.end('<h1>Replacement document</h1>');
  response.end(`<input id="first"><input id="second"><iframe src="http://frame.test:${port}/child"></iframe>
    <script>globalThis.nativeEvents=[];document.addEventListener('input',e=>nativeEvents.push({trusted:e.isTrusted,value:e.target.value}));</script>`);
});

app.whenReady().then(async () => {
  const windows = [], owners = [], failures = [];
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
    const create = async () => {
      const window = new BrowserWindow({ show: false, width: 900, height: 700,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
      windows.push(window);
      await window.loadURL('about:blank');
      const owner = createElectronCdpOwner(window.webContents, {
        initializeTarget: send => send('Emulation.setFocusEmulationEnabled', { enabled: true }),
        onFailure: error => failures.push(error),
      });
      owners.push(owner);
      return { window, owner };
    };
    const { window, owner } = await create();
    await owner.ready;
    const events = [], unsubscribe = owner.subscribe(event => events.push(event));
    await owner.send('Page.enable');
    await window.loadURL(`http://127.0.0.1:${port}/`);
    const evaluate = async (expression, sessionId) => (await owner.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    }, sessionId)).result.value;

    assert.equal(owner.targetSessions().length, 2, 'both cross-site frame targets must attach and resume');
    let child;
    for (const frame of owner.targetSessions()) {
      if (await evaluate('location.pathname', frame.sessionId) === '/child') child = frame;
    }
    assert(child, 'child target is identifiable');
    assert.equal(await evaluate('document.querySelector("#child").id', child.sessionId), 'child');
    await evaluate('document.querySelector("#first").focus()');
    await owner.send('Input.insertText', { text: 'native' });
    assert.deepEqual(await evaluate('nativeEvents'), [{ trusted: true, value: 'native' }]);
    await owner.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await owner.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    assert.equal(await evaluate('document.activeElement.id'), 'second', 'Tab runs the browser default behavior');

    const configured = owner.configure(send => send('Emulation.setDeviceMetricsOverride', {
      width: 420, height: 700, deviceScaleFactor: 1, mobile: false,
    }));
    const metrics = owner.send('Runtime.evaluate', { expression: 'innerWidth', returnByValue: true });
    await configured;
    assert.equal((await metrics).result.value, 420);

    const independent = await create(); await independent.owner.ready;
    await independent.window.loadURL(`http://127.0.0.1:${port}/next`);
    const otherTitle = await independent.owner.send('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true });
    assert.match(otherTitle.result.value, /Replacement/);
    assert.equal(await evaluate('document.querySelector("#first").value'), 'native');

    await window.loadURL(`http://127.0.0.1:${port}/next`);
    assert.equal(owner.targetSessions().length, 0);
    await assert.rejects(owner.send('Runtime.evaluate', { expression: '1' }, child.sessionId), { code: 'STALE_TARGET' });
    assert(events.some(event => event.method === 'Page.frameNavigated'));
    assert.equal(failures.length, 0);
    unsubscribe();
    console.log(`CDP_OWNER_SMOKE_OK Electron ${process.versions.electron}: native input, Tab defaults, nested cross-site frames, configuration ordering, page isolation and stale sessions`);
  } finally {
    for (const owner of owners) owner.dispose();
    for (const window of windows) window.destroy();
    server.close();
  }
}).then(() => app.exit(0), error => { console.error(error); server.close(); app.exit(1); });
