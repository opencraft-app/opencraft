import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureSqliteReadGuard } from '../../packages/sqlite-node/src/index';

test('read proof detects own ABA, rollback, external commits and owner retirement without writes', t => {
  const root = mkdtempSync(join(tmpdir(), 'count-read-guard-'));
  t.after(() => rmSync(root, {recursive:true,force:true}));
  const path = join(root,'db.sqlite');
  const db = new DatabaseSync(path), other = new DatabaseSync(path);
  t.after(() => {other.close();db.close();});
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE t(n INTEGER); INSERT INTO t VALUES(1)');
  let current = true;
  const capture = () => captureSqliteReadGuard(db, () => current)!;
  const stable = capture();
  assert.equal(stable(),true);
  assert.equal(stable(),true);
  assert.equal(db.prepare('SELECT total_changes() AS n').get()!.n,1);
  db.exec('UPDATE t SET n=2; UPDATE t SET n=1');
  assert.equal(stable(),false);
  const rolledBack = capture();
  db.exec('BEGIN; UPDATE t SET n=2; ROLLBACK');
  assert.equal(rolledBack(),false);
  const external = capture();
  other.exec('UPDATE t SET n=2; UPDATE t SET n=1');
  assert.equal(external(),false);
  const retired = capture();current=false;
  assert.equal(retired(),false);current=true;
  assert.equal(retired(),false);
});

test('WAL fixed transaction cannot capture or validate a shared stable window', t => {
  const root = mkdtempSync(join(tmpdir(),'count-read-wal-'));
  t.after(() => rmSync(root,{recursive:true,force:true}));
  const db = new DatabaseSync(join(root,'db')), other = new DatabaseSync(join(root,'db'));
  t.after(() => {other.close();db.close();});
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE t(n); INSERT INTO t VALUES(1)');
  const valid = captureSqliteReadGuard(db,()=>true)!;
  db.exec('BEGIN'); db.prepare('SELECT * FROM t').all();
  assert.equal(captureSqliteReadGuard(db,()=>true),null);
  other.exec('UPDATE t SET n=2');
  assert.equal(valid(),false);
  db.exec('COMMIT');assert.equal(valid(),false);
});

test('closed/reopened connection requires a new original-owner lifetime', () => {
  const db=new DatabaseSync(':memory:');let current=true;
  const valid=captureSqliteReadGuard(db,()=>current)!;
  current=false;db.close();db.open();
  assert.equal(valid(),false);
  assert.equal(captureSqliteReadGuard(db,()=>current),null);
  db.close();
});
