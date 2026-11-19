import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useIntl, IntlProvider } from 'react-intl';
import * as Dialog from '@radix-ui/react-dialog';
import { Button, IconButton, ObjectTitleButton } from '@opencraft/design-system-web/button';
import { CloseIcon, ChevronRightIcon, RefreshIcon, ArrowUpRightIcon } from '@opencraft/design-system-web/action-icons';
import { SettingsSelect, SettingsTextInput, type ExtensionSettingsViewProps } from '@opencraft/extension-react';
import { GOALS, DIRECTIONS } from './catalog';
import { conversationKey, projectItem, summarize, matches, duration, tokenCount, periodStart, type Item, type Conversation } from './model';
import { readOverview, type GetClient, type Snapshot } from './reader';
import { messages, type MessageKey } from './messages';
import './view.scss';
export function createProjectOverviewView(getClient: GetClient, activationSignal: AbortSignal) {
    return function ProjectOverviewView(props: ExtensionSettingsViewProps) { const intl = useIntl(); const catalogs = Object.fromEntries(Object.entries(messages).map(([key, pair]) => ['join.projOverview.' + key, pair[intl.locale.startsWith('zh') ? 0 : 1]])); const scope = JSON.stringify([props.host.currentUser?.providerId, props.host.currentUser?.id, props.host.profiles.map(p => [p.hostId, p.revision])]); return <IntlProvider locale={intl.locale} timeZone={intl.timeZone} messages={{...intl.messages,...catalogs}}><Overview key={scope} {...props} getClient={getClient} activationSignal={activationSignal}/></IntlProvider>; };
}
function Overview({ host, reportError, getClient, activationSignal }: ExtensionSettingsViewProps & {
    getClient: GetClient;
    activationSignal: AbortSignal;
}) {
    const intl = useIntl(), t = (key: MessageKey) => intl.formatMessage({ id: 'join.projOverview.' + key, defaultMessage: messages[key][1] });
    const [snapshot, setSnapshot] = useState<Snapshot | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState(false), [period, setPeriod] = useState(7), [view, setView] = useState('all'), [owner, setOwner] = useState(''), [query, setQuery] = useState(''), [state, setState] = useState(''), [canceled, setCanceled] = useState(false), [selected, setSelected] = useState<string | null>(null), [open, setOpen] = useState(new Set<string>(GOALS.map(g => 'goal:' + g.id))), [refresh, setRefresh] = useState(0), [allWaiting, setAllWaiting] = useState(false), [now, setNow] = useState(Date.now());
    const cache = useRef(snapshot);
    cache.current = snapshot;
    const periodRef = useRef(period);
    useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 60000); return () => clearInterval(timer); }, []);
    useEffect(() => {
        const abort = new AbortController();
        const stop = () => abort.abort();
        activationSignal.addEventListener('abort', stop, { once: true });
        if (activationSignal.aborted)
            abort.abort();
        setLoading(true);
        setError(false);
        if (periodRef.current !== period) {
            setSnapshot(null);
            periodRef.current = period;
        }
        void readOverview(getClient, host, abort.signal, period, s => { if (!abort.signal.aborted)
            setSnapshot(s); }).catch((cause) => { if (abort.signal.aborted)
            return; setError(true); if (cause?.code === 401 || cause?.code === 403) {
            setSnapshot(null);
            return;
        } setSnapshot(value => value ? { ...value, enriching: false } : null); if (cache.current)
            reportError?.({ key: 'proj-overview-refresh', message: t('refreshFailed') }); }).finally(() => { if (!abort.signal.aborted)
            setLoading(false); });
        return () => { abort.abort(); activationSignal.removeEventListener('abort', stop); };
    }, [period, refresh, host.currentUser?.id]);
    // One coalesced refresh, no per-event fanout or work while the view is unmounted.
    useEffect(() => { let timer: ReturnType<typeof setTimeout> | undefined; const queue = () => { if (!timer)
        timer = setTimeout(() => { timer = undefined; setRefresh(v => v + 1); }, 3000); }; const stops = host.profiles.map(p => getClient(p.hostId)?.subscribeNotification(n => { if (n.method === 'opencraft/tasks/changed')
        queue(); })); return () => { if (timer)
        clearTimeout(timer); stops.forEach(stop => stop?.()); }; }, [host.profiles]);
    const members = snapshot?.tasks.members ?? [], memberName = (id: string | null | undefined) => members.find(m => m.id === id)?.name ?? id ?? t('noOwner');
    const references = useMemo(() => { const map = new Map<string, number>(); for (const task of snapshot?.tasks.tasks ?? [])
        for (const link of task.conversations) {
            const key = conversationKey(link.serverId, link.threadId);
            map.set(key, (map.get(key) ?? 0) + 1);
        } return map; }, [snapshot?.tasks.tasks]);
    const items = useMemo(() => snapshot?.tasks.tasks.map(task => projectItem(task, snapshot.conversations, snapshot.events.get(task.id), references, now, periodStart(now, period))) ?? [], [snapshot, references, now, period]);
    const myId = host.currentUser?.handle ?? null;
    const filtered = items.filter(i => (view !== 'mine' || myId !== null && (i.task.assigneeId === myId || i.conversations.some(c => c.participants?.includes(myId)))) && matches(i, query, owner, state) && (canceled || i.state !== 'canceled'));
    const chosen = items.find(i => i.task.id === selected), waiting = filtered.filter(i => i.state === 'waiting').sort((a, b) => (b.currentWait ?? -1) - (a.currentWait ?? -1)), summary = summarize(filtered);
    const toggle = (id: string) => setOpen(previous => { const next = new Set(previous); next.has(id) ? next.delete(id) : next.add(id); return next; });
    const enter = async (c: Conversation) => { try {
        if (!host.openConversation)
            throw Error();
        await host.openConversation(c.serverId, c.threadId);
    }
    catch {
        reportError?.({ key: 'proj-overview-open', message: t('openFailed') });
    } };
    const status = (i: Item) => <span className={`proj-overview__status is-${i.state}`}><i />{t(i.state)}{i.state === 'waiting' ? <small>{i.judge ? `${t('awaiting')} ${memberName(i.judge)}` : ''} {i.currentWait === null ? t('waitUnknown') : duration(i.currentWait)}</small> : null}</span>;
    const cells = (list: readonly Item[]) => { const a = summarize(list); return <><div className="proj-overview__number"><strong>{a.progress === null ? `${a.done}/${a.count}` : Math.round(a.progress * 100) + '%'}</strong><small title={t('progressCoverage')}>{a.progress === null ? t('done') : t('progressCoverage') + ' ' + a.plans + '/' + a.count}</small></div><div className="proj-overview__number"><strong>{tokenCount(a.tokens)} <small>token</small></strong><small>{a.owners} {t('owners')} · {t('tokensCoverage')} {a.tokenCoverage}/{a.count}</small></div><div className="proj-overview__number"><strong>{duration(a.wait)}</strong><small>{t('waitCoverage')} {a.waitCoverage}/{a.count}</small></div></>; };
    const aggregateState = (list: readonly Item[]) => { const a = summarize(list); return <div className="proj-overview__group-status">{a.running ? <span className="is-running">{a.running} {t('running')}</span> : null}{a.waiting ? <span className="is-waiting">{a.waiting} {t('waiting')}</span> : null}{a.unfollowed ? <small>{a.unfollowed} {t('unfollowed')}</small> : null}{!a.running && !a.waiting && !a.unfollowed ? <small>{a.done}/{a.count} {t('done')}</small> : null}</div>; };
    const row = (kind: string, id: string, name: string, description: string, list: readonly Item[]) => <div className={`proj-overview__row is-${kind}`}><div className="proj-overview__name"><IconButton size="sm" aria-label={`${open.has(id) ? t('collapse') : name}`} aria-expanded={open.has(id)} onClick={() => toggle(id)}><ChevronRightIcon size={16} style={{ transform: open.has(id) ? 'rotate(90deg)' : undefined }}/></IconButton><div><ObjectTitleButton onClick={() => toggle(id)}>{name}</ObjectTitleButton><small>{description}</small></div></div>{aggregateState(list)}{cells(list)}</div>;
    const changes = filtered.flatMap(i => i.events.filter(e => e.createdAt >= periodStart(now, period) && ['created', 'updated', 'status_changed', 'linked', 'unlinked'].includes(e.type)).map(e => ({ item: i, event: e }))).sort((a, b) => b.event.createdAt - a.event.createdAt).slice(0, 12);
    return <div className="proj-overview"><header className="proj-overview__header"><div><p>LIGHTVELA</p><h1>{t('title')}</h1><small>{t('sourceOnly')}</small></div><div className="proj-overview__toolbar"><SettingsSelect aria-label={t('period')} value={period} onChange={e => setPeriod(Number(e.target.value))}><option value={7}>{t('week')}</option><option value={30}>{t('month')}</option></SettingsSelect><Button variant={view === 'all' ? 'secondary' : 'ghost'} onClick={() => setView('all')}>{t('all')}</Button><Button variant={view === 'mine' ? 'secondary' : 'ghost'} onClick={() => setView('mine')}>{t('mine')}</Button><IconButton aria-label={t('refresh')} loading={loading} onClick={() => setRefresh(n => n + 1)}><RefreshIcon size={18}/></IconButton></div></header>
 <section aria-label={t('metrics')}><div className="proj-overview__section-title"><h2>{t('metrics')}</h2><small>{t('snapshot')}</small></div><div className="proj-overview__metrics">{([['users', '61,463', '29,742 / 31,721'], ['daily', '7,908', '4,943 / 2,965'], ['retention', '7.7%', '12.2% / 4.5%'], ['userTokens', '—', t('unavailable')]] as const).map(([key, value, foot]) => <div key={key}><span>{t(key)}</span><strong>{value}</strong><small>{foot}{key !== 'userTokens' ? ' · ' + t('regions') : ''}</small></div>)}</div><details className="proj-overview__source"><summary>{t('sourceReport')} · {t('historical')}</summary><p>{t('source')}</p></details></section>
 <section className="proj-overview__planning"><div className="proj-overview__section-title"><h2>{t('planning')}</h2><small>{snapshot ? t('readAt') + ' ' + intl.formatTime(snapshot.asOf) : ''}</small></div><div className="proj-overview__filters"><SettingsTextInput aria-label={t('search')} placeholder={t('search')} value={query} onChange={e => setQuery(e.target.value)}/><SettingsSelect aria-label={t('owner')} value={owner} onChange={e => setOwner(e.target.value)}><option value="">{t('allOwners')}</option>{members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</SettingsSelect><SettingsSelect aria-label={t('status')} value={state} onChange={e => setState(e.target.value)}><option value="">{t('allStatuses')}</option>{(['running', 'waiting', 'unfollowed', 'idle', 'unknown', 'failed', 'done'] as const).map(s => <option value={s} key={s}>{t(s)}</option>)}</SettingsSelect><label><input type="checkbox" checked={canceled} onChange={e => setCanceled(e.target.checked)}/>{t('showCanceled')}</label></div>
 <div className="proj-overview__read-status" role="status">{!myId && view === 'mine' ? t('identity') : loading || snapshot?.enriching ? t('updating') : error ? t('refreshFailed') : `${filtered.length} ${t('following')} · ${summary.running} ${t('running')} · ${summary.waiting} ${t('waiting')} · ${summary.unfollowed} ${t('unfollowed')}`}</div>
 {!snapshot ? <div className="proj-overview__empty">{error ? <><p>{t('failure')}</p><Button onClick={() => setRefresh(n => n + 1)}>{t('retry')}</Button></> : <><p>{t('loading')}</p>{[0, 1, 2, 3, 4].map(n => <div key={n} className="proj-overview__skeleton"/>)}</>}</div> : <><div className="proj-overview__plan"><div className="proj-overview__row is-heading"><span>{t('itemHeading')}</span><span>{t('status')}</span><span>{t('progress')}</span><span>{t('investment')}</span><span>{t('wait')}</span></div>{GOALS.map(g => { const directions = DIRECTIONS.filter(d => d.goal === g.id), list = filtered.filter(i => directions.some(d => d.id === i.direction)); if (!list.length && g.id === 'unassigned' || !list.length && (query || owner || state || view === 'mine'))
            return null; return <Fragment key={g.id}>{row('goal', 'goal:' + g.id, g.name, g.description, list)}{open.has('goal:' + g.id) ? directions.map(d => { const rows = list.filter(i => i.direction === d.id); if (!rows.length && (query || owner || state || view === 'mine'))
            return null; return <Fragment key={d.id}>{row('direction', d.id, d.name, `${rows.length} ${t('following')}`, rows)}{open.has(d.id) ? rows.map(i => <div key={i.task.id} className={`proj-overview__row is-item ${i.state === 'canceled' ? 'is-canceled' : ''}`}><div className="proj-overview__name"><ObjectTitleButton onClick={() => setSelected(i.task.id)}>{i.task.title}</ObjectTitleButton><small>{memberName(i.task.assigneeId)} · {i.conversations.length} {t('conversations')}</small></div>{status(i)}{cells([i])}</div>) : null}</Fragment>; }) : null}</Fragment>; })}{!filtered.length ? <div className="proj-overview__empty">{t('empty')}<Button variant="ghost" onClick={() => { setOwner(''); setQuery(''); setState(''); setView('all'); }}>{t('clear')}</Button></div> : null}</div>
 <div className="proj-overview__section-title"><h2>{t('attention')} <small>{waiting.length}</small></h2>{waiting.length > 3 ? <Button variant="ghost" onClick={() => setAllWaiting(v => !v)}>{allWaiting ? t('collapse') : t('allWaiting')}</Button> : null}</div><div className="proj-overview__waiting">{(view === 'mine' || allWaiting ? waiting : waiting.slice(0, 3)).map(i => <div key={i.task.id}><ObjectTitleButton onClick={() => setSelected(i.task.id)}>{i.task.title}</ObjectTitleButton><span>{memberName(i.judge ?? i.task.assigneeId)}</span><strong>{i.currentWait === null ? t('waitUnknown') : duration(i.currentWait)}</strong>{i.conversations[0] ? <Button variant="ghost" onClick={() => void enter(i.conversations[0]!)}>{t('enter')} <ArrowUpRightIcon size={14}/></Button> : null}</div>)}{!waiting.length ? <p>{t('noWaiting')}</p> : null}</div>
 <div className="proj-overview__bottom"><section><h2>{t('compare')}</h2>{DIRECTIONS.map(d => { const rows = filtered.filter(i => i.direction === d.id); if (!rows.length)
            return null; const a = summarize(rows); return <div className="proj-overview__comparison" key={d.id}><span>{d.name}</span><strong>{tokenCount(a.tokens)} <small>token</small></strong><span>{duration(a.wait)}</span></div>; })}</section><section><h2>{t('recent')}</h2>{changes.length ? changes.map(({ item, event }) => <div className="proj-overview__change" key={event.eventId}><time>{intl.formatDate(event.createdAt, { month: '2-digit', day: '2-digit' })}</time><div><ObjectTitleButton onClick={() => setSelected(item.task.id)}>{item.task.title}</ObjectTitleButton><small>{t(event.type === 'status_changed' ? 'statusChanged' : event.type === 'created' ? 'created' : event.type === 'linked' ? 'linked' : event.type === 'unlinked' ? 'unlinked' : 'updated')} · {event.actor?.label ?? event.actor?.id ?? '—'}</small></div></div>) : <p>{t('noRecent')}</p>}</section></div>
 <details className="proj-overview__source"><summary>{t('notes')}</summary><p>{t('planningSource')}</p><p>{t('coverage')}</p><p>{t('waitNote')}</p><p>{t('humanDays')}</p></details></>}
 </section>
 <Dialog.Root open={!!chosen} onOpenChange={open => { if (!open)
        setSelected(null); }}><Dialog.Portal><Dialog.Overlay className="proj-overview__overlay"/><Dialog.Content className="proj-overview__drawer" aria-describedby={undefined}><div className="proj-overview__drawer-head"><div><small>{DIRECTIONS.find(d => d.id === chosen?.direction)?.name}</small><Dialog.Title>{chosen?.task.title}</Dialog.Title>{chosen ? status(chosen) : null}</div><Dialog.Close asChild><IconButton aria-label={t('close')}><CloseIcon size={18}/></IconButton></Dialog.Close></div>{chosen ? <div className="proj-overview__drawer-body">{chosen.decision ? <section><h3>{t('decision')}</h3><p>{chosen.decision}</p><small>{t('followUp')}</small></section> : null}<section><h3>{t('todos')} {chosen.todos.length ? `${chosen.todos.filter(x => x.completed).length}/${chosen.todos.length}` : ''}</h3>{chosen.todos.length ? chosen.todos.map((todo, index) => <div className="proj-overview__todo" key={index}><input type="checkbox" checked={todo.completed} readOnly aria-label={todo.text}/><span>{todo.text}<small>{todo.executor}</small></span></div>) : <p>{t('noTodos')}</p>}</section><section><h3>{t('conversations')}</h3>{chosen.conversations.map(c => <div className="proj-overview__session" key={c.key}><div><strong>{c.title}</strong><small>{c.participants?.map(memberName).join('、') || '—'} · {t(c.state)} · {tokenCount(c.tokens)} token{c.tokensPartial ? ' · ' + t('partial') : ''}</small></div><Button size="sm" onClick={() => void enter(c)} disabled={!host.openConversation}>{t('enter')}</Button></div>)}{!chosen.conversations.length ? <><p>{t('noConversations')}</p><Button onClick={() => host.openView('opencraft.tasks.board')}>{t('board')}</Button></> : null}</section>{chosen.task.description || chosen.task.acceptanceCriteria ? <details><summary>{t('fullContext')}</summary>{chosen.task.description ? <><h3>{t('description')}</h3><p className="proj-overview__context">{chosen.task.description}</p></> : null}{chosen.task.acceptanceCriteria ? <><h3>{t('acceptance')}</h3><p className="proj-overview__context">{chosen.task.acceptanceCriteria}</p></> : null}</details> : null}</div> : null}</Dialog.Content></Dialog.Portal></Dialog.Root>
 </div>;
}
