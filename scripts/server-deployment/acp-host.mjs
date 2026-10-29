import { ExecutionEnvironmentRuntime } from "../execution-environment.ts";
import { existsSync as existsSyncEntry, realpathSync as realpathSyncEntry } from 'node:fs';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import lockfile from 'proper-lockfile';
import { acquireLock, bootIdentity } from '../full-upgrade/durable.mjs';
import { startEngineHost } from '../../apps/local-agent-host/src/engine-host.ts';
import { handleHostInput } from '../../apps/local-agent-host/src/host-input-http.ts';
import { AcpGenerationHost } from '../../plugins/acp-engine/src/generations.ts';
import { createDshAcpHistory } from './dsh-acp-history.mjs';
import { dshAcpCommand } from '../../plugins/acp-engine/src/index.ts';
import { RemoteSessionCapabilities } from '../../packages/session-capabilities/src/remote.ts';
import { THREAD_ORCHESTRATION_TOOLS } from '../../packages/appserver-protocol/src/collaboration.ts';
import { readDaemonMachineIdentity } from '../../apps/opencraft-daemon/src/machine-identity.ts';
import { readPrivateJson } from './dsh-host-client.mjs';

export { inspectOwnerCgroup as inspectAcpCgroup } from './owner-cgroup.mjs';
import { inspectOwnerCgroup as inspectAcpCgroup } from './owner-cgroup.mjs';

/** Explicit independent ACP/Claude process owner. A gateway only attaches to
 * its descriptor; generation changes are private local control operations. */
