import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
const source = readFileSync(new URL('../../scripts/remote-browser/worker.cjs', import.meta.url), 'utf8');
// Execute the real Worker operation without starting Electron or exposing its private mailbox.
const start = source.indexOf('async function annotationAutomation(');
const end = source.indexOf('async function command(', start);
assert.ok(start > 0 && end > start);
const invoke = runInNewContext(source.slice(start, end) + ';annotationAutomation', { setTimeout, clearTimeout, bridge: '' });
function fixture() {
  const wc = new EventEmitter(); let dispatches = 0;
  wc.mainFrame = { executeJavaScript: async () => { dispatches++; return { ok: true, value: { anchor: {} } }; } };
  wc.send = () => {};
  const p = { id: 'page', document: 'document-1', domReady: false, closed: false, window: { webContents: wc } };
  return { p, wc, dispatches: () => dispatches };
}
function clean(wc) { for (const name of ['dom-ready', 'did-start-navigation', 'destroyed']) assert.equal(wc.listenerCount(name), 0); }
test('annotation waiting for DOM readiness cancels before native dispatch and releases listeners', async () => {
  const f = fixture(), abort = new AbortController();
  const result = invoke(f.p, 'annotatePick', {}, () => {}, abort.signal);
  abort.abort();
  await assert.rejects(result, error => error.code === 'CDP_ABORTED' && error.outcome === 'not-dispatched');
  assert.equal(f.dispatches(), 0); clean(f.wc);
});
test('already cancelled annotation never starts a document wait or native dispatch', async () => {
  const f = fixture(), abort = new AbortController(); abort.abort();
  await assert.rejects(invoke(f.p, 'annotatePick', {}, () => {}, abort.signal), error => error.name === 'AbortError');
  assert.equal(f.dispatches(), 0); clean(f.wc);
});
test('same-URL main document replacement rejects pending annotation', async () => {
  const f = fixture(); const result = invoke(f.p, 'annotatePick', {});
  f.p.document = 'document-2'; f.wc.emit('did-start-navigation', {}, 'https://example.test/', false, true);
  await assert.rejects(result, error => error.code === 'DOCUMENT_CHANGED');
  assert.equal(f.dispatches(), 0); clean(f.wc);
});
test('page close rejects pending annotation and clears document listeners', async () => {
  const f = fixture(); const result = invoke(f.p, 'annotatePick', {}); f.wc.emit('destroyed');
  await assert.rejects(result, error => error.code === 'PAGE_CLOSED'); clean(f.wc);
});
test('control validation is rechecked after document readiness before injection', async () => {
  const f = fixture(); let allowed = true;
  const result = invoke(f.p, 'annotatePick', {}, () => { if (!allowed) throw Object.assign(new Error('Control changed'), { code: 'CONTROL_LOST' }); });
  allowed = false; f.wc.emit('dom-ready');
  await assert.rejects(result, error => error.code === 'CONTROL_LOST');
  assert.equal(f.dispatches(), 0); clean(f.wc);
});
test('ready annotation executes bridge and operation without a missing signal binding', async () => {
  const f = fixture(); f.p.domReady = true;
  assert.deepEqual(JSON.parse(JSON.stringify(await invoke(f.p, 'annotatePick', {}))), { anchor: {} });
  assert.equal(f.dispatches(), 2);
});
