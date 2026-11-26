import { parentPort, workerData, isMainThread } from 'node:worker_threads';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { openManagedDatabase, acquireProcessWriter, sqliteTransaction, nodeSqlDatabase } from '@opencraft/sqlite-node';
import { assemble, createAssemblerState, type AssemblerState, type CanonicalInputState } from '@opencraft/agent-bridge-assembler';
import {
  BRIDGE_MAX_FRAGMENTED_EVENT_BYTES, BRIDGE_OUTBOX_FRAGMENT_BYTES, BRIDGE_OUTBOX_PAGE_BYTES,
  BRIDGE_ERROR_CODES, BRIDGE_THREAD_NOTIFICATIONS, isSuccess, isTerminalInteraction, parseThreadDeltaParams,
} from '@opencraft/agent-bridge-protocol';
import { ThreadQueueStore } from '@opencraft/thread-queue';
import { migrations } from './migrations.js';
import { queuedCommandId, queuedTurnAcknowledgement } from './queue.js';
import { BridgeInboxRefusal, createBridgeInboxStore, HISTORY_IDENTITIES, HISTORY_IDENTITY_COLUMNS, historyIdentity, prepareSelectedHistory } from './inbox-store.js';
import { isArchiveCommand, type BridgeHistorySelection, type Receipt, type Generation, type OutboxEvent, type OutboxFence } from './types.js';
/** Commands that bring a Thread route into existence, and that end its native session. */
const CREATES: readonly string[] = ['session/create', 'session/fork', 'session/adopt'];
const ENDS: readonly string[] = ['session/close', 'session/delete'];
if (isMainThread) throw Error('Bridge SQL must run in a Worker');
const readOnly = workerData.role === 'rollback-identities';
if (!readOnly) mkdirSync(dirname(workerData.path), { recursive: true, mode: 0o700 });
const release = readOnly ? () => {} : acquireProcessWriter(`${workerData.path}.writer`);
const { database: db, outcome } = (() => {
  try {
    // Native session bindings first shipped in v2. Reading a legacy prefix
    // does not require taking the Bridge writer lock or migrating the store.
    return openManagedDatabase({
      schemaId: "agent-bridge-host", path: workerData.path, migrations, legacyPolicy: 'reject',
      readOnly: readOnly ? { minimumVersion: 2 } : undefined,
    });
  }
  catch (error) { release(); throw error; }
})();
if (!readOnly) db.exec('PRAGMA synchronous=FULL');
const tx = <T>(action: () => T) => sqliteTransaction(db, action);
const get = (sql: string, ...args: any[]) => db.prepare(sql).get(...args) as any;
const all = (sql: string, ...args: any[]) => db.prepare(sql).all(...args) as any[];
const run = (sql: string, ...args: any[]) => db.prepare(sql).run(...args);
const meta = (key: string) => get('SELECT value FROM meta WHERE key=?', key).value as string;
const setMeta = (key: string, value: string | number) => run('UPDATE meta SET value=? WHERE key=?', String(value), key);
class Refusal extends Error {}
const require = (condition: unknown, message: string): void => { if (!condition) throw new Refusal(message); };
let failed = false;
const sql = nodeSqlDatabase(db);
function publishQueueChanged(route: string): boolean {
  return run(
    'INSERT INTO outbox(route,generation,payload) SELECT route,generation,? FROM routes WHERE route=?',
    JSON.stringify({ method: 'thread/queue/changed', params: { threadId: route } }), route,
  ).changes === 1;
}

const archivePending = (route: string): boolean =>
  !!get("SELECT 1 FROM commands WHERE route=? AND method IN ('session/archive','session/unarchive') AND state IN ('registered','dispatching')", route);
const queueActive = (route: string, archiveState?: string): boolean =>
  (archiveState ?? get('SELECT archive_state FROM routes WHERE route=?', route)?.archive_state) === 'active' && !archivePending(route);

