import { readdirSync, readFileSync, lstatSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/** Read-only view of AcpEngine's atomic routing records in one fixed generation.
 * There is no second writable map and native IDs never imply public IDs. */
export function createAcpExecutionThreadResolver(directory) {
  if (!isAbsolute(directory ?? '')) throw new Error('Absolute ACP generation routes directory required');
  return nativeId => {
    if (typeof nativeId !== 'string' || !nativeId || nativeId.length > 512) return '';
    try {
      const files = readdirSync(directory);
      if (files.length > 8192) return '';
      let found = '';
      for (const file of files) {
        if (!/^(?:dsh_acp_|acp_|claude_)[a-zA-Z0-9_-]+\.json$/u.test(file)) continue;
        const path = join(directory,file), info = lstatSync(path);
        if (!info.isFile() || info.size > 1024*1024) return '';
        const record = JSON.parse(readFileSync(path,'utf8'));
        if (record.nativeId !== nativeId) continue;
        if (record.schemaVersion !== 1 || file !== `${record.id}.json` || !isAbsolute(record.cwd ?? '') || found) return '';
        found = record.id;
      }
      return found;
    } catch { return ''; }
  };
}
