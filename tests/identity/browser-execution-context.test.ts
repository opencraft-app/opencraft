import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { openServerDatabase } from '../../packages/storage-node/src/server/index.js';
import { ActorStore } from '../../packages/access-control/src/actors.js';
import { Collaboration } from '../../packages/access-control/src/collaboration.js';
import { OrchestrationRuntimeWorker } from '../../packages/access-control/src/orchestration-runtime-store.js';

test('execution context uses Worker SQL, matches input and turn authority, and rechecks human revocation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'browser-execution-context-'));
  const owner = await openServerDatabase(directory), actors = new ActorStore(owner);
  const human = actors.resolveHuman({ provider: 'local', subject: 'one', displayName: 'One', expiresAt: Date.now() + 60000 })!;
  const other = actors.resolveHuman({ provider: 'local', subject: 'two', displayName: 'Two', expiresAt: Date.now() + 60000 })!;
  const worker = new OrchestrationRuntimeWorker(join(directory, 'opencraft-server.sqlite')); await worker.start();
  let resourcesAllowed = true;
  const service = new Collaboration(owner, actors, { hostId: 'host', serverId: 'server', async validate() {}, async receipt() { return null; }, async add() { return null; }, async steer() {}, async cancel() { return false; } },
    Date.now, () => true, worker, () => resourcesAllowed);
  t.after(async () => { await service.close(); await worker.close(); actors.close(); await owner.close(); await rm(directory, { recursive: true, force: true }); });
  service.authorizeExecution(human, 'thread', 'first'); service.executionStarted('thread', 'first', 'first-turn');
  service.executionStarted('thread', 'first', 'continuation');
  service.authorizeExecution(other, 'thread', 'other'); service.executionStarted('thread', 'other', 'other-turn');
  assert.equal((await service.executionContext('thread', { turnId: 'continuation' })).context.actorId, human.actorId);
  const authority = await service.executionContext('thread', { inputId: 'first' });
  owner.database.prepare('INSERT INTO opencraft_input_authorities VALUES(?,?,?)').run('alias-thread', 'alias-input', authority.authorityId);
  const prepare = DatabaseSync.prototype.prepare, exec = DatabaseSync.prototype.exec;
  const probe = new DatabaseSync(':memory:'), statement = probe.prepare('SELECT 1'), prototype = Object.getPrototypeOf(statement);
  const methods = new Map(['get', 'all', 'run', 'iterate'].map(name => [name, prototype[name]])); probe.close();
  const forbidden = () => { throw new Error('SQL on network main thread'); };
  DatabaseSync.prototype.prepare = forbidden; DatabaseSync.prototype.exec = forbidden;
  for (const name of methods.keys()) prototype[name] = forbidden;
  try {
    const result = await service.executionContext('thread', { inputId: 'first', turnId: 'continuation' });
    assert.equal(result.context.actorId, human.actorId); assert.equal(result.turnId, 'continuation');
    await assert.rejects(service.executionContext('thread', { inputId: 'first', turnId: 'other-turn' }));
    await assert.rejects(service.executionContext('foreign', { turnId: 'first-turn' }));
    await assert.rejects(service.executionContext('alias-thread', { inputId: 'alias-input', turnId: 'first-turn' }), undefined,
      'an input alias cannot borrow a similarly named turn from its source thread');
    resourcesAllowed = false; await assert.rejects(service.executionContext('thread', { turnId: 'first-turn' })); resourcesAllowed = true;
  } finally {
    DatabaseSync.prototype.prepare = prepare; DatabaseSync.prototype.exec = exec;
    for (const [name, value] of methods) prototype[name] = value;
  }
  actors.setEnabled(human.actorId, false, other.actorId);
  await assert.rejects(service.executionContext('thread', { inputId: 'first' }));
});