const queue = workerData.role === 'host' ? tx(() => {
  run("INSERT OR IGNORE INTO meta VALUES ('outbox-id',lower(hex(randomblob(16))))");
  setMeta('epoch', Number(meta('epoch')) + 1);
  run(`UPDATE routes SET archive_state='unconfirmed' WHERE route IN (
    SELECT route FROM commands WHERE method IN ('session/archive','session/unarchive') AND state='dispatching'
  )`);
  // Only a recorded dispatch can have reached the provider.
  run("UPDATE commands SET state='unknown' WHERE state='dispatching'");
  run("UPDATE commands SET state='rejected', response=json_object('jsonrpc','2.0','id','host-command:'||id,'error',json_object('kind','explicit-reject','code',?,'message',?)) WHERE state='registered'",
    BRIDGE_ERROR_CODES.explicitReject, 'Bridge Host restarted before dispatch');
  run("UPDATE automation_scripts SET state='unknown' WHERE state IN ('admitted','running')");

  const queue = new ThreadQueueStore(sql, { recoverPending: false });
  const changedRoutes = new Set<string>();
  const commandOutcome = db.prepare(
    "SELECT state,response FROM commands WHERE id=? AND route=? AND method=? AND state IN ('accepted','rejected')",
  );
  const pending = all(`
    SELECT q.thread_id,q.id,d.revision
    FROM opencraft_host_queue q
    LEFT JOIN opencraft_input_delivery d ON d.thread_id=q.thread_id AND d.client_id=q.client_id
    WHERE q.state='dispatching' OR (q.state='closed' AND d.native_admission='pending')
  `);
  for (const { thread_id: route, id, revision } of pending) {
    const row = queue.find(route, id)!;
    const kind = row.targetTurnId === 'unknown' ? 'start' : 'steer';
    // The projected delivery revision can include a terminal Turn observed after the claim.
    const outcome = row.targetTurnId
      ? commandOutcome.get(queuedCommandId(kind, route, row, revision ?? 0), route, 'turn/' + kind)
      : undefined;
    const acknowledgement = outcome?.state === 'accepted' && typeof outcome.response === 'string'
      ? queuedTurnAcknowledgement(JSON.parse(outcome.response), kind === 'steer' ? row.targetTurnId! : undefined)
      : null;
    if (acknowledgement)
      queue.settle(route, id, kind === 'start' ? 'delivered' : 'steering', null, acknowledgement.turnId);
    else if (outcome?.state === 'rejected' &&
      row.delivery?.nativeAdmission !== 'accepted' && row.delivery?.context !== 'recorded')
      queue.settle(route, id, 'queued', kind === 'start' ? 'delivery-rejected' : null);
    else
      queue.settle(route, id, 'unknown', 'steer-delivery-unconfirmed');
    changedRoutes.add(route);
  }
  for (const route of changedRoutes) publishQueueChanged(route);
  return queue;
}) : null;
const inbox = readOnly ? undefined : createBridgeInboxStore(sql);
const selectedOutboxHistory = readOnly ? undefined : prepareSelectedHistory(sql, 'outbox');
const QUEUE_METHODS = new Set(['add', 'list', 'listPage', 'listReconciliation', 'find', 'findByClientId', 'firstAwaitingAdmission', 'update', 'delete', 'reorder', 'claim', 'settle',
  'requestRetry', 'resumeRequestedRetry', 'discardUnknown', 'discardThread', 'recordInput', 'finishTurn', 'receipt', 'pendingThreads', 'maintenanceCounts', 'interruptExecution']);
const receipt = (id: string): Receipt | null => {
  const row = get('SELECT * FROM commands WHERE id=?', id);
  return row ? { commandId: row.id, digest: row.digest, epoch: row.epoch, route: row.route, generation: row.generation, method: row.method, state: row.state,
    ...(row.response ? { response: JSON.parse(row.response) } : {}) } : null;
};
const events = (cursor: number, limit: number): OutboxEvent[] => {
  const page: OutboxEvent[] = [];
  let bytes = 1024; // Fence, brackets and separators.
  for (const row of db.prepare('SELECT * FROM outbox WHERE seq>? ORDER BY seq LIMIT ?').iterate(cursor, limit)) {
    const { payload, ...envelope } = row as unknown as OutboxEvent & { payload: string };
    const rowBytes = Buffer.byteLength(JSON.stringify(envelope)) + Buffer.byteLength(payload) + 16;
    if (page.length && bytes + rowBytes > BRIDGE_OUTBOX_PAGE_BYTES) break;
    page.push({ ...envelope, payload: JSON.parse(payload) });
    bytes += rowBytes;
    if (bytes >= BRIDGE_OUTBOX_PAGE_BYTES) break;
  }
  return page;
};
const outboxFence = (): OutboxFence => ({
  outboxId: meta('outbox-id'),
  acknowledged: Number(meta('ack')),
  high: Number(get("SELECT coalesce((SELECT seq FROM sqlite_sequence WHERE name='outbox'),0) AS high").high),
});
interface EncodedOutboxEvent {
  cursor: number;
  seq: number;
  body: Buffer;
  digest: string;
}

