// Run with the built fork, never with the application's serving process.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const profile = mkdtempSync(join(tmpdir(), 'opencraft-electron-native-input-'));
app.setPath('userData', profile);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('ozone-platform', 'headless');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let window;

app.whenReady().then(async () => {
  window = new BrowserWindow({ width: 640, height: 480, show: false,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const wc = window.webContents;
  assert.equal(typeof wc.getNativeTextInputState, 'function',
    'This executable has no native observation API; the fork has not been built/selected.');
  // Known fixture geometry is a test input, not a production DOM adapter.
  await wc.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html>
    <style>input,textarea{position:absolute;left:40px;width:260px;height:36px;font:20px sans-serif;padding:0}
    #empty{top:40px}#filled{top:110px}textarea{top:180px;height:80px}</style>
    <input id="empty"><input id="filled" value="hello"><textarea>hello\nworld</textarea>`));
  wc.debugger.attach('1.3');
  const observations = [];
  for (const [name, x, y, offset] of [['empty', 100, 55, 0], ['end', 290, 125, 5]]) {
    await wc.debugger.sendCommand('Input.dispatchMouseEvent',
      { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await wc.debugger.sendCommand('Input.dispatchMouseEvent',
      { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    let state;
    for (let attempt = 0; attempt < 100; attempt++) {
      state = wc.getNativeTextInputState();
      if (state.active && state.selection.start === offset && state.selection.end === offset &&
          state.caretBounds?.height > 0) break;
      await delay(20);
    }
    assert.equal(state.active, true, name);
    assert.equal(state.observationOnly, true);
    assert.equal(state.coordinateSpace, 'root-viewport-dip');
    assert.equal(state.selection.start, offset, name);
    assert.equal(state.selection.end, offset, name);
    assert.ok(state.caretBounds?.height > 0, `${name}: native caret unavailable`);
    assert.ok(state.caretBounds.y >= y - 30 && state.caretBounds.y <= y + 30, name);
    assert.equal(Object.hasOwn(state, 'value'), false);
    assert.equal(Object.hasOwn(state, 'text'), false);
    observations.push({ name, state });
  }
  assert.notEqual(observations[0].state.nodeId, observations[1].state.nodeId);
  console.log(JSON.stringify({ versions: process.versions, observations,
    nativeObservationPassed: true, strictInputContractPassed: false,
    physicalOsImeTested: false, productionReady: false }, null, 2));
  app.quit();
}).catch(error => {
  console.error(error);
  app.exit(1);
});

process.on('exit', () => rmSync(profile, { recursive: true, force: true }));
