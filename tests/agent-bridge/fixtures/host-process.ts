import { BridgeHost, attachGateway } from '../../../apps/agent-bridge-host/src/index.js';
import { localTestBackend } from './local-backend.js';
import { guardMainThread } from './main-thread-guard.js';
if (process.env.GUARD_IO === '1') guardMainThread();
const host = await BridgeHost.open({ path: process.env.TEST_DB!, backend: localTestBackend(), policy: { id: 'bridge-test', capacity: { cpuMillis: 16000, memoryBytes: 32 * 1024 ** 3 } }, requestTimeoutMs: 500 });
const gateway = await attachGateway(host, process.env.TEST_TOKEN!);
process.send?.({ url: gateway.url, pid: process.pid });
process.on('message', async message => {
  if (message === 'close') { await gateway.close(); await host.close(); process.exit(0); }
});
