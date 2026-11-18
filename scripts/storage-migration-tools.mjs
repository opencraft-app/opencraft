import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

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
  const tokens = sqliteTokens(sql), insertions = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].word !== 'CREATE' || tokens[i + 1]?.word !== 'TABLE') continue;
    let cursor = i + 2;
    if (tokens[cursor]?.word === 'IF' && tokens[cursor + 1]?.word === 'NOT' && tokens[cursor + 2]?.word === 'EXISTS') cursor += 3;
    const name = tokens[cursor++];
    if (!name || !['word', 'identifier'].includes(name.kind) || tokens[cursor]?.text !== '(') continue;
    let depth = 0;
    for (; cursor < tokens.length; cursor++) {
      const token = tokens[cursor];
      if (token.kind !== 'symbol') continue;
      if (token.text === '(') depth++;
      if (token.text === ')' && --depth === 0) break;
      if (token.text === ';') break;
    }
    if (cursor === tokens.length || tokens[cursor].text !== ')') continue;
    const close = cursor++, options = [];
    while (cursor < tokens.length && tokens[cursor].text !== ';') options.push(tokens[cursor++]);
    const strict = options.some(token => token.word === 'STRICT');
    const withoutRowid = options.some((token, index) => token.word === 'WITHOUT' && options[index + 1]?.word === 'ROWID');
    const expected = tableOptions[name.value.replace(/^__new_/, '')] ?? { strict: true, withoutRowid: false };
    const missing = [...(expected.strict && !strict ? ['STRICT'] : []), ...(expected.withoutRowid && !withoutRowid ? ['WITHOUT ROWID'] : [])];
    if (missing.length) {
      const at = (options.at(-1) ?? tokens[close]).end;
      insertions.push({ at, text: (options.length ? ', ' : ' ') + missing.join(', ') });
    }
    i = cursor;
  }
  for (const { at, text } of insertions.reverse()) sql = sql.slice(0, at) + text + sql.slice(at);
  return sql;
}

/** Token boundaries keep quoted/comment text and balanced CHECK expressions out
 * of DDL matching. In particular, an existing STRICT must not consume the next
 * CREATE INDEX statement while searching for a bare `);`. */
function sqliteTokens(sql) {
  const tokens = [];
  for (let i = 0; i < sql.length;) {
    if (/\s/.test(sql[i])) { i++; continue; }
    if (sql.startsWith('--', i)) { const end = sql.indexOf('\n', i + 2); i = end === -1 ? sql.length : end + 1; continue; }
    if (sql.startsWith('/*', i)) { const end = sql.indexOf('*/', i + 2); i = end === -1 ? sql.length : end + 2; continue; }
    const start = i, quote = sql[i];
    if (['"', "'", '`', '['].includes(quote)) {
      const delimiter = quote === '[' ? ']' : quote;
      let value = ''; i++;
      while (i < sql.length) {
        if (sql[i] === delimiter) {
          if (quote !== '[' && sql[i + 1] === delimiter) { value += delimiter; i += 2; continue; }
          i++; break;
        }
        value += sql[i++];
      }
      tokens.push({ kind: quote === "'" ? 'string' : 'identifier', text: sql.slice(start, i), value, end: i });
    } else if (/[\w$]/.test(quote)) {
      while (i < sql.length && /[\w$]/.test(sql[i])) i++;
      const text = sql.slice(start, i); tokens.push({ kind: 'word', text, value: text, word: text.toUpperCase(), end: i });
    } else { i++; tokens.push({ kind: 'symbol', text: quote, end: i }); }
  }
  return tokens;
}

