import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSandboxPool, createSandbox } from '@opencraft/sandbox';
import { localTestBackend } from './fixtures/local-backend.js';

test('closed child stdin rejects EPIPE without an uncaught stream error', { timeout: 5000 }, async t => {
  const pool = await createSandboxPool({ id: 'pipe-failure-test', capacity: { cpuMillis: 4000, memoryBytes: 8 * 1024 ** 3 } }, localTestBackend());
  const sandbox = await createSandbox(pool, { owner: 'pipe-failure-test' });
  t.after(async () => { await sandbox.close(); await pool.close(); });
  let ready!: () => void;
  const inputClosed = new Promise<void>(resolve => { ready = resolve; });
  // Keep the process alive after closing the actual descriptor: a real pipe
  // failure, independent of the timing of process exit and its notification.
  const child = await sandbox.spawn({ command: [process.execPath, '-e', "require('node:fs').closeSync(0); process.stdout.write('input-closed\\n'); setInterval(() => {}, 1000);"], cwd: '/tmp', env: {} }, output => {
    if (output.stream === 'stdout' && Buffer.from(output.data).toString().includes('input-closed')) ready();
  });
  await inputClosed;
  await assert.rejects(child.writeStdin(Buffer.from('ack\n')), (error: NodeJS.ErrnoException) => error.code === 'EPIPE');
  // The write callback and the stream error event are distinct notifications.
  await new Promise<void>(resolve => setImmediate(resolve));
});
