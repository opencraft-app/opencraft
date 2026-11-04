import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { RemoteBrowserService } from '../../scripts/remote-browser-service.mjs';

const source = readFileSync(new URL('../../scripts/remote-browser/worker.cjs', import.meta.url), 'utf8');
function fixture(capture) {
  let captures = 0;
  const images = [], viewer = { visible: true };
  const image = { getSize: () => ({ width: 390, height: 700 }), toDataURL: () => 'image' };
  const p = { id: 'page', live: true, width: 390, height: 700, epoch: 'epoch',
    ime: { observe() {} }, clipboard: { retire() {} },
    window: { webContents: { startPainting() {}, stopPainting() {},
      capturePage: () => capture(++captures, image) } } };
  const context = vm.createContext({ pages: new Map([[p.id, p]]), activity() {}, refresh() {},
    queueFrame: (_page, value) => images.push(value), resetInput: async () => {}, releaseStreams() {},
    randomUUID: () => 'new-epoch', clearTimeout });
  vm.runInContext(source.slice(source.indexOf('async function command('), source.indexOf("\nipcMain.on('encoder-ready'")), context);
  const host = Object.create(RemoteBrowserService.prototype); host.child = {};
  host.viewers = () => new Map([[{}, viewer]]);
  // Preserve the real worker's error serialization. Missing retryable becomes
  // false across IPC, so a plain capture error terminates the display setter.
  host.request = async (_id, method, input) => {
    try { return await context.command({ page: p.id, method, input }); }
    catch (error) { throw Object.assign(new Error(error.message), { code: error.code || 'BROWSER_ERROR', retryable: !!error.retryable }); }
  };
  const keepAlive = setInterval(() => {}, 1000);
  return { host, p, viewer, images, get captures() { return captures; }, close: () => clearInterval(keepAlive) };
}

test('a transient reveal capture retries through real worker serialization, then caches the acknowledged display state', async () => {
  const f = fixture((attempt, image) => { if (attempt === 1) throw Error('UnknownVizError'); return image; });
  try {
    await f.host.visibility(f.p);
    assert.equal(f.captures, 2); assert.equal(f.p.painted, true); assert.equal(f.images.length, 1);
    await f.host.visibility(f.p); assert.equal(f.captures, 2);
  } finally { f.close(); }
});

test('persistent compositor failure exhausts the existing finite display budget', async () => {
  const f = fixture(() => { throw Error('UnknownVizError'); });
  try {
    await assert.rejects(f.host.visibility(f.p), e => e.code === 'BROWSER_UNAVAILABLE' && e.retryable === true);
    assert.equal(f.captures, 4); assert.equal(f.p.painted, null); assert.equal(f.images.length, 0);
  } finally { f.close(); }
});

test('other reveal errors stay terminal and explicit screenshot failures are not translated', async () => {
  const f = fixture(() => { throw Error('WebContents destroyed'); });
  try {
    await assert.rejects(f.host.visibility(f.p), e => e.message === 'WebContents destroyed' && e.retryable === false);
    assert.equal(f.captures, 1);
  } finally { f.close(); }
  const g = fixture(() => { throw Error('UnknownVizError'); });
  try {
    await assert.rejects(g.host.request(g.p.id, 'capture'), e => e.message === 'UnknownVizError' && e.code === 'BROWSER_ERROR' && e.retryable === false);
    assert.equal(g.captures, 1);
  } finally { g.close(); }
});

test('parking during retry retires the reveal instead of starting another capture', async () => {
  const f = fixture(() => { f.viewer.visible = false; throw Error('UnknownVizError'); });
  try {
    await f.host.visibility(f.p); assert.equal(f.captures, 1); assert.equal(f.p.painted, false); assert.equal(f.p.visible, false);
  } finally { f.close(); }
});

for (const permanent of [false, true]) test(`retained worker capture errors use the same finite budget (persistent=${permanent})`, async () => {
  const f = fixture((_attempt, image) => image);
  let calls = 0;
  f.host.request = async () => {
    if (++calls === 1 || permanent)
      throw Object.assign(Error('UnknownVizError'), { code: 'BROWSER_ERROR', retryable: false });
  };
  try {
    if (permanent) await assert.rejects(f.host.visibility(f.p), e => e.code === 'BROWSER_UNAVAILABLE' && e.retryable === true);
    else { await f.host.visibility(f.p); assert.equal(f.p.painted, true); }
    assert.equal(calls, permanent ? 4 : 2);
  } finally { f.close(); }
});

test('matching capture text with another error code does not override a terminal decision', async () => {
  const f = fixture(() => {}); let calls = 0;
  f.host.request = async () => { calls++; throw Object.assign(Error('UnknownVizError'), { code: 'UNAUTHORIZED', retryable: false }); };
  try {
    await assert.rejects(f.host.visibility(f.p), e => e.code === 'UNAUTHORIZED'); assert.equal(calls, 1);
  } finally { f.close(); }
});
