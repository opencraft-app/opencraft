import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import lockfile from 'proper-lockfile';
import { startEngineHost } from '../../apps/local-agent-host/src/engine-host.ts';
import { handleHostInput } from '../../apps/local-agent-host/src/host-input-http.ts';
import { createPiModelConfiguration } from '../../apps/local-agent-host/src/model-config/pi-adapter.ts';
import { PiEngine } from '../../plugins/pi-engine/src/index.ts';
import { RemoteSessionCapabilities } from '../../packages/session-capabilities/src/remote.ts';
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
    engines.some((engine) => !['dsh', 'pi'].includes(engine)) ||
    new Set(engines).size !== engines.length ||
    !engines.includes(defaultEngine)
  )
    throw new Error('Invalid independent engine selection');
  if (engines.includes('dsh') && !isAbsolute(dshDescriptorPath ?? ''))
    throw new Error('Independent DSH descriptor required');
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  // Acquired before loading catalogs, schedules or sessions. Never share the Pi writer.
  const release = await lockfile.lock(join(dataDirectory, 'pi-owner'), { realpath: false, retries: 0 });
  let host, pi, server, closed;
  const temporary = `${descriptorPath}.${randomUUID()}.tmp`,
    token = randomUUID();
  try {
    const machine = await readDaemonMachineIdentity(dataDirectory, options.machineName);
    const scope = `server:${machine.machineId}:pi`;
    const capabilities = new RemoteSessionCapabilities(dataDirectory, scope);
    pi = new PiEngine({
      ...(await createPiModelConfiguration(join(dataDirectory, 'models'), join(dataDirectory, 'pi'))),
      directory: join(dataDirectory, 'pi'),
      cwd: runtimeDirectory,
      sessionCapabilities: capabilities,
    });
    host = await startEngineHost({
      providers: [pi],
      defaultEngine,
      machine,
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
    if (!host.ready) throw new Error('Independent execution engine did not become ready');
    server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/host-inputs') {
        void handleHostInput(request, response, token, pi.inputs, (threadId, inputId) =>
          capabilities.authorizeInput(threadId, inputId),
        );
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
          storage: host.storageOutcomes,
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
      pid: process.pid,
      close() {
        return (closed ??= (async () => {
          try {
            server.closeAllConnections();
            await new Promise((accept) => server.close(accept));
            await host.close();
          } finally {
            await rm(descriptorPath, { force: true });
            await release();
          }
        })());
      },
    };
  } catch (error) {
    server?.closeAllConnections();
    if (server?.listening) await new Promise((accept) => server.close(accept));
    if (host) await host.close();
    else await pi?.close();
    await rm(temporary, { force: true });
    await release();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
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
