#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { createOptionalResources } from './optional-resources.mjs';

const { values } = parseArgs({ options: { release: { type: 'string' }, state: { type: 'string' }, archive: { type: 'string' } } });
if (!values.release || !values.state) throw new Error('Usage: prefetch.mjs --release /installed/package --state /web-state [--archive /resources.tgz]');
const resources = await createOptionalResources({ releaseRoot: resolve(values.release), cacheDirectory: process.env.OPENCRAFT_RESOURCE_CACHE_DIRECTORY || resolve(values.state, 'resource-cache'),
  registry: process.env.OPENCRAFT_NPM_REGISTRY, userconfig: process.env.OPENCRAFT_NPM_USERCONFIG });
try { await resources.prefetch(values.archive && resolve(values.archive)); }
catch { throw new Error('Optional resources could not be prepared; check the archive or server npm configuration'); }
console.log('Optional Web resources prepared');
