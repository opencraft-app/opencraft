import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../', import.meta.url));
const worker = readFileSync(join(source, 'scripts/remote-browser/worker.cjs'), 'utf8');
// Execute the actual worker command and both automation paths. Only native
// Electron/renderer boundaries are fixtures; no control logic is reimplemented.
const implementation = worker.slice(worker.indexOf('async function automation('), worker.indexOf("ipcMain.on('encoder-ready'"));
const token = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
function fixture(installed = true, sourceText = implementation) {
  const events = [];
  const p = {
    id: 'page', document: 'document', controlToken: null, domReady: true,
    bridgeInstalled: installed ? Promise.resolve() : null,
    clipboard: { retire() { events.push('retire'); } },
    window: { webContents: {
      mainFrame: { async executeJavaScript(script) {
        assert(script.includes('annotateClearPreview'));
        events.push('cleanup');
        await f.duringCleanup?.();
        return f.result;
      } },
      send(_channel, packet) { events.push(packet.type); },
    } },
    automation: { async invoke(_method, _input, { validate }) {
      validate(); await f.duringAutomation?.(); validate(); return 'clicked';
    } },
  };
  const command = new Function('pages', 'resetInput', 'activity', 'bridge', `${sourceText}\nreturn command;`)(
    new Map([[p.id, p]]), async () => { events.push('reset'); await f.duringReset?.(); }, () => {}, '',
  );
  const f = { p, events, result: { ok: true },
    control: (next = token, extra = {}) => command({ page: p.id, method: 'control', document: 'document', input: { token: next }, ...extra }),
    automate: (method = 'click', extra = {}) => command({ page: p.id, method: 'automation', document: 'document', control: token, input: { method }, ...extra }),
  };
  return f;
}

test('first grant without bridge succeeds without installing one', async () => {
  const f = fixture(false); await f.control();
  assert.equal(f.p.controlToken, token);
  assert.deepEqual(f.events, ['reset', 'retire', 'clear']);
  assert.equal(f.p.bridgeInstalled, null);
});
test('installed bridge cleanup permits grant, click and release in order', async () => {
  const f = fixture(); await f.control();
  assert.equal(f.p.controlToken, token);
  assert.equal(await f.automate(), 'clicked');
  await f.control(null, { control: token });
  assert.equal(f.p.controlToken, null);
  assert.deepEqual(f.events, ['reset', 'retire', 'cleanup', 'clear', 'reset', 'retire', 'cleanup', 'clear']);
});
test('negative control reproduces exact original validate failure', async () => {
  const original = implementation.replace("if (p.bridgeInstalled) await annotationAutomation(p, 'annotateClearPreview');", "if (p.bridgeInstalled) await automation(p, 'annotateClearPreview');");
  assert.notEqual(original, implementation);
  const f = fixture(true, original);
  await assert.rejects(f.control(), { name: 'TypeError', message: 'validate is not a function' });
  assert.equal(f.p.controlToken, null);
});
for (const interruption of ['navigation', 'close', 'failure', 'reset-navigation']) {
  test(`cleanup ${interruption} prevents control transfer`, async () => {
    const f = fixture();
    if (interruption === 'navigation') f.duringCleanup = () => { f.p.document = 'replacement'; };
    if (interruption === 'close') f.duringCleanup = () => { f.p.closed = true; };
    if (interruption === 'failure') f.result = { ok: false, error: { code: 'CLEANUP_FAILED', message: 'cleanup failed' } };
    if (interruption === 'reset-navigation') f.duringReset = () => { f.p.document = 'replacement'; };
    await assert.rejects(f.control(), /document changed|cleanup failed/);
    assert.equal(f.p.controlToken, null);
    assert(!f.events.includes('clear'));
  });
}
test('external preview still requires current document and control', async () => {
  const f = fixture();
  await assert.rejects(f.automate('annotatePreview', { control: undefined }), { code: 'CONTROL_LOST' });
  await f.control();
  await assert.rejects(f.automate('annotateClearPreview', { document: undefined }), { code: 'CONTROL_LOST' });
  await assert.rejects(f.control(null, { document: 'stale' }), { code: 'DOCUMENT_CHANGED' });
  await assert.rejects(f.control(null, { control: 'stale' }), { code: 'CONTROL_LOST' });
  assert.equal(f.p.controlToken, token);
});
test('external automation retains document and control checks after dispatch', async () => {
  for (const change of ['document', 'controlToken']) {
    const f = fixture(); await f.control();
    f.duringAutomation = () => { f.p[change] = 'replacement'; };
    await assert.rejects(f.automate(), { code: change === 'document' ? 'DOCUMENT_CHANGED' : 'CONTROL_LOST' });
  }
});
