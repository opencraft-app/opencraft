import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { readJournal, verifyPublishedMigrations, freezePublishedMigrations } from './storage-migration-tools.mjs';

const root = fileURLToPath(new URL('../packages/storage-node/src/server/', import.meta.url));
const journal = readJournal(join(root, 'migrations'));
const check = process.argv.includes('--check');
const rewrites = [];
const migrations = journal.entries.map((entry, index) => {
  const path = join(root, 'migrations', entry.tag + '.sql');
  const original = readFileSync(path, 'utf8');
  // SQLite STRICT is a product invariant not represented in Drizzle's SQLite snapshots.
  const sql = original.split('--> statement-breakpoint').map(statement => /^\s*CREATE TABLE\b/i.test(statement)
    && !/\)\s*STRICT\s*;\s*$/i.test(statement) ? statement.replace(/\);\s*$/, ') STRICT;\n') : statement).join('--> statement-breakpoint');
  if (check && sql !== original) throw new Error(`Storage migration must retain STRICT: ${entry.tag}`);
  if (sql !== original) rewrites.push({ path, sql });
  return { version: index + 1, name: entry.tag, sql };
});
// Validate before writing: a compiler change must never rewrite a frozen migration.
verifyPublishedMigrations(root, journal, migrations, { requirePublished: check });
for (const { path, sql } of rewrites) writeFileSync(path, sql);
if (process.argv.includes('--freeze')) freezePublishedMigrations(root, journal, migrations);
const generated = '// Generated from reviewed SQL. Run npm run generate:storage.\nexport const SERVER_MIGRATIONS = '
  + JSON.stringify(migrations, null, 2) + ' as const;\nexport const OPENCRAFT_VERSION = '
  + JSON.stringify(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version) + ' as const;\n'
  + 'export const SERVER_SCHEMA_EXTRAS_SQL = ' + JSON.stringify(readFileSync(join(root, 'schema-extras.sql'), 'utf8')) + ';\n';
const output = join(root, 'migrations.generated.ts');
if (check) {
  if (readFileSync(output, 'utf8') !== generated) throw new Error('Storage SQL and bundled migrations differ');
} else writeFileSync(output, generated);
