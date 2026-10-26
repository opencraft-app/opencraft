// Native OSR input regression. DOM access belongs only to the local fixture and
// assertions; input routing and editing use Chromium's native APIs.
const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { initializeNativeFocus } = require('../../scripts/remote-browser/focus.cjs');

const profile = mkdtempSync(join(tmpdir(), 'opencraft-oopif-input-'));
app.setPath('userData', profile);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('site-per-process');
app.commandLine.appendSwitch('disable-features', 'SyntheticPointerActions');
let window, server, disposeFocus;
const cases = [], errors = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = setTimeout(() => { console.error('OSR OOPIF input probe timed out'); app.exit(1); }, 30000);

function fixture(child, port) {
  return `<!doctype html><meta charset="utf-8"><style>
  body{margin:0;${child ? 'min-height:2400px;background:rgb(214,255,224);' : ''}}
  input{position:absolute;left:20px;top:20px;width:300px;height:40px;font-size:20px}
  iframe{position:absolute;left:20px;top:240px;width:600px;height:210px;border:0}
  #drag{position:absolute;left:360px;top:20px;width:180px;height:80px;touch-action:none}
  </style><input id="field">${child ? '<div id="drag">Capture target</div>' : ''}${child ? '' : `<iframe src="http://localhost:${port}/child"></iframe>`}
  <script>window.events=[];
  for(const type of ['touchstart','mousedown','keydown','keyup','pointerdown','pointermove','pointerup','input'])addEventListener(type,e=>events.push({
    type,target:e.target.id,trusted:e.isTrusted,key:e.key,pointerId:e.pointerId,
    x:e.touches?.[0]?.clientX??e.clientX,y:e.touches?.[0]?.clientY??e.clientY}));
  if(document.getElementById('drag'))drag.addEventListener('pointerdown',e=>drag.setPointerCapture(e.pointerId));</script>`;
}

async function until(read, accept, label) {
  const expires = Date.now() + 5000;
  while (Date.now() < expires) {
    const result = await read();
    if (accept(result)) return result;
    await delay(10);
  }
  throw new Error(label);
}

