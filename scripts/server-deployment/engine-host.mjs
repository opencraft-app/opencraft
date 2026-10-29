import { ModelPolicyStore } from '@opencraft/model-usage-policy';
import { existsSync as existsSyncEntry, realpathSync as realpathSyncEntry } from 'node:fs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { acquireLock, bootIdentity } from '../full-upgrade/durable.mjs';
import { inspectOwnerCgroup } from './owner-cgroup.mjs';
import { PiRemoteInputs } from './pi-remote-inputs.mjs';
import { PiOwnerHandoff } from './pi-owner-handoff.mjs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, join } from 'node:path';
import lockfile from 'proper-lockfile';
import { startEngineHost } from '../../apps/local-agent-host/src/engine-host.ts';
import { RemoteEngineProvider } from '../../apps/local-agent-host/src/remote-engine-provider.ts';
import { attachEngineHost } from './engine-host-client.mjs';
import { handleHostInput } from '../../apps/local-agent-host/src/host-input-http.ts';
import { createPiModelConfiguration } from '../../apps/local-agent-host/src/model-config/pi-adapter.ts';
import { PiEngine, piHandoffReconciliation } from '../../plugins/pi-engine/src/index.ts';
import { RemoteSessionCapabilities } from '../../packages/session-capabilities/src/remote.ts';
import { THREAD_ORCHESTRATION_TOOLS } from '../../packages/appserver-protocol/src/collaboration.ts';
import { readDaemonMachineIdentity } from '../../apps/opencraft-daemon/src/machine-identity.ts';
import { attachDshHost, readPrivateJson } from './dsh-host-client.mjs';

/** Owns Pi execution independently of a versioned gateway. DSH remains in its
 * existing pinned Host; this process only attaches to it. */
