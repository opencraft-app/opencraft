import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDirectory = resolve(process.env.OPENCRAFT_DEV_DATA_DIRECTORY || resolve(homedir(), '.opencraft/dev-local'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
let child: ReturnType<typeof spawn> | undefined;
let host: Awaited<ReturnType<typeof import('../apps/local-agent-host/src/main.js').startLocalAgentHost>> | undefined;
let vite: import('vite').ViteDevServer | undefined;
let releaseStorage: (() => Promise<void>) | undefined;
let closeOperation: Promise<void> | undefined;
function close(): Promise<void> {
  return closeOperation ??= (async () => {
    child?.kill('SIGTERM');
    try { await vite?.close(); } finally {
      try { await host?.close(); } finally { await releaseStorage?.(); }
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
  const { startLocalAgentHost, acquireLocalAgentStorageOwner } = await import('../apps/local-agent-host/src/main.js');
  releaseStorage = await acquireLocalAgentStorageOwner(dataDirectory);
  host = await startLocalAgentHost({ dataDirectory, projectlessWorkspaceDirectory: workspace,
    dshExecutable: resolve(root, 'runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js') });
  // Only Vite sees the private token. Renderer recipes contain a same-origin path.
  process.env.OPENCRAFT_APPSERVER_URL = host.websocketUrl;
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
  vite.printUrls();
  console.log('Local execution is ready. Open the page and configure models to start chatting.');
} catch (error) {
  await close();
  // Do not print transport URLs or nested errors containing private credentials.
  console.error('Local development startup failed. Check the preceding build output and whether the Web port is available.');
  process.exitCode = 1;
}
