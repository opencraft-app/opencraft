#!/usr/bin/env node
// Temporary, offline-only data maintenance. Does not ingest/replay messages or grant sender identity.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { FORWARDED_RECORD_MIME, parseForwardedRecord, forwardedRecordIdentity } from '../../../packages/appserver-protocol/src/forwarded-record.ts';

const digest = value => createHash('sha256').update(typeof value === 'string' || value instanceof Uint8Array ? value : JSON.stringify(value)).digest('hex');
const select = `SELECT m.*,e.source AS provider_source,e.external_id,e.sender_id,e.fingerprint
 FROM actor_messages m JOIN actor_channel_external_messages e ON e.message_id=m.id`;
function eligible(row) {
  try {
    const s = JSON.parse(row.provider_source);
    return Array.isArray(s) && s.length === 4 && s[0] === 'wecom-customer-service'
      && s.every(v => typeof v === 'string' && v.length > 0 && v.length <= 512)
      && row.content.startsWith('[聊天记录] ');
  } catch { return false; }
}
const beforeHash = row => digest(row);
const nameFor = record => record.title.replace(/[\\/\x00-\x1f]/gu, '_').slice(0, 120) + '.chat-record.json';

/** Recover presentation labels only from the old transport's exact line format.
 * Missing years/provider IDs/media stay missing. Continuation lines remain literal.
 * The immutable native text is never changed and remains the original archive. */
export function legacyTextRecord(text) {
  const [header, ...lines] = text.split('\n'), entries = [{
    path: '0', sender: { id: '', name: '历史文本恢复说明' }, parts: [{ kind: 'notice',
      text: '仅由旧版文本恢复显示，并非原始聊天记录。姓名为历史文本标签，不代表已验证身份；年份与原始附件未保留。原消息文字保持不变。' }],
  }];
  let current;
  for (const line of lines) {
    const m = /^(\d{2}-\d{2} \d{2}:\d{2}) ([^:\r\n]{1,256}): (.*)$/u.exec(line);
    const date = m && /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01]) ([01]\d|2[0-3]):[0-5]\d$/u.test(m[1]);
    if (date && entries.length < 999) {
      current = { path: String(entries.length), sender: { id: '', name: m[2] }, parts: [
        { kind: 'notice', text: `历史时间标签：${m[1]}（年份未知）` },
        { kind: 'text', text: m[3] },
      ] };
      entries.push(current);
    } else {
      if (!current) { current = { path: String(entries.length), sender: { id: '', name: '历史文本' }, parts: [{ kind: 'text', text: line }] }; entries.push(current); }
      else current.parts.at(-1).text += '\n' + line;
    }
  }
  return parseForwardedRecord({ version: 1, title: header.slice('[聊天记录] '.length).slice(0, 256) || '聊天记录', partial: true, entries });
}

