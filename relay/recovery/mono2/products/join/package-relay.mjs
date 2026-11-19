#!/usr/bin/env node
import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageRelay } from '../../opencraft/scripts/package-relay.mjs';

const result = await packageRelay({ output: process.argv[2], relayEntry: fileURLToPath(new URL('./relay-main.ts', import.meta.url)) });

const assets = join(result.output, 'plugins/join/public');
await mkdir(assets, { recursive: true });
await copyFile(new URL('./plugins/join/public/joinvela-mascot-share-512.jpg', import.meta.url), join(assets, 'joinvela-mascot-share-512.jpg'));
