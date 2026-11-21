import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';

// Exercise the actual worker function without launching or mocking Electron's
// security/transport owner. Native rendering is a separate acceptance boundary.
const source = await readFile(new URL('../../apps/headless-server/src/remote-browser/worker.cjs', import.meta.url), 'utf8');
const start = source.indexOf('async function annotationAutomation(');
const end = source.indexOf('async function command(', start);
assert.ok(start >= 0 && end > start);
const invoke = vm.runInNewContext(source.slice(start, end) + '\nannotationAutomation', { setTimeout, clearTimeout, bridge: '/* compiled bridge */' });
function page(ready = true) {
  const wc = new EventEmitter();
  const scripts = [], messages = [];
  wc.mainFrame = { executeJavaScript: async text => {
    scripts.push(text);
    return scripts.length === 1 ? undefined : { ok: true, value: { anchor: { bindingKey: 'binding', selector: '#target', documentGeneration: 'document' } } };
  } };
  wc.send = (...args) => messages.push(args);
  return { p: { id: 'page', document: 'document', domReady: ready, closed: false, window: { webContents: wc } }, wc, scripts, messages };
}
test('annotation DOM-ready cancellation removes listeners without dispatching page code', async () => {
  const { p, wc, scripts } = page(false), abort = new AbortController();
  const pending = invoke(p, 'annotatePick', {}, undefined, abort.signal);
  assert.equal(wc.listenerCount('dom-ready'), 1);
  abort.abort();
  await assert.rejects(pending, error => error.code === 'CDP_ABORTED' && error.outcome === 'not-dispatched');
  for (const name of ['dom-ready', 'did-start-navigation', 'destroyed']) assert.equal(wc.listenerCount(name), 0);
  assert.equal(scripts.length, 0);
});
test('annotation navigation while waiting rejects and releases DOM listeners', async () => {
  const { p, wc, scripts } = page(false);
  const pending = invoke(p, 'annotatePick', {});
  wc.emit('did-start-navigation', {}, 'https://example.test', false, true);
  await assert.rejects(pending, error => error.code === 'DOCUMENT_CHANGED');
  assert.equal(wc.listenerCount('dom-ready'), 0);
  assert.equal(scripts.length, 0);
});
test('cancellation after bridge installation prevents annotation dispatch', async () => {
  const { p, wc, scripts } = page(), abort = new AbortController();
  wc.mainFrame.executeJavaScript = async text => { scripts.push(text); abort.abort(); };
  await assert.rejects(invoke(p, 'annotatePick', {}, undefined, abort.signal), error => error.name === 'AbortError');
  assert.equal(scripts.length, 1);
});
test('authority loss after bridge installation prevents annotation dispatch', async () => {
  const { p, wc, scripts } = page(); let admitted = true;
  wc.mainFrame.executeJavaScript = async text => { scripts.push(text); admitted = false; };
  await assert.rejects(invoke(p, 'annotatePick', {}, () => { if (!admitted) throw new Error('authority revoked'); }), /authority revoked/);
  assert.equal(scripts.length, 1);
});
test('ready annotation results bind exact document and target identities', async () => {
  const { p, scripts, messages } = page();
  const result = await invoke(p, 'annotatePick', {});
  assert.equal(result.anchor.bindingKey, 'binding');
  assert.equal(scripts.length, 2);
  assert.deepEqual(messages.map(message => message[1].type), ['bind', 'bind-generation']);
});
