import test from "node:test";
import assert from "node:assert/strict";
import { RemoteBrowserSurfaceHost } from "../../apps/workbench-web/src/browser/remote-browser-surface-host";
import { decodeFrame } from "../../apps/workbench-web/src/browser/remote-browser-media-runtime";
const deferred = () => {
  let resolve!: (v?: any) => void, reject!: (e: Error) => void;
  const promise = new Promise<any>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
function fixture() {
  const host: any = Object.create(RemoteBrowserSurfaceHost.prototype),
    loading = deferred(),
    p: any = { id: "page", closed: false, connection: 1, inputBound: true, mediaReady: null, mediaRuntime: null };
  let loads = 0;
  Object.assign(host, {
    pages: new Map([[p.id, p]]),
    inputFailed: false,
    loadMediaRuntime: () => {
      loads++;
      return loading.promise;
    },
  });
  return { host, p, loading, loads: () => loads };
}
test("media code is lazy, shared across page waiters and creates no decoder or socket", async () => {
  const f = fixture();
  assert.equal(f.loads(), 0);
  const a = f.host.ensureMediaReady(f.p),
    b = f.host.ensureMediaReady(f.p);
  assert.equal(a, b);
  assert.equal(f.loads(), 1);
  const runtime = {};
  f.loading.resolve(runtime);
  await a;
  assert.equal(f.p.mediaRuntime, runtime);
  assert.equal(f.p.decoder, undefined);
  assert.equal(f.p.socket, undefined);
  assert.equal(f.host.ensureMediaReady(f.p), a);
});
for (const reason of ["close", "fail", "replacement"])
  test("media load arriving after " + reason + " cannot attach to page", async () => {
    const f = fixture(),
      pending = f.host.ensureMediaReady(f.p);
    if (reason === "close") f.p.closed = true;
    if (reason === "fail") {
      f.host.inputFailed = true;
      f.host.storageError = Error("storage failed");
    }
    if (reason === "replacement") f.host.pages.set(f.p.id, {});
    const rejected = assert.rejects(pending, /closed|storage failed/);
    f.loading.resolve({});
    await rejected;
    assert.equal(f.p.mediaRuntime, null);
  });
test("explicit retry can recover a failed media-code load", async () => {
  const f = fixture(),
    pending = f.host.ensureMediaReady(f.p),
    rejected = assert.rejects(pending, /chunk unavailable/);
  f.loading.reject(Error("chunk unavailable"));
  await rejected;
  assert.equal(f.p.mediaReady, null);
  f.host.loadMediaRuntime = async () => ({});
  await f.host.ensureMediaReady(f.p);
  assert(f.p.mediaRuntime);
});
test("input and media prepare concurrently; replaced connection never creates a socket", async () => {
  const f = fixture(),
    input = deferred();
  f.p.inputBound = false;
  let inputStarted = false;
  f.host.ensureInputBound = () => {
    inputStarted = true;
    return input.promise.then(() => {
      f.p.inputBound = true;
    });
  };
  const ready = f.host.connectTransport(f.p, 1),
    rejected = assert.rejects(ready, /superseded/);
  assert(inputStarted);
  assert.equal(f.loads(), 1);
  f.loading.resolve({});
  await Promise.resolve();
  assert.equal(f.p.socket, undefined);
  f.p.connection++;
  input.resolve();
  await rejected;
  assert.equal(f.p.socket, undefined);
  assert(f.p.mediaRuntime);
});
test("media failure blocks transport instead of accepting undecodable frames", async () => {
  const f = fixture(),
    ready = f.host.connectTransport(f.p, 1),
    rejected = assert.rejects(ready, /media chunk failed/);
  f.loading.reject(Error("media chunk failed"));
  await rejected;
  assert.equal(f.p.socket, undefined);
});

test("WebCodecs first frame, latest-only paint and stale decoder outputs preserve ownership", (t) => {
  const originals = new Map(
      ["VideoDecoder", "EncodedVideoChunk", "requestAnimationFrame", "cancelAnimationFrame"].map((k) => [
        k,
        Object.getOwnPropertyDescriptor(globalThis, k),
      ]),
    ),
    callbacks = new Map<number, () => void>();
  let serial = 0;
  class Decoder {
    state = "configured";
    decodeQueueSize = 0;
    constructor(readonly options: any) {}
    configure() {}
    decode() {}
    close() {
      this.state = "closed";
    }
  }
  for (const [k, v] of Object.entries({
    VideoDecoder: Decoder,
    EncodedVideoChunk: class {
      constructor(readonly options: any) {}
    },
    requestAnimationFrame: (cb: () => void) => {
      callbacks.set(++serial, cb);
      return serial;
    },
    cancelAnimationFrame: (id: number) => callbacks.delete(id),
  }))
    Object.defineProperty(globalThis, k, { configurable: true, value: v });
  t.after(() => {
    for (const [k, d] of originals)
      if (d) Object.defineProperty(globalThis, k, d);
      else delete (globalThis as any)[k];
  });
  const p: any = {
    closed: false,
    decoder: null,
    media: null,
    video: null,
    latest: null,
    raf: 0,
    needsKey: true,
    width: 390,
    height: 600,
    mediaReceiver: null,
    cancelVideoReady: null,
  };
  const paints: any[] = [],
    host: any = Object.create(RemoteBrowserSurfaceHost.prototype),
    owner: any = {
      paintFrame: (_p: any, frame: any) => paints.push(frame),
      didPaint() {},
      resetDecoder: (page: any) => host.resetDecoder(page),
      run() {},
    };
  const packet = new ArrayBuffer(10);
  new Uint8Array(packet)[0] = 1;
  decodeFrame(owner, p, packet);
  const decoder = p.decoder;
  assert(decoder);
  let closes = 0;
  const frame = (timestamp: number) => ({
    timestamp,
    close() {
      closes++;
    },
  });
  const a = frame(1),
    b = frame(2);
  decoder.options.output(a);
  decoder.options.output(b);
  assert.equal(closes, 1);
  assert.equal(callbacks.size, 1);
  const paint = [...callbacks.values()][0];
  callbacks.clear();
  paint();
  assert.deepEqual(paints, [b]);
  assert.equal(closes, 2);
  assert.equal(p.latest, null);
  decoder.options.output(frame(3));
  host.resetDecoder(p);
  assert.equal(decoder.state, "closed");
  assert.equal(callbacks.size, 0);
  assert.equal(closes, 3);
  decoder.options.output(frame(4));
  assert.equal(closes, 4);
  assert.deepEqual(paints, [b]);
  assert.equal(p.needsKey, true);
});
