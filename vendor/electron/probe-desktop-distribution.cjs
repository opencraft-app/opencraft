// Cross-platform native fork smoke probe. Run this with the built Electron
// executable, never with the application's serving process.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const profile = mkdtempSync(join(tmpdir(), 'opencraft-electron-desktop-probe-'));
app.setPath('userData', profile);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('site-per-process');
let window;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  const show = process.env.OPENCRAFT_ELECTRON_PROBE_HIDDEN !== '1';
  window = new BrowserWindow({ width: 640, height: 480, show, webPreferences: {
    offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false,
  } });
  const wc = window.webContents;
  assert.equal(typeof wc.getNativeTextInputState, 'function', 'native text-input API missing');
  assert.equal(typeof wc.mainFrame.getNativeClipboardContextForTesting, 'function', 'native clipboard API missing');
  assert.equal(typeof wc.mainFrame.getNativeImeContextForTesting, 'function', 'native IME API missing');
  await wc.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
    '<!doctype html><input id="editor" value="desktop probe">',
  ));
  if (show) {
    window.focus();
    wc.focus();
  }
  await wc.executeJavaScript('editor.focus();editor.setSelectionRange(editor.value.length, editor.value.length)');
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = wc.getNativeTextInputState();
    if (state.active && state.selection.start === 13 && state.selection.end === 13
        && state.caretBounds?.height > 0) {
      assert.equal(state.observationOnly, true);
      assert.equal(Object.hasOwn(state, 'value'), false);
      assert.equal(Object.hasOwn(state, 'text'), false);
      console.log(JSON.stringify({
        versions: process.versions,
        nativeProbePassed: true,
        capabilities: {
          textInputObservation: true,
          nativeClipboard: true,
          nativeIme: true,
      },
      }));
      app.quit();
      return;
    }
    await delay(20);
  }
  throw new Error('native editor state did not become available');
}).catch(error => {
  console.error(error);
  app.exit(1);
});

process.on('exit', () => rmSync(profile, { recursive: true, force: true }));
