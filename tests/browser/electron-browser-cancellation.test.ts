import test from 'node:test';
import assert from 'node:assert/strict';
import { createElectronBrowserAutomation } from '../../apps/workbench-web/src/browser/electron-browser-automation.js';

test('Electron automation cancels the exact native request and rejects late success without replay', async () => {
  const document = Object.assign(new EventTarget(), { activeElement: null, defaultView: new EventTarget() });
  const guest = { ownerDocument: document, getWebContentsId: () => 7 } as any;
  const cancelled: unknown[] = []; let calls = 0, enter!: () => void, release!: (value: any) => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const automation = createElectronBrowserAutomation(guest, {
    async connectAutomation() { return { ok: true, value: { lease: 'lease', capabilities: {} as any } }; },
    invokeAutomation(_guest, _lease, requestId, method) {
      calls++; assert.equal(method, 'wait'); enter();
      return new Promise(resolve => { release = resolve; (guest as any).requestId = requestId; });
    },
    async cancelAutomation(...args) { cancelled.push(args); release({ ok: true, value: undefined }); },
    async releaseAutomation() {},
  });
  const controller = new AbortController();
  const waiting = automation.wait({ text: 'never', timeoutMs: 30000 }, { signal: controller.signal });
  const rejected = assert.rejects(waiting, { code: 'CDP_ABORTED', outcome: 'unknown' });
  await entered; controller.abort(); controller.abort(); await rejected;
  assert.deepEqual(cancelled, [[7, 'lease', guest.requestId]]);
  assert.equal(calls, 1);
  await assert.rejects(automation.wait({ text: 'never', timeoutMs: 30000 }, { signal: controller.signal }), { code: 'CDP_ABORTED', outcome: 'not-dispatched' });
  assert.equal(calls, 1);
  automation.dispose();
});
