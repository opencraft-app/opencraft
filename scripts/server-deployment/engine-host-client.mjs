import { isAbsolute, resolve } from 'node:path';
import { readPrivateJson } from './dsh-host-client.mjs';

/** A gateway attachment has no execution or storage ownership. Re-read the
 * private descriptor on reconnect; never fall back to an in-process engine. */
export async function attachEngineHost(path, dataDirectory, machineId, engines, defaultEngine) {
  const read = async () => {
    const d = await readPrivateJson(path);
    const ws = new URL(d.websocketUrl),
      control = new URL(d.controlUrl);
    if (
      d.schemaVersion !== 1 ||
      !isAbsolute(d.dataDirectory ?? '') ||
      resolve(d.dataDirectory) !== resolve(dataDirectory) ||
      d.machineId !== machineId ||
      !Number.isSafeInteger(d.pid) ||
      d.pid < 1 ||
      typeof d.token !== 'string' ||
      !d.token ||
      ws.protocol !== 'ws:' ||
      ws.hostname !== '127.0.0.1' ||
      ws.pathname !== '/rpc' ||
      !ws.searchParams.get('token') ||
      ws.username ||
      ws.password ||
      control.protocol !== 'http:' ||
      control.hostname !== '127.0.0.1' ||
      control.pathname !== '/' ||
      control.search ||
      control.hash ||
      control.username ||
      control.password ||
      !Array.isArray(d.engines) ||
      [...d.engines].sort().join() !== [...engines].sort().join() ||
      d.defaultEngine !== defaultEngine
    )
      throw new Error('Engine Host descriptor is incompatible with this deployment');
    const response = await fetch(new URL('/health', control), {
      headers: { authorization: `Bearer ${d.token}` },
      signal: AbortSignal.timeout(5000),
    });
    const health = await response.json();
    if (
      !response.ok ||
      health.ok !== true ||
      health.protocolVersion !== 1 ||
      health.pid !== d.pid ||
      health.machineId !== machineId ||
      health.defaultEngine !== defaultEngine ||
      !Array.isArray(health.engines) ||
      [...health.engines].sort().join() !== [...engines].sort().join()
    )
      throw new Error('Independent execution Host is unavailable');
    return { descriptor: d, health };
  };
  const input = async (action, threadId, inputId, text) => {
    const { descriptor: d } = await read();
    const response = await fetch(new URL('/host-inputs', d.controlUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${d.token}` },
      body: JSON.stringify({ action, threadId, inputId, ...(text === undefined ? {} : { text }) }),
      signal: AbortSignal.timeout(35000),
    });
    if (!response.ok) throw new Error('Execution Host input outcome unknown');
    const { receipt } = await response.json();
    if (
      receipt !== null &&
      (!receipt ||
        !['delivered', 'discarded', 'unknown'].includes(receipt.state) ||
        (receipt.turnId !== null && typeof receipt.turnId !== 'string'))
    )
      throw new Error('Invalid execution Host input receipt');
    return receipt;
  };
  const initial = await read();
  return {
    websocketUrl: initial.descriptor.websocketUrl,
    storageOutcomes: initial.health.storage,
    inputs: {
      receipt: (threadId, inputId) => input('receipt', threadId, inputId),
      submit: async (threadId, inputId, text, canAdmit) =>
        (await canAdmit()) ? input('submit', threadId, inputId, text) : null,
    },
    resolveWebsocketUrl: async () => (await read()).descriptor.websocketUrl,
    getExecutionIdentity: async threadId => {
      if (typeof threadId !== 'string' || !threadId || threadId.length > 512) throw new Error('Execution Thread required');
      const { descriptor: d } = await read();
      const url = new URL('/execution-origin', d.controlUrl); url.searchParams.set('threadId', threadId);
      const response = await fetch(url, { headers: {authorization: `Bearer ${d.token}`}, signal: AbortSignal.timeout(5000) });
      const result = await response.json();
      if (!response.ok || result.threadId !== threadId || result.pid !== null && (!Number.isSafeInteger(result.pid) || result.pid < 1))
        throw new Error('Execution process unavailable');
      if (result.turn !== undefined && result.turn !== null && (typeof result.turn.id !== 'string'
        || typeof result.turn.status !== 'string' || result.turn.inputId !== null && typeof result.turn.inputId !== 'string')) throw new Error('Invalid execution observation');
      return {pid:result.pid,...(result.turn === undefined ? {} : {turn:result.turn})};
    },
    getIdentity: async () => {
      const { health } = await read();
      return { pid: health.pid };
    },
    async close() {},
  };
}

export async function readEngineHostIdentity(path) {
  const descriptor = await readPrivateJson(path);
  const attachment = await attachEngineHost(
    path,
    descriptor.dataDirectory,
    descriptor.machineId,
    descriptor.engines,
    descriptor.defaultEngine,
  );
  return attachment.getIdentity();
}

/** Authenticated owner resolves the physical native generation; never use a
 * wrapper environment incarnation or the routing Host PID for remote ACP. */
export async function readEngineExecutionIdentity(path, threadId) {
  const d = await readPrivateJson(path);
  const attachment = await attachEngineHost(path, d.dataDirectory, d.machineId, d.engines, d.defaultEngine);
  return attachment.getExecutionIdentity(threadId);
}