// Retained outbox rows are immutable. Keep one bounded encoding beside the
// storage owner so fragment retries reuse its bytes without reviving acked rows.
let encodedOutboxEvent: EncodedOutboxEvent | undefined;
const checkpoint = (route: string): AssemblerState => {
  const row = get('SELECT state FROM checkpoints WHERE route=?', route);
  return row ? JSON.parse(row.state) : createAssemblerState(1);
};
function receiptWithIdentities(id: string): Receipt | null {
  const row = receipt(id);
  if (!row || row.state !== 'accepted' || !row.response || !isSuccess(row.response)) return row;
  const result = row.response.result as { turn?: { id?: unknown }; nativeTurnId?: unknown; turnId?: unknown } | null;
  const nativeId = result?.turn?.id ?? result?.nativeTurnId ?? result?.turnId;
  const identities: NonNullable<Receipt['identities']> = {};
  if (CREATES.includes(row.method)) {
    const native = get('SELECT native_id FROM native_sessions WHERE route=?', row.route)?.native_id;
    if (typeof native === 'string') identities.nativeThreadId = native;
  }
  if (typeof nativeId === 'string' && ['turn/start', 'turn/steer'].includes(row.method)) {
    const state = checkpoint(row.route);
    const id = state.openTurns[nativeId]?.turnId ?? state.settledNativeTurns[nativeId];
    if (typeof id === 'string') identities.turn = { nativeId, id };
  }
  return identities.nativeThreadId !== undefined || identities.turn !== undefined ? { ...row, identities } : row;
}
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
const turnIdle = (route: string, excludingCommandId = ''): boolean =>
  !get("SELECT 1 FROM commands WHERE route=? AND id<>? AND method IN ('turn/start','turn/steer') AND state IN ('registered','dispatching','unknown')", route, excludingCommandId)
  && Object.keys(checkpoint(route).openTurns).length === 0;
