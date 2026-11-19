import assert from "node:assert/strict";
import test from "node:test";
import { createDeferredRfbDesktopAdapter } from "../../plugins/cloud-desktop/src/deferred-rfb";
import type { RfbDesktopAdapter, DesktopRfbSession } from "../../plugins/cloud-desktop/src/rfb";
import type { DesktopConnection } from "../../plugins/cloud-desktop/src/contract";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function fixture() {
  let closes = 0,
    connects = 0,
    mounts = 0;
  const connection: DesktopConnection = {
    getSnapshot: () => ({ videoReady: false, inputReady: false, controlAvailable: false, ended: false }),
    subscribe: () => () => {},
    requestControl: async () => {
      throw new Error("not granted");
    },
    close() {},
  };
  const media: RfbDesktopAdapter = {
    async connect() {
      connects++;
      return connection;
    },
    surfaces: {
      mount(_element, value) {
        assert.equal(value, connection);
        mounts++;
        return { setActive() {}, enableInput() {}, disableInput() {}, dispose() {} };
      },
    },
  };
  const session: DesktopRfbSession = {
    openChannel() {
      throw new Error("not opened during loading");
    },
    close() {
      closes++;
    },
  };
  return { media, session, connection, counts: () => ({ closes, connects, mounts }) };
}

test("registration and unused surfaces do not load media; concurrent viewers share one load", async () => {
  const f = fixture(),
    pending = deferred<RfbDesktopAdapter>();
  let loads = 0;
  const adapter = createDeferredRfbDesktopAdapter(() => {
    loads++;
    return pending.promise;
  });
  assert.equal(loads, 0);
  assert.throws(() => adapter.surfaces.mount({} as HTMLElement, f.connection), /unavailable/);
  assert.equal(loads, 0);
  const surfaces = adapter.surfaces;
  const a = adapter.connect(f.session, new AbortController().signal);
  const b = adapter.connect(f.session, new AbortController().signal);
  await Promise.resolve();
  assert.equal(loads, 1);
  pending.resolve(f.media);
  assert.equal(await a, f.connection);
  assert.equal(await b, f.connection);
  assert.equal(adapter.surfaces, surfaces);
  surfaces.mount({} as HTMLElement, f.connection);
  assert.deepEqual(f.counts(), { closes: 0, connects: 2, mounts: 1 });
});

test("cancellation while importing closes immediately and cannot connect after a late load", async () => {
  const f = fixture(),
    pending = deferred<RfbDesktopAdapter>();
  const adapter = createDeferredRfbDesktopAdapter(() => pending.promise);
  const abort = new AbortController();
  const result = adapter.connect(f.session, abort.signal);
  abort.abort();
  assert.equal(f.counts().closes, 1);
  pending.resolve(f.media);
  await assert.rejects(result, { name: "AbortError" });
  assert.deepEqual(f.counts(), { closes: 1, connects: 0, mounts: 0 });
  // Cancellation belongs to one viewer, not the shared module load.
  assert.equal(await adapter.connect(f.session, new AbortController().signal), f.connection);
});

test("an already retired viewer neither loads nor connects", async () => {
  const f = fixture();
  let loads = 0;
  const adapter = createDeferredRfbDesktopAdapter(async () => {
    loads++;
    return f.media;
  });
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(adapter.connect(f.session, abort.signal));
  assert.equal(loads, 0);
  assert.equal(f.counts().closes, 1);
});

test("failed module loading closes the viewer and permits a subsequent attempt", async () => {
  const f = fixture();
  let loads = 0;
  const adapter = createDeferredRfbDesktopAdapter(async () => {
    if (++loads === 1) throw new Error("import failed");
    return f.media;
  });
  await assert.rejects(adapter.connect(f.session, new AbortController().signal), /import failed/);
  assert.equal(f.counts().closes, 1);
  assert.equal(await adapter.connect(f.session, new AbortController().signal), f.connection);
  assert.equal(loads, 2);
});

test("after transfer, only the real adapter owns cancellation and failure cleanup", async () => {
  const f = fixture();
  const entered = deferred<void>();
  const abort = new AbortController();
  const adapter = createDeferredRfbDesktopAdapter(async () => ({
    ...f.media,
    async connect(session, signal) {
      signal.addEventListener("abort", () => session.close(), { once: true });
      entered.resolve();
      return f.connection;
    },
  }));
  const result = adapter.connect(f.session, abort.signal);
  await entered.promise;
  await result;
  abort.abort();
  assert.equal(f.counts().closes, 1);
  const failed = createDeferredRfbDesktopAdapter(async () => ({
    ...f.media,
    async connect(session) {
      session.close();
      throw new Error("decoder failed");
    },
  }));
  await assert.rejects(failed.connect(f.session, new AbortController().signal), /decoder failed/);
  assert.equal(f.counts().closes, 2, "wrapper must not double-close after transfer");
});
