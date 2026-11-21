// Spike experiment: does a page-hosted annotation overlay (preload) get
// painted into the offscreen frames we encode, stay aligned while scrolling,
// and stay invisible to automation (inspect/readContext/revision)?
//
//   OPENCRAFT_ELECTRON_EXECUTABLE=/path/to/electron node scripts/smoke/browser/smoke-annotation-overlay.mjs
import assert from 'node:assert/strict';
import { mkdtemp, cp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';

const executable = process.env.OPENCRAFT_ELECTRON_EXECUTABLE;
if (!executable) throw Error('Set OPENCRAFT_ELECTRON_EXECUTABLE to a local Electron runtime');
const dir = await mkdtemp(join(tmpdir(), 'annotation-overlay-'));
await build({entryPoints:[resolve('apps/headless-server/src/remote-browser/annotation-preload.cjs')],outfile:join(dir,'annotation-preload.cjs'),bundle:true,platform:'node',format:'cjs',external:['electron']});
await build({ entryPoints: [resolve('packages/browser-preview-bridge/src/index.ts')], outfile: join(dir, 'preview-bridge.js'),
  bundle: true, platform: 'browser', format: 'iife', globalName: 'OpenCraftPreviewBridgeRuntime', logLevel: 'silent' });

// Same webPreferences as worker.cjs createPage().
await writeFile(join(dir, 'main.cjs'), String.raw`
const { app, BrowserWindow } = require('electron');
const { readFileSync } = require('fs'); const { join } = require('path');
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('ozone-platform', 'headless');
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.setPath('userData', join(__dirname, 'data'));
const bridge = readFileSync(join(__dirname, 'preview-bridge.js'), 'utf8');
const W = 800, H = 600, BLUE = [0x12, 0x8d, 0xff];
const page = '<!doctype html><title>t</title><style>body{margin:0;background:#fff}#a{position:absolute;left:100px;top:900px;width:200px;height:80px;background:#f00;border:0;padding:0}</style>' +
  '<div style="height:3000px"></div><button id="a">Target</button><p>Body text</p>';
const results = {}; const fail = e => { console.log(JSON.stringify({ error: String(e && e.stack || e) })); app.exit(1); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const http = require('http');
app.whenReady().then(async () => {
  const server = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(req.url === '/next' ? '<p>next</p>' : page); });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); const base = 'http://127.0.0.1:' + server.address().port;
  const win = new BrowserWindow({ width: W, height: H, useContentSize: true, show: true, frame: false,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, preload: join(__dirname, 'annotation-preload.cjs') } });
  const wc = win.webContents; let latest = null, paints = 0;
  wc.setFrameRate(30); wc.on('paint', (_e, _d, image) => { latest = image; paints++; });
  // Pixel at a viewport point from the most recent encoded-path frame.
  const frame = async () => { const n = paints; wc.invalidate(); for (let i = 0; i < 50 && paints === n; i++) await sleep(20); return latest.toBitmap(); };
  const px = (bmp, x, y) => { const size = latest.getSize(), i = (y * size.width + x) * 4; return [bmp[i + 2], bmp[i + 1], bmp[i]]; }; // BGRA
  const isBlue = c => Math.abs(c[0] - BLUE[0]) < 40 && Math.abs(c[1] - BLUE[1]) < 40 && Math.abs(c[2] - BLUE[2]) < 40;
  const js = code => wc.mainFrame.executeJavaScript(code);
  await wc.loadURL(base + '/');
  await js(bridge + ';(()=>{const api=OpenCraftPreviewBridgeRuntime;api.installPreviewBridgeRuntime({window,parentOrigin:location.origin});' +
    'window.__a=new api.PreviewBridgeAdapter({hostWindow:window,frameWindow:window,targetOrigin:location.origin,previewId:"p",generation:1});})()');
  const call = (m, i = {}) => js('window.__a[' + JSON.stringify(m) + '](' + JSON.stringify(i) + ')');
  results.hostBeforeAnnotation = await js('!!document.getElementById("opencraft-annotation-host")');
  const before = await call('inspect');
  await js('scrollTo(0, 700)'); await sleep(50);
  const afterScroll = await call('inspect'); // scroll alone does not mutate DOM
  const rect = await js('(()=>{const r=document.getElementById("a").getBoundingClientRect();return {x:r.left+scrollX,y:r.top+scrollY,width:r.width,height:r.height}})()');
  wc.send('opencraft:annotation', { type: 'bind', key: 'test-target', selector: '#a' });
  wc.send('opencraft:annotation', { type: 'boxes', boxes: [{ ...rect, targetKey: 'test-target' }] }); await sleep(100);
  // Viewport y of the element's top border: 900 - 700 = 200.
  let bmp = await frame();
  results.boxPaintedAtElement = isBlue(px(bmp, 200, 200)) && isBlue(px(bmp, 100, 240));
  results.hostMounted = await js('!!document.getElementById("opencraft-annotation-host")');
  results.shadowClosed = await js('document.getElementById("opencraft-annotation-host").shadowRoot === null');
  const withBox = await call('inspect');
  results.revisionStableAcrossMount = withBox.revision === afterScroll.revision;
  results.inspectExcludesOverlay = JSON.stringify(withBox.elements.map(e => e.name)) === JSON.stringify(before.elements.map(e => e.name));
  const ctx = await call('readContext');
  results.readContextUnchanged = ctx.content.includes('Target') && !ctx.content.includes('opencraft');
  // Scroll and grab the very next frame: the box must have moved with the page.
  await js('scrollTo(0, 800)'); bmp = await frame();
  // Per-frame alignment: in every painted frame during a scroll, the box's top
  // border row must sit on the red element's top row. Latency is irrelevant;
  // what matters is that viewers never see the box detached from the element.
  const isRed = c => c[0] > 200 && c[1] < 60 && c[2] < 60;
  const COL = 110; // inside the element, left of its label text
  const top = (b, test) => { for (let y = 0; y < 600; y++) if (test(px(b, COL, y))) return y; return -1; };
  const samples = [];
  for (let y = 700; y <= 1000; y += 25) {
    await js('scrollTo(0,' + y + ')'); const b = await frame();
    // Expected element top in this viewport is 900 - y. Box border is 2px
    // outside the element; red starts right under it.
    // Captured frames can trail scrollTo by a frame; alignment is judged
    // within each frame. The 2px border hugs the red element on both edges.
    const red = top(b, isRed); if (red < 0) continue;
    let last = red; while (last + 1 < 600 && isRed(px(b, COL, last + 1))) last++;
    const topOk = red < 2 || (isBlue(px(b, COL, red - 1)) && isBlue(px(b, COL, red - 2)));
    samples.push(topOk && (last === 599 || isBlue(px(b, COL, last + 1))));
  }
  results.alignedAfterScroll = samples.length >= 8 && samples.every(Boolean);
  await js('scrollTo(0, 800)'); await sleep(200);
  // Clicks pass through the overlay to the page.
  results.hitTestPassesThrough = await js('document.elementFromPoint(200, 140)?.id') === 'a';
  // Real picker through the bridge: a tap on the frame (half-size frame) at the
  // button, with the overlay box on top of it, resolves the page element.
  const picked = await call('annotatePick', { point: { x: 100, y: 70, frameWidth: 400, frameHeight: 300 } });
  const again = await call('annotatePick', { point: { x: 100, y: 70, frameWidth: 400, frameHeight: 300 } });
  results.repeatedPickReusesRef = again.anchor.ref === picked.anchor.ref;
  results.pickResolvesElement = picked.anchor.selector === 'button#a' && picked.anchor.text === 'Target' && picked.anchor.rect.y === 900;
  results.pickRefUsable = await call('click', { ref: picked.anchor.ref, expectedRevision: picked.anchor.revision }).then(() => true, () => false);
  await js('scrollTo(0, 800)'); await sleep(100); // click() scrolls the target into view
  // Labels and pending style render inside the overlay without bumping revision.
  wc.send('opencraft:annotation', { type: 'boxes', boxes: [{ ...rect, label: '1' }, { ...rect, y: rect.y + 100, pending: true }] }); await sleep(100);
  results.labelledBoxesKeepRevision = (await call('inspect')).revision === picked.anchor.revision;
  // Zoom: box stays aligned because both are laid out in CSS px.
  wc.setZoomFactor(1.5); await sleep(150);
  const z = await js('(()=>{const r=document.getElementById("a").getBoundingClientRect();return [Math.round(r.left*1.5),Math.round(r.top*1.5)]})()');
  bmp = await frame(); results.alignedAfterZoom = isBlue(px(bmp, z[0] + 60, z[1] + 1));
  wc.setZoomFactor(1); await sleep(100);
  // Page removes our host: it comes back with the same boxes.
  await js('document.getElementById("opencraft-annotation-host").remove()'); await sleep(50);
  results.remountsAfterRemoval = await js('!!document.getElementById("opencraft-annotation-host")');
  wc.send('opencraft:annotation', { type: 'clear' }); await sleep(50); bmp = await frame();
  results.clearRemovesPaint = !isBlue(px(bmp, 200, 100));
  // Agent capture path: screenshots include the boxes on purpose, so the
  // agent sees which element the user pointed at.
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Missing overlay paint acknowledgement')), 5000);
    const onReply = (_event, channel, id) => {
      if (channel !== 'opencraft:annotation-applied' || id !== 'capture-test') return;
      clearTimeout(timer); wc.removeListener('ipc-message', onReply); resolve();
    };
    wc.on('ipc-message', onReply);
    wc.send('opencraft:annotation', { type: 'boxes', boxes: [rect], requestId: 'capture-test' });
  });
  results.overlayPaintAcknowledged = true;
  const cap = await wc.capturePage(); const cb = cap.toBitmap(), cw = cap.getSize().width;
  results.capturePageIncludesOverlay = (() => { const i = (100 * cw + 200) * 4; return isBlue([cb[i + 2], cb[i + 1], cb[i]]); })();
  // Navigation drops the overlay along with the document.
  await wc.loadURL(base + '/next');
  results.overlayGoneAfterNavigation = !(await js('!!document.getElementById("opencraft-annotation-host")'));
  wc.send('opencraft:annotation', { type: 'boxes', boxes: [{ x: 10, y: 10, width: 50, height: 20 }] }); await sleep(50);
  results.preloadActiveAfterNavigation = await js('!!document.getElementById("opencraft-annotation-host")');
  console.log(JSON.stringify(results)); app.exit(0);
}).catch(fail);
`);

const child = spawn(executable, ['--no-sandbox', '--ozone-platform=headless', '--ozone-override-screen-size=1920,1080', '--disable-gpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage', join(dir, 'main.cjs')],
  { env: { ...process.env, ELECTRON_RUN_AS_NODE: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
let out = ''; child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { if (process.env.DEBUG) process.stderr.write(d); });
const code = await new Promise(r => child.on('exit', r));
await rm(dir, { recursive: true, force: true });
const line = out.trim().split('\n').filter(l => l.startsWith('{')).pop();
assert.ok(line, `no result (exit ${code})`);
const results = JSON.parse(line);
if (results.error) throw Error(results.error);
console.table(results);
for (const [k, v] of Object.entries(results)) assert.equal(v, k === 'hostBeforeAnnotation' ? false : true, k);
console.log('annotation overlay spike: ok');
