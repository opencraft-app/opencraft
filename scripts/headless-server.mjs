#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runHeadlessCli } from './headless-application.mjs';
export { parseHeadlessArguments, startHeadlessServer, runHeadlessCli } from './headless-application.mjs';

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runHeadlessCli().catch(error => { console.error(error); process.exitCode = 1; });
}