app.whenReady().then(async () => {
  await session.defaultSession.setProxy({ mode: 'direct' });
  server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(fixture(request.url === '/child', server.address().port));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  window = new BrowserWindow({ width: 720, height: 540, frame: false, show: false,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const wc = window.webContents;
  wc.on('render-process-gone', (_event, detail) => errors.push(detail));
  await wc.loadURL('about:blank');
  disposeFocus = await initializeNativeFocus(wc, () => errors.push('Native frame focus initialization failed'));
  await wc.loadURL(`http://127.0.0.1:${server.address().port}/`);
  assert.deepEqual(await wc.executeJavaScript('({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})'),
    { width: 720, height: 540, dpr: 1 }, 'Pass the documented headless screen and scale flags');
  const child = wc.mainFrame.frames.find(frame => frame.url.includes('localhost'));
  assert(child, 'Cross-site fixture frame must load');
  assert.notEqual(child.processId, wc.mainFrame.processId, 'Fixture must use a real OOPIF');
  assert.equal(typeof child.getNativeImeContextForTesting, 'function', 'The owned native IME fork is required');
  await wc.debugger.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 10 });
  const read = code => child.executeJavaScript(code);

  for (const transformed of [false, true]) {
    await wc.executeJavaScript(`document.querySelector('iframe').style.transform=${JSON.stringify(transformed ? 'translate(30px,15px) scale(.75)' : '')};document.querySelector('iframe').style.transformOrigin='0 0'`);
    // Fixture DOM layout can precede the displayed compositor frame. Wait for
    // the actual native readback, rather than injecting at future coordinates.
    await until(async () => {
      try {
        const image = await wc.capturePage();
        const size = image.getSize(), bitmap = image.toBitmap();
        const at = (242 * size.width + 22) * 4;
        return { size, green: bitmap[at] === 224 && bitmap[at + 1] === 255 && bitmap[at + 2] === 214 };
      } catch { return null; }
    }, result => result && result.size.width === 720 && result.size.height === 540
      && result.green === !transformed, 'Native compositor must display the fixture transform');
    for (const type of ['touch', 'mouse', 'electron-mouse']) {
      await read("field.value='';events=[];document.activeElement.blur();scrollTo(0,0)");
      const point = transformed ? { x: 110, y: 285 } : { x: 100, y: 280 };
      if (type === 'touch') {
        await wc.debugger.sendCommand('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 0, ...point }] });
        await wc.debugger.sendCommand('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      } else if (type === 'electron-mouse') {
        wc.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, modifiers: ['leftButtonDown'], ...point });
        wc.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
      } else {
        await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
        await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
      }
      const event = await until(() => read(`events.find(event=>event.type===${JSON.stringify(type === 'touch' ? 'touchstart' : 'mousedown')})`), Boolean,
        'Root input must reach the cross-site frame');
      assert.equal(event.target, 'field');
      assert.equal(event.trusted, true);
      assert(Math.abs(event.x - 80) < 1 && Math.abs(event.y - 40) < 1, JSON.stringify(event));
      assert.equal(wc.focusedFrame, child);
      const context = await until(() => child.getNativeImeContextForTesting(), result => result.available, 'Native child editor context unavailable');
      const result = await child.applyNativeImeForTesting({ token: context.token, compositionId: context.compositionId,
        type: 'commit', text: '原生输入', selectionStart: 4, selectionEnd: 4 });
      assert.equal(result.status, 'processed');
      assert.equal(await read('field.value'), '原生输入');
      assert.equal(await wc.executeJavaScript('field.value'), '');
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Left' });
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'Left' });
      const key = await until(() => read("events.find(event=>event.type==='keydown'&&event.key==='ArrowLeft')"),
        Boolean, 'Electron keyboard input must reach the focused cross-site frame');
      assert.equal(key.target, 'field');
      assert.equal(key.trusted, true);
      assert.deepEqual(await read('({start:field.selectionStart,end:field.selectionEnd})'),
        { start: 3, end: 3 });
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] });
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] });
      await until(() => read('({start:field.selectionStart,end:field.selectionEnd})'),
        range => range.start === 0 && range.end === 4, 'Native Ctrl+A must select child text');
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' });
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' });
      await until(() => read('field.value'), value => value === '', 'Native Backspace must edit child text');
      assert.equal(await wc.executeJavaScript('field.value'), '');
      cases.push({ type, transformed, event, nativeIme: true, keyboard: key, nativeSelectDelete: true });
    }
  }
  // Keep the displayed transform from the final case: child (380,60) maps
  // to root (335,300). Capture must retain this child after leaving its surface.
  await read('events=[]');
  wc.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, modifiers: ['leftButtonDown'], x: 335, y: 300 });
  await until(() => read("events.some(event=>event.type==='pointerdown'&&event.target==='drag'&&drag.hasPointerCapture(event.pointerId))"),
    Boolean, 'Native child pointer capture was not established');
  wc.sendInputEvent({ type: 'mouseMove', button: 'left', modifiers: ['leftButtonDown'], x: 680, y: 480 });
  wc.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: 680, y: 480 });
  const captured = await until(() => read("events.find(event=>event.type==='pointerup'&&event.target==='drag')"),
    Boolean, 'Mouse release outside iframe must reach the captured child');
  assert.equal(captured.trusted, true);
  cases.push({ type: 'electron-mouse-capture', event: captured });
  await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 450, y: 340, deltaX: 0, deltaY: 180 });
  const scrollY = await until(() => read('scrollY'), value => value > 0, 'Wheel must scroll the cross-site child');
  cases.push({ type: 'wheel', childScrollY: scrollY });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, cases, errors, physicalOsIme: false }));
}).catch(error => { console.error(JSON.stringify({ completedCases: cases, errors })); console.error(error); process.exitCode = 1; }).finally(async () => {
  clearTimeout(deadline);
  disposeFocus?.();
  window?.destroy();
  if (server) await new Promise(resolve => server.close(resolve));
  rmSync(profile, { recursive: true, force: true });
  app.exit(process.exitCode || 0);
});
