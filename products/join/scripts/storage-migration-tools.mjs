import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const digest = value => createHash('sha256').update(value).digest('hex');
export function readJournal(directory) {
  const journal = JSON.parse(readFileSync(join(directory, 'meta/_journal.json'), 'utf8'));
  if (journal.version !== '7' || journal.dialect !== 'sqlite' || !Array.isArray(journal.entries) || !journal.entries.length) throw new Error('Invalid SQLite migration journal');
  const ids = new Set();
  let previousId, previousWhen = -Infinity;
  for (const [index, entry] of journal.entries.entries()) {
    if (entry.version !== '6' || entry.idx !== index || !Number.isSafeInteger(entry.when) || entry.when <= previousWhen
      || !new RegExp(`^${String(index).padStart(4, '0')}_[a-zA-Z0-9_]+$`).test(entry.tag)) throw new Error('Invalid migration order or identity');
    const snapshot = JSON.parse(readFileSync(join(directory, 'meta', `${String(index).padStart(4, '0')}_snapshot.json`), 'utf8'));
    if (snapshot.version !== '6' || snapshot.dialect !== 'sqlite' || typeof snapshot.id !== 'string'
      || ids.has(snapshot.id) || (index === 0 ? snapshot.prevId !== '00000000-0000-0000-0000-000000000000' : snapshot.prevId !== previousId)) throw new Error('Broken migration snapshot chain');
    readFileSync(join(directory, entry.tag + '.sql'), 'utf8');
    ids.add(snapshot.id); previousId = snapshot.id; previousWhen = entry.when;
  }
  const sqlFiles = readdirSync(directory).filter(name => name.endsWith('.sql')).sort();
  const snapshots = readdirSync(join(directory, 'meta')).filter(name => name.endsWith('_snapshot.json')).sort();
  if (JSON.stringify(sqlFiles) !== JSON.stringify(journal.entries.map(entry => entry.tag + '.sql').sort())
    || JSON.stringify(snapshots) !== JSON.stringify(journal.entries.map((_, index) => `${String(index).padStart(4, '0')}_snapshot.json`))) throw new Error('Orphaned migration SQL or snapshot');
  return journal;
}

/** Drizzle snapshots omit SQLite table options. Preserve them across rebuilds. */
export function retainTableOptions(sql, tableOptions) {
  return sql.replace(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(?:`([^`]+)`|"([^"]+)"|(\w+))([\s\S]*?)\);/gi, (statement, backtick, quoted, plain) => {
    const name = (backtick ?? quoted ?? plain).replace(/^__new_/, '');
    const options = tableOptions[name] ?? { strict: true, withoutRowid: false };
    return statement.slice(0, -1) + (options.strict ? ' STRICT' : '') + (options.withoutRowid ? (options.strict ? ', ' : ' ') + 'WITHOUT ROWID' : '') + ';';
  });
}

/** Freeze both source artifacts and the SQL the managed executor will hash. */
export function migrationPublications(directory, journal, migrations, baseline = false) {
  return journal.entries.map((entry, index) => {
    const migration = baseline && index === 0 ? undefined : migrations[baseline ? index - 1 : index];
    if (!(baseline && index === 0) && !migration) throw new Error('Migration publication has no executable identity');
    return { tag: entry.tag, when: entry.when, version: migration?.version ?? 0,
      sqlChecksum: digest(readFileSync(join(directory, 'migrations', entry.tag + '.sql'))),
      snapshotChecksum: digest(readFileSync(join(directory, 'migrations/meta', String(index).padStart(4, '0') + '_snapshot.json'))),
      compiledChecksum: migration ? digest(migration.sql) : null };
  });
}

export function verifyPublishedMigrations(directory, journal, migrations, { baseline = false, requirePublished = false } = {}) {
  const published = JSON.parse(readFileSync(join(directory, 'published.json'), 'utf8'));
  const current = migrationPublications(directory, journal, migrations, baseline);
  if (!Array.isArray(published) || published.length > current.length || published.some((known, index) => {
    const expected = current[index];
    return !known || Object.keys(known).length !== Object.keys(expected).length
      || Object.entries(expected).some(([key, value]) => known[key] !== value);
  })) throw new Error(`Published migration changed: ${directory}`);
  if (requirePublished && published.length !== current.length) throw new Error(`Unfrozen migration; review SQL and run freeze:storage: ${directory}`);
  return { published, current };
}

/** Append identities only after validating every already-frozen entry. */
export function freezePublishedMigrations(directory, journal, migrations, options) {
  const { published, current } = verifyPublishedMigrations(directory, journal, migrations, options);
  if (published.length !== current.length) writeFileSync(join(directory, 'published.json'), JSON.stringify(current, null, 2) + '\n');
}

export function freezeStore(directory) {
  const compiled = compileStore(directory);
  freezePublishedMigrations(directory, readJournal(join(directory, 'migrations')), compiled.migrations, { baseline: true });
}

export function compileStore(directory, { requirePublished = false } = {}) {
  const baseline = JSON.parse(readFileSync(join(directory, 'baseline.json'), 'utf8'));
  const folder = join(directory, 'migrations');
  const journal = readJournal(folder);
  if (digest(readFileSync(join(folder, '0000_legacy_baseline.sql'))) !== baseline.baselineSqlChecksum
    || digest(readFileSync(join(folder, 'meta/0000_snapshot.json'))) !== baseline.baselineSnapshotChecksum) throw new Error('Published schema baseline changed');
  const migrations = journal.entries.slice(1).map((entry, index) => {
    const original = readFileSync(join(folder, entry.tag + '.sql'), 'utf8');
    const snapshot = JSON.parse(readFileSync(join(folder, 'meta', String(entry.idx).padStart(4, '0') + '_snapshot.json'), 'utf8'));
    const sql = restoreIndexExpressions(original, snapshot);
    if (/\bDROP\s+INDEX\s+[`"]?legacy_unique_/i.test(sql)) throw new Error('Changing an adopted SQLite UNIQUE constraint requires a transactional table rebuild');
    if (/\bPRAGMA\s+(?:foreign_keys|journal_mode)\s*=/i.test(sql)) throw new Error('SQLite rebuild must use transactional SQL; foreign_keys cannot toggle inside a managed migration');
    return { version: baseline.legacy.length + index + 1, name: entry.tag, sql: retainTableOptions(sql, baseline.tableOptions) };
  });
  verifyPublishedMigrations(directory, journal, migrations, { baseline: true, requirePublished });
  return { baseline: baseline.legacy, migrations };
}

