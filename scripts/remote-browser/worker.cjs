// Separate Electron main process. No public listener or application UI.
const { app, BrowserWindow, ipcMain, session } = require('electron');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');
const { createInterface } = require('node:readline');
const { installClipboard } = require('./clipboard.cjs');
const { installIme } = require('./ime.cjs');
const { initializeNativeFocus } = require('./focus.cjs');
const { createControls } = require('./controls.cjs');
const { isTouchInput, createTouchInput, createWidgetTouchDispatcher, createWidgetWheelDispatcher, MAX_TOUCH_POINTS } = require('./touch.cjs');
app.commandLine.appendSwitch('opencraft-remote-clipboard');
// Keep per-contact release semantics stable on our pinned Chromium runtime.
app.commandLine.appendSwitch('disable-features', 'SyntheticPointerActions');
const ipc = typeof process.send === 'function';
let dispatch;
// CSS pixels, independent of the viewer's devicePixelRatio. Bound software
// surfaces to H.264 level 4's 8192 macroblocks, including portrait windows.
function viewport(input = {}) {
  if (input.width === undefined && input.height === undefined) return { width: 1280, height: 720 };
  if (!Number.isFinite(input.width) || !Number.isFinite(input.height) || input.width <= 0 || input.height <= 0) throw new Error('Invalid viewport');
  const scale = Math.min(1, 4096 / input.width, 4096 / input.height, Math.sqrt(2097152 / (input.width * input.height)));
  let width = Math.max(64, Math.round(input.width * scale / 2) * 2), height = Math.max(64, Math.round(input.height * scale / 2) * 2);
  while (Math.ceil(width / 16) * Math.ceil(height / 16) > 8192) {
    if (width >= height) width -= 2; else height -= 2;
  }
  return { width, height };
}
const deviceProfiles = new Set(['desktop', 'iphone', 'ipad', 'android-phone', 'android-tablet', 'desktop-touch']);
function deviceProfile(input = {}) {
  const profile = input.deviceProfile ?? 'desktop';
  if (!deviceProfiles.has(profile)) throw new Error('Invalid device profile');
  return profile;
}
const configuration = p => ({ document: p.document, navigation: navigation(p), width: p.width, height: p.height, zoom: Math.round(p.window.webContents.getZoomFactor() * 100), dpr: 1, deviceProfile: p.deviceProfile, codec: 'avc1.42E028', nativeCopy: p.clipboard?.available() === true, nativeIme: p.ime?.available() === true, multiTouch: true, touchTiming: true, productionDemand: 1, mediaBuckets: 2, production: p.productionStats ?? null });
function userAgent(p, profile) {
  const chrome = process.versions.chrome;
  if (profile === 'iphone') return 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
  if (profile === 'ipad') return 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
  if (profile.startsWith('android-')) return `Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome}${profile === 'android-phone' ? ' Mobile' : ''} Safari/537.36`;
  return p.desktopUserAgent;
}
async function emulateDevice(p, size, profile) {
  const wc = p.window.webContents;
  if (profile === 'desktop' && !wc.debugger.isAttached()) return;
  if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
  // This debugger is private to the worker. Clients select a bounded profile,
  // never CDP commands, JavaScript, or arbitrary UA/header overrides.
  const command = (method, input) => wc.debugger.sendCommand(method, input);
  if (profile !== p.deviceProfile || !p.deviceConfigured) {
    const android = profile.startsWith('android-'), ios = profile === 'iphone' || profile === 'ipad';
    const ua = userAgent(p, profile);
    const platform = ios ? (profile === 'iphone' ? 'iPhone' : 'iPad') : android ? 'Linux armv8l' : p.desktopPlatform;
    const metadata = { brands: [{brand:'Chromium',version:process.versions.chrome.split('.')[0]}],
      fullVersionList: [{brand:'Chromium',version:process.versions.chrome}], fullVersion:process.versions.chrome,
      platform:ios?'iOS':android?'Android':p.desktopPlatformName, platformVersion:ios?'18.0.0':android?'14.0.0':'',
      architecture:ios||android?'arm':process.arch === 'arm64'?'arm':'x86', bitness:'64', model:'', mobile:ios||profile === 'android-phone' };
    wc.setUserAgent(ua);
    await command('Emulation.setUserAgentOverride', {userAgent:ua,platform,userAgentMetadata:metadata});
  }
  const mobile = !['desktop','desktop-touch'].includes(profile), touch = profile !== 'desktop';
  if (mobile) await command('Emulation.setDeviceMetricsOverride', {
    ...size, screenWidth:size.width, screenHeight:size.height, deviceScaleFactor:1, mobile:true, scale:1,
    screenOrientation:{type:size.width > size.height?'landscapePrimary':'portraitPrimary',angle:size.width > size.height?90:0} });
  else await command('Emulation.clearDeviceMetricsOverride');
  await command('Emulation.setTouchEmulationEnabled', {enabled:touch,maxTouchPoints:MAX_TOUCH_POINTS});
  // Electron's injected mouse events bypass Chromium's mouse-to-touch hook.
  // The bounded input adapter below emits actual touch sequences instead.
  p.deviceConfigured = true;
}
function resize(p, input = {}) {
  // A single writer orders rapid preset/rotation changes and navigation against
  // the effective device state, including changes with identical pixel sizes.
  const size = viewport(input), profile = deviceProfile(input);
  const operation = (p.viewportQueue ?? Promise.resolve()).then(async () => {
    if (p.closed) throw new Error('Browser page closed');
    if (size.width === p.width && size.height === p.height && profile === p.deviceProfile) return configuration(p);
    await p.touch.reset();
    const previous = {width:p.width,height:p.height}, previousProfile = p.deviceProfile;
    p.reconfiguring = true; p.epoch = randomUUID(); p.inFlight = false; p.key = true;
    clearTimeout(p.mergeTimer); p.mergeUntil = 0; p.pending = p.previous = p.latest = null;
    releaseStreams(p);
    try {
      p.window.setContentSize(size.width, size.height);
      await emulateDevice(p, size, profile);
      Object.assign(p, size, {deviceProfile:profile});
    } catch (error) {
      p.window.setContentSize(previous.width, previous.height);
      p.deviceConfigured = false;
      await emulateDevice(p, previous, previousProfile).catch(() => {});
      throw error;
    } finally { p.reconfiguring = false; }
    // Same WebContents/DOM. Announce before the new epoch's first keyframe.
    send({ type: 'viewport', page: p.id, ...configuration(p) });
    if (p.visible) { activity(p); p.window.webContents.invalidate(); }
    return configuration(p);
  });
  p.viewportQueue = operation.catch(() => {});
  return operation;
}
const pages = new Map();
let encoderWindow, encoderReady = false;
const bridge = readFileSync(join(__dirname, 'preview-bridge.js'), 'utf8');
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('ozone-platform', 'headless');
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.setPath('userData', process.env.OPENCRAFT_BROWSER_DATA_DIR);
const connected = () => ipc ? process.connected : !process.stdout.destroyed;
const send = (message, callback) => {
  if (!connected()) return;
  if (ipc) process.send(message, callback);
  else process.stdout.write(JSON.stringify(message) + '\n', callback);
};
const validUrl = value => { const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Unsupported browser URL'); return url.href; };
function diffArea(a, b, width, height) {
  if (!a || a.length !== b.length) return width * height;
  const x = new Uint32Array(a.buffer, a.byteOffset, a.length / 4), y = new Uint32Array(b.buffer, b.byteOffset, b.length / 4);
  let left = width, right = -1, top = height, bottom = -1;
  for (let row = 0; row < height; row++) {
    const offset = row * width; let lo = 0, hi = width - 1;
    while (lo < width && x[offset + lo] === y[offset + lo]) lo++;
    if (lo === width) continue;
    while (hi > lo && x[offset + hi] === y[offset + hi]) hi--;
    left = Math.min(left, lo); right = Math.max(right, hi); top = Math.min(top, row); bottom = row;
  }
  return right < 0 ? 0 : (right - left + 1) * (bottom - top + 1);
}
function activity(p) {
  clearTimeout(p.activityTimer); clearTimeout(p.mergeTimer); p.mergeUntil = 0;
  p.interactive = true; captureRate(p); pump(p); pump(p, 'slow');
  p.activityTimer = setTimeout(() => { p.interactive = false; captureRate(p);
    p.activityTimer = setTimeout(() => { if (!p.closed) p.window.webContents.setFrameRate(2); }, 2800);
  }, 1200);
}
function stream(p, bucket) {
  return bucket === 'fast' ? p : (p.slow ??= { key: true, inFlight: false, mergeUntil: 0 });
}
const encoderId = (p, bucket) => bucket === 'fast' ? p.id : p.id + '/slow';
function permitted(p, bucket) {
  if (!p.productionPlan) return !p.productionGated && bucket === 'fast';
  return performance.now() < p.productionExpires && p.productionPlan[bucket].allowed;
}
function captureRate(p) {
  const rate = p.productionPlan ? Math.max(2, ...['fast', 'slow'].filter(b => permitted(p, b)).map(b => p.productionPlan[b].fps)) : p.productionGated ? 2 : p.displayRate ?? 30;
  p.window.webContents.setFrameRate(Math.min(rate, p.interactive ? 30 : 10));
}
function queueFrame(p, image) {
  p.latest = image;
  const raw = { image }, timestamp = Math.round(performance.now() * 1000);
  p.productionStats ??= { captured: 0, bitmap: 0, encoded: 0, fast: 0, slow: 0 };
  p.productionStats.captured++;
  for (const bucket of ['fast', 'slow']) { stream(p, bucket).pending = { raw, timestamp }; pump(p, bucket); }
}
function releaseStreams(p) {
  for (const bucket of ['fast', 'slow']) {
    const st = stream(p, bucket);
    clearTimeout(st.mergeTimer); clearTimeout(st.rateTimer);
    st.inFlight = false; st.pending = st.previous = null; st.key = true; st.mergeUntil = 0; st.nextAt = 0;
    encoderWindow.webContents.send('release-encoder', encoderId(p, bucket));
  }
}
function pump(p, bucket = 'fast') {
  const st = stream(p, bucket), now = performance.now();
  if (p.closed || p.reconfiguring || !p.visible || !encoderReady || st.inFlight || !st.pending || !permitted(p, bucket) || st.mergeUntil > now) return;
  const parameters = p.productionPlan?.[bucket] ?? { fps: 30, bitrate: 2500000 };
  if (now < (st.nextAt ?? 0)) {
    if (!st.rateTimer) st.rateTimer = setTimeout(() => { st.rateTimer = null; pump(p, bucket); }, st.nextAt - now);
    return;
  }
  const signature = parameters.fps + ':' + parameters.bitrate;
  if (st.encodingSignature !== signature) { st.encodingSignature = signature; st.key = true; st.previous = null; }
  const frame = st.pending;
  if (!frame.raw.bytes) { frame.raw.bytes = frame.raw.image.toBitmap(); p.productionStats.bitmap++; }
  const bytes = frame.raw.bytes, area = diffArea(st.previous, bytes, p.width, p.height);
  if (!area && !st.key) { st.pending = null; return; }
  if (!st.key && !p.interactive && area <= p.width * p.height * .08 && !frame.merged) {
    st.mergeUntil = now + 150;
    st.mergeTimer = setTimeout(() => { st.mergeUntil = 0; if (st.pending) st.pending.merged = true; pump(p, bucket); }, 150); return;
  }
  st.pending = null; st.previous = bytes; st.inFlight = true; st.nextAt = now + 1000 / parameters.fps;
  encoderWindow.webContents.send('encode-frame', { id: encoderId(p, bucket), page: p.id, bucket, epoch: p.epoch,
    width: p.width, height: p.height, bytes, timestamp: frame.timestamp, key: st.key, ...parameters }); st.key = false;
}
function refresh(p, bucket = 'fast') {
  const st = stream(p, bucket); st.key = true; st.previous = null;
  if (p.latest) st.pending = { raw: { image: p.latest }, timestamp: Math.round(performance.now() * 1000) };
  p.window.webContents.invalidate(); pump(p, bucket);
}
function navigation(p) {
  const wc = p.window.webContents;
  return { url: wc.getURL(), title: wc.getTitle(), canGoBack: wc.navigationHistory.canGoBack(), canGoForward: wc.navigationHistory.canGoForward(), isLoading: wc.isLoading() };
}
function state(p) {
  if (p.closed) return;
  const wc = p.window.webContents;
  send({ type: 'navigation', page: p.id, state: navigation(p) });
}
async function resetInput(p) {
  await p.touch.reset();
  await p.ime?.retire();
  if (p.closed) return;
  const wc = p.window.webContents;
  for (const keyCode of p.pressedKeys ?? []) wc.sendInputEvent({ type: 'keyUp', keyCode });
  p.pressedKeys?.clear();
  for (const button of p.pressedButtons ?? []) wc.sendInputEvent({ type: 'mouseUp', button, x: p.pointer?.x ?? 0, y: p.pointer?.y ?? 0, clickCount: 1 });
  p.pressedButtons?.clear();
}
function closePage(id) {
  const p = pages.get(id); if (!p) return;
  pages.delete(id); p.closed = true;
  dispatch?.retire(id);
  p.clipboard?.dispose(); p.ime?.dispose();
  p.focusDispose?.();
  clearTimeout(p.activityTimer); clearTimeout(p.mergeTimer);
  p.pending = p.previous = p.latest = null;
  releaseStreams(p); p.window.destroy();
}
async function createPage(id, input) {
  if (pages.has(id)) return resize(pages.get(id), input);
  const { width, height } = viewport(input);
  const profile = deviceProfile(input);
  if (pages.size >= 64) throw new Error('Browser page limit reached');
  const partition = `persist:remote-${id}`;
  const ses = session.fromPartition(partition);
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.on('will-download', event => event.preventDefault());
  const window = new BrowserWindow({ width, height, useContentSize: true, show: true, frame: false,
    webPreferences: { partition, offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const p = { id, window, width, height, deviceProfile:'desktop', deviceConfigured:false,
    desktopUserAgent:window.webContents.getUserAgent(), desktopPlatform:process.platform === 'darwin'?'MacIntel':process.platform === 'win32'?'Win32':'Linux x86_64',
    desktopPlatformName:process.platform === 'darwin'?'macOS':process.platform === 'win32'?'Windows':'Linux', epoch: randomUUID(), visible: false, closed: false, key: true, encoderReady: false, document: randomUUID(), bridgeInstalled: null, interactive: false, productionGated: input.productionDemand === true };
  pages.set(id, p);
  const wc = window.webContents;
  p.touch = createTouchInput(createWidgetTouchDispatcher(wc.debugger, () => wc.getZoomFactor(), () => p.document), undefined, () => p.document);
  p.wheel = createWidgetWheelDispatcher(wc.debugger, () => wc.getZoomFactor(), () => p.document);
  p.clipboard = installClipboard(p, send); p.ime = installIme(p, send);
  wc.setFrameRate(2); wc.stopPainting();
  wc.setWindowOpenHandler(({ url }) => { try { send({ type: 'new-window', page: id, url: validUrl(url) }); } catch {} return { action: 'deny' }; });
  for (const event of ['will-navigate', 'will-redirect']) wc.on(event, (e, url) => { try { validUrl(url); } catch { e.preventDefault(); } });
  wc.on('did-start-navigation', (_e, _url, inPlace, mainFrame) => { if (!p.closed && mainFrame && !inPlace) {
    p.document = randomUUID(); p.bridgeInstalled = null; p.domReady = false;
    send({ type: 'input-reset', page: id, document: p.document });
    p.inputReset = (p.inputReset ?? Promise.resolve()).then(() => resetInput(p)).catch(() => {});
  } });
  for (const event of ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page', 'page-title-updated']) wc.on(event, () => { if (!p.closed) { state(p); if (p.visible) activity(p); } });
  wc.on('dom-ready', () => { p.domReady = true; });
  wc.on('render-process-gone', (_event, details) => {
    if (p.closed) return;
    // Destroy the dead WebContents and its queued control stream before the
    // owner permits recreation. Other Tabs and their live DOM remain intact.
    closePage(id);
    send({ type: 'renderer-gone', page: id, reason: details.reason, exitCode: details.exitCode });
  });
  wc.on('did-fail-load', (_e, code, _description, _url, mainFrame) => { if (!p.closed && mainFrame && code !== -3) send({ type: 'error', page: id, message: 'Browser navigation failed' }); });
  wc.on('paint', (_event, _dirty, image) => {
    if (p.closed || p.reconfiguring || image.getSize().width !== p.width || image.getSize().height !== p.height) return;
    queueFrame(p, image);
  });
  wc.on('cursor-changed', (_event, cursor) => {
    const aliases = { pointer: 'default', hand: 'pointer', nodrop: 'no-drop', null: 'default' };
    send({ type: 'cursor', page: id, cursor: aliases[cursor] || cursor });
  });

  // Offscreen Ozone windows do not gain renderer page focus from OS window
  // focus or injected mouse events. Give each independent remote page its own
  // native focus context; this changes no focused element or selection and
  // remains stable when another viewer/page receives input or video is parked.
  // The debugger stays private to the worker, shared with device emulation.
  try {
    await wc.loadURL('about:blank');
    p.focusDispose = await initializeNativeFocus(wc, () => {
      if (!p.closed) send({ type: 'error', page: id, message: 'Browser frame initialization failed; reload this tab' });
    });
    if (profile !== 'desktop') await resize(p, {...input, width, height});
    return configuration(p);
  } catch (error) { if (pages.get(id) === p) closePage(id); throw error; }
}
async function automation(p, method, input) {
  if (!['readContext', 'inspect', 'click', 'fill', 'press', 'scroll', 'wait'].includes(method)) throw new Error('Unsupported browser operation');
  const generation = p.document, wc = p.window.webContents;
  if (!p.domReady) await new Promise((resolve, reject) => {
    const clean = () => { wc.off('dom-ready', ready); wc.off('did-start-navigation', changed); wc.off('destroyed', destroyed); };
    const ready = () => { clean(); resolve(); };
    const destroyed = () => { clean(); reject(new Error('Browser page closed')); };
    const changed = (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) { clean(); reject(new Error('Browser document changed')); } };
    wc.once('dom-ready', ready); wc.on('did-start-navigation', changed); wc.once('destroyed', destroyed);
  });
  if (p.document !== generation || p.closed) throw new Error('Browser document changed');
  const frame = wc.mainFrame;
  const key = 'opencraft.remote.bridge.' + generation;
  p.bridgeInstalled ??= frame.executeJavaScript(`${bridge}\n;(() => {
    const api = OpenCraftPreviewBridgeRuntime;
    const cleanup = api.installPreviewBridgeRuntime({window,parentOrigin:location.origin});
    const adapter = new api.PreviewBridgeAdapter({hostWindow:window,frameWindow:window,targetOrigin:location.origin,previewId:${JSON.stringify(p.id + ':' + generation)},generation:1});
    window[Symbol.for(${JSON.stringify(key)})]={adapter,cleanup};
  })()`);
  await p.bridgeInstalled;
  if (p.document !== generation || p.closed) throw new Error('Browser document changed');
  const result = await frame.executeJavaScript(`(async () => {
    const state=window[Symbol.for(${JSON.stringify(key)})];
    if(!state) throw new Error('Browser document changed');
    try { return {ok:true,value:await state.adapter[${JSON.stringify(method)}](${JSON.stringify(input || {})})}; }
    catch(error) { return {ok:false,error:{code:error.code||'BROWSER_ERROR',message:error.message,retryable:!!error.retryable}}; }
  })()`);
  if (p.document !== generation || p.closed) throw new Error('Browser document changed');
  if (!result.ok) throw Object.assign(new Error(result.error.message), result.error);
  return result.value;
}
async function command(message) {
  const { page: id, method, input = {} } = message;
  if (method === 'inventory') return [...pages.values()].map(p => ({ id: p.id, ...configuration(p) }));
  if (method === 'create') return createPage(id, input);
  if (method === 'close') { closePage(id); return; }
  const p = pages.get(id); if (!p) throw new Error('Browser page closed');
  const wc = p.window.webContents;
  const checkDocument = () => {
    if (message.document !== undefined && message.document !== p.document)
      throw Object.assign(new Error('Browser document changed'), { code: 'DOCUMENT_CHANGED', retryable: true });
  };
  checkDocument();
  if (message.control !== undefined && message.control !== p.controlToken)
    throw Object.assign(new Error('Browser control changed'), { code: 'CONTROL_LOST', retryable: true });
  if (method === 'viewport') return resize(p, input);
  if (method !== 'close') await p.viewportQueue;
  await p.inputReset;
  checkDocument();
  if (method === 'control') {
    if (input.token !== null && (typeof input.token !== 'string' || !/^[a-zA-Z0-9-]{20,100}$/.test(input.token))) throw new Error('Invalid control token');
    await resetInput(p); p.clipboard.retire(); p.controlToken = input.token; return;
  }
  if (message.control !== undefined && message.control !== p.controlToken)
    throw Object.assign(new Error('Browser control changed'), { code: 'CONTROL_LOST', retryable: true });
  if (method === 'observe') { p.ime.observe(); return; }
  if (method === 'snapshot') return configuration(p);
  if (method === 'production') {
    if (!input || !/^[a-zA-Z0-9-]{20,100}$/.test(input.epoch ?? '') || !Number.isSafeInteger(input.revision) || input.revision < 1
      || !Number.isInteger(input.ttlMs) || input.ttlMs < 250 || input.ttlMs > 2000
      || !input.buckets || Object.keys(input.buckets).sort().join(',') !== 'fast,slow') throw new Error('Invalid production plan');
    for (const bucket of ['fast', 'slow']) {
      const b = input.buckets[bucket];
      if (!b || typeof b.allowed !== 'boolean' || !Number.isInteger(b.fps) || b.fps < 5 || b.fps > 30
        || !Number.isInteger(b.bitrate) || b.bitrate < 250000 || b.bitrate > 5000000) throw new Error('Invalid production budget');
    }
    if (p.productionEpoch && p.productionEpoch !== input.epoch) throw new Error('Production epoch changed without parking');
    if (input.revision <= (p.productionRevision ?? 0)) return;
    p.productionEpoch = input.epoch; p.productionRevision = input.revision; p.productionGated = true;
    p.productionPlan = input.buckets; p.productionExpires = performance.now() + input.ttlMs;
    captureRate(p); pump(p); pump(p, 'slow'); return;
  }
  if (method === 'display-rate') {
    if (!Number.isInteger(input.fps) || input.fps < 5 || input.fps > 30) throw new Error('Invalid display rate');
    p.displayRate = input.fps; wc.setFrameRate(p.interactive ? input.fps : Math.min(10, input.fps)); return;
  }
  if (method === 'copy') {
    if (input.context !== undefined && (typeof input.context !== 'string' || !/^[a-zA-Z0-9-]{20,100}$/.test(input.context))) throw new Error('Invalid copy context');
    return p.clipboard.copy(input.context);
  }
  if (method === 'navigate') {
    const url = input.url === null ? 'about:blank' : validUrl(input.url);
    p.previous = null; if (p.visible) activity(p);
    // Navigation acceptance is not page load completion. A slow subresource
    // must not block attaching video or the user's stop/replacement command.
    // Native navigation/did-fail-load events remain the result authority.
    void wc.loadURL(url).catch(() => {});
    return;
  }
  if (method === 'reload') { wc.reload(); return; }
  if (method === 'stop') { wc.stop(); return; }
  if (method === 'back') { if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); return; }
  if (method === 'forward') { if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward(); return; }
  if (method === 'visible') {
    p.visible = input.visible === true;
    if (!p.visible) p.clipboard.retire();
    if (p.visible) {
      wc.startPainting(); activity(p); refresh(p); p.ime.observe();
      // Paint may initially return the surface cached before parking. Capture
      // once on reveal so changes made while parked reach the viewer too.
      const epoch = p.epoch, image = await wc.capturePage();
      if (!p.closed && p.visible && p.epoch === epoch && image.getSize().width === p.width && image.getSize().height === p.height) { queueFrame(p, image); }
    }
    else { await resetInput(p); wc.stopPainting(); p.epoch = randomUUID(); releaseStreams(p); p.productionPlan = null; p.productionEpoch = null; p.productionRevision = 0; p.key = true; clearTimeout(p.activityTimer); clearTimeout(p.mergeTimer); p.mergeUntil = 0; p.pending = p.previous = p.latest = null; }
    return;
  }
  if (method === 'keyframe') { const bucket = input?.bucket === 'slow' ? 'slow' : 'fast', st = stream(p, bucket); if (performance.now() - (st.lastKey || -1000) >= 500) { st.lastKey = performance.now(); refresh(p, bucket); } return; }
  if (method === 'capture') return (await wc.capturePage()).toDataURL();
  if (method === 'zoom') { const percent = Number(input.percent); if (!Number.isFinite(percent) || percent < 25 || percent > 500) throw new Error('Invalid zoom'); wc.setZoomFactor(percent / 100); return; }
  if (method === 'ime') { activity(p); return p.ime.apply(input); }
  if (method === 'text') { if (typeof input.text !== 'string' || input.text.length > 10000) throw new Error('Invalid text'); activity(p); await wc.insertText(input.text); return; }
  if (method === 'input') {
    const allowed = ['mouseMove','mouseDown','mouseUp','mouseWheel','keyDown','keyUp','char','touchStart','touchMove','touchEnd','touchCancel'];
    if (!allowed.includes(input.type)) throw new Error('Invalid input');
    if (['mouseDown', 'keyDown', 'touchStart'].includes(input.type)) {
      p.clipboard.retire(); await p.ime.retire();
      checkDocument();
      p.contextIntent = typeof input.menuIntent === 'string' && /^[a-zA-Z0-9-]{20,100}$/.test(input.menuIntent) ? input.menuIntent : null;
    }
    // A held touch/drag is active work even without another down/up event.
    // Otherwise native touch ACKs fall to the idle 2 fps cadence mid-gesture.
    if (input.type !== 'mouseMove' || p.touch.active || input.modifiers?.includes('leftButtonDown')) activity(p);
    if (input.type === 'touchCancel') return resetInput(p);
    if (['touchStart', 'touchMove', 'touchEnd'].includes(input.type)) return p.touch.apply(input);
    // Copy the finite, typed input surface; no arbitrary Electron options.
    const event = { type: input.type };
    for (const name of ['x','y','deltaX','deltaY','clickCount']) if (Number.isFinite(input[name])) event[name] = Math.max(-10000, Math.min(10000, input[name]));
    if (['left','right','middle'].includes(input.button)) event.button = input.button;
    if (typeof input.keyCode === 'string' && input.keyCode.length <= 64) event.keyCode = input.keyCode;
    if (Array.isArray(input.modifiers)) event.modifiers = input.modifiers.filter(v => ['shift','control','alt','meta','leftButtonDown'].includes(v));
    const touch = isTouchInput(input, p.deviceProfile);
    if (touch && ['mouseMove','mouseDown','mouseUp'].includes(event.type) && (!event.button || event.button === 'left')) return p.touch.mouse(event);
    p.pressedKeys ??= new Set(); p.pressedButtons ??= new Set();
    if (event.type === 'keyDown' && event.keyCode) p.pressedKeys.add(event.keyCode);
    if (event.type === 'keyUp') p.pressedKeys.delete(event.keyCode);
    if (event.type === 'mouseDown' && event.button) p.pressedButtons.add(event.button);
    if (event.type === 'mouseUp') p.pressedButtons.delete(event.button);
    if (event.x !== undefined && event.y !== undefined) p.pointer = { x: event.x, y: event.y };
    if (event.type === 'mouseWheel') return p.wheel(event);
    wc.sendInputEvent(event); return;
  }
  if (method === 'automation') { activity(p); return automation(p, input.method, input.input); }
  throw new Error('Unsupported browser command');
}
ipcMain.on('encoder-ready', event => { if (encoderWindow?.webContents === event.sender) { encoderReady = true; for (const p of pages.values()) { pump(p); pump(p, 'slow'); } } });
ipcMain.on('encoder-error', (event, packet) => {
  const p = pages.get(packet?.page ?? packet?.id);
  if (p && packet.epoch === p.epoch && encoderWindow?.webContents === event.sender) {
    const st = stream(p, packet.bucket ?? 'fast'); st.inFlight = false; st.key = true;
    send({ type: 'error', page: p.id, message: 'H.264 encoder unavailable' });
  }
});
ipcMain.on('encoded-packet', (event, packet) => {
  const p = pages.get(packet.page ?? packet.id), bucket = packet.bucket ?? 'fast';
  if (!p || packet.epoch !== p.epoch || encoderWindow?.webContents !== event.sender || !['fast', 'slow'].includes(bucket)) return;
  const st = stream(p, bucket);
  const header = Buffer.alloc(9); header[0] = packet.key ? 1 : 0; header.writeBigUInt64BE(BigInt(packet.timestamp), 1);
  const bytes = Buffer.concat([header, Buffer.from(packet.bytes)]);
  p.productionStats.encoded++; p.productionStats[bucket]++;
  if (connected()) send({ type: 'frame', page: p.id, bucket, bytes: bytes.toString('base64') }, error => { if (packet.epoch === p.epoch) { st.inFlight = false; if (!error) pump(p, bucket); } });
  else st.inFlight = false;
});
app.whenReady().then(async () => {
  encoderWindow = new BrowserWindow({ show: false, width: 1, height: 1,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, preload: join(__dirname, 'encoder-preload.cjs') } });
  await encoderWindow.loadFile(join(__dirname, 'encoder.html'));
  dispatch = createControls(command, id => pages.get(id)?.document);
  const receive = message => {
    const operation = dispatch(message);
    void operation.then(value => send({ type: 'result', id: message.id, value }), error => send({ type: 'result', id: message.id, error: { code: error.code || 'BROWSER_ERROR', message: error.message, retryable: !!error.retryable } })); };
  if (ipc) process.on('message', receive);
  else { const lines = createInterface({ input: process.stdin }); lines.on('line', line => { try { receive(JSON.parse(line)); } catch {} }); lines.on('close', () => app.exit(0)); }
  send({ type: 'ready' });
});
app.on('window-all-closed', () => {});
process.on('disconnect', () => app.exit(0));
process.on('SIGTERM', () => app.exit(0));
