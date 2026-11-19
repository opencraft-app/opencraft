import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import type { installBrowserGuests } from './browser-guests.js';

/** Only semantic operations on this window's owned guests cross preload. */
export function installBrowserAutomationIpc(ipc: Pick<IpcMain, 'handle'>, options: {
  trusted(event: IpcMainInvokeEvent): boolean;
  guests(): ReturnType<typeof installBrowserGuests> | null;
}) {
  for (const operation of ['connect', 'invoke', 'cancel', 'release'] as const) {
    ipc.handle(`opencraft:browser-automation-${operation}`, async (event, id: unknown, lease: unknown, requestId: unknown, method: unknown, input: unknown) => {
      try {
        if (!options.trusted(event) || !Number.isSafeInteger(id) || (id as number) <= 0)
          throw Object.assign(new Error('Invalid browser automation caller'), { code: 'INVALID_CALLER' });
        const entry = options.guests()?.require(id as number);
        if (!entry) throw Object.assign(new Error('Browser page unavailable'), { code: 'PAGE_CLOSED' });
        if (operation === 'connect') return { ok: true, value: await entry.automation.connect() };
        if (typeof lease !== 'string' || !/^[a-zA-Z0-9-]{36}$/.test(lease))
          throw Object.assign(new Error('Invalid browser automation client'), { code: 'INVALID_ARGUMENT' });
        if (operation === 'release') { entry.automation.release(lease); return { ok: true }; }
        if (typeof requestId !== 'string' || !/^[a-zA-Z0-9-]{36}$/.test(requestId))
          throw Object.assign(new Error('Invalid browser automation request identity'), { code: 'INVALID_ARGUMENT' });
        if (operation === 'cancel') { entry.automation.cancel(lease, requestId); return { ok: true }; }
        if (typeof method !== 'string' || !['inspect', 'readContext', 'click', 'fill', 'press', 'scroll', 'wait'].includes(method)
          || !input || typeof input !== 'object' || Array.isArray(input))
          throw Object.assign(new Error('Invalid browser automation request'), { code: 'INVALID_ARGUMENT' });
        const value = await entry.automation.invoke(lease, requestId, method as Parameters<typeof entry.automation.invoke>[2], input as Record<string, unknown>);
        return { ok: true, value };
      } catch (error) {
        const failure = error as { code?: string; message?: string; outcome?: string };
        return { ok: false, error: { code: failure.code || 'BROWSER_ERROR', message: failure.message || 'Browser operation failed',
          retryable: false, outcome: failure.outcome || 'not-dispatched' } };
      }
    });
  }
}
