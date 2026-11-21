#!/usr/bin/env node
import { existsSync as existsSyncEntry, realpathSync as realpathSyncEntry } from 'node:fs';
import { runHeadlessCli } from './headless-application.mjs';
export { parseHeadlessArguments, startHeadlessServer, runHeadlessCli } from './headless-application.mjs';

if (process.argv[1] && existsSyncEntry(process.argv[1]) && realpathSyncEntry(process.argv[1]) === realpathSyncEntry(new URL(import.meta.url))) {
  runHeadlessCli().catch(error => { console.error(error); process.exitCode = 1; });
}
