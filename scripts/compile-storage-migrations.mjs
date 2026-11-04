import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../packages/storage-node/src/server/', import.meta.url));
const journal = JSON.parse(readFileSync(join(root, 'migrations/meta/_journal.json'), 'utf8'));
const check = process.argv.includes('--check');
const migrations = journal.entries.map((entry, index) => {
  const path = join(root, 'migrations', entry.tag + '.sql');
  const original = readFileSync(path, 'utf8');
  // SQLite STRICT is a product invariant not represented in Drizzle's SQLite snapshots.
  const sql = original.split('--> statement-breakpoint').map(statement => /^\s*CREATE TABLE\b/i.test(statement)
    && !/\)\s*STRICT\s*;\s*$/i.test(statement) ? statement.replace(/\);\s*$/, ') STRICT;\n') : statement).join('--> statement-breakpoint');
  if (check && sql !== original) throw new Error(`Storage migration must retain STRICT: ${entry.tag}`);
  if (!check && sql !== original) writeFileSync(path, sql);
  return { version: index + 1, name: entry.tag, sql };
});
const generated = '// Generated from reviewed SQL. Run npm run generate:storage.\nexport const SERVER_MIGRATIONS = '
  + JSON.stringify(migrations, null, 2) + ' as const;\nexport const OPENCRAFT_VERSION = '
  + JSON.stringify(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version) + ' as const;\n';
const output = join(root, 'migrations.generated.ts');
if (check) {
  if (readFileSync(output, 'utf8') !== generated) throw new Error('Storage SQL and bundled migrations differ');
} else writeFileSync(output, generated);
