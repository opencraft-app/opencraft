import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { homedir, networkInterfaces } from 'node:os';
import { dirname, resolve } from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const dataDirectory = resolve(process.env.OPENCRAFT_DEV_DATA_DIRECTORY || resolve(homedir(), '.opencraft/dev-local'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
let child: ReturnType<typeof spawn> | undefined;
let host: Awaited<ReturnType<typeof import('../../apps/local-agent-host/src/main.js').startLocalAgentHost>> | undefined;
let hub: Awaited<ReturnType<typeof import('../../plugins/local-account/src/desktop.js').createDesktopAccountHost>> | undefined;
let collaboration: import('@opencraft/access-control/collaboration').Collaboration | undefined;
let gatewayStore: import('@opencraft/account-pool-host').ModelGatewayStore | undefined;
let hubServer: http.Server | undefined;
let vite: import('vite').ViteDevServer | undefined;
let relayServer: tls.Server | undefined;
let releaseStorage: (() => Promise<void>) | undefined;
let closeOperation: Promise<void> | undefined;
function close(): Promise<void> {
  return closeOperation ??= (async () => {
    child?.kill('SIGTERM');
    await new Promise<void>(done => relayServer ? relayServer.close(() => done()) : done());
    await new Promise<void>(done => hubServer ? hubServer.close(() => done()) : done());
    try { await vite?.close(); } finally {
      try { await host?.close(); } finally {
        try { await collaboration?.close(); } finally {
          try { gatewayStore?.close(); } finally {
            try { await hub?.close(); } finally { await releaseStorage?.(); }
          }
        }
      }
    }
  })();
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  // npm/tsx and the terminal may forward the same shutdown more than once.
  // Every signal joins the same cleanup before any handler exits the process.
  void close().then(() => process.exit(0), () => process.exit(1));
});
async function run(script: string) {
  await new Promise<void>((done, reject) => {
    child = spawn(npm, ['run', script], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
    child.once('error', reject);
    child.once('exit', code => { child = undefined; code === 0 ? done() : reject(new Error(`${script} failed`)); });
  });
}
try {
  // Use the existing pinned engine preparation and Host; never attach to an
  // ambient OPENCRAFT_DSH_URL or another installation's session directory.
  delete process.env.OPENCRAFT_DSH_URL;
  delete process.env.OPENCRAFT_DSH_REPOSITORY;
  await run('prepare:dsh-runtime');
  await run('build:preview-bridge');
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const workspace = resolve(dataDirectory, 'workspace');
  await mkdir(workspace, { recursive: true });
  const devMachineArchive = resolve(dataDirectory, 'dev-machine-bundle.tgz');
  const devArchivePayload = 'opencraft-dev-machine-placeholder';
  await writeFile(devMachineArchive, devArchivePayload);
  let devEnrollmentOrigin = process.env.OPENCRAFT_ENROLLMENT_ORIGIN?.trim() || undefined;
  let devEnrollmentCa: string | undefined;
  let upstreamHostPort = 0;
  if (!devEnrollmentOrigin) {
    const lanIp = Object.values(networkInterfaces())
      .flatMap(entries => entries ?? [])
      .find(entry => entry.family === 'IPv4' && !entry.internal)?.address;
    if (lanIp) {
      try {
        const keyPath = resolve(dataDirectory, 'dev-relay-key.pem');
        const certPath = resolve(dataDirectory, 'dev-relay-cert.pem');
        execFileSync('openssl', [
          'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
          '-nodes', '-days', '2', '-subj', '/CN=opencraft-dev-relay',
          '-addext', `subjectAltName=IP:${lanIp}`, '-keyout', keyPath, '-out', certPath,
        ], { stdio: 'ignore' });
        const [key, cert] = await Promise.all([readFile(keyPath, 'utf8'), readFile(certPath, 'utf8')]);
        relayServer = tls.createServer({ key, cert }, tlsSocket => {
          if (!upstreamHostPort) { tlsSocket.destroy(); return; }
          const upstream = net.connect(upstreamHostPort, '127.0.0.1');
          tlsSocket.pipe(upstream);
          upstream.pipe(tlsSocket);
          tlsSocket.on('error', () => upstream.destroy());
          upstream.on('error', () => tlsSocket.destroy());
        });
        await new Promise<void>((done, reject) => {
          relayServer!.once('error', reject);
          relayServer!.listen(0, lanIp, () => done());
        });
        const relayAddr = relayServer.address();
        if (relayAddr && typeof relayAddr !== 'string') {
          devEnrollmentOrigin = `https://${lanIp}:${relayAddr.port}`;
          devEnrollmentCa = cert;
        }
      } catch {
        relayServer?.close();
        relayServer = undefined;
      }
    }
  }
  const { startLocalAgentHost, acquireLocalAgentStorageOwner } = await import('../../apps/local-agent-host/src/main.js');
  releaseStorage = await acquireLocalAgentStorageOwner(dataDirectory);
  host = await startLocalAgentHost({ dataDirectory, projectlessWorkspaceDirectory: workspace,
    dshExecutable: resolve(root, 'runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'),
    personalMachines: {
      archive: devMachineArchive,
      digest: createHash('sha256').update(devArchivePayload).digest('hex'),
      installer: resolve(root, 'scripts/personal-machine/install.sh'),
      updater: resolve(root, 'scripts/personal-machine/update.mjs'),
      enrollmentOrigin: devEnrollmentOrigin,
      enrollmentCa: devEnrollmentCa,
    } });
  upstreamHostPort = Number(new URL(host.websocketUrl).port);
  const { createDesktopAccountHost } = await import('../../plugins/local-account/src/desktop.js');
  const nodeCrypto = await import('node:crypto');
  const devPasswordHasher = typeof (nodeCrypto as { argon2?: unknown }).argon2 === 'function'
    ? undefined
    : {
        async hash(password: string): Promise<string> {
          const salt = nodeCrypto.randomBytes(16).toString('hex');
          const derived = await new Promise<Buffer>((done, reject) =>
            nodeCrypto.scrypt(password, salt, 32, (err, key) => (err ? reject(err) : done(key))),
          );
          return `$dev-scrypt$${salt}$${derived.toString('hex')}`;
        },
        async verify(password: string, record: { salt: string; passwordDigest: string }) {
          const parts = record.passwordDigest.split('$');
          if (parts.length !== 4 || parts[1] !== 'dev-scrypt') return { ok: false, needsRehash: false };
          const derived = await new Promise<Buffer>((done, reject) =>
            nodeCrypto.scrypt(password, parts[2]!, 32, (err, key) => (err ? reject(err) : done(key))),
          );
          const expected = Buffer.from(parts[3]!, 'hex');
          return {
            ok: expected.length === derived.length && nodeCrypto.timingSafeEqual(derived, expected),
            needsRehash: false,
          };
        },
      };
  hub = await createDesktopAccountHost(
    resolve(dataDirectory, 'hub'),
    () => '<!doctype html><title>OpenCraft Hub</title>',
    { passwordHasher: devPasswordHasher },
  );
  const { Collaboration } = await import('@opencraft/access-control/collaboration');
  const { ImChannelsAppServer } = await import('@opencraft/access-control/im-channels-appserver');
  const { LOGICAL_CLIENT_FIELD } = await import('@opencraft/app-host-protocol');
  const { WebSocketServer } = await import('ws');
  collaboration = new Collaboration(hub.storage, hub.actors, undefined, Date.now, hub.admittedActor);
  collaboration.start();
  const { ModelGatewayStore } = await import('@opencraft/account-pool-host');
  const { modelGatewayHttp, MODEL_GATEWAY_PATH } = await import('@opencraft/account-pool-host/model-gateway-http');
  const { ModelConfigurationRepository, ModelCredentialRepository } = await import('../../apps/local-agent-host/src/model-config/repository.js');
  const { gatewayContributions } = await import('../../apps/local-agent-host/src/model-config/gateway-contributions.js');
  const { fileStateDocumentStore } = await import('@opencraft/document-storage/state-file');
  const { fileSecretStore } = await import('@opencraft/secret-storage/file');
  const { serveNodeHttpExchange } = await import('@opencraft/identity-core/http-exchange-node');
  const hubModelsDir = resolve(dataDirectory, 'hub', 'models');
  await mkdir(hubModelsDir, { recursive: true, mode: 0o700 });
  const modelConfiguration = new ModelConfigurationRepository(fileStateDocumentStore(hubModelsDir));
  const modelCredentials = new ModelCredentialRepository(fileSecretStore(resolve(hubModelsDir, 'secrets')));
  gatewayStore = new ModelGatewayStore(resolve(dataDirectory, 'hub', 'model-gateway.sqlite'));
  const contributions = gatewayContributions({
    models: modelConfiguration,
    credentials: modelCredentials,
    store: () => gatewayStore!,
  });
  let devOrigin: string | null = null;
  const modelGatewayHandler = modelGatewayHttp({
    store: () => gatewayStore!,
    ...contributions,
    authority: request => {
      const cookieHeader = request.headers.cookie ?? '';
      const token = cookieHeader
        .split(';')
        .map(part => part.trim())
        .find(part => part.startsWith('oc_human='))
        ?.slice('oc_human='.length);
      const session = token ? hub!.authenticateSession(token) : null;
      if (!session) return null;
      return {
        actor: session.actorContext.actorId,
        administrator: true,
        origin: devOrigin,
      };
    },
  });
  const channelsWss = new WebSocketServer({ noServer: true });
  hubServer = http.createServer((request, response) => {
    const existingCookie = request.headers.cookie ?? '';
    if (!existingCookie.includes('oc_human=')) {
      const sessionCookie = `oc_human=${hub!.createNativeSession()}; oc_desktop_owner=${hub!.browserProof}`;
      request.headers.cookie = existingCookie ? `${existingCookie}; ${sessionCookie}` : sessionCookie;
    }
    const reqUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (reqUrl.pathname === MODEL_GATEWAY_PATH) {
      void serveNodeHttpExchange(request, response, modelGatewayHandler).then(handled => {
        if (!handled && !response.headersSent) {
          response.statusCode = 404;
          response.end('Not found');
        }
      }).catch(() => {
        if (!response.headersSent) {
          response.statusCode = 500;
          response.end('Model gateway error');
        }
      });
      return;
    }
    void hub!.handle(request, response).then(handled => {
      if (!handled && !response.headersSent) {
        response.statusCode = 404;
        response.end('Not found');
      }
    }).catch(() => {
      if (!response.headersSent) {
        response.statusCode = 500;
        response.end('Hub error');
      }
    });
  });
  hubServer.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/__opencraft_channels') {
      socket.destroy();
      return;
    }
    const cookieHeader = request.headers.cookie ?? '';
    const humanCookie = cookieHeader
      .split(';')
      .map(part => part.trim())
      .find(part => part.startsWith('oc_human='))
      ?.slice('oc_human='.length);
    const token = humanCookie || hub!.createNativeSession();
    const sessionContext = hub!.authenticateSession(token);
    if (!sessionContext) {
      socket.destroy();
      return;
    }
    channelsWss.handleUpgrade(request, socket, head, async ws => {
      const server = new ImChannelsAppServer(() => collaboration!);
      let closed = false;
      const unsub = server.subscribeMessage(frame => {
        if (closed || ws.readyState !== ws.OPEN) return;
        const parsed = JSON.parse(frame) as Record<string, unknown>;
        delete parsed[LOGICAL_CLIENT_FIELD];
        ws.send(JSON.stringify(parsed));
      });
      ws.on('message', data => {
        try {
          const parsed = JSON.parse(String(data)) as Record<string, unknown>;
          parsed[LOGICAL_CLIENT_FIELD] ??= 'dev-ws';
          void server.sendWithContext(JSON.stringify(parsed), sessionContext);
        } catch {
          // Ignore malformed client frames.
        }
      });
      ws.on('close', () => {
        closed = true;
        unsub();
        void server.close();
      });
      try {
        await server.connect();
      } catch {
        ws.close();
      }
    });
  });
  await new Promise<void>((done, reject) => {
    hubServer!.once('error', reject);
    hubServer!.listen(0, '127.0.0.1', () => done());
  });
  const hubAddr = hubServer.address();
  if (!hubAddr || typeof hubAddr === 'string') throw new Error('Local Hub failed to bind');
  // Only Vite sees the private token. Renderer recipes contain a same-origin path.
  process.env.OPENCRAFT_APPSERVER_URL = host.websocketUrl;
  process.env.OPENCRAFT_HUB_URL = `http://127.0.0.1:${hubAddr.port}`;
  process.env.VITE_INCLUDE_LOCAL_ASSETS = 'true';
  process.env.VITE_INCLUDE_HEADLESS_MODEL_SERVICES = 'true';
  process.env.VITE_APPSERVER_HOSTS_JSON = JSON.stringify([{ hostId: 'local', label: 'Local OpenCraft',
    kind: 'local', url: '/appserver', executionLocation: 'Local', workspaceBrowseRoots: [workspace] }]);
  process.env.VITE_WEB_BUILTIN_AGENTS = 'enabled';
  process.env.VITE_HYPERNODE_PLUGIN = 'disabled';
  // An explicit renderer URL must not bypass the authenticated local proxy.
  process.env.VITE_APPSERVER_WS_URL = '';
  const { createServer } = await import('vite');
  vite = await createServer({ root: resolve(root, 'apps/workbench-web'),
    configFile: resolve(root, 'apps/workbench-web/vite.config.ts'),
    server: { host: '127.0.0.1', port: Number(process.env.OPENCRAFT_DEV_PORT || 5173), strictPort: true, open: false },
    plugins: [{ name: 'opencraft-local-admission', configureServer(server) {
      // The proxy carries a private Host credential. A different website must
      // not be able to use it via a cross-site WebSocket to loopback.
      server.httpServer?.prependListener('upgrade', (request, socket) => {
        if (!request.url?.startsWith('/appserver')) return;
        const address = server.httpServer?.address();
        const origin = address && typeof address !== 'string' ? `http://127.0.0.1:${address.port}` : null;
        if (request.headers.origin !== origin || request.headers.host !== origin?.slice(7)) socket.destroy();
      });
    } }],
  });
  await vite.listen();
  const viteAddr = vite.httpServer?.address();
  if (viteAddr && typeof viteAddr !== 'string') {
    devOrigin = `http://127.0.0.1:${viteAddr.port}`;
    hub.setOrigin(devOrigin);
  }
  vite.printUrls();
  console.log('Local execution is ready. Open the page and configure models to start chatting.');
} catch (error) {
  await close();
  // Do not print transport URLs or nested errors containing private credentials.
  console.error('Local development startup failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
