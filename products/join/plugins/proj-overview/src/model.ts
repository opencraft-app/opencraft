import type { TaskDetail, TaskEvent } from '@opencraft/appserver-protocol';
import { followUpProjection } from '../../../../../plugins/tasks/src/ai-follow-up-model';
import { DIRECTIONS, TASK_DIRECTIONS } from './catalog';
export const HOUR = 3600000;
export const periodStart = (now: number, days: number) => Math.floor((now + 8 * HOUR) / (24 * HOUR)) * 24 * HOUR - 8 * HOUR - (days - 1) * 24 * HOUR;
export type ExecutionState = 'running' | 'waiting' | 'idle' | 'failed' | 'unknown';
export interface Todo {
    text: string;
    completed: boolean;
    executor: string;
}
export interface Conversation {
    key: string;
    serverId: string;
    threadId: string;
    title: string;
    state: ExecutionState;
    updatedAt: number;
    todos: readonly Todo[];
    planKnown: boolean;
    participants: readonly string[] | null;
    tokens: number | null;
    tokensPartial: boolean;
}
export interface Item {
    task: TaskDetail;
    direction: string;
    state: ExecutionState | 'unfollowed' | 'done' | 'canceled';
    conversations: readonly Conversation[];
    todos: readonly Todo[];
    progress: number | null;
    wait: number | null;
    currentWait: number | null;
    judge: string | null;
    decision: string | null;
    tokens: number | null;
    tokenCoverage: number;
    events: readonly TaskEvent[];
    eventsKnown: boolean;
}
export const conversationKey = (serverId: string, threadId: string) => JSON.stringify([serverId, threadId]);
export function parseTodos(text: string): Todo[] { return text.split('\n').flatMap(line => { const m = /^\s*[-*]\s+\[([ xX])\]\s+(.+)$/.exec(line); return m ? [{ text: m[2]!, completed: m[1]!.toLowerCase() === 'x', executor: 'AI' }] : []; }); }
export function projectItem(task: TaskDetail, conversations: ReadonlyMap<string, Conversation>, events: readonly TaskEvent[] | undefined, references: ReadonlyMap<string, number>, now: number, from: number): Item {
    const linked = task.conversations.map(c => conversations.get(conversationKey(c.serverId, c.threadId)) ?? { key: conversationKey(c.serverId, c.threadId), ...c, title: c.threadId, state: 'unknown' as const, updatedAt: 0, todos: [], planKnown: false, participants: null, tokens: null, tokensPartial: true });
    const closed = task.status === 'done' || task.status === 'canceled';
    const projection = events ? followUpProjection(task, events) : null;
    const waitingReport = projection?.lane === 'needs' && projection.readyAt !== null;
    const state: Item['state'] = closed ? task.status === 'done' ? 'done' : 'canceled' : !linked.length ? 'unfollowed' : linked.some(c => c.state === 'running') ? 'running' : linked.some(c => c.state === 'waiting') || waitingReport ? 'waiting' : linked.some(c => c.state === 'failed') ? 'failed' : linked.some(c => c.state === 'unknown') ? 'unknown' : 'idle';
    const todos = linked.flatMap(c => c.todos), allPlans = linked.length > 0 && linked.every(c => c.planKnown);
    // Complete histories and explicit handoffs only. Board status and last update are not a wait start.
    let wait: number | null = events ? 0 : null;
    if (events) {
        let status: TaskDetail['status'] = task.status;
        const ordered = [...events].sort((a, b) => a.seq - b.seq);
        const first = ordered.find(e => e.type === 'created')?.payload.status ?? ordered.find(e => e.type === 'status_changed')?.payload.from;
        if (typeof first === 'string')
            status = first as TaskDetail['status'];
        for (let n = 0; n < ordered.length; n++) {
            const event = ordered[n]!;
            if (event.type === 'created' || event.type === 'status_changed') {
                const next = event.payload.to ?? event.payload.status;
                if (typeof next === 'string')
                    status = next as TaskDetail['status'];
            }
            const p = followUpProjection({ ...task, status }, ordered.slice(0, n + 1));
            if (p.lane === 'needs' && p.readyAt !== null && task.assigneeId) {
                const end = ordered[n + 1]?.createdAt ?? now;
                wait! += Math.max(0, end - Math.max(from, event.createdAt, p.readyAt));
            }
        }
    }
    const currentWait = state === 'waiting' && waitingReport && task.assigneeId ? Math.max(0, now - projection.readyAt!) : null;
    const knownTokens = linked.filter(c => c.tokens !== null);
    const tokens = knownTokens.length ? knownTokens.reduce((sum, c) => sum + c.tokens! / Math.max(1, references.get(c.key) ?? 1), 0) : null;
    return { task, direction: TASK_DIRECTIONS[task.id] ?? 'unassigned', state, conversations: linked, todos, progress: allPlans && todos.length ? todos.filter(t => t.completed).length / todos.length : null, wait, currentWait, judge: waitingReport ? projection.report?.judgeId ?? task.assigneeId ?? null : null, decision: waitingReport ? projection.decision : null, tokens, tokenCoverage: linked.length ? knownTokens.filter(c => !c.tokensPartial).length / linked.length : 0, events: events ?? [], eventsKnown: !!events };
}
export function summarize(items: readonly Item[]) { const live = items.filter(i => i.state !== 'canceled'), plans = live.filter(i => i.progress !== null), waits = live.filter(i => i.wait !== null), tokens = live.filter(i => i.tokens !== null); return { count: live.length, done: live.filter(i => i.state === 'done').length, progress: plans.length ? plans.reduce((s, i) => s + i.progress!, 0) / plans.length : null, plans: plans.length, wait: waits.length ? waits.reduce((s, i) => s + i.wait!, 0) : null, waitCoverage: waits.length, tokens: tokens.length ? tokens.reduce((s, i) => s + i.tokens!, 0) : null, tokenCoverage: live.filter(i => i.tokenCoverage === 1).length, owners: new Set(live.flatMap(i => i.task.assigneeId ? [i.task.assigneeId] : [])).size, waiting: live.filter(i => i.state === 'waiting').length, running: live.filter(i => i.state === 'running').length, unfollowed: live.filter(i => i.state === 'unfollowed').length }; }
export function matches(item: Item, query: string, owner: string, status: string) { const d = DIRECTIONS.find(d => d.id === item.direction); return (!query || [item.task.title, item.task.assigneeId, d?.name, item.task.id].join(' ').toLowerCase().includes(query.toLowerCase())) && (!owner || item.task.assigneeId === owner) && (!status || item.state === status); }
export function duration(ms: number | null) { if (ms === null)
    return '—'; const hours = Math.max(0, Math.floor(ms / HOUR)); return hours >= 48 ? `${Math.floor(hours / 24)} 天 ${hours % 24} 小时` : hours < 1 && ms > 0 ? '不到 1 小时' : `${hours} 小时`; }
export function tokenCount(n: number | null) { return n === null ? '—' : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(Math.round(n)); }