export async function startIndependentAcpHost(options) {
  const { descriptorPath, dataDirectory, runtimeDirectory, id = 'acp', initialGeneration } = options;
  if (![descriptorPath, dataDirectory, runtimeDirectory].every(path => typeof path === 'string' && isAbsolute(path))
    || !['acp', 'dsh-acp', 'claude-code'].includes(id)) throw new Error('Invalid independent ACP Host configuration');
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const releaseKernel = await acquireLock(join(dataDirectory, 'acp-writer.lock'));
  let release;
  try { release = await lockfile.lock(join(dataDirectory, 'acp-owner'), { realpath: false, retries: 0 }); } catch (error) { await releaseKernel(); throw error; }
  const bootId = await bootIdentity();
  const runtime = { entrySha256: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
    sourceRevision: process.env.OPENCRAFT_OBSERVE_SOURCE_REVISION ?? null, buildId: process.env.OPENCRAFT_OBSERVE_BUILD_ID ?? null,
    node: process.version, nodeAbi: process.versions.modules };
  const temporary = `${descriptorPath}.${randomUUID()}.tmp`, token = randomUUID();
  let provider, host, server, closed;
  try {
    const identityDirectory = options.machineIdentityDirectory ?? dataDirectory;
    const machine = await readDaemonMachineIdentity(identityDirectory, options.machineName);
    const capabilities = new RemoteSessionCapabilities(options.sessionCapabilitiesDirectory ?? identityDirectory, `server:${machine.machineId}:${id}`);
    provider = new AcpGenerationHost({ id, dataDirectory, initialGeneration, inspectOsWork: inspectAcpCgroup,
      runtimeIdentity: runtime.entrySha256, readConfig: async (path, generationId) => {
      const config = await readPrivateJson(path);
      config.executionEnvironment = ExecutionEnvironmentRuntime.open(identityDirectory);
      // The runtime that supplies the ACP profile is explicit and versioned by
      // the operator. Never replace or restart the previous DSH web owner.
      if (id === 'dsh-acp') {
        if (!isAbsolute(config.dshEntry ?? '')) throw new Error('DSH ACP generation requires an explicit runtime entry');
        const nativeHome = join(dataDirectory, 'native', generationId);
        const history = await createDshAcpHistory({ dshEntry: config.dshEntry, nativeHome: config.nativeHistoryRoot ?? join(nativeHome, 'sessions'), cacheDirectory: join(dataDirectory, 'history', generationId), compression: config.nativeHistoryCompression ?? 'zstd' });
        return { ...config, ...dshAcpCommand(config.dshEntry, config.patches), history, id, cwd: config.cwd ?? runtimeDirectory };
      }
      return { ...config, id, cwd: config.cwd ?? runtimeDirectory };
    } });
    provider.setOrchestration({ tools: THREAD_ORCHESTRATION_TOOLS,
      call: (threadId, turnId, callId, name, args, signal, inputId) => capabilities.orchestration(threadId, {
        incarnation: provider.incarnation(threadId), turnId, callId, name, arguments: args, ...(inputId ? { inputId } : {}),
      }, signal),
    });
    host = await startEngineHost({ providers: [provider], defaultEngine: id, machine, strictClose: true,
      admitRequest: (method, operation) => provider.admitHostRequest(method, operation) });
    if (!host.ready) throw new Error('Independent ACP Host did not become ready');
    server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/host-inputs') {
        void handleHostInput(request, response, token, provider.inputs, (threadId, inputId) => capabilities.authorizeInput(threadId, inputId)); return;
      }
      if (request.headers.origin !== undefined || request.headers.authorization !== `Bearer ${token}`) { response.writeHead(403); response.end(); return; }
      if (url.pathname === '/execution-origin' && request.method === 'GET') {
        try {
          const threadId = url.searchParams.get('threadId');
          if (!threadId || threadId.length > 512) throw new Error('Invalid Thread');
          const observation = provider.executionObservation(threadId);
          response.writeHead(200, {'content-type':'application/json','cache-control':'no-store'});
          response.end(JSON.stringify({threadId,...observation}));
        } catch { response.writeHead(404); response.end('{}'); }
        return;
      }
      if (url.pathname === '/owner-handoff' && request.method === 'POST') {
        void (async () => {
          const chunks = []; let size = 0;
          for await (const chunk of request) { size += chunk.length; if (size > 4096) throw new Error('Control body too large'); chunks.push(chunk); }
          const { action, ...input } = JSON.parse(Buffer.concat(chunks).toString());
          if (!['fence','inspect','release','cold-ready','resume'].includes(action) || Object.keys(input).some(key => !['expectedOwner','expectedEpoch','operationId','fence','identity'].includes(key))) throw new Error('Invalid Host control');
          const value = await provider.ownerControl(action, input);
          response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify({ ...value, bootId, runtime, pid: process.pid }));
        })().catch(() => { response.writeHead(409); response.end(JSON.stringify({ error: 'owner_handoff_rejected' })); }); return;
      }
      if (url.pathname === '/health'  && request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ ok: true, protocolVersion: 1, pid: process.pid, machineId: machine.machineId,
          engines: [id], defaultEngine: id, bootId, runtime, storage: host.storageOutcomes, ...provider.snapshot(), occupancy: provider.occupancy() })); return;
      }
      if (url.pathname === '/generations' && request.method === 'POST') {
        void (async () => {
          const chunks = []; let size = 0;
          for await (const chunk of request) { size += chunk.length; if (size > 16384) throw new Error('Control body too large'); chunks.push(chunk); }
          const { action, ...input } = JSON.parse(Buffer.concat(chunks).toString());
          if (!['add', 'activate', 'suspend', 'retire', 'preparation'].includes(action) || Object.keys(input).some(key => !['id', 'configPath', 'expectedCurrent', 'expectedEpoch', 'expectedOwner', 'operationId', 'preparation'].includes(key))) throw new Error('Invalid generation operation');
          const result = await provider.manage(action, input);
          response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(result));
        })().catch(() => { response.writeHead(409); response.end(JSON.stringify({ error: 'generation_operation_rejected' })); }); return;
      }
      response.writeHead(404); response.end();
    });
    await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
    await mkdir(dirname(descriptorPath), { recursive: true, mode: 0o700 });
    await writeFile(temporary, JSON.stringify({ schemaVersion: 1, pid: process.pid, machineId: machine.machineId,
      dataDirectory: resolve(dataDirectory), engines: [id], defaultEngine: id, websocketUrl: host.websocketUrl,
      controlUrl: `http://127.0.0.1:${server.address().port}`, token }), { mode: 0o600 });
    await rename(temporary, descriptorPath);
    return { websocketUrl: host.websocketUrl, provider, async close() {
      return closed ??= (async () => {
        try { server.closeAllConnections(); await new Promise(accept => server.close(accept)); await host.close(); }
        finally { await rm(descriptorPath, { force: true }); }
        await release(); await releaseKernel();
      })();
    } };
  } catch (error) {
    server?.closeAllConnections(); if (server?.listening) await new Promise(accept => server.close(accept));
    if (host) await host.close(); else await provider?.close();
    await rm(temporary, { force: true }); await release(); await releaseKernel(); throw error;
  }
}

if (process.argv[1] && existsSyncEntry(process.argv[1]) && realpathSyncEntry(process.argv[1]) === realpathSyncEntry(new URL(import.meta.url))) {
  const host = await startIndependentAcpHost(await readPrivateJson(process.env.OPENCRAFT_ACP_HOST_CONFIG ?? ''));
  console.log('Independent ACP Host ready');
  const stop = () => void host.close().then(() => process.exit(0), () => process.exit(1));
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}
