import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOGICAL_CLIENT_FIELD as CLIENT } from '@opencraft/app-host-protocol';
import { TokenUsageStateDatabase } from '../../apps/opencraft-daemon/src/token-usage-state-database.js';
import { OpenCraftTokenUsageLedger } from '../../apps/opencraft-daemon/src/token-usage-ledger.js';
import { TokenUsageQueryService } from '../../apps/opencraft-daemon/src/token-usage-query-service.js';
import { TokenUsageQueryTransport } from '../../apps/opencraft-daemon/src/token-usage-query-transport.js';
import type { DuplexTransport } from '@opencraft/appserver-client/transport';
const params = { from: '2026-10-21', through: '2026-10-21' };
for (const engine of ['dsh', 'pi']) test(`${engine}: existing statistics retain self/team authorization`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'usage-routing-'));
  const state = new TokenUsageStateDatabase(directory), ledger = new OpenCraftTokenUsageLedger(state, 'server', () => Date.parse('2026-10-21T00:00:00Z'));
  const key = { threadId: 'thread', turnId: 'turn' };
  ledger.startTurn(key, Date.parse('2026-10-21T00:00:00Z'), 'human', true);
  for (const actorId of ['alice', 'bob']) ledger.recordInput(key, { inputId: actorId, actorId, actorKind: 'human', mode: 'start', admission: 'confirmed' });
  ledger.recordSource({ ...key, lineage: 'native', sourceId: 'response', kind: 'response', version: 0, provider: 'p', model: 'm', counts: { totalTokens: '1200' } });
  const service = new TokenUsageQueryService({ entry: new URL('../../apps/opencraft-daemon/src/token-usage-query-worker.ts', import.meta.url).pathname, databasePath: join(directory, 'token-usage.sqlite'), serverId: 'server' });
  const listeners = new Set<(frame: string) => void>();
  const native: DuplexTransport = {
    status: { state: 'open' }, async connect() {}, async close() {}, subscribeStatus() { return () => {}; },
    subscribeMessage(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    async send(frame) {
      const r = JSON.parse(frame);
      if (r.method === 'runtime/client/disconnect') return;
      const response = r.method === 'initialize' ? { result: { engine } } : { error: { code: -32603, message: `Method not supported by OpenCraft DSH host: ${r.method}` } };
      for (const fn of listeners) fn(JSON.stringify({ id: r.id, [CLIENT]: r[CLIENT], ...response }));
    },
  };
  const transport = new TokenUsageQueryTransport(native, service);
  const replies: any[] = []; transport.subscribeMessage(frame => replies.push(JSON.parse(frame)));
  t.after(async () => { await transport.close(); service.close(); state.close(); await rm(directory, { recursive: true, force: true }); });
  let authority: { actorId: string; administrator: boolean } | null = { actorId: 'alice', administrator: false }, sequence = 0;
  const request = async (method: string, parameters: unknown = {}) => {
    const id = ++sequence;
    const frame = JSON.stringify({ id, method, params: parameters, [CLIENT]: 'client' });
    if (transport.sendWithContext) await transport.sendWithContext(frame, { sender: null, tokenUsageAuthority: () => authority });
    else await transport.send(frame);
    return replies.find(value => value.id === id);
  };
  await request('initialize');
  const own = await request('opencraft/token-usage/query', params);
  assert.equal(own.error, undefined, JSON.stringify(own.error));
  assert.equal(own.result.summary.tokens, '600');
  assert.equal((await request('opencraft/token-usage/query', { ...params, scope: 'team' })).error.code, 403);
  assert.equal((await request('opencraft/token-usage/query', { ...params, actorId: 'bob' })).error.code, 403);
  authority = { actorId: 'admin', administrator: true };
  assert.equal((await request('opencraft/token-usage/query', { ...params, scope: 'team' })).result.summary.tokens, '1200');
  const revoked = request('opencraft/token-usage/query', params); authority = null;
  assert.equal((await revoked).error.code, 401);
  assert.equal((await request('opencraft/token-usage/query', params)).error.code, 401);
  authority = { actorId: 'alice', administrator: false };
  const retired = request('opencraft/token-usage/query', params);
  await request('runtime/client/disconnect');
  assert.equal(await retired, undefined, 'no late response for disconnected client');
});
