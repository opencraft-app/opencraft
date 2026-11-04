#!/usr/bin/env node
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createResidentEntry, residentRequest } from './resident-entry.mjs';

const directory = process.env.OPENCRAFT_WEB_STATE || resolve(homedir(), '.local/share/opencraft/web');
const args = process.argv.slice(2);
if (args[0] === '--status' && args.length === 1) {
  console.log(JSON.stringify(await residentRequest(join(directory, 'resident-entry.sock'), { action: 'status' })));
} else if (args[0] === '--reload' && args.length === 2) {
  console.log(JSON.stringify(await residentRequest(join(directory, 'resident-entry.sock'), { action: 'reload', entry: args[1] })));
} else {
  if (args.length) throw new Error('Invalid resident entry command');
  const app = await createResidentEntry({
    entry: process.env.OPENCRAFT_WEB_ENTRY || join(dirname(fileURLToPath(import.meta.url)), 'cli.mjs'),
    stateDirectory: directory, host: process.env.OPENCRAFT_WEB_HOST || '127.0.0.1',
    port: Number(process.env.OPENCRAFT_WEB_PORT || 10000),
    internalPort: process.env.OPENCRAFT_RELAY_INTERNAL_PORT ? Number(process.env.OPENCRAFT_RELAY_INTERNAL_PORT) : null,
  });
  console.log('[opencraft resident] listeners ready');
  let stopping = false;
  const shutdown = async () => { if (stopping) return; stopping = true; await app.close(); process.exit(0); };
  process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
}
