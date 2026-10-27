import { HostInteractions } from '../../../packages/app-host-server/src/interactions';
import type { InteractionSourceRequest } from '@opencraft/appserver-protocol';
import { requireThat } from './recovery-chaos';

type State = 'pending' | 'responding' | 'unconfirmed';
type ProducerSource = { -readonly [K in keyof InteractionSourceRequest]: InteractionSourceRequest[K] };
type Validation = 'none' | 'peer' | 'conflict' | 'throw' | 'replace';
export type ReplyEvent = { type: 'capture'; state: State | 'keep'; same: boolean }
  | { type: 'answer'; submission: 'a' | 'b'; payload: 0 | 1; validation: Validation }
  | { type: 'finish'; target: 'oldest' | 'newest'; ok: boolean }
  | { type: 'resolve'; stale: boolean } | { type: 'clear' };
export type ReplyMutant = 'late-state' | 'duplicate-write' | 'drop-error';
export function parseReplyTrace(value: unknown): ReplyEvent[] {
  requireThat(Array.isArray(value) && value.length <= 10000, 'TRACE_SCHEMA', 'expected at most 10000 reply events');
  for (const item of value) {
    requireThat(!!item && typeof item === 'object', 'TRACE_SCHEMA', 'invalid reply event');
    const e = item as Record<string, unknown>;
    requireThat(['capture', 'answer', 'finish', 'resolve', 'clear'].includes(String(e.type)), 'TRACE_SCHEMA', 'invalid reply event type');
    if (e.type === 'capture') requireThat(['pending', 'responding', 'unconfirmed', 'keep'].includes(String(e.state)) && typeof e.same === 'boolean', 'TRACE_SCHEMA', 'invalid producer replay');
    if (e.type === 'answer') requireThat(['a', 'b'].includes(String(e.submission)) && (e.payload === 0 || e.payload === 1)
      && ['none', 'peer', 'conflict', 'throw', 'replace'].includes(String(e.validation)), 'TRACE_SCHEMA', 'invalid answer intent');
    if (e.type === 'finish') requireThat(['oldest', 'newest'].includes(String(e.target)) && typeof e.ok === 'boolean', 'TRACE_SCHEMA', 'invalid writer outcome');
    if (e.type === 'resolve') requireThat(typeof e.stale === 'boolean', 'TRACE_SCHEMA', 'invalid native resolution');
  }
  return value as ReplyEvent[];
}
export function generateReplyChaos(seed: number, steps: number): ReplyEvent[] {
  let random = seed >>> 0;
  const next = () => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random >>> 8; };
  const capture = (): ReplyEvent => ({ type: 'capture', state: 'pending', same: false });
  const answer = (): ReplyEvent => ({ type: 'answer', submission: 'a', payload: 0, validation: 'none' });
  const events: ReplyEvent[] = [capture(), answer(), capture(), answer(), { type: 'finish', target: 'oldest', ok: false }];
  for (let i = 0; i < steps; i++) {
    const choice = next() % 6;
    if (choice === 0) events.push({ type: 'capture', state: (['pending', 'responding', 'unconfirmed', 'keep'] as const)[next() % 4]!, same: !!(next() % 2) });
    else if (choice === 1 || choice === 2) events.push({ type: 'answer', submission: next() % 2 ? 'a' : 'b', payload: next() % 2 ? 0 : 1,
      validation: (['none', 'peer', 'conflict', 'throw', 'replace'] as const)[next() % 5]! });
    else if (choice === 3) events.push({ type: 'finish', target: next() % 2 ? 'oldest' : 'newest', ok: !!(next() % 2) });
    else if (choice === 4) events.push({ type: 'resolve', stale: !!(next() % 2) });
    else events.push({ type: 'clear' });
    if (i % 20 === 19) events.push({ type: 'clear' }, capture(), { ...answer(), validation: 'peer' } as ReplyEvent);
  }
  return events;
}
function gate() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
type Outcome = 'pending' | 'submitted' | 'already-submitted' | 'resolved' | 'RESPONSE_CONFLICT' | 'invalid' | 'NOT_FOUND' | 'writer-error';
/** The ledger predicts admission, publication and caller results from saved
 * producer/caller inputs. Only public coordinator methods and declared writers
 * are exercised; synthetic observation controls are distinct from old code. */