export function journalRecords(roots) {
  const found = new Map(), conflicts = new Set();
  function visit(directory, depth = 0) {
    if (depth > 2 || !fs.existsSync(directory)) return;
    for (const e of fs.readdirSync(directory, { withFileTypes: true })) {
      const f = path.join(directory, e.name);
      if (e.isDirectory()) { visit(f, depth + 1); continue; }
      if (!e.isFile() || !/^[a-f0-9]{64}\.json$/u.test(e.name) || fs.statSync(f).size > 8 * 1024 * 1024) continue;
      let row; try { row = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
      const event = row?.event;
      if (row.admitted !== true || typeof row.messageId !== 'string' || !event?.forwardedRecord) continue;
      const key = digest([event.source, event.id]);
      if (e.name !== key + '.json') continue;
      const prior = found.get(row.messageId);
      if (prior && digest(prior.event) !== digest(event)) conflicts.add(row.messageId);
      else found.set(row.messageId, row);
    }
  }
  for (const root of roots) visit(root);
  for (const id of conflicts) found.set(id, { conflict: true });
  return found;
}

export function planBackfill(db, { journals = new Map(), limit = 1000 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw Error('invalid_limit');
  const rows = db.prepare(select + " WHERE substr(m.content,1,7)='[聊天记录] ' ORDER BY m.seq LIMIT ?").all(limit + 1);
  if (rows.length > limit) throw Error('backfill_limit_exceeded');
  const items = [], skipped = { provider: 0, attached: 0, journalConflict: 0, invalid: 0 };
  for (const row of rows) {
    if (!eligible(row)) { skipped.provider++; continue; }
    if (db.prepare('SELECT 1 FROM actor_channel_attachments WHERE message_id=?').get(row.id)) { skipped.attached++; continue; }
    const j = journals.get(row.id); let record, mode;
    try {
      if (j) {
        const a = j.event;
        if (j.conflict || !a || j.messageId !== row.id || a.source !== row.provider_source || a.id !== row.external_id
          || a.text !== row.content || a.at !== row.created_at) { skipped.journalConflict++; continue; }
        const sender = a.sender?.id ?? a.author;
        const extension = [...(a.mentioned === true && a.assistantEligible === true ? [true, a.author] : []),
          digest(forwardedRecordIdentity(a.forwardedRecord))];
        if (row.fingerprint !== digest([sender, a.text, a.at, a.mediaIdentity ?? a.mediaId ?? null, ...extension])) { skipped.journalConflict++; continue; }
        record = parseForwardedRecord(a.forwardedRecord); mode = 'retained-typed-journal';
      } else { record = legacyTextRecord(row.content); mode = 'partial-legacy-text'; }
      const bytes = JSON.stringify(record);
      items.push({ messageId: row.id, beforeHash: beforeHash(row), mode, name: nameFor(record), record, bytesSha256: digest(bytes) });
    } catch { skipped.invalid++; }
  }
  return { schemaVersion: 1, kind: 'wecom-forwarded-record-backfill', id: randomUUID(), createdAt: Date.now(), items, skipped };
}
function validated(plan) {
  if (plan?.schemaVersion !== 1 || plan.kind !== 'wecom-forwarded-record-backfill' || !Array.isArray(plan.items) || plan.items.length > 1000) throw Error('invalid_plan');
  const ids = new Set();
  return plan.items.map(item => {
    if (!item || typeof item.messageId !== 'string' || ids.has(item.messageId) || !/^[a-f0-9]{64}$/u.test(item.beforeHash)) throw Error('invalid_plan');
    ids.add(item.messageId);
    const record = parseForwardedRecord(item.record), bytes = Buffer.from(JSON.stringify(record));
    if (digest(bytes) !== item.bytesSha256 || nameFor(record) !== item.name) throw Error('plan_payload_changed');
    return { ...item, bytes };
  });
}
export function applyBackfill(db, plan, { rollback = false, ownedIds } = {}) {
  if (rollback && (!Array.isArray(ownedIds) || ownedIds.some(id => !plan.items.some(i => i.messageId === id)))) throw Error('rollback_ownership_required');
  const ownership = new Set(ownedIds ?? []);
  const items = validated(plan), result = { inserted: 0, removed: 0, unchanged: 0 };
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000; BEGIN IMMEDIATE');
  try {
    for (const item of items) {
      if (rollback && !ownership.has(item.messageId)) { result.unchanged++; continue; }
      const row = db.prepare(select + ' WHERE m.id=?').get(item.messageId);
      if (!row || !eligible(row) || beforeHash(row) !== item.beforeHash) throw Error('message_changed');
      const existing = db.prepare('SELECT name,mime,bytes FROM actor_channel_attachments WHERE message_id=?').get(item.messageId);
      if (existing && (existing.name !== item.name || existing.mime !== FORWARDED_RECORD_MIME || digest(existing.bytes) !== item.bytesSha256)) throw Error('attachment_conflict');
      if (rollback) {
        if (existing) { db.prepare('DELETE FROM actor_channel_attachments WHERE message_id=?').run(item.messageId); result.removed++; }
        else result.unchanged++;
      } else if (existing) result.unchanged++;
      else { db.prepare('INSERT INTO actor_channel_attachments(message_id,name,mime,bytes) VALUES(?,?,?,?)').run(item.messageId, item.name, FORWARDED_RECORD_MIME, item.bytes); result.inserted++; }
    }
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw Error('foreign_key_check_failed');
    if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw Error('quick_check_failed');
    db.exec('COMMIT'); return result;
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
function assertCold() {
  const v = JSON.parse(execFileSync('docker', ['inspect', 'opencraft-gateway-1'], { encoding: 'utf8' }))[0];
  if (v.State.Running || v.State.Pid !== 0) throw Error('gateway_must_be_stopped');
  for (const name of fs.readdirSync('/proc').filter(n => /^\d+$/u.test(n))) {
    try {
      if (!fs.readFileSync('/proc/' + name + '/cgroup', 'utf8').includes(v.Id)) continue;
      const stat = fs.readFileSync('/proc/' + name + '/stat', 'utf8');
      if (stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z') throw Error('gateway_native_owner_still_alive');
    } catch (e) { if (e.message === 'gateway_native_owner_still_alive') throw e; }
  }
}
export async function main(argv) {
  const opts = { journals: [] }; let mode = 'plan';
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--apply' || k === '--rollback') { if (mode !== 'plan') throw Error('conflicting_modes'); mode = k.slice(2); }
    else if (['--db', '--plan', '--journal-root', '--backup-dir'].includes(k) && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      const v = path.resolve(argv[++i]); if (k === '--journal-root') opts.journals.push(v); else { const key = k.slice(2); if (opts[key]) throw Error('duplicate_option'); opts[key] = v; }
    } else throw Error('Usage: --db FILE --plan PRIVATE.json [--journal-root DIR] [--apply --backup-dir NEWDIR | --rollback]');
  }
  if (!opts.db || !opts.plan) throw Error('db_and_plan_required');
  if (mode !== 'plan') assertCold();
  if (!fs.statSync(opts.db).isFile()) throw Error('database_must_exist');
  const metadata = new Map(['','-wal','-shm'].filter(s => fs.existsSync(opts.db + s)).map(s => [s, fs.statSync(opts.db + s)]));
  const db = new DatabaseSync(opts.db, { readOnly: mode === 'plan' });
  try {
    if (mode === 'plan') {
      const plan = { ...planBackfill(db, { journals: journalRecords(opts.journals) }), database: opts.db };
      fs.writeFileSync(opts.plan, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      return { mode, planned: plan.items.length, modes: Object.fromEntries(['retained-typed-journal', 'partial-legacy-text'].map(k => [k, plan.items.filter(i => i.mode === k).length])), skipped: plan.skipped };
    }
    const stat = fs.lstatSync(opts.plan); if (!stat.isFile() || (stat.mode & 0o077)) throw Error('plan_must_be_private_regular_file');
    const plan = JSON.parse(fs.readFileSync(opts.plan, 'utf8')); if (plan.database !== opts.db) throw Error('database_path_changed');
    validated(plan);
    if (mode === 'apply') {
      if (!opts['backup-dir']) throw Error('backup_dir_required');
      fs.mkdirSync(opts['backup-dir'], { mode: 0o700 });
      const files = [];
      for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(opts.db + suffix)) {
        const dest = path.join(opts['backup-dir'], 'database.sqlite' + suffix); fs.copyFileSync(opts.db + suffix, dest); fs.chmodSync(dest, 0o600);
        files.push({ file: path.basename(dest), sha256: digest(fs.readFileSync(dest)) });
      }
      const ownedIds = plan.items.filter(i => !db.prepare('SELECT 1 FROM actor_channel_attachments WHERE message_id=?').get(i.messageId)).map(i => i.messageId);
      const backup = new DatabaseSync(path.join(opts['backup-dir'], 'database.sqlite'), { readOnly: true });
      try { if (backup.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw Error('invalid_backup'); } finally { backup.close(); }
      for (const f of files) f.sha256 = digest(fs.readFileSync(path.join(opts['backup-dir'], f.file)));
      fs.writeFileSync(path.join(opts['backup-dir'], 'receipt.json'), JSON.stringify({ planId: plan.id, files, ownedIds }), { flag: 'wx', mode: 0o600 });
    }
    let ownedIds;
    if (mode === 'rollback') {
      if (!opts['backup-dir']) throw Error('backup_dir_required');
      const receipt = JSON.parse(fs.readFileSync(path.join(opts['backup-dir'], 'receipt.json')));
      if (receipt.planId !== plan.id || !Array.isArray(receipt.ownedIds)) throw Error('backup_plan_mismatch');
      for (const f of receipt.files) if (!['database.sqlite','database.sqlite-wal','database.sqlite-shm'].includes(f.file) || digest(fs.readFileSync(path.join(opts['backup-dir'], f.file))) !== f.sha256) throw Error('backup_changed');
      ownedIds = receipt.ownedIds;
    }
    return { mode, ...applyBackfill(db, plan, { rollback: mode === 'rollback', ownedIds }) };
  } finally {
    db.close();
    // An operator running as root must not leave newly-created WAL files owned by root.
    if (mode !== 'plan' && process.getuid?.() === 0) for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(opts.db + suffix)) {
      const stat = metadata.get(suffix) ?? metadata.get(''); fs.chownSync(opts.db + suffix, stat.uid, stat.gid); fs.chmodSync(opts.db + suffix, stat.mode & 0o777);
    }
  }
}
if (process.argv[1] && fs.realpathSync(new URL(import.meta.url)) === fs.realpathSync(process.argv[1])) {
  main(process.argv.slice(2)).then(v => console.log(JSON.stringify(v))).catch(() => { console.error('Backfill refused or failed; inspect private maintenance receipts. No message replay performed.'); process.exitCode = 1; });
}
