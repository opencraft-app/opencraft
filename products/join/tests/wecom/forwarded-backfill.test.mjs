import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { planBackfill, applyBackfill, legacyTextRecord } from '../../scripts/backfill-wecom-forwarded-records.mjs';
import { forwardedRecordIdentity } from '../../../../packages/appserver-protocol/src/forwarded-record.ts';
const hash = v => createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');
const source = JSON.stringify(['wecom-customer-service', 'test-corp', 'test-service', 'room']);
function fixture(t) {
  const db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE actor_messages(id TEXT PRIMARY KEY,seq INTEGER,channel_id TEXT,content TEXT,created_at INTEGER);
    CREATE TABLE actor_channel_external_messages(message_id TEXT PRIMARY KEY REFERENCES actor_messages(id),source TEXT,external_id TEXT,sender_id TEXT,fingerprint TEXT);
    CREATE TABLE actor_channel_attachments(message_id TEXT PRIMARY KEY REFERENCES actor_messages(id),name TEXT,mime TEXT,bytes BLOB);`);
  t.after(() => db.close());
  const add = (id, content = '[聊天记录] 讨论\n11-13 00:14 T1: 接口超时\n  续行\n11-13 00:18 T2: [图片]', provider = source) => {
    db.prepare('INSERT INTO actor_messages VALUES(?,?,?,?,?)').run(id, Number(id.slice(1)), 'room', content, 123);
    db.prepare('INSERT INTO actor_channel_external_messages VALUES(?,?,?,?,?)').run(id, provider, 'provider-' + id, 'outer-sender', 'original-fingerprint');
  };
  return { db, add, snapshot: () => JSON.stringify([db.prepare('SELECT * FROM actor_messages').all(), db.prepare('SELECT * FROM actor_channel_external_messages').all()]) };
}
test('legacy labels stay unverified, dates have no guessed year, image markers have no fabricated media', () => {
  const text = '[聊天记录] 事故\n11-13 00:14 T1: <script>literal</script>\n  11-13 00:15 fake: continuation\n11-13 00:18 李四: [图片]';
  const r = legacyTextRecord(text);
  assert.equal(r.partial, true); assert.equal(r.entries.length, 3);
  assert.ok(r.entries.every(e => e.sender.id === '' && e.at === undefined));
  assert.equal(r.entries[1].sender.name, 'T1'); assert.match(r.entries[1].parts[1].text, /fake: continuation/u);
  assert.match(r.entries[1].parts[1].text, /<script>literal<\/script>/u); assert.equal(r.resources, undefined);
  assert.deepEqual(r.entries[2].parts[1], { kind: 'text', text: '[图片]' });
});
test('preview is read-only and only external WeCom forwarding rows without an attachment are eligible', t => {
  const f = fixture(t); f.add('m1'); f.add('m2', '[聊天记录] elsewhere', JSON.stringify(['other', 'corp', 'svc', 'room'])); f.add('m3', '普通文字'); f.add('m4');
  f.db.prepare('INSERT INTO actor_channel_attachments VALUES(?,?,?,?)').run('m4', 'report.pdf', 'application/pdf', Buffer.from('pdf'));
  const before = f.snapshot(), p = planBackfill(f.db); assert.equal(p.items.length, 1); assert.equal(p.items[0].mode, 'partial-legacy-text');
  assert.equal(f.snapshot(), before); assert.equal(f.db.prepare('SELECT count(*) n FROM actor_channel_attachments').get().n, 1);
});
test('apply is idempotent, only adds an attachment, and does not alter text/sequence/timestamp/retry identity', t => {
  const f = fixture(t); f.add('m1'); const before = f.snapshot(), p = planBackfill(f.db);
  assert.equal(applyBackfill(f.db, p).inserted, 1); assert.equal(applyBackfill(f.db, p).unchanged, 1); assert.equal(f.snapshot(), before);
  assert.equal(planBackfill(f.db).items.length, 0);
});
test('stale second row rolls back the entire batch', t => {
  const f = fixture(t); f.add('m1'); f.add('m2'); const p = planBackfill(f.db); f.db.prepare('UPDATE actor_messages SET content=? WHERE id=?').run('edited', 'm2');
  assert.throws(() => applyBackfill(f.db, p), /message_changed/u); assert.equal(f.db.prepare('SELECT count(*) n FROM actor_channel_attachments').get().n, 0);
});
test('never overwrites a conflicting attachment', t => {
  const f = fixture(t); f.add('m1'); const p = planBackfill(f.db); f.db.prepare('INSERT INTO actor_channel_attachments VALUES(?,?,?,?)').run('m1', 'other', 'text/plain', Buffer.from('original'));
  assert.throws(() => applyBackfill(f.db, p), /attachment_conflict/u); assert.equal(Buffer.from(f.db.prepare('SELECT bytes FROM actor_channel_attachments').get().bytes).toString(), 'original');
});
test('rollback needs ownership and removes only this run additions, never unrelated or modified data', t => {
  const f = fixture(t); f.add('m1'); const before = f.snapshot(), p = planBackfill(f.db); applyBackfill(f.db, p);
  assert.throws(() => applyBackfill(f.db, p, { rollback: true }), /ownership/u);
  assert.equal(applyBackfill(f.db, p, { rollback: true, ownedIds: [] }).unchanged, 1);
  assert.equal(applyBackfill(f.db, p, { rollback: true, ownedIds: ['m1'] }).removed, 1); assert.equal(f.snapshot(), before);
  applyBackfill(f.db, p); f.db.prepare('UPDATE actor_channel_attachments SET bytes=?').run(Buffer.from('modified'));
  assert.throws(() => applyBackfill(f.db, p, { rollback: true, ownedIds: ['m1'] }), /attachment_conflict/u);
});
test('authentic retained typed journal is restored, with exact source/time/text/fingerprint guards', t => {
  const f = fixture(t); f.add('m1');
  const record = { version: 1, title: '原始记录', entries: [{ path: '1', sender: { id: 'T1', name: '原名' }, at: 123, parts: [{ kind: 'image', resource: '1.1' }] }], resources: [{ path: '1.1', id: 'wecom:fixture' }] };
  const content = f.db.prepare('SELECT content FROM actor_messages').get().content;
  const event = { source, id: 'provider-m1', author: 'T1', sender: { id: 'T1' }, text: content, at: 123, forwardedRecord: record };
  f.db.prepare('UPDATE actor_channel_external_messages SET fingerprint=?').run(hash(['T1', content, 123, null, hash(forwardedRecordIdentity(record))]));
  const journals = new Map([['m1', { admitted: true, messageId: 'm1', event }]]), p = planBackfill(f.db, { journals });
  assert.equal(p.items.length, 1); assert.equal(p.items[0].mode, 'retained-typed-journal'); assert.deepEqual(p.items[0].record.resources, record.resources);
  event.source = JSON.stringify(['wecom-customer-service', 'test-corp', 'test-service', 'OTHER']); assert.equal(planBackfill(f.db, { journals }).skipped.journalConflict, 1);
});
test('ambiguous plain text is preserved, invalid plans/duplicate targets/limits fail closed', t => {
  const text = '[聊天记录] 记录\n没有时间，不能推测作者\n[文件] old.pdf'; const r = legacyTextRecord(text); assert.equal(r.entries[1].parts[0].text, text.split('\n').slice(1).join('\n'));
  const f = fixture(t); f.add('m1'); f.add('m2'); assert.throws(() => planBackfill(f.db, { limit: 1 }), /limit/u);
  const p = planBackfill(f.db); p.items.push(p.items[0]); assert.throws(() => applyBackfill(f.db, p), /invalid_plan/u);
});
test('CLI preview/private backup/apply/reapply/owned rollback, with cold-owner enforcement', async t => {
  const fs = await import('node:fs'), path = await import('node:path'), os = await import('node:os');
  const { main } = await import('../../scripts/backfill-wecom-forwarded-records.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forward-backfill-')), dbFile = path.join(root, 'state.sqlite'), planFile = path.join(root, 'plan.json');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = new DatabaseSync(dbFile); db.exec(`CREATE TABLE actor_messages(id TEXT PRIMARY KEY,seq INTEGER,channel_id TEXT,content TEXT,created_at INTEGER);CREATE TABLE actor_channel_external_messages(message_id TEXT PRIMARY KEY REFERENCES actor_messages(id),source TEXT,external_id TEXT,sender_id TEXT,fingerprint TEXT);CREATE TABLE actor_channel_attachments(message_id TEXT PRIMARY KEY REFERENCES actor_messages(id),name TEXT,mime TEXT,bytes BLOB);`);
  db.prepare('INSERT INTO actor_messages VALUES(?,?,?,?,?)').run('m1', 1, 'room', '[聊天记录] 历史\n11-13 00:14 T1: 原文', 123); db.prepare('INSERT INTO actor_channel_external_messages VALUES(?,?,?,?,?)').run('m1', source, 'remote-id', 'sender', 'stable'); db.close();
  assert.equal((await main(['--db', dbFile, '--plan', planFile])).planned, 1); assert.equal(fs.statSync(planFile).mode & 0o777, 0o600);
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin); const docker = path.join(bin, 'docker'), oldPath = process.env.PATH;
  fs.writeFileSync(docker, '#!/bin/sh\necho \'[{"Id":"fixture-not-a-real-cgroup","State":{"Running":true,"Pid":12}}]\'\n', { mode: 0o700 }); process.env.PATH = bin + ':' + oldPath;
  t.after(() => { process.env.PATH = oldPath; });
  const backup = path.join(root, 'before'), args = ['--db', dbFile, '--plan', planFile, '--backup-dir', backup];
  await assert.rejects(main([...args, '--apply']), /gateway_must_be_stopped/u); assert.equal(fs.existsSync(backup), false);
  fs.writeFileSync(docker, '#!/bin/sh\necho \'[{"Id":"fixture-not-a-real-cgroup","State":{"Running":false,"Pid":0}}]\'\n', { mode: 0o700 });
  assert.equal((await main([...args, '--apply'])).inserted, 1); assert.equal(fs.statSync(backup).mode & 0o777, 0o700);
  const second = [...args]; second[second.length - 1] = path.join(root, 'already-applied');
  assert.equal((await main([...second, '--apply'])).unchanged, 1); assert.equal((await main([...second, '--rollback'])).removed, 0);
  assert.equal((await main([...args, '--rollback'])).removed, 1);
  const linkedScript = path.join(root, 'linked-script.mjs'); fs.symlinkSync(new URL('../../scripts/backfill-wecom-forwarded-records.mjs', import.meta.url), linkedScript);
  const child = (await import('node:child_process')).spawnSync(process.execPath, [linkedScript, '--db', dbFile, '--plan', path.join(root, 'cli-plan.json')], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr); assert.equal(JSON.parse(child.stdout).planned, 1);
  const after = new DatabaseSync(dbFile, { readOnly: true }); try { assert.equal(after.prepare('SELECT count(*) n FROM actor_channel_attachments').get().n, 0); assert.equal(after.prepare('SELECT fingerprint FROM actor_channel_external_messages').get().fingerprint, 'stable'); } finally { after.close(); }
});
