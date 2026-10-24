import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../../scripts/remote-browser/worker.cjs', import.meta.url), 'utf8');
function fixture() {
  let now = 0, copies = 0; const sent = [];
  const context = vm.createContext({ performance: { now: () => now }, encoderReady: true,
    encoderWindow: { webContents: { send: (...x) => sent.push(x) } }, setTimeout: () => 1, clearTimeout() {}, diffArea: () => 100 });
  vm.runInContext(source.slice(source.indexOf('function stream('), source.indexOf('function navigation(')), context);
  const p = { id: 'page', width: 100, height: 100, epoch: 'native-epoch', visible: true, interactive: true, productionGated: true,
    key: true, window: { webContents: { invalidate() {}, setFrameRate() {} } } };
  const image = { toBitmap() { copies++; return new Uint8Array(40000); } };
  return { context, p, image, sent, get copies() { return copies; }, setNow(x) { now = x; } };
}
test('production permits are checked before bitmap work and expire without further encoding', () => {
  const f = fixture(); f.context.queueFrame(f.p, f.image); assert.equal(f.copies, 0); assert.equal(f.sent.length, 0);
  f.p.productionPlan = { fast: { allowed: true, fps: 30, bitrate: 2000000 }, slow: { allowed: false, fps: 15, bitrate: 700000 } }; f.p.productionExpires = 1000;
  f.context.pump(f.p); assert.equal(f.copies, 1); assert.equal(f.sent.length, 1);
  f.p.inFlight = false; f.setNow(1100); f.context.queueFrame(f.p, f.image); assert.equal(f.copies, 1); assert.equal(f.sent.length, 1);
});
test('two bucket encoders share one captured bitmap and never create a third producer', () => {
  const f = fixture(); f.p.productionPlan = { fast: { allowed: true, fps: 30, bitrate: 2000000 }, slow: { allowed: true, fps: 15, bitrate: 700000 } }; f.p.productionExpires = 1000;
  f.context.queueFrame(f.p, f.image); assert.equal(f.copies, 1); assert.equal(f.sent.length, 2);
  assert.deepEqual(f.sent.map(x => x[1].bucket), ['fast', 'slow']);
  assert.equal(f.p.productionStats.fast, 0); assert.equal(f.p.productionStats.bitmap, 1);
});