const operations: Record<string, (args: any) => any> = {
  scriptAdmit: ({key,digest}:any) => tx(()=>{
    const previous=get('SELECT * FROM automation_scripts WHERE key=?',key);
    if(previous){require(previous.digest===digest,'Script key reused with different input');return {fresh:false,...previous,result:previous.result?JSON.parse(previous.result):null};}
    run("INSERT INTO automation_scripts VALUES(?,?,'admitted',NULL)",key,digest);return {fresh:true,key,state:'admitted'};
  }),
  scriptShow: ({key}:any) => {const row=get('SELECT * FROM automation_scripts WHERE key=?',key);return row?{...row,result:row.result?JSON.parse(row.result):null}:null;},
  scriptSettle: ({key,state,result}:any) => {
    require(['running','completed','failed','unknown'].includes(state),'Invalid script state');
    run("UPDATE automation_scripts SET state=?,result=? WHERE key=? AND state IN ('admitted','running')",state,JSON.stringify(result??null),key);
  },
  ready: () => outcome,
  queue: ({ method, args }: any) => {
    require(queue !== null && typeof method === 'string' && QUEUE_METHODS.has(method) && Array.isArray(args), 'Unsupported queue operation');
    if (method === 'claim' && !queueActive(args[0])) return null;
    return (queue as any)[method](...args);
  },
  // A route on an older generation that could move to the current one: nothing open, in custody or waiting.
  migration: ({ route }: any) => {
    const binding = get('SELECT generation FROM routes WHERE route=?', route);
    const native = get('SELECT native_id,restorable FROM native_sessions WHERE route=?', route);
    return { generation: binding?.generation ?? null, current: meta('current'), nativeId: native?.restorable === 1 ? native.native_id : null, busy: busy(route) };
  },
  rebindRoute: ({ route, from, to }: any) => tx(() => {
    require(get('SELECT generation FROM routes WHERE route=?', route)?.generation === from, 'Route moved meanwhile');
    require(get('SELECT 1 FROM generations WHERE id=? AND retired=0', to), 'Generation unavailable');
    require(!busy(route), 'Route became busy');
    run('UPDATE routes SET generation=? WHERE route=?', to, route);
  }),
  // A generation nothing is bound to any more, and whose events are acknowledged, is retired.
  retireUnused: ({ id }: any) => tx(() => {
    if (meta('current') === id || get('SELECT 1 FROM routes WHERE generation=?', id) || get('SELECT 1 FROM outbox WHERE generation=?', id)) return false;
    run('UPDATE generations SET retired=1 WHERE id=?', id);
    return true;
  }),
  // Idle for queue dispatch: no turn open in the assembled state and no turn command in custody.
  routeIdle: ({ route, excludingCommandId, forQueue = false }: { route: string; excludingCommandId?: string; forQueue?: boolean }) =>
    (!forQueue || queueActive(route)) && turnIdle(route, excludingCommandId),
  queueChanged: ({ route }: { route: string }) => tx(() =>
    require(publishQueueChanged(route), 'Queue Thread has no route')),
  snapshot: () => ({ epoch: Number(meta('epoch')), current: meta('current'), ack: Number(meta('ack')), historyIdentityPages: true, historyIdentitySelection: true, historyPublicTurnBatch: true,
    generations: all('SELECT * FROM generations').map(row => ({ ...row, config: JSON.parse(row.config) })), routes: all('SELECT * FROM routes'), nativeSessions: all('SELECT * FROM native_sessions'), interactions: all('SELECT * FROM interactions') }),
  add: (config: Generation) => tx(() => {
    const previous = get('SELECT * FROM generations WHERE id=?', config.id);
    require(!previous || previous.config === JSON.stringify(config), 'Generation configuration is immutable');
    if (!previous) run('INSERT INTO generations(id,config) VALUES (?,?)', config.id, JSON.stringify(config));
  }),
  activate: ({ id, expected, cutoverCodex }: { id: string; expected: string; cutoverCodex?: boolean }) => tx(() => {
    require(meta('current') === expected, 'Stale current generation');
    const target = get('SELECT config FROM generations WHERE id=? AND retired=0', id);
    require(target, 'Generation unavailable');
    if (cutoverCodex) {
      const { provider } = JSON.parse(target.config) as Generation;
      require(provider.providerId === 'codex' && provider.capabilities.adoption, 'Codex generation does not support adoption');
      run(`UPDATE routes SET generation=? WHERE generation<>? AND generation IN (
        SELECT id FROM generations WHERE json_extract(config,'$.provider.providerId')='codex'
      )`, id, id);
      // Receipts, events and checkpoints describe the original operation. Only
      // the route and its native binding change owners.
      run(`UPDATE native_sessions SET generation=? WHERE generation<>? AND route IN (
        SELECT route FROM routes WHERE generation=?
      )`, id, id, id);
    }
    setMeta('current', id);
    if (cutoverCodex) return {
      routes: all('SELECT * FROM routes'),
      activeRoutes: all(`SELECT r.route FROM routes r JOIN native_sessions n USING(route) JOIN checkpoints c USING(route)
        WHERE r.generation=? AND r.archive_state='active' AND n.restorable=1
          AND EXISTS (SELECT 1 FROM json_each(c.state,'$.openTurns'))`, id).map(row => row.route),
    };
  }),
  admit: ({ command, digest, route, maxSpoolBytes }: any) => tx(() => {
    const old = receipt(command.commandId);
    if (old) { require(old.digest === digest, 'commandId reused with different input'); return { receipt: old, fresh: false }; }
    require(![...CREATES,'turn/start','turn/steer'].includes(command.method) || Number(get('SELECT coalesce(sum(length(CAST(payload AS BLOB))),0) AS bytes FROM outbox').bytes) < maxSpoolBytes, 'Spool full; new admissions stopped');
    let binding = get('SELECT generation,archive_state FROM routes WHERE route=?', route);
    if (binding && CREATES.includes(command.method)) {
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
      require(CREATES.includes(command.method), 'Thread must be explicitly created');
      const generation = meta('current');
      require(get('SELECT 1 FROM generations WHERE id=? AND retired=0', generation), 'No active generation');
      run('INSERT INTO routes(route,generation) VALUES (?,?)', route, generation); binding = { generation, archive_state: 'active' };
    }
    if (command.method === 'turn/start' || command.method === 'turn/steer')
      require(queueActive(route, binding.archive_state), 'Thread is archived or an archive operation is unresolved');
    if (isArchiveCommand(command.method)) {
      require(!archivePending(route), 'Thread archive operation is already in progress');
      if (command.method === 'session/archive')
        require(turnIdle(route) && !get("SELECT 1 FROM opencraft_host_queue WHERE thread_id=? AND state='dispatching'", route),
          'Cannot archive a Thread while input delivery is in progress');
    }
    if (command.method === 'session/resume') {
      const native = get('SELECT native_id,restorable FROM native_sessions WHERE route=?', route);
      const requested = command.params?.providerThreadId ?? command.params?.nativeSessionId;
      require(native, 'Thread has no recorded native session');
      require(native.restorable === 1, 'Recorded native session is not restorable');
      require(requested === undefined || native.native_id === requested,
        'Resume id does not match the recorded restorable native session');
    }
    run('INSERT INTO commands(id,digest,epoch,route,generation,method,state) VALUES (?,?,?,?,?,?,?)', command.commandId, digest, Number(meta('epoch')), route, binding.generation, command.method, 'registered');
    return { receipt: receipt(command.commandId), fresh: true };
  }),
  observationRoute: ({ route, forQueue = false, forHistory = false }: { route: string; forQueue?: boolean; forHistory?: boolean }) => {
    const binding = get('SELECT generation,archive_state FROM routes WHERE route=?', route);
    const state = binding?.archive_state ?? null;
    const pending = (forQueue || forHistory) && state === 'active' && archivePending(route);
    return { generation: binding?.generation ?? null, epoch: Number(meta('epoch')),
      archiveState: pending ? 'unconfirmed' : state,
      ...(forQueue ? { queueActive: state === 'active' && !pending } : {}) };
  },
  restorableRoutes: ({ generation }: any) => all(
    'SELECT routes.route FROM routes JOIN native_sessions USING(route) WHERE routes.generation=? AND native_sessions.restorable=1',
    generation,
  ).map(row => row.route),
  rollbackIdentities: () => all(
    `SELECT routes.route, native_sessions.native_id, native_sessions.restorable
     FROM routes JOIN native_sessions
       ON routes.route=native_sessions.route AND routes.generation=native_sessions.generation`,
  ),
  threadState: ({ route }: any) => ({ state: checkpoint(route), nativeSession: get('SELECT * FROM native_sessions WHERE route=?', route) ?? null }),
  query: ({ id }: any) => receiptWithIdentities(id),
  dispatch: ({ id }: any) => tx(() => {
    const command = receipt(id);
    require(command?.state === 'registered', 'Command is not dispatchable');
    if (command?.method === 'turn/start' || command?.method === 'turn/steer')
      require(queueActive(command.route), 'Thread is archived or an archive operation is unresolved');
    run("UPDATE commands SET state='dispatching' WHERE id=?", id); return receipt(id);
  }),
  settle: ({ id, response, state, interactionId, localStop }: any) => tx(() => {
    require(['accepted', 'rejected', 'unknown'].includes(state), 'Invalid settlement');
    const prior = receipt(id);
    const localSettlement = prior?.state === 'registered' &&
      (state === 'rejected' || (state === 'accepted' && localStop === true && prior.method === 'turn/stop'));
    // A late transport reply cannot erase an unknown outcome.
    if (prior?.state !== 'dispatching' && !localSettlement) return prior;
    run('UPDATE commands SET state=?,response=? WHERE id=?', state, response ? JSON.stringify(response) : null, id);
    const row = receipt(id)!;
    if (isArchiveCommand(row.method) && state !== 'rejected')
      run('UPDATE routes SET archive_state=? WHERE route=?',
        state === 'unknown' ? 'unconfirmed' : row.method === 'session/archive' ? 'archived' : 'active', row.route);
    if (state === 'accepted' && ['interaction/resolve', ...ENDS, 'turn/stop'].includes(row.method)) {
      const retiring = row.method === 'interaction/resolve' ? all('SELECT * FROM interactions WHERE route=? AND id=?', row.route, interactionId) : all('SELECT * FROM interactions WHERE route=?', row.route);
      for (const interaction of retiring) {
        run('DELETE FROM interactions WHERE route=? AND id=?', row.route, interaction.id);
        run('INSERT INTO outbox(route,generation,payload) VALUES (?,?,?)', row.route, row.generation, JSON.stringify({ method: 'interaction/resolved', params: { threadId: row.route, interactionId: interaction.id, reason: 'resolved' } }));
      }
    }
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
    } else if (method === 'thread/notification') {
      // Store allow-listed notifications under their native methods for the gateway to publish.
      require(typeof params.method === 'string' && BRIDGE_THREAD_NOTIFICATIONS.has(params.method) && params.params && typeof params.params === 'object' && !Array.isArray(params.params), 'Invalid thread notification');
      if (params.method === 'item/commandExecution/terminalInteraction')
        require(isTerminalInteraction(params.params), 'Invalid terminal interaction');
      if (params.method === 'thread/archived' || params.method === 'thread/unarchived')
        run('UPDATE routes SET archive_state=? WHERE route=?', params.method === 'thread/archived' ? 'archived' : 'active', route);
      run('INSERT INTO outbox(route,generation,payload) VALUES (?,?,?)', route, generation, JSON.stringify({ method: params.method, params: { ...params.params, threadId: route } }));
    } else {
      require(['thread/identity', 'interaction/request', 'interaction/resolved', 'provider/recovery'].includes(method), 'Unsupported callback');
      if (method === 'interaction/request') {
        require(typeof params.interactionId === 'string', 'Missing interaction identity');
        run('INSERT OR IGNORE INTO interactions VALUES (?,?,?)', route, params.interactionId, generation);
      }
      if (method === 'interaction/resolved') {
        require(typeof params.interactionId === 'string' && ['resolved', 'connection-lost'].includes(params.reason), 'Invalid interaction settlement');
        run('DELETE FROM interactions WHERE route=? AND id=?', route, params.interactionId);
      }
      run('INSERT INTO outbox(route,generation,payload) VALUES (?,?,?)', route, generation, JSON.stringify({ method, params }));
    }
    run('INSERT INTO callbacks VALUES (?,?,?)', generation, id, digest);
  }),
  events: ({ cursor, limit, fenced = false, fragmentOffset }: {
    cursor: number; limit: number; fenced?: boolean; fragmentOffset?: number;
  }) => {
    const fence = outboxFence();
    require(Number.isSafeInteger(cursor) && cursor >= fence.acknowledged && cursor <= fence.high, 'Cursor is outside retained outbox');
    require(Number.isSafeInteger(limit) && limit > 0 && limit <= 256, 'Invalid page limit');
    if (fragmentOffset === undefined) {
      const batch = events(cursor, limit);
      return fenced ? { ...fence, events: batch } : batch;
    }
    require(Number.isSafeInteger(fragmentOffset) && fragmentOffset >= 0 && fragmentOffset % BRIDGE_OUTBOX_FRAGMENT_BYTES === 0,
      'Invalid outbox fragment offset');
    let encoded = encodedOutboxEvent?.cursor === cursor ? encodedOutboxEvent : undefined;
    if (!encoded) {
      const batch = events(cursor, limit);
      const single = batch.length === 1 ? JSON.stringify(batch[0]) : undefined;
      const bytes = single === undefined ? 0 : Buffer.byteLength(single);
      // Ordinary pages and legacy Node whole-event reads keep their wire format.
      if (single === undefined || bytes + 1024 <= BRIDGE_OUTBOX_PAGE_BYTES ||
          (!fenced && bytes > BRIDGE_MAX_FRAGMENTED_EVENT_BYTES)) {
        require(fragmentOffset === 0, 'Outbox fragment is no longer available');
        return fenced ? { ...fence, events: batch } : batch;
      }
      const body = Buffer.from(single);
      encoded = { cursor, seq: batch[0]!.seq, body, digest: createHash('sha256').update(body).digest('hex') };
      if (bytes <= BRIDGE_MAX_FRAGMENTED_EVENT_BYTES) encodedOutboxEvent = encoded;
    }
    const { seq, body, digest } = encoded;
    require(fragmentOffset < body.length, 'Invalid outbox fragment offset');
    return {
      ...(fenced ? fence : {}),
      fragment: { seq, offset: fragmentOffset, total: body.length, digest,
        data: body.subarray(fragmentOffset, fragmentOffset + BRIDGE_OUTBOX_FRAGMENT_BYTES).toString('base64') },
    };
  },
  historyIdentities: ({ route, after, through, selection }: {
    route: string; after: number; through?: number; selection?: BridgeHistorySelection;
  }) => {
    const fence = outboxFence();
    const end = through ?? fence.high;
    require(Number.isSafeInteger(after) && after >= 0 && Number.isSafeInteger(end) &&
      after <= end && end <= fence.high, 'Invalid history identity cursor');
    const identities = selection ? selectedOutboxHistory!(route, after, end, selection)
      : all(`SELECT ${HISTORY_IDENTITY_COLUMNS} FROM outbox WHERE route=? AND seq>? AND seq<=?
        AND ${HISTORY_IDENTITIES} ORDER BY seq LIMIT 256`, route, after, end).map(historyIdentity);
    return { ...fence, identities };
  },
  ack: ({ cursor, outboxId }: { cursor: number; outboxId?: string }) => tx(() => {
    const fence = outboxFence();
    require(outboxId === undefined || outboxId === fence.outboxId, 'Outbox identity changed');
    require(Number.isSafeInteger(cursor) && cursor >= fence.acknowledged && cursor <= fence.high, 'Invalid acknowledgement');
    setMeta('ack', cursor); run('DELETE FROM outbox WHERE seq<=?', cursor);
    if (encodedOutboxEvent && encodedOutboxEvent.seq <= cursor) encodedOutboxEvent = undefined;
  }),
  abandon: ({ route, id }: any) => tx(() => {
    const row = get('SELECT method,state,route FROM commands WHERE id=?', id);
    require(row && row.state === 'rejected' && CREATES.includes(row.method) && row.route === route,
      'Only a rejected create can abandon its route');
    require(!get('SELECT 1 FROM native_sessions WHERE route=?', route), 'Native session retains the route');
    require(!get('SELECT 1 FROM commands WHERE route=? AND id<>?', route), 'Other command custody retains the route');
    require(!get('SELECT 1 FROM outbox WHERE route=?', route), 'Unacknowledged events retain the route');
    run('DELETE FROM routes WHERE route=?', route);
    return { abandoned: true };
  }),
  releaseRoute: ({ route }: any) => tx(() => {
    require(!busy(route), 'Thread still has work or unknown custody');
    require(get("SELECT 1 FROM commands WHERE route=? AND method IN ('session/close','session/delete') AND state='accepted'", route), 'Native close required');
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
  inbox: ({ batch }: { batch: OutboxEvent[] }) => inbox!.apply(batch),
  inboxRead: ({ cursor = 0 }: { cursor?: number }) => inbox!.read(cursor),
  inboxReadIdentities: ({ route, after, through, selection }: {
    route: string; after: number; through: number; selection?: BridgeHistorySelection;
  }) => inbox!.readIdentities(route, after, through, selection),
  inboxReadPendingInteractions: ({ route, after, through, ids }: { route: string; after: number; through: number; ids: readonly string[] }) =>
    inbox!.readPendingInteractions(route, after, through, ids),
  cursor: () => inbox!.cursor(),
  close: () => { db.close(); release(); },
};
parentPort!.on('message', ({ id, op, args }) => {
  try {
    if (failed) throw new Refusal('Storage owner failed');
    if (readOnly && !['ready', 'rollbackIdentities', 'close'].includes(op)) throw new Refusal('Read-only storage operation');
    if (!operations[op]) throw new Refusal('Unknown storage operation');
    const value = operations[op]!(args);
    parentPort!.postMessage({ id, value });
  } catch (error) {
    // Report the original failure: closing an already closed database must not replace it.
    if (!(error instanceof Refusal || error instanceof BridgeInboxRefusal)) { failed = true; try { if (db.isOpen) db.close(); } catch { /* keep the original */ } try { release(); } catch { /* keep the original */ } }
    parentPort!.postMessage({
      id, error: error instanceof Error ? error.message : 'Storage failure',
      fatal: failed, refused: !failed && error instanceof Refusal,
    });
  }
});
