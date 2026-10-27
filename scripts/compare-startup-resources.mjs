#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
const [beforeFile, afterFile, limitFlag, limitValue, ...extra] = process.argv.slice(2);
if (!beforeFile || !afterFile || extra.length || (limitFlag && limitFlag !== '--max-invalidated-js')) throw new Error('Usage: compare-startup-resources.mjs <before.json> <after.json> [--max-invalidated-js <bytes>]');
const limit = limitFlag ? Number(limitValue) : Infinity;
if (limitFlag && (!Number.isSafeInteger(limit) || limit < 0)) throw new Error('Cache budget must be a non-negative integer');
const [before, after] = await Promise.all([beforeFile, afterFile].map(async file => JSON.parse(await readFile(file, 'utf8'))));
for (const report of [before, after]) if (report.schemaVersion !== 1 || !Array.isArray(report.chunks) || !Array.isArray(report.critical)) throw new Error('Unsupported startup resource report');
const oldFiles = new Set(before.chunks.map(chunk => chunk.file));
const signature = chunk => [...chunk.modules].sort().join('\n');
const oldGroups = new Map(before.chunks.map(chunk => [signature(chunk), chunk]));
const rows = after.chunks.filter(chunk => after.critical.includes(chunk.file) && !oldFiles.has(chunk.file)).map(chunk => {
  const old = oldGroups.get(signature(chunk));
  return { file: chunk.file, bytes: chunk.bytes, previous: old?.file ?? null,
    change: old && old.normalizedHash && old.normalizedHash === chunk.normalizedHash ? 'references-only' : old ? 'code-or-generated-layout' : 'module-membership',
    modules: chunk.modules.length };
});
const invalidatedCriticalJavaScript = rows.reduce((sum, row) => sum + row.bytes, 0);
console.log(JSON.stringify({ before: before.totals, after: after.totals,
  invalidatedCriticalJavaScript,
  referenceOnlyBytes: rows.filter(row => row.change === 'references-only').reduce((sum, row) => sum + row.bytes, 0), rows }, null, 2));
if (invalidatedCriticalJavaScript > limit) { console.error(`Startup cache invalidation: ${invalidatedCriticalJavaScript} > ${limit}`); process.exitCode = 1; }
