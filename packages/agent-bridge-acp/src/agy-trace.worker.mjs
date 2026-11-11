// Foreign AGY databases are read-only. Never use an OpenCraft migration owner here.
import { isMainThread, parentPort } from 'node:worker_threads';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync as Database } from 'node:sqlite';
if (isMainThread) throw Error('AGY SQLite must run in a Worker');

// Only the documented protobuf wire fields needed for raw user input are decoded.
// Unknown fields are skipped; malformed/duplicate known fields fail closed.
function fields(bytes) {
  const result = new Map(); let at = 0;
  function integer() {
    let n = 0, scale = 1;
    for (let i = 0; i < 10; i++) {
      if (at >= bytes.length) throw Error('truncated protobuf');
      const b = bytes[at++]; n += (b & 127) * scale;
      if (!(b & 128)) { if (!Number.isSafeInteger(n)) throw Error('invalid varint'); return n; }
      scale *= 128;
    }
    throw Error('invalid varint');
  }
  while (at < bytes.length) {
    const tag = integer(), key = Math.floor(tag / 8), wire = tag % 8;
    if (!key) throw Error('invalid field');
    let value;
    if (wire === 0) integer();
    else if (wire === 1) at += 8;
    else if (wire === 5) at += 4;
    else if (wire === 2) { const size = integer(); value = bytes.subarray(at, at + size); at += size; }
    else throw Error('unsupported wire');
    if (at > bytes.length) throw Error('truncated field');
    if (value !== undefined) {
      if (result.has(key)) result.set(key, null); else result.set(key, value);
    }
  }
  return result;
}
function rawText(blob) {
  if (!(blob instanceof Uint8Array)) throw Error('invalid payload');
  const prompt = fields(blob).get(19);
  if (!prompt) throw Error('missing raw user prompt');
  const f = fields(prompt), direct = f.get(2), content = f.get(3);
  const nested = content ? fields(content).get(1) : undefined;
  if (direct === null || content === null || nested === null) throw Error('ambiguous prompt');
  const decode = v => new TextDecoder('utf-8', { fatal: true }).decode(v);
  if (direct && nested && decode(direct) !== decode(nested)) throw Error('ambiguous text');
  if (!direct && !nested) throw Error('missing raw text');
  return decode(direct ?? nested);
}
function read(path) {
  const db = new Database(path, { readOnly: true, timeout: 100 });
  try {
    db.exec('PRAGMA query_only = ON');
    const schema = db.prepare('PRAGMA table_info(steps)').all();
    for (const [name, type] of [['idx','INTEGER'],['step_type','INTEGER'],['step_payload','BLOB']]) {
      const c = schema.find(c => c.name === name);
      if (!c || c.type.toUpperCase() !== type || (name === 'idx' && c.pk !== 1)) throw Error('AGY schema mismatch');
    }
    if (schema.some(c => c.name !== 'idx' && c.pk > 0)) throw Error('AGY index identity mismatch');
    const users = db.prepare('SELECT idx, step_payload FROM steps WHERE step_type = 14 ORDER BY idx LIMIT 10001').all();
    if (users.length > 10000) throw Error('trace too large');
    const rows = users.map(r => {
      if (!Number.isSafeInteger(r.idx) || r.idx < 0) throw Error('invalid row');
      return { idx: r.idx, text: rawText(r.step_payload) };
    });
    return { rows, max: db.prepare('SELECT COALESCE(MAX(idx), -1) AS n FROM steps').get().n };
  } finally { db.close(); }
}
parentPort.on('message', async ({ id, dir, conversation }) => {
  try {
    let path;
    if (conversation !== undefined) {
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(conversation)) throw Error('invalid conversation');
      path = join(dir, conversation + '.db');
    } else {
      const names = (await readdir(dir)).filter(n => /^[a-zA-Z0-9_-]+\.db$/.test(n));
      const files = await Promise.all(names.map(async n => ({ n, m: (await stat(join(dir,n))).mtimeMs })));
      files.sort((a,b) => b.m-a.m); if (!files.length) throw Error('no schema sample');
      path = join(dir, files[0].n);
    }
    const value = read(path);
    if (conversation === undefined && value.rows.length === 0) throw Error("no validated user sample");
    parentPort.postMessage({ id, value });
  } catch { parentPort.postMessage({ id, error: 'AGY trace schema/read unconfirmed' }); }
});
