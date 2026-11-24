import { readFile, stat } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { isAbsolute, resolve } from 'node:path';

export async function readPrivateJson(path) {
  if (!isAbsolute(path)) throw new Error('DSH Host configuration requires an absolute path');
  const info = await stat(path);
  if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0)
    throw new Error('DSH Host configuration must be an owned private file');
  return JSON.parse(await readFile(path, 'utf8'));
}

/** A descriptor source: a private descriptor file (the Host's own container), or a
 * function (a Gateway resolving a workspace endpoint, whose local listener replaces
 * the in-environment socket). Re-read on every attach and reconnect. */
export function descriptorReader(source) {
  if (typeof source === 'function') return source;
  return () => readPrivateJson(source);
}

/** An independent Host listens on loopback TCP (`ws://127.0.0.1:<port>/rpc`) or on a
 * private Unix socket (`ws+unix:///abs/host.sock:/rpc`). Returns the transport or throws. */
export function privateHostWebsocket(raw) {
  const url = new URL(raw);
  if (url.username || url.password || url.hash || !url.searchParams.get('token')) throw new Error('Invalid Host websocket');
  if (url.protocol === 'ws:' && url.hostname === '127.0.0.1' && url.pathname === '/rpc') return { url, origin: `http://${url.host}` };
  const at = url.pathname.lastIndexOf(':');
  if (url.protocol === 'ws+unix:' && url.hostname === '' && at > 0 && url.pathname.slice(at + 1) === '/rpc'
    && isAbsolute(url.pathname.slice(0, at))) return { url, socketPath: url.pathname.slice(0, at) };
  throw new Error('Invalid Host websocket');
}

/** Rewrites a Host websocket URL onto another private socket (a local endpoint listener). */
export function websocketOnSocket(raw, socketPath) {
  const { url } = privateHostWebsocket(raw);
  if (!isAbsolute(socketPath)) throw new Error('Endpoint socket must be absolute');
  return `ws+unix://${socketPath}:/rpc${url.search}`;
}

/** One HTTP request to a Host's control routes over its websocket transport (or a TCP control URL). */
export function hostRequest(base, path, { method = 'GET', headers = {}, body, timeoutMs = 5000 } = {}) {
  const target = base.startsWith('http:') ? { origin: new URL(base).origin } : privateHostWebsocket(base);
  if (target.origin) return fetch(new URL(path, target.origin), { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
  return new Promise((accept, reject) => {
    const req = httpRequest({ socketPath: target.socketPath, path, method, headers: { ...headers, host: 'localhost' }, signal: AbortSignal.timeout(timeoutMs) }, response => {
      const chunks = []; let size = 0;
      response.on('data', chunk => { size += chunk.length; if (size > 16 * 1024 * 1024) req.destroy(new Error('Host response too large')); else chunks.push(chunk); });
      response.on('error', reject);
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        accept({ ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode, json: async () => JSON.parse(text) });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** Attach to the whole Host, including its execution journal and capability bridge.
 * An execution gateway never opens its stores or terminates its process. */
async function readDshHost(read, expectedDataDirectory, expectedMachineId) {
  const descriptor = await read();
  let transport;
  try { transport = privateHostWebsocket(descriptor.websocketUrl); } catch { transport = undefined; }
  if (descriptor.schemaVersion !== 1 || !transport
    || !isAbsolute(descriptor.dataDirectory) || resolve(descriptor.dataDirectory) !== resolve(expectedDataDirectory)
    || (expectedMachineId !== undefined && descriptor.machineId !== expectedMachineId)
    || !Number.isSafeInteger(descriptor.pid) || descriptor.pid < 1)
    throw new Error('DSH Host descriptor is incompatible with this deployment');
  const response = await hostRequest(descriptor.websocketUrl, '/health');
  const health = await response.json();
  if (!response.ok || health.ok !== true || health.engine !== 'dsh' || health.pid !== descriptor.pid
    // A Host bridges DSH only when it is installed; without it the Host runs with no native engine.
    || (health.enginePid !== null && (!Number.isSafeInteger(health.enginePid) || health.enginePid < 1))
    || (health.engineIncarnation !== undefined && health.engineIncarnation !== null
      && (typeof health.engineIncarnation !== 'string' || !health.engineIncarnation || health.engineIncarnation.length > 512)))
    throw new Error('Independent DSH Host is unavailable');
  // PIDs are the Host's own namespace; only the reported incarnation is comparable here.
  return { websocketUrl: descriptor.websocketUrl, storageOutcomes: health.storage, hostInputs: health.hostInputs === 1,
    identity: { pid: health.pid, enginePid: health.enginePid },
    engineExecution: health.enginePid === null || !health.engineIncarnation ? null : { pid: health.enginePid, incarnation: health.engineIncarnation } };
}

/** Runs one owner read through the source's placement fence when it has one (a Gateway's
 * workspace endpoint: the same agent incarnation before and after), else directly. */
export function fencedRead(source, operation) {
  return typeof source?.fence === 'function' ? source.fence(operation) : operation();
}

export async function attachDshHost(source, expectedDataDirectory, expectedMachineId) {
  const descriptor = descriptorReader(source);
  const read = () => readDshHost(descriptor, expectedDataDirectory, expectedMachineId);
  const input = async (action, threadId, inputId, text) => {
    const host = await read(); if (!host.hostInputs) return null; // No native attempt on an older Host; safe until drained upgrade.
    const token = new URL(host.websocketUrl).searchParams.get('token');
    const response = await hostRequest(host.websocketUrl, '/host-inputs', {
      method: 'POST', headers: {'content-type':'application/json', Authorization:'Bearer '+token},
      body: JSON.stringify({action,threadId,inputId,...(text === undefined ? {} : {text})}), timeoutMs: 35_000,
    });
    if (!response.ok) throw new Error('DSH input outcome unknown');
    const result = await response.json(), receipt = result?.receipt;
    if (result?.ownerReceipt) {
      const confirmed = await hostRequest(host.websocketUrl, '/host-inputs', {
        method:'POST',headers:{'content-type':'application/json',Authorization:'Bearer '+token},
        body:JSON.stringify({action:'ack',ownerReceipt:result.ownerReceipt}),timeoutMs:5000,
      });
      if (!confirmed.ok || (await confirmed.json()).accepted !== true) throw new Error('DSH consumer acknowledgment unknown');
    }
    if (receipt !== null && (!receipt || !['delivered','discarded','unknown'].includes(receipt.state)
      || receipt.turnId !== null && typeof receipt.turnId !== 'string')) throw new Error('Invalid DSH input receipt');
    return receipt;
  };
  const { engineExecution: _initialEngine, ...initial } = await read();
  return { ...initial,
    inputs: { receipt: (threadId,inputId) => input('receipt',threadId,inputId),
      submit: async (threadId,inputId,text,canAdmit) => await canAdmit() ? input('submit',threadId,inputId,text) : null },
    resolveWebsocketUrl: async () => (await read()).websocketUrl,
    getIdentity: async () => (await read()).identity,
    /** The engine process holding DSH executions, as the Host reports it; null when none. */
    engineExecutionIdentity: async () => (await fencedRead(source, read)).engineExecution,
    async close() {} };
}

/** A configured independent Host exists before a lazy engine client attaches. */
export async function readDshHostIdentity(source) {
  const read = descriptorReader(source);
  const descriptor = await read();
  return (await readDshHost(read, descriptor.dataDirectory)).identity;
}
