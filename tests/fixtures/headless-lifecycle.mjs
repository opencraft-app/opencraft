import { startHeadlessServer } from '../../scripts/headless-application.mjs';
import { mkdir, writeFile, open } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.argv[2];
const webRoot = join(root, 'web');
await mkdir(webRoot, { recursive: true });
await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>Lifecycle fixture</title>');
await writeFile(join(webRoot, 'version.json'), JSON.stringify({ schemaVersion: 1, buildId: 'lifecycle', headlessServer: true, headlessHostId: 'opencraft-server' }));
let finish;
const held = new Promise(resolve => { finish = resolve; });
process.on('message', message => { if (message === 'flush') finish(); });
try {
  const app = await startHeadlessServer({ root, webRoot, dataDirectory: join(root, 'data'), port: 0,
    startAgentHost: async () => ({ websocketUrl: 'ws://127.0.0.1:9/rpc', async close() {
      process.send({ event: 'flushing' });
      await held;
      const file = await open(join(root, 'flushed'), 'w', 0o600);
      try { await file.writeFile('durable'); await file.sync(); } finally { await file.close(); }
    } }),
  });
  process.send({ event: 'ready', pid: process.pid });
  process.once('SIGTERM', async () => {
    try { await app.close(); process.exit(0); }
    catch (error) { process.send({ event: 'error', code: error.code, message: error.message }); process.exit(1); }
  });
} catch (error) {
  process.send({ event: 'error', code: error.code, message: error.message }); process.exit(1);
}
