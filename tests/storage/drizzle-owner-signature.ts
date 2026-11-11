import type { DatabaseSync } from 'node:sqlite';

function expression(value: unknown): string {
  if (value == null) return '';
  return String(value).replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|`[^`]*`|\s+|[^'"`\s]+/g, token => {
    if (token.startsWith("'")) return token;
    if (/^\s/.test(token)) return '';
    return token.replace(/^[`"]|[`"]$/g, '').toLowerCase();
  }).replace(/^\((.*)\)$/s, '$1');
}

function checks(sql: string): string[] {
  const values: string[] = [];
  const pattern = /\bCHECK\s*\(/gi;
  for (let match; (match = pattern.exec(sql));) {
    const start = pattern.lastIndex;
    let index = start, depth = 1, quote: string | null = null;
    while (depth && index < sql.length) {
      const token = sql[index++];
      if (quote) { if (token === quote) { if (sql[index] === quote) index++; else quote = null; } }
      else if ("'\"`".includes(token)) quote = token;
      else if (token === '(') depth++;
      else if (token === ')') depth--;
    }
    values.push(expression(sql.slice(start, index - 1))); pattern.lastIndex = index;
  }
  return values.sort();
}

/** Compare SQLite meaning while ignoring formatting and generated constraint names. */
export function ownerSchemaSignature(database: DatabaseSync) {
  const tables = database.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='schema_migrations' ORDER BY name").all();
  return tables.map(table => {
    const quoted = JSON.stringify(table.name);
    const columns = database.prepare(`PRAGMA table_info(${quoted})`).all().map(column => ({
      name: column.name, type: String(column.type).toLowerCase(), pk: column.pk,
      notNull: !!column.notnull || !!column.pk && String(column.type).toLowerCase() === 'integer',
      default: expression(column.dflt_value),
    }));
    const indexes = database.prepare(`PRAGMA index_list(${quoted})`).all().filter(index => index.origin !== 'pk').map(index => {
      const ddl = database.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(index.name as string)?.sql;
      const where = typeof ddl === 'string' ? ddl.match(/\bWHERE\s+([\s\S]*)$/i)?.[1] : '';
      const keys = database.prepare(`PRAGMA index_xinfo(${JSON.stringify(index.name)})`).all().filter(key => key.key).map(key => ({
        name: key.name, descending: key.desc, collation: key.coll,
      }));
      return { name: (String(index.name).startsWith('sqlite_autoindex_') || String(index.name).startsWith('legacy_unique_')) ? 'unique' : index.name,
        unique: index.unique, keys, where: expression(where) };
    }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const foreignKeys = database.prepare(`PRAGMA foreign_key_list(${quoted})`).all().map(({ id: _id, ...key }) => key)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return { name: table.name, columns, indexes, foreignKeys, checks: checks(String(table.sql)),
      strict: /\)\s*STRICT\b|,\s*STRICT\b/i.test(String(table.sql)), withoutRowid: /\bWITHOUT\s+ROWID\b/i.test(String(table.sql)) };
  });
}
