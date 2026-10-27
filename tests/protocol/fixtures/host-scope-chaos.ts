import type { AppHostServer } from '@opencraft/app-host-server';
import { hostScopeFixture } from './host-scopes';
import { flushCleanup, trackCleanup } from './host-cleanup';
import { requireThat } from './recovery-chaos';

type Side = 'a' | 'b';
type Notice = 'success' | 'reject' | 'hold';
export type ScopeEvent = { type: 'setup'; layout: 'shared' | 'distinct' | 'opaque'; lifetime: 'server' | 'last-claim'; noticeA: Notice; noticeB: Notice }
  | { type: 'grant' | 'retire' | 'probe' | 'fence'; host: Side }
  | { type: 'late'; host: Side; ok: boolean }
  | { type: 'deadline' | 'detach' | 'observe' | 'heal' };
export type ScopeMutant = 'notify-peer' | 'drop-reply' | 'leak-native';

export function parseScopeTrace(value: unknown): ScopeEvent[] {
  requireThat(Array.isArray(value) && value.length <= 10000, 'TRACE_SCHEMA', 'expected at most 10000 Host scope events');
  for (const item of value) {
    requireThat(typeof item === 'object' && item !== null, 'TRACE_SCHEMA', 'invalid Host scope event');
    const e = item as Record<string, unknown>;
    requireThat(['setup', 'grant', 'retire', 'probe', 'fence', 'late', 'deadline', 'detach', 'observe', 'heal'].includes(String(e.type)), 'TRACE_SCHEMA', 'invalid Host scope discriminant');
    if (e.type === 'setup') requireThat(['shared', 'distinct', 'opaque'].includes(String(e.layout)) && ['server', 'last-claim'].includes(String(e.lifetime))
      && ['success', 'reject', 'hold'].includes(String(e.noticeA)) && ['success', 'reject', 'hold'].includes(String(e.noticeB)), 'TRACE_SCHEMA', 'invalid Host scope composition');
    if (['grant', 'retire', 'probe', 'fence', 'late'].includes(String(e.type))) requireThat(e.host === 'a' || e.host === 'b', 'TRACE_SCHEMA', 'invalid Host scope target');
    if (e.type === 'late') requireThat(typeof e.ok === 'boolean', 'TRACE_SCHEMA', 'invalid Host scope native outcome');
  }
  return value as ScopeEvent[];
}

export function generateScopeChaos(seed: number, steps: number): ScopeEvent[] {
  let state = seed >>> 0;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state >>> 8; };
  const events: ScopeEvent[] = [{ type: 'setup', layout: (['shared', 'distinct', 'opaque'] as const)[next() % 3]!, lifetime: next() % 2 ? 'server' : 'last-claim',
    noticeA: (['success', 'reject', 'hold'] as const)[next() % 3]!, noticeB: (['success', 'reject', 'hold'] as const)[next() % 3]! },
  { type: 'grant', host: 'a' }, { type: 'grant', host: 'b' }, { type: 'retire', host: 'a' }, { type: 'probe', host: 'b' }];
  const choices: ScopeEvent[] = [{ type: 'grant', host: 'a' }, { type: 'grant', host: 'b' }, { type: 'retire', host: 'a' }, { type: 'retire', host: 'b' },
    { type: 'probe', host: 'a' }, { type: 'probe', host: 'b' }, { type: 'deadline' }, { type: 'detach' }, { type: 'observe' }, { type: 'heal' },
    { type: 'late', host: 'a', ok: true }, { type: 'late', host: 'a', ok: false }, { type: 'late', host: 'b', ok: true }, { type: 'late', host: 'b', ok: false },
    { type: 'fence', host: 'a' }, { type: 'fence', host: 'b' }];
  for (let i = 0; i < steps; i++) {
    events.push({ ...choices[next() % choices.length]! });
    if (i % 24 === 23) events.push({ type: 'heal' }, { type: 'grant', host: 'a' }, { type: 'grant', host: 'b' });
  }
  events.push({ type: 'heal' }); return events;
}

/** One intent per Host in each round, repeated on the same Server across
 * explicit heals and Renderer incarnations. Native outcomes, expected target,
 * registration and physical resources are predicted from saved inputs. */
