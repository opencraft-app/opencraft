import { syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs';
import sqlite from 'node:sqlite';
/** Called after module loading; guards actual runtime main-thread IO. */
export function guardMainThread(): void {
  for (const key of ['readFileSync','writeFileSync','openSync','mkdirSync','renameSync','unlinkSync','statSync','lstatSync','chmodSync','fsyncSync'] as const)
    (fs as any)[key] = () => { throw Error(`Main-thread blocking IO: ${key}`); };
  (sqlite as any).DatabaseSync = new Proxy(sqlite.DatabaseSync, { construct() { throw Error('Main-thread SQLite constructor'); } });
  syncBuiltinESMExports();
}
