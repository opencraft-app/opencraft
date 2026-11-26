import { writeFile } from 'node:fs/promises';
import { BridgeHost, attachGateway } from '../../../apps/agent-bridge-host/src/index.js';
import { localTestBackend } from './local-backend.js';
import { guardMainThread } from './main-thread-guard.js';
if (process.env.GUARD_IO === '1') guardMainThread();
const cliIssueMarker = process.env.TEST_CLI_ISSUE_MARKER;
const host = await BridgeHost.open({
  path: process.env.TEST_DB!, backend: localTestBackend(),
  policy: { id: 'bridge-test', capacity: { cpuMillis: 16000, memoryBytes: 32 * 1024 ** 3 } },
  requestTimeoutMs: 500,
  executionCli: cliIssueMarker ? {
    async issue() {
      await writeFile(cliIssueMarker, 'waiting');
      return new Promise(() => {});
    },
  } : undefined,
});
const gateway = await attachGateway(host, process.env.TEST_TOKEN!);
process.send?.({ url: gateway.url, pid: process.pid });
process.on('message', async message => {
  if (message === 'close') { await gateway.close(); await host.close(); process.exit(0); }
});