export async function simulateHostScopes(events: readonly ScopeEvent[], options: { Server?: typeof AppHostServer; mutant?: ScopeMutant } = {}) {
  type Fixture = ReturnType<typeof hostScopeFixture>;
  type Page = ReturnType<Fixture['page']>;
  type Model = { host: string; granted: boolean; active: boolean; lease: string; generation: number; resource: boolean; registered: boolean;
    native: 'none' | 'pending' | 'success' | 'failure'; fenced: boolean; notices: number; closes: number; factories: number;
    retiring?: ReturnType<typeof trackCleanup>; expected: 'pending' | 'resolved' | 'rejected'; code?: string };
  let f: Fixture | undefined, page: Page | undefined, setup: Extract<ScopeEvent, { type: 'setup' }> | undefined, round = 0, detached = false, lastRetired: Side | undefined;
  const sides: Side[] = ['a', 'b'], models = {} as Record<Side, Model>, coverage: Record<string, number> = {};
  const metrics = { events: events.length, connectIntents: 0, connectSettled: 0, rpcIntents: 0, rpcFrames: 0, nativeAdmissions: 0, cleanupCalls: 0 };
  const cover = (key: string) => { coverage[key] = (coverage[key] ?? 0) + 1; };
  const notice = (h: Side) => h === 'a' ? setup!.noticeA : setup!.noticeB;
  const lease = (h: Side) => setup!.layout === 'opaque' ? (h === 'a' ? `n:${round}` : `b\0n:${round}`)
    : setup!.layout === 'shared' ? `shared:${round}` : `${h}:${round}`;
  const nativeResult = (m: Model, ok: boolean) => {
    if (!m.resource || !m.registered) return;
    m.native = ok ? 'success' : 'failure'; m.registered = !ok; m.fenced = !ok;
    if (m.retiring && m.expected === 'pending') { m.expected = ok ? 'resolved' : 'rejected'; m.code = undefined; }
  };
  const issue = (m: Model, mode: Notice) => {
    m.notices++; metrics.nativeAdmissions++; m.native = mode === 'hold' ? 'pending' : mode === 'success' ? 'success' : 'failure';
    if (mode === 'success') m.registered = false;
    if (mode === 'reject') m.fenced = true;
  };
  const releasePhysical = (m: Model) => {
    if (!m.resource) return;
    m.closes++; metrics.cleanupCalls++; m.resource = false; m.registered = false; m.fenced = false;
    if (m.retiring && m.expected === 'pending') { m.expected = 'resolved'; m.code = undefined; }
  };
  async function rpc(h: Side, method: 'initialize' | 'echo') {
    const m = models[h], token = `scope:${++metrics.rpcIntents}`;
    let response: { result?: unknown } | undefined;
    try { response = await page!.rpc(m.host, m.lease, m.generation, method, method === 'echo' ? { token } : { clientInfo: { name: token, version: '1' } }); }
    catch (error) { requireThat(false, 'SCOPE_RPC_REPLY', `${h} ${method} failed: ${String(error)}`); }
    const seen = options.mutant === 'drop-reply' && setup!.layout === 'opaque' && models.a.granted && models.b.granted && h === 'a' ? undefined : response;
    requireThat(method === 'initialize' ? Boolean(seen?.result) : JSON.stringify(seen?.result) === JSON.stringify({ token }), 'SCOPE_RPC_REPLY', `${h} lost its own ${method} response`);
    metrics.rpcFrames++;
  }
  function check() {
    if (!f) return;
    for (const h of sides) {
      const m = models[h], group = f.physicals.get(m.host) ?? [];
      const peer = h === 'a' ? 'b' : 'a';
      const seenNotices = group.reduce((n, p) => n + p.notifications.length, 0)
        + (options.mutant === 'notify-peer' && lastRetired === peer && models[peer].notices > 0 && m.granted ? 1 : 0);
      requireThat(seenNotices === m.notices, 'SCOPE_NOTIFICATION_TARGET', `${h} notifications ${seenNotices}, expected ${m.notices}`);
      requireThat(group.length === m.factories, 'SCOPE_FACTORY_OWNER', `${h} factory crossed its Host boundary`);
      requireThat(group.reduce((n, p) => n + p.closeCalls, 0) === m.closes, 'SCOPE_PHYSICAL_OWNER', `${h} cleanup crossed its Host boundary`);
      requireThat(group.filter(p => !p.released).length === Number(m.resource), 'SCOPE_PHYSICAL_RESOURCE', `${h} resource conservation failed`);
      const clients = group.reduce((n, p) => n + p.initializedClients.size, 0)
        + (options.mutant === 'leak-native' && m.granted && !m.registered && m.resource ? 1 : 0);
      requireThat(clients === Number(m.registered && m.resource), 'SCOPE_NATIVE_CLIENTS', `${h} native clients ${clients}, expected ${Number(m.registered && m.resource)}`);
      if (m.retiring) {
        requireThat(m.retiring.state === m.expected, 'SCOPE_CALLER_PROGRESS', `${h} local outcome ${m.retiring.state}, expected ${m.expected}`);
        if (m.code) requireThat((m.retiring.error as { code?: unknown })?.code === m.code, 'SCOPE_CALLER_OUTCOME', `${h} lost its captured timeout classification`);
      }
    }
  }
  function predictDetach(repaired = false) {
    for (const h of sides) {
      const m = models[h]; m.active = false;
      if (m.retiring && m.expected === 'pending') { m.expected = 'rejected'; m.code = undefined; }
      if (m.resource && m.registered && m.native !== 'pending') issue(m, repaired ? 'success' : notice(h));
      if (setup!.lifetime === 'last-claim') releasePhysical(m);
    }
  }
  try {
    for (const e of events) {
      if (e.type === 'setup') {
        if (f) continue;
        setup = e; f = hostScopeFixture({ Server: options.Server, lifetime: e.lifetime }); page = f.page();
        for (const h of sides) models[h] = { host: e.layout === 'opaque' ? (h === 'a' ? 'scope\0b' : 'scope') : h, granted: false, active: false,
          lease: '', generation: 0, resource: false, registered: false, native: 'none', fenced: false, notices: 0, closes: 0, factories: 0, expected: 'pending' };
        cover(`layout.${e.layout}`); cover(`lifetime.${e.lifetime}`); continue;
      }
      if (!f || !page || !setup) continue;
      if (e.type === 'grant') {
        const m = models[e.host];
        if (!m.granted && !detached) {
          metrics.connectIntents++; const grant = await page.bridge.connectHost(m.host, lease(e.host)); metrics.connectSettled++;
          if (!m.resource) { m.resource = true; m.factories++; }
          m.granted = m.active = m.registered = true; m.lease = lease(e.host); m.generation = grant.generation;
          f.current(m.host).notifyMode = notice(e.host); await rpc(e.host, 'initialize'); cover('grant');
        }
      } else if (e.type === 'retire') {
        const m = models[e.host];
        if (m.active && !detached) {
          m.active = false; lastRetired = e.host; issue(m, notice(e.host));
          m.expected = notice(e.host) === 'hold' ? 'pending' : notice(e.host) === 'success' ? 'resolved' : 'rejected';
          m.retiring = trackCleanup(page.bridge.disconnectHost(m.host, m.lease, m.generation));
          if (setup.lifetime === 'last-claim') releasePhysical(m);
          cover(`retire.${notice(e.host)}`);
        }
      } else if (e.type === 'probe') {
        if (models[e.host].active && !detached) { await rpc(e.host, 'echo'); cover('explicit-peer-rpc'); }
      } else if (e.type === 'fence') {
        const m = models[e.host];
        if (m.fenced && m.resource && !detached) {
          metrics.connectIntents++; let rejected = false;
          try { await page.bridge.connectHost(m.host, `challenge:${round}:${metrics.connectIntents}`); }
          catch (error) { rejected = (error as { code?: unknown })?.code === 'APP_HOST_LOGICAL_CLEANUP_FAILED'; }
          metrics.connectSettled++; requireThat(rejected, 'SCOPE_FAILURE_FENCE', `${e.host} lost its own failure fence`); cover('fence-challenge');
        }
      } else if (e.type === 'deadline') {
        for (const m of Object.values(models)) if (m.resource && m.native === 'pending') {
          m.fenced = true;
          if (m.retiring && m.expected === 'pending') { m.expected = 'rejected'; m.code = 'APP_HOST_DISCONNECT_TIMEOUT'; cover('deadline.pending'); }
        }
        await f.deadline();
      } else if (e.type === 'late') {
        const m = models[e.host]; if (m.native === 'pending') { nativeResult(m, e.ok); cover(`late.${e.ok}`); }
        for (const p of f.physicals.get(m.host) ?? []) for (const n of p.notifications) { if (e.ok) n.gate.resolve(); else n.gate.reject(Error('synthetic late scoped notification failure')); }
      } else if (e.type === 'detach' && !detached) {
        predictDetach(); detached = true; page.bridge.close(); cover('renderer-detach');
      } else if (e.type === 'heal') {
        for (const h of sides) { const m = models[h]; if (m.native === 'pending') nativeResult(m, true); }
        for (const group of f.physicals.values()) for (const p of group) { p.notifyMode = 'success'; p.releaseNotifications(); }
        await flushCleanup(); check();
        if (!detached) { predictDetach(true); detached = true; page.bridge.close(); }
        for (const h of sides) { releasePhysical(models[h]); await f.server.resetHost(models[h].host); }
        await flushCleanup(); check();
        for (const m of Object.values(models)) { m.granted = m.active = m.registered = m.fenced = false; m.native = 'none'; m.retiring = undefined; m.expected = 'pending'; m.code = undefined; }
        round++; page = f.page(); detached = false; lastRetired = undefined; cover('cycle.heal');
      }
      await flushCleanup(); check();
      // A namespace change cannot revoke another currently admitted RPC client.
      if (!detached) for (const h of sides) if (models[h].active) await rpc(h, 'echo');
    }
    return { ...metrics, coverage };
  } finally { await f?.close(); }
}
