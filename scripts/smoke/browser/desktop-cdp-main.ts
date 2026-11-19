import { app, BrowserWindow, ipcMain } from 'electron';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { installBrowserGuests } from '../../../apps/desktop/src/browser-guests';
import { installBrowserAutomationIpc } from '../../../apps/desktop/src/browser-automation-ipc';

const directory = process.env.OPENCRAFT_CDP_PROBE_DIR!;
const server = createServer(async (request, response) => {
  try {
    const asset = request.url === '/client.js' ? 'client.js' : request.url === '/guest.js' ? 'guest.js' : null;
    response.setHeader('content-type', asset ? 'text/javascript' : 'text/html');
    if (asset) return response.end(await readFile(join(directory, asset)));
    if (request.url === '/guest') return response.end('<div id="root"></div><script src="/guest.js"></script>');
    if (request.url === '/next') return response.end('<h1>New document</h1><input aria-label="Fresh field">');
    response.end('<input id="outside" value="Workbench draft"><div id="root"></div><script src="/client.js"></script>');
  } catch { response.statusCode = 500; response.end(); }
});

app.whenReady().then(async () => {
  let window: BrowserWindow | undefined, foreign: BrowserWindow | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    window = new BrowserWindow({ show: true, width: 1100, height: 850, webPreferences: {
      backgroundThrottling: false, sandbox: true, contextIsolation: true,
      nodeIntegration: false, webviewTag: true, preload: join(directory, 'preload.cjs'),
    } });
    const contents = window.webContents;
    const guests = installBrowserGuests(contents);
    installBrowserAutomationIpc(ipcMain, {
      trusted: event => event.sender === contents && event.senderFrame === contents.mainFrame && event.senderFrame.url.startsWith(origin + '/'),
      guests: () => guests,
    });
    let nativeGuest: Electron.WebContents | undefined;
    contents.on('did-attach-webview', (_event, guest) => { nativeGuest = guest; });
    await window.loadURL('about:blank');
    await window.loadURL(origin);
    const result = await contents.executeJavaScript('globalThis.probe');
    assert.equal(result.ok, true); assert(nativeGuest?.debugger.isAttached());
    assert.equal(result.backend, 'electron-cdp');
    foreign = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: join(directory, 'preload.cjs') } });
    await foreign.loadURL(origin + '/next');
    const denied = await foreign.webContents.executeJavaScript(`opencraftDesktop.browser.connectAutomation(${nativeGuest!.id})`);
    assert.equal(denied.ok, false); assert.equal(denied.error.code, 'INVALID_CALLER');
    assert.equal(await nativeGuest!.executeJavaScript('typeof opencraftDesktop'), 'undefined');
    console.log(`DESKTOP_CDP_SMOKE_OK Electron ${process.versions.electron}: actual preload, owned webview IPC, React controlled input, trusted events, document leases, disposal, unowned guest and foreign caller rejection`);
  } finally { foreign?.destroy(); window?.destroy(); server.close(); }
}).then(() => app.exit(0), error => { console.error(error); server.close(); app.exit(1); });
