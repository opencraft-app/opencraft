import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { readJournal } from './storage-migration-tools.mjs';

const defaultRoot = fileURLToPath(new URL('../../packages/storage-node/src/server/', import.meta.url));
/** Trusted maintenance caller chooses its source owner; import never compiles the default tree. */
export function compileServerMigrations({root=defaultRoot,check=false,freeze=false}={}) {
const journal = readJournal(join(root, 'migrations'));
const manifestPath = join(root, 'migration-lineages.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const digest = value => createHash('sha256').update(value).digest('hex');
if (manifest.format !== 1 || !Array.isArray(manifest.canonicalPublished) || !Array.isArray(manifest.alternates)) throw Error('Invalid Server migration lineages');
const migrations = journal.entries.map((entry, index) => {
  const path = join(root, 'migrations', entry.tag + '.sql');
  const original = readFileSync(path, 'utf8');
  const frozen = manifest.canonicalPublished[index];
  if (frozen && (frozen.version !== index + 1 || frozen.name !== entry.tag || frozen.checksum !== digest(original))) throw Error('Published Server migration changed: ' + entry.tag);
  // STRICT is a product invariant omitted from Drizzle snapshots. Never rewrite
  // a published identity to add it; only a new unpublished append can normalize.
  const sql = original.split('--> statement-breakpoint').map(statement => /^\s*CREATE TABLE\b/i.test(statement)
    && !/\)\s*STRICT\s*;\s*$/i.test(statement) ? statement.replace(/\);\s*$/, ') STRICT;\n') : statement).join('--> statement-breakpoint');
  if ((check || frozen) && sql !== original) throw Error('Storage migration must retain STRICT: ' + entry.tag);
  if (!check && sql !== original) writeFileSync(path, sql);
  const snapshotChecksum = digest(readFileSync(join(root, 'migrations/meta', String(index).padStart(4, '0') + '_snapshot.json')));
  if (frozen?.snapshotChecksum && frozen.snapshotChecksum !== snapshotChecksum) throw Error('Published Server snapshot changed: ' + entry.tag);
  return { version: index + 1, name: entry.tag, sql };
});
if (manifest.canonicalPublished.length > migrations.length) throw Error('Published Server history was truncated');
if (check && manifest.canonicalPublished.length !== migrations.length) throw Error('Unpublished Server migrations; review and freeze first');
if (freeze) {
  while (manifest.canonicalPublished.length < migrations.length) {
    const m = migrations[manifest.canonicalPublished.length];
    manifest.canonicalPublished.push({ version: m.version, name: m.name, checksum: digest(m.sql), snapshotChecksum: digest(readFileSync(join(root, 'migrations/meta', String(m.version - 1).padStart(4, '0') + '_snapshot.json'))) });
  }
}
const byChecksum = new Map();
for (const [index, migration] of migrations.entries()) {
  const checksum = digest(migration.sql);
  if (byChecksum.has(checksum)) throw Error('Ambiguous duplicate Server SQL identity');
  byChecksum.set(checksum, index);
}
const ids = new Set(), alternates = [];
for (const alternate of manifest.alternates) {
  if (!alternate || typeof alternate.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(alternate.id) || ids.has(alternate.id) || !Array.isArray(alternate.published) || !alternate.published.length) throw Error('Invalid Server alternate history');
  ids.add(alternate.id);
  const applied = new Set();
  const chain = alternate.published.map((identity, index) => {
    const source = byChecksum.get(identity.checksum);
    if (identity.version !== index + 1 || typeof identity.name !== 'string' || !identity.name || source === undefined || applied.has(source)) throw Error('Unknown or ambiguous published Server lineage SQL');
    applied.add(source);
    return { version: identity.version, name: identity.name, sql: migrations[source].sql };
  });
  for (const [index, migration] of migrations.entries()) if (!applied.has(index)) chain.push({ version: chain.length + 1, name: 'converge_' + migration.name, sql: migration.sql });
  const published = alternate.convergencePublished ?? [];
  if (!Array.isArray(published) || published.length > chain.length || published.some((identity, index) => {
    const migration = chain[index];
    return identity.version !== migration.version || identity.name !== migration.name || identity.checksum !== digest(migration.sql);
  })) throw Error('Published Server convergence history changed: ' + alternate.id);
  if (check && published.length !== chain.length) throw Error('Unpublished Server convergence history: ' + alternate.id);
  if (freeze) alternate.convergencePublished = chain.map(migration => ({version:migration.version,name:migration.name,checksum:digest(migration.sql)}));
  alternates.push({ id: alternate.id, migrations: chain });
}
if (freeze) writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
// Hash the complete finite family, not a fiction that alternate ledgers were
// rewritten into canonical order. Import receipts keep their prior provenance.
const contractHash = digest(JSON.stringify({ canonical: migrations, alternates }));
const generated = '// Generated from reviewed SQL. Run npm run generate:storage.\nexport const SERVER_MIGRATIONS = '
  + JSON.stringify(migrations, null, 2) + ' as const;\nexport const SERVER_ALTERNATE_MIGRATIONS = '
  + JSON.stringify(alternates.map(entry => ({...entry,migrations:entry.migrations.map(migration => ({...migration,sql:'__SERVER_SQL_' + byChecksum.get(digest(migration.sql)) + '__'}))})), null, 2).replace(/"sql": "__SERVER_SQL_(\d+)__"/g, '"sql": SERVER_MIGRATIONS[$1].sql') + ' as const;\nexport const SERVER_MIGRATION_CONTRACT_HASH = ' + JSON.stringify(contractHash) + ' as const;\nexport const OPENCRAFT_VERSION = '
  + JSON.stringify(JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version) + ' as const;\n';
const output = join(root, 'migrations.generated.ts');
if (check) { if (readFileSync(output, 'utf8') !== generated) throw Error('Storage SQL and bundled migrations differ'); }
else writeFileSync(output, generated);

return {migrations,alternates,contractHash};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))compileServerMigrations({check:process.argv.includes('--check'),freeze:process.argv.includes('--freeze')});
