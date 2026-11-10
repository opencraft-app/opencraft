import { parentPort, workerData, isMainThread } from 'node:worker_threads';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { openManagedDatabase, acquireProcessWriter, sqliteTransaction } from '@opencraft/sqlite-node';
import { projectToAppServer, assemble, createAssemblerState, type AssemblerState, type CanonicalInputState } from '@opencraft/agent-bridge-assembler';
import { parseThreadDeltaParams } from '@opencraft/agent-bridge-protocol';
import { migrations } from './migrations.js';
import type { Receipt, Generation, OutboxEvent } from './types.js';
if (isMainThread) throw Error('Bridge SQL must run in a Worker');
mkdirSync(dirname(workerData.path), { recursive: true, mode: 0o700 });
const release = acquireProcessWriter(`${workerData.path}.writer`);
const { database: db, outcome } = (() => {
  try { return openManagedDatabase({ path: workerData.path, migrations, legacyPolicy: 'reject' }); }
  catch (error) { release(); throw error; }
})();
db.exec('PRAGMA synchronous=FULL');
const tx = <T>(action: () => T) => sqliteTransaction(db, action);
const get = (sql: string, ...args: any[]) => db.prepare(sql).get(...args) as any;
const all = (sql: string, ...args: any[]) => db.prepare(sql).all(...args) as any[];
const run = (sql: string, ...args: any[]) => db.prepare(sql).run(...args);
const meta = (key: string) => get('SELECT value FROM meta WHERE key=?', key).value as string;
const setMeta = (key: string, value: string | number) => run('UPDATE meta SET value=? WHERE key=?', String(value), key);
class Refusal extends Error {}
const require = (condition: unknown, message: string): void => { if (!condition) throw new Refusal(message); };
let failed = false;
if (workerData.role === 'host') tx(() => {
  setMeta('epoch', Number(meta('epoch')) + 1);
  run("UPDATE commands SET state='unknown' WHERE state='dispatching'");
});
const receipt = (id: string): Receipt | null => {
  const row = get('SELECT * FROM commands WHERE id=?', id);
  return row ? { commandId: row.id, digest: row.digest, epoch: row.epoch, route: row.route, generation: row.generation, method: row.method, state: row.state,
    ...(row.response ? { response: JSON.parse(row.response) } : {}) } : null;
};
const events = (table: 'outbox' | 'inbox', cursor: number, limit = 256): OutboxEvent[] => all(`SELECT * FROM ${table} WHERE seq>? ORDER BY seq LIMIT ?`, cursor, limit)
  .map(row => ({ ...row, payload: JSON.parse(row.payload), ...(row.projection ? { projection: JSON.parse(row.projection) } : {}) }));
