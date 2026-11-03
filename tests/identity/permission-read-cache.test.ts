import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PermissionReadCache, withPermissionReads as read, withPermissionWrite as write } from '../../packages/access-control/src/permission-read-cache.js';
import { openServerDatabase } from '../../packages/storage-node/src/server/index.js';
import { ActorStore } from '../../packages/access-control/src/actors.js';
import { MembershipStore, InstanceAccess } from '../../packages/access-control/src/index.js';
function fixture(db: DatabaseSync, limit = 1024) {
  db.exec("CREATE TABLE policy(id TEXT PRIMARY KEY,enabled INTEGER); INSERT INTO policy VALUES('a',1)");
  const statement = db.prepare('SELECT enabled FROM policy WHERE id=?'), cache = new PermissionReadCache(db, db, limit);
  let loads = 0;
  return { cache, get: (id = 'a') => cache.get(id, () => { loads++; return statement.get(id)?.enabled; }), loads: () => loads };
}
test('permission snapshots reuse hits and misses and invalidate for local and external commits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oc-permission-cache-')), path = join(dir, 'policy.sqlite');
  const db = new DatabaseSync(path), other = new DatabaseSync(path);
  try {
    const f = fixture(db);
    read(() => { assert.equal(f.get(), 1); assert.equal(f.get(), 1); assert.equal(f.get('missing'), undefined); });
    read(() => { assert.equal(f.get(), 1); assert.equal(f.get('missing'), undefined); });
    assert.equal(f.loads(), 2);
    db.exec("UPDATE policy SET enabled=0 WHERE id='a'"); assert.equal(read(() => f.get()), 0);
    other.exec("UPDATE policy SET enabled=1 WHERE id='a'"); assert.equal(read(() => f.get()), 1);
    assert.equal(f.loads(), 4);
  } finally { other.close(); db.close(); await rm(dir, { recursive: true, force: true }); }
});
test('permission writes break nested snapshots; transaction and rolled-back rows never enter cache', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const f = fixture(db);
    read(() => {
      assert.equal(f.get(), 1);
      write(() => db.exec("UPDATE policy SET enabled=0 WHERE id='a'")); assert.equal(f.get(), 0);
      db.exec("BEGIN; UPDATE policy SET enabled=1 WHERE id='a'"); assert.equal(f.get(), 1);
      db.exec('ROLLBACK'); assert.equal(f.get(), 0);
    });
    assert.equal(read(() => f.get()), 0);
  } finally { db.close(); }
});
test('permission snapshots end at await and exceptions; schema changes and close cannot reuse rows', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const f = fixture(db);
    await read(async () => { assert.equal(f.get(), 1); await Promise.resolve(); db.exec("UPDATE policy SET enabled=0 WHERE id='a'"); assert.equal(f.get(), 0); });
    assert.throws(() => read(() => { f.get(); throw new Error('stop'); }), /stop/);
    db.exec("UPDATE policy SET enabled=1 WHERE id='a'"); assert.equal(read(() => f.get()), 1);
    db.exec('DROP TABLE policy; CREATE TABLE policy(id TEXT PRIMARY KEY,enabled INTEGER)'); assert.equal(read(() => f.get()), undefined);
    f.cache.close(); assert.throws(() => read(() => f.get()), /closed/);
  } finally { db.close(); }
});
test('permission cache evicts least recently used rows at its bound', () => {
  const db = new DatabaseSync(':memory:');
  try { const f = fixture(db, 2); read(() => { for (const id of ['a','b','a','c','a','b']) f.get(id); }); assert.equal(f.loads(), 4); }
  finally { db.close(); }
});
test('shared permission stores reuse one owner fence and preserve revocation, expiration and returned-value isolation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oc-permission-stores-')), source = await openServerDatabase(dir), db = source.database;
  const counts = new Map<string, number>(), prepare = db.prepare.bind(db);
  db.prepare = ((sql: string, ...rest: unknown[]) => {
    const statement = Reflect.apply(prepare, db, [sql, ...rest]);
    return new Proxy(statement, { get(target, key) {
      const value = Reflect.get(target, key, target); if (typeof value !== 'function') return value;
      return (...args: unknown[]) => { if (['get','all','run'].includes(String(key))) counts.set(sql, (counts.get(sql) ?? 0) + 1); return Reflect.apply(value, target, args); };
    } });
  }) as typeof db.prepare;
  let now = Date.now();
  const actors = new ActorStore(source, () => now), members = new MembershipStore(source);
  const principal = { provider:'fixture',subject:'human',displayName:'Human',expiresAt:now+10000 }, human = actors.resolveHuman(principal)!;
  members.set(principal, 'member', true, 'fixture'); members.setActor(human.actorId, 'member', true, 'fixture');
  const access = new InstanceAccess(members, [], actors);
  try {
    counts.clear(); for (let i=0;i<20;i++) assert.equal(access.admitsActor(human.actorId), true);
    for (const sql of ['SELECT * FROM actors WHERE id=?','SELECT binding FROM actor_bindings WHERE actor_id=? ORDER BY binding','SELECT role,enabled FROM members WHERE binding=?','SELECT role,enabled FROM actor_members WHERE actor_id=?']) assert.equal(counts.get(sql),1,sql);
    assert.equal(counts.get('PRAGMA data_version'),20,'repositories share the owner fence');
    read(() => {
      const bindings=actors.bindings(human.actorId); bindings[0]!.subject='mutated'; assert.equal(actors.bindings(human.actorId)[0]!.subject,'human');
      members.setActor(human.actorId,'member',false,'fixture'); assert.equal(access.admitsActor(human.actorId),false);
    });
    members.setActor(human.actorId,'member',true,'fixture'); assert.equal(access.admitsActor(human.actorId),true);
    read(() => { assert.equal(actors.isCurrent(human),true); actors.setEnabled(human.actorId,false,'fixture'); assert.equal(actors.isCurrent(human),false); });
    actors.setEnabled(human.actorId,true,'fixture'); assert.equal(read(() => actors.isCurrent(human)),false,'old generation stays revoked');
    const current=actors.resolveHuman(principal)!; assert.equal(read(() => actors.isCurrent(current)),true);
    now+=20000; assert.equal(read(() => actors.isCurrent(current)),false,'expiry is live');
    const other=new DatabaseSync(join(dir,'opencraft-server.sqlite'));
    try {
      other.prepare('UPDATE actor_members SET enabled=0 WHERE actor_id=?').run(human.actorId);
      assert.equal(access.admitsActor(human.actorId),false,'external writer revokes the cached member at the next boundary');
      other.prepare('UPDATE actor_members SET enabled=1 WHERE actor_id=?').run(human.actorId);
      assert.equal(access.admitsActor(human.actorId),true);
    } finally { other.close(); }
    const session=actors.createSession('Session','fixture'), credential=actors.issueCredential(session.id,now+60000,'fixture');
    const proof=actors.authenticateSession(credential.token)!;
    read(() => { assert.equal(actors.isCurrent(proof),true); actors.revokeCredential(credential.credentialId,'fixture'); assert.equal(actors.isCurrent(proof),false); });
    principal.expiresAt=0; assert.equal(access.role(principal),null,'cached rows cannot extend a login');
    actors.close(); assert.throws(() => read(() => actors.get(human.actorId)),/closed/);
  } finally { members.close(); actors.close(); await source.close(); await rm(dir,{recursive:true,force:true}); }
});
