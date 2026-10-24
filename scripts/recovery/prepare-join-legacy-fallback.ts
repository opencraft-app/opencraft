#!/usr/bin/env node
/** One-time recovery of the fixed 2026-10-14 legacy managed entry. Never a boot hook. */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SSH_CONNECTION_MIGRATIONS } from '../../apps/opencraft-daemon/src/ssh-connection-store.js';

export const LEGACY_JOIN_SOURCE_SHA256 = 'ac9737d51dfe4b5b9896f9de96070f5a69b115f71c7fdad1d5fe7217d6877686';
type Identity = { version: number; name: string; checksum: string };
/** No database handle: the original single SSH owner retains all reads/writes. */
export function acceptsPublishedSshHistory(rows: unknown, identities: readonly Identity[]): boolean {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > identities.length) return false;
  return rows.every((row: unknown, index: number) => {
    if (!row || typeof row !== 'object') return false;
    const value = row as Record<string, unknown>, expected = identities[index];
    return !!expected && value.version === expected.version && value.name === expected.name && value.checksum === expected.checksum;
  });
}
export function legacySshHistoryExpression(): string {
  const migrations: readonly { version: number; name: string; sql: string }[] = SSH_CONNECTION_MIGRATIONS;
  // This recovery is valid only while v2 is bookkeeping, not a schema/data change.
  if (migrations.length !== 2 || migrations[0]?.version !== 1 || migrations[0].name !== 'ssh-connections'
    || migrations[1]?.version !== 2 || migrations[1].name !== 'ssh-user-version' || migrations[1].sql !== 'PRAGMA user_version=1') {
    throw new Error('Published SSH migration identities no longer match this historical recovery');
  }
  const identities = migrations.map(({ version, name, sql }) => ({ version, name, checksum: createHash('sha256').update(sql).digest('hex') }));
  return `(${acceptsPublishedSshHistory.toString()})(history, ${JSON.stringify(identities)})`;
}
export function prepareJoinLegacyFallback(source: Buffer): { bytes: Buffer; sourceSha256: string; outputSha256: string } {
  const sourceSha256 = createHash('sha256').update(source).digest('hex');
  if (sourceSha256 !== LEGACY_JOIN_SOURCE_SHA256) throw new Error('Unknown legacy entry source bytes');
  const text = source.toString('utf8');
  const declaration = `var SCHEMA = ${JSON.stringify(SSH_CONNECTION_MIGRATIONS[0].sql)};`;
  if (text.split(declaration).length !== 2) throw new Error('Legacy SSH schema does not match its published owner');
  const anchor = 'history.length !== 1 || history[0].version !== 1 || history[0].name !== "ssh-connections" || history[0].checksum !== BASELINE_HASH';
  // The exact source digest and this unique owner guard must both match.
  const at = text.indexOf(anchor);
  if (at < 0 || text.indexOf(anchor, at + anchor.length) >= 0) throw new Error('Legacy SSH owner guard is not unique');
  const bytes = Buffer.from(text.slice(0, at) + `!${legacySshHistoryExpression()}` + text.slice(at + anchor.length));
  return { bytes, sourceSha256, outputSha256: createHash('sha256').update(bytes).digest('hex') };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output || process.argv.length !== 4 || resolve(input) === resolve(output)) throw new Error('Pass distinct explicit input and new output paths');
  const result = prepareJoinLegacyFallback(await readFile(input));
  // Refuse overwriting either the original bundle or any prior recovery artifact.
  await writeFile(output, result.bytes, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ sourceSha256: result.sourceSha256, outputSha256: result.outputSha256, compatibility: 'legacy-join-ssh-ledger-v1-v2', dataRestored: false }));
}