const checkpoint = (route: string): AssemblerState => {
  const row = get('SELECT state FROM checkpoints WHERE route=?', route);
  return row ? JSON.parse(row.state) : createAssemblerState(1);
};
const unsettledInput = (input: CanonicalInputState): boolean => {
  if (input.admission.value === 'unknown' || ['withdraw-requested', 'unknown'].includes(input.withdrawal.value)) return true;
  if (input.withdrawal.value === 'withdrawn' || ['rejected', 'failed'].includes(input.admission.value)) return false;
  if (input.disposition === 'queued' || input.disposition === null) return true;
  return ['pending', 'registered', 'queued', 'unknown'].includes(input.outcome);
};
const busy = (route: string): boolean => {
  const state = checkpoint(route);
  return !!get("SELECT 1 FROM commands WHERE route=? AND state IN ('registered','dispatching','unknown')", route)
    || !!get('SELECT 1 FROM interactions WHERE route=?', route)
    || Object.keys(state.streams).length > 0
    || Object.values(state.inputs).some(unsettledInput)
    || Object.keys(state.openTurns).length > 0 || Object.keys(state.openItems).length > 0
    || state.pendingAccepted.some(id => !state.inputs[id] || unsettledInput(state.inputs[id]!));
};
const operations: Record<string, (args: any) => any> = {
  ready: () => outcome,
  snapshot: () => ({ epoch: Number(meta('epoch')), current: meta('current'), ack: Number(meta('ack')),
    generations: all('SELECT * FROM generations').map(row => ({ ...row, config: JSON.parse(row.config) })), routes: all('SELECT * FROM routes'), nativeSessions: all('SELECT * FROM native_sessions') }),
  add: (config: Generation) => tx(() => {
    const previous = get('SELECT * FROM generations WHERE id=?', config.id);
    require(!previous || previous.config === JSON.stringify(config), 'Generation configuration is immutable');
    if (!previous) run('INSERT INTO generations(id,config) VALUES (?,?)', config.id, JSON.stringify(config));
  }),
  activate: ({ id, expected }: any) => tx(() => {
    require(meta('current') === expected, 'Stale current generation');
    require(get('SELECT 1 FROM generations WHERE id=? AND retired=0', id), 'Generation unavailable');
    setMeta('current', id);
  }),
  admit: ({ command, digest, route, maxSpoolBytes }: any) => tx(() => {
    const old = receipt(command.commandId);
    if (old) { require(old.digest === digest, 'commandId reused with different input'); return { receipt: old, fresh: false }; }
    require(!['session/create','turn/start','turn/steer'].includes(command.method) || Number(get('SELECT coalesce(sum(length(CAST(payload AS BLOB))),0) AS bytes FROM outbox').bytes) < maxSpoolBytes, 'Spool full; new admissions stopped');
    let binding = get('SELECT generation FROM routes WHERE route=?', route);
    if (binding && command.method === 'session/create') {
      // A rejected first create left only a route binding, no native session,
      // outbox or accepted command. Allow that Thread identity to retry rather
      // than bricking it; any accepted/unsettled command or native fact still
      // means "already exists".
      require(!get('SELECT 1 FROM native_sessions WHERE route=?', route)
        && !get('SELECT 1 FROM outbox WHERE route=?', route)
        && !get("SELECT 1 FROM commands WHERE route=? AND state<>'rejected'", route),
        'Thread already exists');
    }
    if (!binding) {
      require(!get('SELECT 1 FROM released_routes WHERE route=?', route), 'Thread is permanently closed');
      require(command.method === 'session/create', 'Thread must be explicitly created');
      const generation = meta('current');
      require(get('SELECT 1 FROM generations WHERE id=? AND retired=0', generation), 'No active generation');
      run('INSERT INTO routes VALUES (?,?)', route, generation); binding = { generation };
    }
    run('INSERT INTO commands(id,digest,epoch,route,generation,method,state) VALUES (?,?,?,?,?,?,?)', command.commandId, digest, Number(meta('epoch')), route, binding.generation, command.method, 'registered');
    return { receipt: receipt(command.commandId), fresh: true };
  }),
  threadState: ({ route }: any) => ({ state: checkpoint(route), nativeSession: get('SELECT * FROM native_sessions WHERE route=?', route) ?? null }),
  query: ({ id }: any) => receipt(id),
  dispatch: ({ id }: any) => tx(() => {
    require(receipt(id)?.state === 'registered', 'Command is not dispatchable');
    run("UPDATE commands SET state='dispatching' WHERE id=?", id); return receipt(id);
  }),
  settle: ({ id, response, state, interactionId }: any) => tx(() => {
    require(['accepted', 'rejected', 'unknown'].includes(state), 'Invalid settlement');
    // A late transport reply cannot erase an unknown outcome.
    if (receipt(id)?.state !== 'dispatching') return receipt(id);
    run('UPDATE commands SET state=?,response=? WHERE id=?', state, response ? JSON.stringify(response) : null, id);
    const row = receipt(id)!;
    if (state === 'accepted' && row.method === 'interaction/resolve' && typeof interactionId === 'string') run('DELETE FROM interactions WHERE route=? AND id=?', row.route, interactionId);
    // Closing the native session or stopping its turn resolves every pending
    // human interaction at the source; keeping the rows would block release.
    if (state === 'accepted' && (row.method === 'session/close' || row.method === 'turn/stop')) run('DELETE FROM interactions WHERE route=?', row.route);
    return row;
  }),
  callback: ({ generation, id, method, params }: any) => tx(() => {
    const digest = createHash('sha256').update(JSON.stringify({ method, params })).digest('hex');
    const previous = get('SELECT digest FROM callbacks WHERE generation=? AND id=?', generation, id);
    if (previous) { require(previous.digest === digest, 'Callback id reused'); return; }
    const route = params.threadId;
    require(typeof route === 'string' && get('SELECT 1 FROM routes WHERE route=? AND generation=?', route, generation), 'Callback generation does not own Thread');
    if (method === 'thread/identity') {
      require(typeof params.providerThreadId === 'string' && (params.sessionRestorable === undefined || typeof params.sessionRestorable === 'boolean'), 'Invalid native identity');
      run('INSERT INTO native_sessions VALUES (?,?,?,?) ON CONFLICT(route) DO UPDATE SET native_id=excluded.native_id,restorable=excluded.restorable', route, generation, params.providerThreadId, params.sessionRestorable === true ? 1 : 0);
    }
    if (method === 'interaction/request') require(typeof params.kind === 'string' && 'payload' in params, 'Invalid interaction');
    if (method === 'provider/recovery') require(['sessionArchived','authRequired','restartRecommended','staleTurn','rateLimited'].includes(params.kind)
      && typeof params.message === 'string' && typeof params.retryable === 'boolean', 'Invalid recovery');
    if (method === 'thread/delta') {
      const parsed = parseThreadDeltaParams(params);
      require(parsed.ok, parsed.reason ?? 'Invalid delta');
      require(parsed.params!.deltas.every(delta => delta.scope.threadId === route), 'Delta scope mismatch');
      const state = checkpoint(route);
      const previousTime = Number(get('SELECT at_ms FROM checkpoints WHERE route=?', route)?.at_ms ?? 0);
      const now = Math.max(Date.now(), previousTime);
      const result = assemble(state, parsed.params!.deltas, { threadId: route, clockSeed: now - state.seq });
      run('INSERT INTO checkpoints VALUES (?,?,?) ON CONFLICT(route) DO UPDATE SET state=excluded.state,at_ms=excluded.at_ms', route, JSON.stringify(result.state), result.events.at(-1)?.atMs ?? now);
      for (const event of result.events) run('INSERT INTO outbox(route,generation,payload) VALUES (?,?,?)', route, generation, JSON.stringify({ kind: 'canonical', event }));
    } else {
      require(['thread/identity', 'interaction/request', 'provider/recovery'].includes(method), 'Unsupported callback');
      if (method === 'interaction/request') {
        require(typeof params.interactionId === 'string', 'Missing interaction identity');
        run('INSERT OR IGNORE INTO interactions VALUES (?,?,?)', route, params.interactionId, generation);
      }
      run('INSERT INTO outbox(route,generation,payload) VALUES (?,?,?)', route, generation, JSON.stringify({ method, params }));
    }
    run('INSERT INTO callbacks VALUES (?,?,?)', generation, id, digest);
  }),
  events: ({ cursor, limit }: any) => {
    require(Number.isSafeInteger(cursor) && cursor >= Number(meta('ack')), 'Cursor is before acknowledged retention');
    require(Number.isSafeInteger(limit) && limit > 0 && limit <= 256, 'Invalid page limit');
    return events('outbox', cursor, limit);
  },
  ack: ({ cursor }: any) => tx(() => {
    const high = Number(get("SELECT coalesce((SELECT seq FROM sqlite_sequence WHERE name='outbox'),0) AS high").high);
    require(Number.isSafeInteger(cursor) && cursor >= Number(meta('ack')) && cursor <= high, 'Invalid acknowledgement');
    setMeta('ack', cursor); run('DELETE FROM outbox WHERE seq<=?', cursor);
  }),
  releaseRoute: ({ route }: any) => tx(() => {
    require(!busy(route), 'Thread still has work or unknown custody');
    require(get("SELECT 1 FROM commands WHERE route=? AND method='session/close' AND state='accepted'", route), 'Native close required');
    require(!get('SELECT 1 FROM outbox WHERE route=?', route), 'Thread events remain unacknowledged');
    run('INSERT INTO released_routes SELECT route,generation FROM routes WHERE route=?', route);
    run('DELETE FROM routes WHERE route=?', route);
  }),
  retire: ({ id }: any) => tx(() => {
    require(meta('current') !== id, 'Cannot retire current generation');
    require(!get('SELECT 1 FROM routes WHERE generation=?', id), 'Generation still has bindings');
    require(!get('SELECT 1 FROM outbox WHERE generation=?', id), 'Generation events remain unacknowledged');
    run('UPDATE generations SET retired=1 WHERE id=?', id);
  }),
  inbox: ({ batch }: { batch: OutboxEvent[] }) => tx(() => {
    let cursor = Number(meta('ack'));
    const inserted: OutboxEvent[] = [];
    for (const row of batch) {
      if (row.seq <= cursor) {
        const old = get('SELECT * FROM inbox WHERE seq=?', row.seq);
        require(old && old.route === row.route && old.generation === row.generation && old.payload === JSON.stringify(row.payload), 'Conflicting replay');
        continue;
      }
      require(row.seq === cursor + 1, 'Outbox sequence gap');
      const payload = row.payload as any;
      const projection = payload?.kind === 'canonical'
        ? projectToAppServer([{ ...payload.event, threadId: JSON.parse(row.route)[1] }], { steerEvidenceDeclared: false, schemaVersion: 1 }) : [];
      run('INSERT INTO inbox VALUES (?,?,?,?,?)', row.seq, row.route, row.generation, JSON.stringify(row.payload), JSON.stringify(projection));
      cursor = row.seq; inserted.push(row);
    }
    setMeta('ack', cursor); return { cursor, inserted };
  }),
  inboxRead: ({ cursor = 0 }: any) => events('inbox', cursor),
  cursor: () => Number(meta('ack')),
  close: () => { db.close(); release(); },
};
parentPort!.on('message', ({ id, op, args }) => {
  try {
    if (failed) throw new Refusal('Storage owner failed');
    if (!operations[op]) throw new Refusal('Unknown storage operation');
    const value = operations[op]!(args);
    parentPort!.postMessage({ id, value });
  } catch (error) {
    if (!(error instanceof Refusal)) { failed = true; try { db.close(); } finally { release(); } }
    parentPort!.postMessage({ id, error: error instanceof Error ? error.message : 'Storage failure', fatal: failed });
  }
});