export async function simulateReplyOwners(events: readonly ReplyEvent[], options: { Coordinator?: typeof HostInteractions; mutant?: ReplyMutant } = {}) {
  const h = new (options.Coordinator ?? HostInteractions)();
  type Call = { token: number; submission: string; payload: number; expected: Outcome; actual: Outcome;
    error: Error; seenError?: unknown; held?: ReturnType<typeof gate>; child?: Call; validation: Validation };
  let entry: { lifetime: number; state: State; owner?: Call } | undefined;
  let lifetime = 0, serial = 0, revision = 0, notices = 0, expectedNotices = 0, nativeSerial = 0;
  let currentSource: ProducerSource | undefined, id: string | undefined, retired = false;
  let lastRetiredFailure = false, duplicate = false;
  const calls: Call[] = [], writes: { token: number; route: string | number }[] = [], expectedWrites: typeof writes = [];
  const coverage: Record<string, number> = {};
  const cover = (key: string) => { coverage[key] = (coverage[key] ?? 0) + 1; };
  h.subscribe(() => { notices++; });
  const publish = () => { revision++; expectedNotices++; };
  const freshSource = (state: State | 'keep', same: boolean): ProducerSource => ({
    id: same && currentSource ? currentSource.id : `native:${++nativeSerial}`,
    method: 'item/tool/requestUserInput', params: { threadId: 'thread', turnId: 'turn', questions: [] },
    __opencraftInteractionKey: 'lifetime', ...(state === 'keep' ? {} : { __opencraftInteractionState: state }),
  });
  const predictCapture = (state: State | 'keep') => {
    if (retired) return;
    if (!entry) entry = { lifetime: ++lifetime, state: state === 'keep' ? 'pending' : state };
    else if (state !== 'keep') { entry.state = state; if (state === 'pending') entry.owner = undefined; }
    publish();
  };
  const predictClear = () => { entry = undefined; retired = false; revision = 0; };
  function plan(submission: string, payload: number, validation: Validation): Call {
    const c: Call = { token: ++serial, submission, payload, validation, expected: 'pending', actual: 'pending', error: Error('synthetic writer failure') };
    calls.push(c);
    if (!entry) c.expected = retired ? 'resolved' : 'NOT_FOUND';
    else if (entry.state !== 'pending') c.expected = entry.owner?.submission === submission && entry.owner.payload !== payload ? 'RESPONSE_CONFLICT' : 'already-submitted';
    else if (validation === 'throw') c.expected = 'invalid';
    else if (validation === 'replace') { predictClear(); predictCapture('pending'); c.expected = 'resolved'; }
    else if (validation === 'peer' || validation === 'conflict') {
      c.child = plan(validation === 'conflict' ? submission : `peer:${serial}`, 1 - payload, 'none');
      c.expected = validation === 'conflict' ? 'RESPONSE_CONFLICT' : 'already-submitted';
    } else {
      c.held = gate(); entry.owner = c; entry.state = 'responding'; publish();
      expectedWrites.push({ token: c.token, route: currentSource!.id });
    }
    return c;
  }
  function invoke(c: Call) {
    const requestId = id ?? 'missing';
    void h.respond('thread', requestId, c.submission, { answer: c.payload }, source => {
      writes.push({ token: c.token, route: source.id });
      return c.held?.promise ?? Promise.resolve();
    }, () => {
      if (c.validation === 'throw') throw Error('invalid');
      if (c.validation === 'replace') { h.clear(); currentSource = freshSource('pending', false); id = h.capture(currentSource); }
      if (c.child) invoke(c.child);
    }).then(result => { c.actual = result; }, error => {
      c.seenError = error;
      c.actual = error === c.error ? 'writer-error' : error?.domainData?.code ?? (error?.message === 'invalid' ? 'invalid' : 'unexpected');
    });
  }
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  function check() {
    const snap = h.snapshot('thread', true);
    const seenState = options.mutant === 'late-state' && lastRetiredFailure && entry ? 'unconfirmed' : snap.requests[0]?.state;
    requireThat(seenState === entry?.state && snap.requests.length === Number(!!entry), 'REPLY_CURRENT_STATE', 'writer outcome changed another attempt');
    requireThat(snap.revision === revision && notices === expectedNotices, 'REPLY_PUBLICATION_OWNER', 'retired attempt published or lost a current publication');
    const seenWrites = writes.length + Number(options.mutant === 'duplicate-write' && duplicate);
    requireThat(seenWrites === expectedWrites.length && JSON.stringify(writes) === JSON.stringify(expectedWrites), 'REPLY_NATIVE_ADMISSION', 'response admission or native route differs from saved intents');
    for (const c of calls) {
      const seen = options.mutant === 'drop-error' && c.actual === 'writer-error' ? 'submitted' : c.actual;
      requireThat(seen === c.expected, 'REPLY_CALLER_OUTCOME', `call ${c.token}: ${seen}, expected ${c.expected}`);
      if (c.expected === 'writer-error') requireThat(c.seenError === c.error, 'REPLY_ERROR_IDENTITY', 'writer error was replaced');
    }
  }
  try {
    for (const e of events) {
      lastRetiredFailure = false;
      if (e.type === 'capture') {
        predictCapture(e.state); const next = freshSource(e.state, e.same);
        // Reuse the actual object too, exercising same-object pending replay.
        if (e.same && currentSource) { delete currentSource.__opencraftInteractionState; Object.assign(currentSource, next); }
        else currentSource = next;
        try { id = h.capture(currentSource); requireThat(!retired, 'REPLY_SOURCE_RETIREMENT', 'retired source was reused'); }
        catch (error) { requireThat(retired && (error as { domainData?: { code: string } }).domainData?.code === 'SOURCE_RETIRED', 'REPLY_SOURCE_RETIREMENT', 'unexpected producer rejection'); }
        cover(`capture.${e.state}`);
      } else if (e.type === 'answer') {
        const c = plan(e.submission, e.payload, e.validation); invoke(c);
        if (c.child) duplicate = true;
        cover(`validation.${e.validation}`);
      } else if (e.type === 'finish') {
        const pending = calls.filter(c => c.held && c.expected === 'pending');
        const c = e.target === 'oldest' ? pending[0] : pending.at(-1);
        if (c) {
          c.expected = e.ok ? 'submitted' : 'writer-error';
          const owns = entry?.owner === c;
          if (!e.ok && owns) { entry!.state = 'unconfirmed'; publish(); }
          lastRetiredFailure = !e.ok && !owns;
          if (e.ok) c.held!.resolve(); else c.held!.reject(c.error);
          cover(`finish.${e.ok}.${owns ? 'current' : 'retired'}`);
        }
      } else if (e.type === 'clear') { predictClear(); h.clear(); cover('clear'); }
      else if (e.type === 'resolve') {
        const route = e.stale ? 'not-the-current-route' : currentSource?.id;
        if (!e.stale && entry) { entry = undefined; retired = true; publish(); }
        if (route !== undefined) h.resolveNative(route, 'thread'); cover(`resolve.${e.stale}`);
      }
      await flush(); check();
    }
    return { events: events.length, nativeReplies: writes.length, coverage };
  } finally {
    h.clear(); for (const c of calls) c.held?.resolve(); await flush();
  }
}