/** Freeze both source artifacts and the SQL the managed executor will hash. */
export function migrationPublications(directory, journal, migrations, baseline = false) {
  return journal.entries.map((entry, index) => {
    const migration = baseline && index === 0 ? undefined : migrations[baseline ? index - 1 : index];
    if (!(baseline && index === 0) && !migration) throw new Error('Migration publication has no executable identity');
    return { tag: entry.tag, when: entry.when, version: migration?.version ?? 0,
      sqlChecksum: digest(readFileSync(join(directory, 'migrations', entry.tag + '.sql'))),
      snapshotChecksum: digest(readFileSync(join(directory, 'migrations/meta', String(index).padStart(4, '0') + '_snapshot.json'))),
      compiledChecksum: migration ? digest(migration.sql) : null,
      // Existing manifests remain byte-for-byte compatible. An adopted ledger
      // name is independently frozen: equal SQL is not equal migration history.
      ...(migration && migration.name !== entry.tag ? { ledgerName: migration.name } : {}) };
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
  const adopted = readAdoptedIdentities(directory, journal, baseline.legacy.length);
  const migrations = journal.entries.slice(1).map((entry, index) => {
    const original = readFileSync(join(folder, entry.tag + '.sql'), 'utf8');
    const identity = adopted.get(entry.tag);
    const snapshot = JSON.parse(readFileSync(join(folder, 'meta', String(entry.idx).padStart(4, '0') + '_snapshot.json'), 'utf8'));
    // A previously executed ledger hashes its original SQL, not Drizzle's
    // normalized index spelling. Never silently rewrite that published identity.
    const sql = identity ? original : restoreIndexExpressions(original, snapshot);
    if (/\bDROP\s+INDEX\s+[`"]?legacy_unique_/i.test(sql)) throw new Error('Changing an adopted SQLite UNIQUE constraint requires a transactional table rebuild');
    if (/\bPRAGMA\s+(?:foreign_keys|journal_mode)\s*=/i.test(sql)) throw new Error('SQLite rebuild must use transactional SQL; foreign_keys cannot toggle inside a managed migration');
    const compiledSql = retainTableOptions(sql, baseline.tableOptions);
    if (identity && digest(compiledSql) !== identity.checksum) throw new Error(`Adopted migration SQL differs: ${entry.tag}`);
    return { version: baseline.legacy.length + index + 1, name: identity?.name ?? entry.tag, sql: compiledSql };
  });
  verifyPublishedMigrations(directory, journal, migrations, { baseline: true, requirePublished });
  return { baseline: baseline.legacy, migrations };
}

/** Optional source-only adoption map. It cannot change versions or execute SQL;
 * every entry must describe an appended journal item and its exact old ledger. */
function readAdoptedIdentities(directory, journal, prefixLength) {
  let entries;
  try { entries = JSON.parse(readFileSync(join(directory, 'adopted-identities.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return new Map(); throw error; }
  if (!Array.isArray(entries)) throw new Error('Invalid adopted migration identities');
  const appended = new Map(journal.entries.slice(1).map((entry, index) => [entry.tag, prefixLength + index + 1]));
  const adopted = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Object.keys(entry).sort().join(',') !== 'checksum,name,tag,version'
      || typeof entry.tag !== 'string' || adopted.has(entry.tag) || !appended.has(entry.tag)
      || entry.version !== appended.get(entry.tag)
      || typeof entry.name !== 'string' || !entry.name.trim() || entry.name.trim() !== entry.name
      || entry.name === entry.tag || entry.name.length > 128 || /[\u0000-\u001f\u007f]/.test(entry.name)
      || typeof entry.checksum !== 'string' || !/^[a-f0-9]{64}$/.test(entry.checksum)) {
      throw new Error('Invalid adopted migration identity');
    }
    adopted.set(entry.tag, entry);
  }
  return adopted;
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

export async function assertSchemaCurrent(directory, { schemaFiles = [join(directory, 'schema.ts')] } = {}) {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { pathToFileURL } = await import('node:url');
  const { build } = await import('esbuild');
  const { generateSQLiteDrizzleJson, generateSQLiteMigration } = await import('drizzle-kit/api');
  if (!Array.isArray(schemaFiles) || !schemaFiles.length || schemaFiles.some(file => typeof file !== 'string' || !file)) throw new Error('Schema validation needs concrete source files');
  const files = schemaFiles.map(file => resolve(file));
  if (new Set(files).size !== files.length) throw new Error('Duplicate schema source file');
  const journal = readJournal(join(directory, 'migrations'));
  const previous = JSON.parse(readFileSync(join(directory, 'migrations/meta', `${String(journal.entries.length - 1).padStart(4, '0')}_snapshot.json`), 'utf8'));
  const scratch = mkdtempSync(join(tmpdir(), 'oc-schema-check-'));
  try {
    const entry = join(scratch, 'schema.mjs');
    const contents = files.map((file, index) => `import * as schema${index} from ${JSON.stringify(file)};`).join('\n')
      + `\nexport default [${files.map((_, index) => `schema${index}`).join(',')}];\n`;
    await build({ stdin: { contents, resolveDir: resolve(directory), loader: 'ts' }, outfile: entry,
      bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
    const sources = (await import(pathToFileURL(entry).href)).default;
    const { is, getTableName } = await import('drizzle-orm');
    const { SQLiteTable } = await import('drizzle-orm/sqlite-core');
    const schema = Object.create(null), tables = new Map();
    for (const [index, source] of sources.entries()) for (const [name, value] of Object.entries(source)) {
      if (Object.hasOwn(schema, name)) throw new Error(`Duplicate schema export: ${name}`);
      if (is(value, SQLiteTable)) {
        const table = getTableName(value), prior = tables.get(table);
        if (prior && (prior.index !== index || prior.value !== value)) throw new Error(`Duplicate schema table owner: ${table}`);
        tables.set(table, { index, value });
      }
      schema[name] = value;
    }
    if ((await generateSQLiteMigration(previous, await generateSQLiteDrizzleJson(schema, previous.id))).length) throw new Error(`Ungenerated schema changes: ${directory}`);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