/** Drizzle Kit's SQLite index squash format splits expression commas. Recover
 * emitted CREATE INDEX statements from the generated snapshot's structured data. */
export function restoreIndexExpressions(sql, snapshot) {
  const indexes = new Map(Object.values(snapshot.tables).flatMap(table => Object.values(table.indexes).map(index => [index.name, { table: table.name, ...index }])));
  const pattern = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:`([^`]+)`|"([^"]+)"|(\w+))/gi;
  const quote = name => '`' + name.replaceAll('`', '``') + '`';
  let output = '', cursor = 0;
  for (let match; (match = pattern.exec(sql));) {
    const index = indexes.get(match[1] ?? match[2] ?? match[3]);
    if (!index) throw new Error('Generated index has no snapshot identity');
    let end = pattern.lastIndex, delimiter = null;
    for (; end < sql.length; end++) {
      const token = sql[end];
      if (delimiter) { if (token === delimiter) { if (sql[end + 1] === delimiter) end++; else delimiter = null; } }
      else if ("'\"`".includes(token)) delimiter = token;
      else if (token === ';') break;
    }
    if (end === sql.length) throw new Error('Unterminated generated index');
    const columns = index.columns.map(column => snapshot.internal?.indexes?.[index.name]?.columns?.[column]?.isExpression ? column : quote(column));
    output += sql.slice(cursor, match.index) + `CREATE ${index.isUnique ? 'UNIQUE ' : ''}INDEX ${quote(index.name)} ON ${quote(index.table)} (${columns.join(', ')})${index.where ? ' WHERE ' + index.where : ''};`;
    cursor = end + 1; pattern.lastIndex = cursor;
  }
  return output + sql.slice(cursor);
}

export async function assertSchemaCurrent(directory) {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { pathToFileURL } = await import('node:url');
  const { build } = await import('esbuild');
  const { generateSQLiteDrizzleJson, generateSQLiteMigration } = await import('drizzle-kit/api');
  const journal = readJournal(join(directory, 'migrations'));
  const previous = JSON.parse(readFileSync(join(directory, 'migrations/meta', `${String(journal.entries.length - 1).padStart(4, '0')}_snapshot.json`), 'utf8'));
  const scratch = mkdtempSync(join(tmpdir(), 'oc-schema-check-'));
  try {
    const entry = join(scratch, 'schema.mjs');
    await build({ entryPoints: [join(directory, 'schema.ts')], outfile: entry, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
    const schema = await import(pathToFileURL(entry).href);
    if ((await generateSQLiteMigration(previous, await generateSQLiteDrizzleJson(schema, previous.id))).length) throw new Error(`Ungenerated schema changes: ${directory}`);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
