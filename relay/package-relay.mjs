#!/usr/bin/env node
import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { packageRelay } from '../scripts/package-relay.mjs';

const entry = name => fileURLToPath(new URL(name, import.meta.url));
const { output } = await packageRelay({ output: process.argv[2], relayEntry: entry('./relay-main.ts') });
await build({
  entryPoints: [entry('./grasp-rewrite-worker.ts')],
  outfile: join(output, 'grasp-rewrite-worker.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
});
await mkdir(join(output, 'assets'), { recursive: true });
await copyFile(entry('./assets/joinvela-mascot-share-512.jpg'), join(output, 'assets/joinvela-mascot-share-512.jpg'));
