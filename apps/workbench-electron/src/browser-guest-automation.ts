import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';
import { createElectronCdpOwner, type ElectronCdpOwner } from '@opencraft/browser-cdp/electron';
import { createCdpAutomation, type CdpAutomation } from '@opencraft/browser-cdp/automation';

function unavailable(code: string, message: string) {
  return Object.assign(new Error(message), { code, retryable: false, outcome: 'not-dispatched' });
}

/** Main owns the native connection; renderer clients borrow document leases. */
export function createGuestAutomation(guest: WebContents, document: () => number, owned: () => boolean) {
  const leases = new Map<string, { generation: number; controller: AbortController; calls: Map<string, AbortController> }>();
  let owner: ElectronCdpOwner | undefined, automation: CdpAutomation | undefined, disposed = false;
  function validate(generation: number) {
    if (disposed || guest.isDestroyed() || !owned()) throw unavailable('PAGE_CLOSED', 'Browser page closed');
    if (document() !== generation) throw unavailable('DOCUMENT_CHANGED', 'Browser document changed');
  }
  const api = {
    async connect() {
      const generation = document(); validate(generation);
      if (leases.size >= 8) throw unavailable('AUTOMATION_BUSY', 'Too many browser automation clients');
      if (!owner) {
        owner = createElectronCdpOwner(guest, {
          initializeTarget: async send => { await send('Emulation.setFocusEmulationEnabled', { enabled: true }); },
        });
        automation = createCdpAutomation({ transport: owner, sessions: () => owner!.targetSessions(), instanceId: randomUUID(), platform: process.platform,
          acquireDrawing() {
            const previous = guest.getBackgroundThrottling();
            guest.setBackgroundThrottling(false);
            return () => { if (!guest.isDestroyed()) guest.setBackgroundThrottling(previous); };
          },
        });
      }
      await owner.ready; validate(generation);
      if (leases.size >= 8) throw unavailable('AUTOMATION_BUSY', 'Too many browser automation clients');
      const lease = randomUUID();
      leases.set(lease, { generation, controller: new AbortController(), calls: new Map() });
      return { lease, capabilities: automation!.capabilities };
    },
    async invoke(lease: string, requestId: string, method: Parameters<CdpAutomation['invoke']>[0], input: Readonly<Record<string, unknown>>) {
      const client = leases.get(lease);
      if (!client || !automation) throw unavailable('DOCUMENT_CHANGED', 'Browser automation client expired');
      if (client.calls.size >= 16 || client.calls.has(requestId)) throw unavailable('AUTOMATION_BUSY', 'Browser automation request limit reached');
      const controller = new AbortController(); client.calls.set(requestId, controller);
      const check = () => {
        validate(client.generation);
        if (leases.get(lease) !== client) throw unavailable('DOCUMENT_CHANGED', 'Browser automation client expired');
        if (!['inspect', 'readContext', 'wait'].includes(method) && !guest.isFocused())
          throw unavailable('CONTROL_LOST', 'Browser input focus changed');
      };
      try {
        check();
        return await automation.invoke(method, input, { signal: AbortSignal.any([client.controller.signal, controller.signal]), validate: check });
      } finally { client.calls.delete(requestId); }
    },
    cancel(lease: string, requestId: string) { leases.get(lease)?.calls.get(requestId)?.abort(); },
    release(lease: string) { leases.get(lease)?.controller.abort(); leases.delete(lease); },
    retireDocument() { for (const lease of leases.keys()) api.release(lease); },
    dispose() {
      if (disposed) return;
      disposed = true; api.retireDocument(); automation?.dispose(); owner?.dispose();
    },
  };
  return api;
}