export async function startIndependentEngineHost(options) {
  const { descriptorPath, dataDirectory, dshDescriptorPath, runtimeDirectory } = options;
  if (
    ![descriptorPath, dataDirectory, runtimeDirectory].every((value) => typeof value === 'string' && isAbsolute(value))
  )
    throw new Error('Engine Host requires absolute descriptor, data and runtime paths');
  const engines = options.engines ?? ['dsh', 'pi'],
    defaultEngine = options.defaultEngine ?? engines[0];
  if (
    !engines.includes('pi') ||
    engines.some((engine) => !['dsh', 'pi', 'dsh-acp', 'acp', 'claude-code'].includes(engine)) ||
    new Set(engines).size !== engines.length ||
    !engines.includes(defaultEngine)
  )
    throw new Error('Invalid independent engine selection');
  if (engines.includes('dsh') && !isAbsolute(dshDescriptorPath ?? ''))
    throw new Error('Independent DSH descriptor required');
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  // Acquired before loading catalogs, schedules or sessions. Never share the Pi writer.
  const releaseKernel = await acquireLock(join(dataDirectory, 'pi-writer.lock')).catch(error => { throw new Error('Pi writer already being held or unavailable', { cause: error }); });
  let release;
  try { release = await lockfile.lock(join(dataDirectory, 'pi-owner'), { realpath: false, retries: 0 }); }
  catch (error) { await releaseKernel(); throw error; }
  const runtime = { entrySha256: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'), node: process.version, nodeAbi: process.versions.modules, sourceRevision:process.env.OPENCRAFT_OBSERVE_SOURCE_REVISION ?? null, buildId:process.env.OPENCRAFT_OBSERVE_BUILD_ID ?? null, configSha256:createHash('sha256').update(JSON.stringify(options)).digest('hex') };
  const bootId = await bootIdentity();
  const handoff = new PiOwnerHandoff(dataDirectory, runtime, inspectOwnerCgroup);
  let host, pi, server, closed;
  const temporary = `${descriptorPath}.${randomUUID()}.tmp`,
    token = randomUUID();
  try {
    await Promise.all(['pi','projects','models'].map(name => mkdir(join(dataDirectory,name), { recursive:true, mode:0o700 })));
    new ModelPolicyStore(join(dataDirectory, "model-usage-policy.sqlite")).close();
    await handoff.load();
    const machine = await readDaemonMachineIdentity(dataDirectory, options.machineName);
    const scope = `server:${machine.machineId}:pi`;
    const capabilities = new RemoteSessionCapabilities(dataDirectory, scope);
    pi = new PiEngine({
      ...(await createPiModelConfiguration(join(dataDirectory, 'models'), join(dataDirectory, 'pi'))),
      modelPolicyPath: join(dataDirectory, "model-usage-policy.sqlite"),
      admission: handoff, dataDirectory, directory: join(dataDirectory, 'pi'),
      attachmentDirectory: join(dataDirectory, 'agent', 'attachments'),
      cwd: runtimeDirectory,
      sessionCapabilities: capabilities,
    });
    pi.setOrchestration({ tools: THREAD_ORCHESTRATION_TOOLS,
      call: (threadId, turnId, callId, name, args, signal, inputId) => capabilities.orchestration(threadId, {
        turnId, callId, name, arguments: args, incarnation: pi.orchestrationIncarnation, ...(inputId ? { inputId } : {}),
      }, signal),
    });
    const remoteInputs = new Map(), remoteOrigins = new Map();
    const remotes = [];
    for (const id of engines.filter(id => !['pi', 'dsh'].includes(id))) {
      const remote = options.remoteEngines?.find(remote => remote.id === id);
      if (!isAbsolute(remote?.descriptorPath ?? '') || !isAbsolute(remote?.dataDirectory ?? '')) throw new Error('Independent ACP descriptor and data directory required');
      const attachment = await attachEngineHost(remote.descriptorPath, remote.dataDirectory, machine.machineId, [id], id);
      const prefix = id === 'dsh-acp' ? 'dsh_acp_' : id === 'claude-code' ? 'claude_' : 'acp_';
      remotes.push(new RemoteEngineProvider(id, id, prefix, `${id}:`, attachment)); remoteInputs.set(id, attachment.inputs); remoteOrigins.set(id, attachment.getExecutionIdentity);
    }
    const remoteInputCustody = new PiRemoteInputs(join(dataDirectory,'pi'), remoteInputs, handoff);
    await remoteInputCustody.load();
    const inputs = {
      receipt: (threadId,inputId) => threadId.startsWith('pi_') ? pi.inputs.receipt(threadId,inputId) : remoteInputCustody.receipt(threadId,inputId),
      submit: (threadId,inputId,text,admit) => threadId.startsWith('pi_') ? pi.inputs.submit(threadId,inputId,text,admit) : remoteInputCustody.submit(threadId,inputId,text,admit),
    };
    host = await startEngineHost({
      providers: [pi, ...remotes],
      defaultEngine,
      machine, strictClose: true, admitRequest: (method, operation) => handoff.run(operation, piHandoffReconciliation(method)),
      resources: {
        projectDirectory: join(dataDirectory, 'projects'),
        attachmentDirectory: join(dataDirectory, 'agent', 'attachments'),
      },
      ...(engines.includes('dsh')
        ? {
            legacy: {
              id: 'dsh',
              label: 'DeepSeek Harness',
              start: () => attachDshHost(dshDescriptorPath, join(dataDirectory, 'agent'), machine.machineId),
            },
          }
        : {}),
    });
    runtime.machineId = machine.machineId;
    handoff.attach(pi, host, remotes, remoteInputCustody);
    if (!host.ready) throw new Error('Independent execution engine did not become ready');
    server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/host-inputs') {
        void handleHostInput(request, response, token, inputs, (threadId, inputId) =>
          new RemoteSessionCapabilities(dataDirectory, `server:${machine.machineId}:${threadId.startsWith('pi_') ? 'pi' : threadId.startsWith('dsh_acp_') ? 'dsh-acp' : threadId.startsWith('claude_') ? 'claude-code' : 'acp'}`).authorizeInput(threadId, inputId),
        );
        return;
      }
      if (url.pathname === '/owner-handoff' && request.method === 'POST') {
        if (request.headers.origin !== undefined || request.headers.authorization !== `Bearer ${token}`) { response.writeHead(403); response.end(); return; }
        void (async () => {
          const chunks = []; let size = 0;
          for await (const chunk of request) { size += chunk.length; if (size > 4096) throw new Error('Control body too large'); chunks.push(chunk); }
          const { action, ...input } = JSON.parse(Buffer.concat(chunks).toString());
          if (!['fence','inspect','release','cold-ready','resume'].includes(action) || Object.keys(input).some(key => !['expectedOwner','expectedEpoch','operationId','fence','identity'].includes(key))) throw new Error('Invalid Pi control');
          const value = await handoff.control(action, input);
          response.writeHead(200, { 'content-type':'application/json', 'cache-control':'no-store' }); response.end(JSON.stringify({ ...value, runtime, bootId, pid:process.pid }));
        })().catch(() => { response.writeHead(409); response.end(JSON.stringify({ error:'owner_handoff_rejected' })); }); return;
      }
      if (url.pathname === '/execution-origin' && request.method === 'GET'
        && request.headers.origin === undefined && request.headers.authorization === `Bearer ${token}`) {
        void (async () => {
          const threadId = url.searchParams.get('threadId');
          if (!threadId || threadId.length > 512) throw new Error('Invalid Thread');
          let pid, turn;
          if (pi.ownsThread(threadId)) pid = process.pid;
          else {
            const id = threadId.startsWith('dsh_acp_') ? 'dsh-acp' : threadId.startsWith('claude_') ? 'claude-code' : threadId.startsWith('acp_') ? 'acp' : 'dsh';
            if (id === 'dsh' && engines.includes(id)) pid = (await (await attachDshHost(dshDescriptorPath, join(dataDirectory,'agent'), machine.machineId)).getIdentity()).enginePid;
            else {
              const origin = remoteOrigins.get(id); if (!origin) throw new Error('Origin unavailable');
              const observation = await origin(threadId); pid = observation.pid; turn = observation.turn;
            }
          }
          response.writeHead(200, {'content-type':'application/json','cache-control':'no-store'});
          response.end(JSON.stringify({threadId,pid,...(turn === undefined ? {} : {turn})}));
        })().catch(() => { response.writeHead(404); response.end('{}'); });
        return;
      }
      if (
        url.pathname !== '/health' ||
        request.method !== 'GET' ||
        request.headers.origin !== undefined ||
        request.headers.authorization !== `Bearer ${token}`
      ) {
        response.writeHead(403);
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(
        JSON.stringify({
          ok: true,
          protocolVersion: 1,
          pid: process.pid,
          machineId: machine.machineId,
          engines,
          defaultEngine,
          storage: host.storageOutcomes, handoff: handoff.authority.snapshot(), runtime, bootId,
        }),
      );
    });
    await new Promise((accept, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', accept);
    });
    await mkdir(dirname(descriptorPath), { recursive: true, mode: 0o700 });
    await writeFile(
      temporary,
      JSON.stringify({
        schemaVersion: 1,
        pid: process.pid,
        machineId: machine.machineId,
        dataDirectory: resolve(dataDirectory),
        engines,
        defaultEngine,
        websocketUrl: host.websocketUrl,
        controlUrl: `http://127.0.0.1:${server.address().port}`,
        token,
      }),
      { mode: 0o600 },
    );
    await rename(temporary, descriptorPath);
    return {
      websocketUrl: host.websocketUrl,
      pid: process.pid, pi, handoff,
      close() {
        return (closed ??= (async () => {
          server.closeAllConnections();
          await new Promise((accept) => server.close(accept));
          if (!handoff.released) await host.close();
          await rm(descriptorPath, { force: true });
          await release(); await releaseKernel();
        })());
      },
    };
  } catch (error) {
    server?.closeAllConnections();
    if (server?.listening) await new Promise((accept) => server.close(accept));
    if (host) await host.close();
    else await pi?.close();
    await rm(temporary, { force: true });
    await release(); await releaseKernel();
    throw error;
  }
}

if (process.argv[1] && existsSyncEntry(process.argv[1]) && realpathSyncEntry(process.argv[1]) === realpathSyncEntry(new URL(import.meta.url))) {
  const host = await startIndependentEngineHost(await readPrivateJson(process.env.OPENCRAFT_ENGINE_HOST_CONFIG ?? ''));
  console.log('Independent execution Host ready');
  const stop = () =>
    void host.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
