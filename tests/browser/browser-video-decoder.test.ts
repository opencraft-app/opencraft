import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { browserH264Config, selectBrowserVideoDecoder } from '../../apps/workbench-web/src/browser/browser-video-decoder';
import { RemoteBrowserSurfaceHost } from '../../apps/workbench-web/src/browser/remote-browser-surface-host';

function globals(t: TestContext, values: Record<string, unknown>) {
  for (const [key, value] of Object.entries(values)) {
    const old = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => { if (old) Object.defineProperty(globalThis, key, old); else delete (globalThis as any)[key]; });
  }
}
const mse = { isTypeSupported: (type: string) => { assert.equal(type, 'video/mp4; codecs="avc1.42E028"'); return true; } };

test('preflight asks for the exact runtime config, prefers supported WebCodecs and retires its timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let probes = 0;
  globals(t, { VideoDecoder: { async isConfigSupported(config: VideoDecoderConfig) {
    probes++; assert.deepEqual(config, { codec: 'avc1.42E028', optimizeForLatency: true }); return { supported: true };
  } }, EncodedVideoChunk: class {}, MediaSource: mse });
  assert.equal(await selectBrowserVideoDecoder(), 'webcodecs');
  t.mock.timers.tick(10000); assert.equal(probes, 1);
});

for (const failure of ['unsupported', 'throw', 'reject', 'missing-probe', 'missing-chunk']) {
  test(`preflight selects MSE for ${failure} WebCodecs rather than trusting interface presence`, async t => {
    const decoder = { isConfigSupported: () => {
      if (failure === 'throw') throw new TypeError('unsupported');
      if (failure === 'reject') return Promise.reject(new DOMException('unsupported', 'NotSupportedError'));
      return Promise.resolve({ supported: false });
    } };
    globals(t, { VideoDecoder: failure === 'missing-probe' ? {} : decoder,
      EncodedVideoChunk: failure === 'missing-chunk' ? undefined : class {}, MediaSource: mse });
    assert.equal(await selectBrowserVideoDecoder(), 'mse');
  });
}

test('MSE absence or rejection leaves no decoder admitted', async t => {
  globals(t, { VideoDecoder: undefined, EncodedVideoChunk: undefined, MediaSource: undefined });
  assert.equal(await selectBrowserVideoDecoder(), null);
  Object.defineProperty(globalThis, 'MediaSource', { configurable: true, value: { isTypeSupported() { throw Error('unavailable'); } } });
  assert.equal(await selectBrowserVideoDecoder(), null);
});

test('a hung capability query is bounded and its late support cannot replace the MSE selection', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let support: (result: { supported: boolean }) => void = () => {};
  globals(t, { VideoDecoder: { isConfigSupported: () => new Promise(resolve => { support = resolve; }) }, EncodedVideoChunk: class {}, MediaSource: mse });
  let result: unknown;
  const pending = selectBrowserVideoDecoder().then(value => { result = value; });
  await Promise.resolve(); t.mock.timers.tick(1999); await Promise.resolve(); assert.equal(result, undefined);
  t.mock.timers.tick(1); await pending; assert.equal(result, 'mse');
  support({ supported: true }); await Promise.resolve(); assert.equal(result, 'mse');
});

test('cancelling preflight rejects without selecting MSE and fences a late codec answer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let support: (result: { supported: boolean }) => void = () => {}, mseQueries = 0;
  globals(t, { VideoDecoder: { isConfigSupported: () => new Promise(resolve => { support = resolve; }) }, EncodedVideoChunk: class {},
    MediaSource: { isTypeSupported() { mseQueries++; return true; } } });
  const owner = new AbortController(), pending = selectBrowserVideoDecoder(owner.signal);
  await Promise.resolve(); owner.abort(); await assert.rejects(pending, { name: 'AbortError' });
  support({ supported: true }); t.mock.timers.tick(10000); await Promise.resolve(); assert.equal(mseQueries, 0);
  await assert.rejects(selectBrowserVideoDecoder(owner.signal), { name: 'AbortError' }); assert.equal(mseQueries, 0);
});

for (const phase of ['construct', 'configure', 'async-unsupported']) {
  test(`runtime ${phase} failure is surfaced once, releases the decoder and cannot storm keyframes`, t => {
    let attempts = 0, closes = 0, requests = 0;
    let callbacks: VideoDecoderInit;
    class Decoder {
      state = 'unconfigured'; decodeQueueSize = 0;
      constructor(init: VideoDecoderInit) { attempts++; callbacks = init; if (phase === 'construct') throw Error('failed'); }
      configure(config: VideoDecoderConfig) { assert.deepEqual(config, browserH264Config); if (phase === 'configure') throw Error('failed'); this.state = 'configured'; }
      decode() {}
      close() { this.state = 'closed'; closes++; }
    }
    globals(t, { VideoDecoder: Decoder, EncodedVideoChunk: class {}, cancelAnimationFrame() {} });
    const host: any = Object.create(RemoteBrowserSurfaceHost.prototype); host.videoDecoder = 'webcodecs'; host.run = () => { requests++; };
    const errors: string[] = [], page: any = { closed: false, decodeFailed: false, mediaReceiver: null, decoder: null, needsKey: true,
      cancelVideoReady: null, video: null, media: null, latest: null, raf: 0, events: { onError: (value: string) => errors.push(value) } };
    const packet = new Uint8Array(10); packet[0] = 1;
    assert.doesNotThrow(() => host.decode(page, packet.buffer));
    if (phase === 'async-unsupported') callbacks!.error(new DOMException('H264 unsupported', 'NotSupportedError'));
    for (let n = 0; n < 30; n++) host.decode(page, packet.buffer);
    assert.equal(attempts, 1); assert.equal(closes, phase === 'construct' ? 0 : 1);
    assert.equal(requests, 0); assert.equal(errors.length, 1); assert.match(errors[0]!, /H.264.*unavailable/);
    assert.equal(page.decoder, null); assert.equal(page.decodeFailed, true);
    if (phase === 'async-unsupported') {
      callbacks!.error(new DOMException('late unsupported', 'NotSupportedError')); assert.equal(errors.length, 1);
      let released = false; callbacks!.output({ close() { released = true; } } as VideoFrame); assert.equal(released, true);
    }
  });
}
