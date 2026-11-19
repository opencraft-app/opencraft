import { createParticipationOverview } from '../../tencentoa/src/participation-overview';
import type { AppServerClient } from '@opencraft/appserver-client';
import { TASKS, type TaskDetail, type TaskEvent, type TasksSnapshot, type TasksRequestPort } from '@opencraft/appserver-protocol';
import type { PlatformViewHost } from '@opencraft/extension-react';
import { legacyDirectServerProjectionFromHost } from '@opencraft/workbench-runtime';
import { readFollowUpEvents } from '../../../../../plugins/tasks/src/ai-follow-up-model';
import { conversationKey, parseTodos, type Conversation } from './model';
export type GetClient = (id: string) => AppServerClient | undefined;
export interface Snapshot {
    tasks: TasksSnapshot;
    conversations: ReadonlyMap<string, Conversation>;
    events: ReadonlyMap<string, readonly TaskEvent[]>;
    asOf: number;
    enriching: boolean;
}
export function hostFor(host: PlatformViewHost, serverId: string) { return host.profiles.find(p => p.enabled && legacyDirectServerProjectionFromHost({ hostId: p.hostId, hostKind: p.hostKind, label: p.displayName }).serverOrigin.serverId === serverId)?.hostId ?? serverId; }
export async function readOverview(getClient: GetClient, host: PlatformViewHost, signal: AbortSignal, period: number, publish: (s: Snapshot) => void) {
    const authority = 'opencraft-server';
    if (!getClient(authority)?.initializeResult)
        await host.ensureRuntimeReady?.(authority);
    signal.throwIfAborted();
    const client = getClient(authority);
    if (!client)
        throw new Error('tasks_unavailable');
    const epoch = client.connectionGeneration;
    const check = () => { signal.throwIfAborted(); if (getClient(authority) !== client || client.connectionGeneration !== epoch)
        throw new Error('connection_changed'); };
    const port: TasksRequestPort = { request: async (method, params) => { check(); const result = await client.request(method, params, { signal, priority: 'background', timeoutMs: 15000 }); check(); return result; } };
    const snapshot = await port.request(TASKS.list, {}), tasks = snapshot.tasks.filter(t => !t.deletedAt && !t.archivedAt);
    const conversations = new Map<string, Conversation>(), events = new Map<string, readonly TaskEvent[]>();
    let lastPublished = 0;
    const emit = (done = false) => { check(); if (done || Date.now() - lastPublished > 200) {
        lastPublished = Date.now();
        publish({ tasks: { ...snapshot, tasks }, conversations: new Map(conversations), events: new Map(events), asOf: Date.now(), enriching: !done });
    } };
    emit();
    const links = [...new Map(tasks.flatMap(t => t.conversations.map(c => [conversationKey(c.serverId, c.threadId), c] as const))).values()];
    // Team ledger is optional and authorized by its own server. Never fall back to self and label it team.
    const people = new Map<string, readonly string[]>();
    const participation = createParticipationOverview(getClient, () => host.currentUser?.id ?? null);
    const usage = new Map<string, {
        values: Map<string, number>;
        partial: boolean;
    }>();
    const jobs: (() => Promise<void>)[] = [...new Set(links.map(c => hostFor(host, c.serverId)))].map(id => async () => {
        try {
            if (!getClient(id)?.initializeResult)
                await host.ensureRuntimeReady?.(id);
            signal.throwIfAborted();
            const c = getClient(id);
            if (!c)
                return;
            const gen = c.connectionGeneration;
            const values = new Map<string, number>();
            let cursor: string | undefined;
            let partial = false;
            let revision: number | undefined;
            const cursors = new Set<string>();
            const date = (n: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(n);
            for (let page = 0; page < 50; page++) {
                const r = await c.request('opencraft/token-usage/query', { scope: 'team', view: 'threads', from: date(Date.now() - (period - 1) * 86400000), through: date(Date.now()), limit: 100, ...(cursor ? { cursor } : {}) }, { signal, priority: 'background', timeoutMs: 15000 });
                signal.throwIfAborted();
                if (c.connectionGeneration !== gen || getClient(id) !== c || r.scope !== 'team' || !r.canQueryTeam || !r.coverage.enabled)
                    throw Error();
                if (revision !== undefined && r.snapshotRevision !== revision)
                    throw Error();
                revision = r.snapshotRevision;
                partial ||= r.coverage.partial;
                for (const row of r.rows)
                    if ('key' in row) {
                        const number = Number(row.tokens);
                        if (Number.isFinite(number) && number >= 0)
                            values.set(row.key, number);
                    }
                if (!r.nextCursor) {
                    usage.set(id, { values, partial });
                    return;
                }
                if (cursors.has(r.nextCursor))
                    throw Error();
                cursors.add(r.nextCursor);
                cursor = r.nextCursor;
            }
        }
        catch {
            signal.throwIfAborted();
        }
    });
    await pool(jobs, signal);
    for (const id of new Set(links.map(c => hostFor(host, c.serverId)))) {
        const owned = links.filter(c => hostFor(host, c.serverId) === id);
        for (let start = 0; start < owned.length; start += 100) {
            try {
                const rows = await participation.read(id, owned.slice(start, start + 100).map(c => c.threadId), signal);
                for (const row of rows)
                    if (!row.pending)
                        people.set(conversationKey(id, row.threadId), row.participants);
            }
            catch {
                signal.throwIfAborted();
            }
        }
    }
    const enrich: (() => Promise<void>)[] = [...tasks.map(task => async () => { try {
            events.set(task.id, await readFollowUpEvents(port, task.id));
        }
        catch {
            signal.throwIfAborted();
        } emit(); }), ...links.map(link => async () => {
            const key = conversationKey(link.serverId, link.threadId), id = hostFor(host, link.serverId);
            try {
                if (!getClient(id)?.initializeResult)
                    await host.ensureRuntimeReady?.(id);
                signal.throwIfAborted();
                const c = getClient(id);
                if (!c)
                    throw Error();
                const gen = c.connectionGeneration;
                const { thread } = await c.request('thread/read', { threadId: link.threadId, includeTurns: false }, { signal, priority: 'background', timeoutMs: 15000 });
                signal.throwIfAborted();
                if (getClient(id) !== c || c.connectionGeneration !== gen)
                    throw Error();
                const status = thread.status && typeof thread.status === 'object' ? thread.status as Record<string, unknown> : {};
                const flags = Array.isArray(status.activeFlags) ? status.activeFlags : [];
                const state = status.type === 'active' ? flags.some(f => f === 'waitingOnApproval' || f === 'waitingOnUserInput') ? 'waiting' : 'running' : status.type === 'idle' ? 'idle' : status.type === 'systemError' ? 'failed' : 'unknown';
                let todos: Conversation['todos'] = [], planKnown = false;
                // Summary history deliberately omits plans. Read only the newest bounded item
                // page in each of the three latest turns; never hydrate the whole thread.
                try {
                    const turns = await c.request('thread/turns/list', { threadId: link.threadId, cursor: null, limit: 3, itemsView: 'notLoaded', sortDirection: 'desc' }, { signal, priority: 'background', timeoutMs: 15000 });
                    for (const turn of turns.data) {
                        signal.throwIfAborted();
                        const page = await c.request('thread/items/list', { threadId: link.threadId, turnId: turn.id, cursor: null, limit: 50, sortDirection: 'desc' }, { signal, priority: 'background', timeoutMs: 15000 });
                        signal.throwIfAborted();
                        if (c.connectionGeneration !== gen || getClient(id) !== c)
                            throw Error();
                        let planSeen = false;
                        for (const entry of page.data) {
                            const item = 'item' in entry ? entry.item : entry;
                            if (item && typeof item === 'object' && 'type' in item && item.type === 'plan' && 'text' in item && typeof item.text === 'string') {
                                planSeen = true;
                                todos = parseTodos(item.text);
                                planKnown = todos.length > 0;
                                break;
                            }
                        }
                        if (planSeen || page.nextCursor)
                            break; // Do not fall back to an older plan across a truncated turn.
                    }
                }
                catch {
                    signal.throwIfAborted();
                }
                const ledger = usage.get(id);
                conversations.set(key, { key, serverId: link.serverId, threadId: link.threadId, title: (typeof thread.name === 'string' ? thread.name.trim() : '') || (typeof thread.preview === 'string' ? thread.preview.trim() : '') || link.threadId, state, updatedAt: typeof thread.updatedAt === 'number' ? thread.updatedAt * 1000 : 0, todos, planKnown, participants: people.get(conversationKey(id, link.threadId)) ?? null, tokens: ledger?.values.get(link.threadId) ?? null, tokensPartial: ledger?.partial ?? true });
            }
            catch {
                signal.throwIfAborted();
                conversations.set(key, { key, ...link, title: link.threadId, state: 'unknown', updatedAt: 0, todos: [], planKnown: false, participants: null, tokens: null, tokensPartial: true });
            }
            emit();
        })];
    await pool(enrich, signal);
    emit(true);
}
async function pool(jobs: readonly (() => Promise<void>)[], signal: AbortSignal) { let next = 0; const results = await Promise.allSettled(Array.from({ length: Math.min(4, jobs.length) }, async () => { while (next < jobs.length) {
    signal.throwIfAborted();
    await jobs[next++]!();
} })); for (const result of results)
    if (result.status === 'rejected')
        throw result.reason; }
