import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { BrowserLocalMenuController } from '../../apps/workbench-web/src/browser/browser-local-menu';
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
function fixture() {
  const writes: unknown[] = [], errors: string[] = [];
  const menu = deferred<'copy' | null>();
  const controller = new BrowserLocalMenuController({ show: () => menu.promise, cancel() {},
    async writeClipboard(data) { writes.push(data); } });
  let active = true;
  return { controller, writes, errors, menu, current: () => active, retire() { active = false; controller.retire(); } };
}
test('local native menu selection invokes remote command and then writes its exact final payload', async () => {
  const f = fixture(); let copies = 0;
  f.controller.open({ x: 5, y: 9, copy: true, link: false, current: f.current,
    run: async () => { copies++; return { text: '最终结果', html: '<b>最终结果</b>' }; }, focus() {}, error: message => f.errors.push(message) });
  assert.equal(copies, 0); assert.equal(f.controller.getSnapshot(), null, 'native menu has no DOM duplicate');
  f.menu.resolve('copy'); await tick(); await tick();
  assert.equal(copies, 1); assert.deepEqual(f.writes, [{ text: '最终结果', html: '<b>最终结果</b>' }]);
});
test('tab switch or disconnect rejects a late result before client clipboard write', async () => {
  const f = fixture(), data = deferred<{ text: string }>();
  f.controller.copy(() => data.promise, f.current, message => f.errors.push(message));
  await tick(); f.retire(); data.resolve({ text: '迟到' }); await tick();
  assert.deepEqual(f.writes, []); assert.deepEqual(f.errors, []);
});
test('retirement between accepted data and its next Promise reaction prevents desktop clipboard write', async () => {
  const f = fixture(); let checks = 0;
  f.controller.copy(async () => ({ text: '已返回但过期' }), () => {
    if (++checks === 2) queueMicrotask(() => f.controller.retire());
    return true;
  }, message => f.errors.push(message));
  await tick();
  assert.deepEqual(f.writes, []); assert.deepEqual(f.errors, []);
});
test('late menu close cannot dismiss a newer owner or copy without selection', async () => {
  const dom = new JSDOM(); Object.assign(globalThis, { window: dom.window });
  try {
    const controller = new BrowserLocalMenuController(undefined);
    const base = { x: 1, y: 2, copy: true, link: false, current: () => true, run: async () => ({ text: '' }), focus() {}, error() {} };
    controller.open(base); const first = controller.getSnapshot()!;
    controller.open(base); const second = controller.getSnapshot()!;
    controller.dismiss(first.id); assert.equal(controller.getSnapshot(), second);
    controller.retire(); assert.equal(controller.getSnapshot(), null);
  } finally { dom.window.close(); }
});
test('browser clipboard promises are offered during the gesture and canceled before data arrives', async () => {
  const dom = new JSDOM(); const blobs: Promise<Blob>[] = [];
  Object.assign(globalThis, { window: dom.window });
  const previousClipboardItem = globalThis.ClipboardItem;
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  class Item {
    constructor(data: Record<string, Promise<Blob>>) { blobs.push(...Object.values(data)); }
  }
  let called = false;
  Object.assign(globalThis, { ClipboardItem: Item });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { write: async () => { called = true; await Promise.all(blobs); } } } });
  try {
    const controller = new BrowserLocalMenuController(undefined), pending = deferred<{ text: string }>();
    controller.copy(() => pending.promise, () => true, () => {});
    assert(called, 'write must start before awaiting the network');
    controller.retire(); pending.resolve({ text: 'late' });
    const results = await Promise.allSettled(blobs); assert(results.every(result => result.status === 'rejected'));
    await tick();
  } finally {
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
    Object.assign(globalThis, { ClipboardItem: previousClipboardItem }); dom.window.close();
  }
});
test('retirement after accepted data rejects both promised browser formats before fulfillment', async () => {
  const dom = new JSDOM(); const blobs: Promise<Blob>[] = [];
  Object.assign(globalThis, { window: dom.window });
  const previousItem = globalThis.ClipboardItem;
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  class Item { constructor(data: Record<string, Promise<Blob>>) { blobs.push(...Object.values(data)); } }
  Object.assign(globalThis, { ClipboardItem: Item });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { write: async () => { await Promise.all(blobs); } } } });
  try {
    const controller = new BrowserLocalMenuController(undefined); let checks = 0;
    controller.copy(async () => ({ text: '过期', html: '<b>过期</b>' }), () => {
      if (++checks === 2) queueMicrotask(() => controller.retire());
      return true;
    }, () => assert.fail('retired copy must not notify'));
    const results = await Promise.allSettled(blobs);
    assert.equal(results.length, 2); assert(results.every(result => result.status === 'rejected'));
    await tick();
  } finally {
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
    Object.assign(globalThis, { ClipboardItem: previousItem }); dom.window.close();
  }
});
