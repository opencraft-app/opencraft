import * as DropdownMenu from "@opencraft/design-system-web/dropdown-menu";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowRightIcon as ArrowRight, ClockIcon as Clock } from "@opencraft/design-system-web/action-icons";
import { SettingsControlPair, SegmentedControl, SettingsButton, SettingsSelect, SettingsChoiceSelect, SettingsTextInput } from "@opencraft/extension-react";
import { ObjectActionSurface, ObjectTitleButton } from "@opencraft/design-system-web/button";
import * as Dialog from "@radix-ui/react-dialog";
import { CloseIcon } from "@opencraft/design-system-web/action-icons";
import { SettingsCopyButton } from "@opencraft/extension-react";
import { BOARD_COLUMNS, boardColumn } from "./board-columns";
import { useWorkBoardText } from "./work-board-messages";
import { workBoardReadRecord } from "./work-board-read-model";
import { useIntl } from "@opencraft/i18n/react";
import type { TaskConversation, TaskDetail, TaskMember, TasksRequestPort } from "@opencraft/appserver-protocol";
import { activeFollowUpTask, FOLLOW_UP_LANES, followUpProjection, followUpDwellStart, followUpTaskKey, readFollowUpEvents, type FollowUpProjection } from "./ai-follow-up-model";
import { MemberAvatar } from "./member-avatar";
import "./ai-follow-up.scss";

export interface FollowUpSelection { readonly scope: string; readonly search: string; readonly grouping?: "state" | "priority" | "workflow"; readonly lanes?: Readonly<Record<string, string>> }
const PRIORITIES = ["urgent", "high", "normal", "low", "none"] as const;
type CachedProjection = { key: string; status: string; value: FollowUpProjection; failed: boolean };

function ColumnCards({ identity, positions, visible, onPosition, children }: { identity: string; positions: Map<string, number>; visible: boolean; onPosition(value: number): void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!visible || !ref.current) return;
    ref.current.scrollTop = positions.get(identity) ?? 0;
    onPosition(ref.current.scrollTop);
  }, [identity, positions, visible]);
  return <div ref={ref} className="tasks-ai-follow-up__cards" onScroll={event => {
    if (!visible) return;
    positions.set(identity, event.currentTarget.scrollTop); onPosition(event.currentTarget.scrollTop);
  }}>{children}</div>;
}

/** A read-only projection; task status, activity and navigation retain their existing owners. */
export function AIFollowUp({ tasks, members, activity, port, ownerFilter, onOwnerFilterChange, selection, onSelectionChange, myMemberId, onOpenConversation, onOpenTask, pending = false, dwellSince = 0, compact = false, scrollPositions }: {
  dwellSince?: number;
  compact?: boolean;
  scrollPositions?: Map<string, number>;
  tasks: readonly TaskDetail[];
  members: readonly TaskMember[];
  activity: boolean;
  port: TasksRequestPort;
  ownerFilter: string;
  onOwnerFilterChange(value: string): void;
  selection: FollowUpSelection;
  onSelectionChange(value: FollowUpSelection): void;
  myMemberId: string | null;
  onOpenConversation?: (link: TaskConversation) => void;
  onOpenTask?: (task: TaskDetail) => void;
  pending?: boolean;
}) {
  const intl = useIntl(), t = useWorkBoardText();
  const localPositions = useRef(new Map<string, number>());
  const columnPositions = scrollPositions ?? localPositions.current;
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [condensed, setCondensed] = useState(false);
  const tabs = useRef<HTMLDivElement>(null);
  const [agentOpen, setAgentOpen] = useState(false);
  const [readTaskId, setReadTaskId] = useState("");
  const candidates = tasks.filter(task => task.deletedAt === null && !task.archivedAt);
  const readable = candidates.filter(activeFollowUpTask);
  const ownerName = (id: string | null | undefined) => members.find(member => member.id === id)?.name ?? id ?? t("unassigned");
  const ownerIds = [...new Set(candidates.flatMap(task => task.assigneeId ? [task.assigneeId] : []))];
  if (ownerFilter.startsWith("member:") && !ownerIds.includes(ownerFilter.slice(7))) ownerIds.push(ownerFilter.slice(7));
  const taskKey = JSON.stringify(readable.map(task => [task.id, followUpTaskKey(task)]));
  const cache = useRef(new Map<string, CachedProjection>());
  const [reports, setReports] = useState<ReadonlyMap<string, CachedProjection>>(new Map());
  const [checking, setChecking] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(timer); }, []);
  const reader = useMemo(() => ({ request: port.request }), [port.request]);
  useEffect(() => {
    let live = true;
    const rows = readable;
    const changed = rows.filter(task => cache.current.get(task.id)?.key !== followUpTaskKey(task));
    if (!activity) { setChecking(false); return; }
    setChecking(changed.length > 0);
    void (async () => {
      let cursor = 0;
      const results = new Map(cache.current);
      await Promise.all(Array.from({ length: Math.min(4, changed.length) }, async () => {
        while (live && cursor < changed.length) {
          const task = changed[cursor++]!;
          try { results.set(task.id, { key: followUpTaskKey(task), status: task.status, value: followUpProjection(task, await readFollowUpEvents(reader, task.id)), failed: false }); }
          catch { results.set(task.id, { key: followUpTaskKey(task), status: task.status, value: followUpProjection(task), failed: true }); }
        }
      }));
      if (live) {
        const ids = new Set(rows.map(task => task.id));
        for (const id of results.keys()) if (!ids.has(id)) results.delete(id);
        cache.current = results; setReports(results); setChecking(false);
      }
    })();
    return () => { live = false; };
    // The serialized authority key fences changed rows; browsing filters never trigger reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskKey, activity, reader, refresh]);
  const projection = (task: TaskDetail): FollowUpProjection => {
    const cached = activity ? reports.get(task.id) : undefined;
    if (cached?.key === followUpTaskKey(task)) return cached.value;
    // Retain the last-known lane during a same-status refresh, but never show its old clock as current.
    if (cached && !cached.failed && cached.status === task.status) return { ...cached.value, readyAt: null, enteredAt: null };
    return followUpProjection(task);
  };
  const unverified = (task: TaskDetail) => !activity || reports.get(task.id)?.key !== followUpTaskKey(task) || reports.get(task.id)?.failed;
  const dwellStart = (task: TaskDetail) => unverified(task) ? null : followUpDwellStart(task, projection(task), dwellSince);
  const unavailable = readable.some(task => reports.get(task.id)?.failed && reports.get(task.id)?.key === followUpTaskKey(task)) || !activity;
  const query = selection.search.trim().toLocaleLowerCase();
  const active = candidates.filter(task => {
    const p = projection(task);
    const judge = p.report?.judgeId;
    return (!ownerFilter || (ownerFilter === "unassigned" ? !task.assigneeId : task.assigneeId === ownerFilter.slice(7)))
      && (selection.scope !== "mine" || !!myMemberId && !unverified(task) && activeFollowUpTask(task) && p.lane === "needs" && judge === myMemberId)
      && (selection.scope !== "owned" || !!myMemberId && task.assigneeId === myMemberId)
      && (!query || [task.title, task.id, p.decision, p.report?.artifact].join(" ").toLocaleLowerCase().includes(query));
  });
  const titles = { todo: t("todo"), working: t("working"), needs: t("needs"), review: t("review"), ready: t("ready"), closed: t("closed") };
  const descriptions = {
    todo: t("todoDescription"),
    working: t("workingDescription"),
    needs: t("needsDescription"),
    review: t("reviewDescription"),
    ready: t("readyDescription"),
  };
  const grouping = selection.grouping ?? "state";
  const priority = (task: TaskDetail) => task.priority && PRIORITIES.includes(task.priority) ? task.priority : "none";
  const priorityLabels = {
    urgent: t("urgent"), high: t("high"),
    normal: t("normal"), low: t("low"), none: t("unset"),
  };
  const workflowLabels = Object.fromEntries(BOARD_COLUMNS.map(id => [id, t(id)]));
  const collaborationGroup = (task: TaskDetail) => activeFollowUpTask(task) ? projection(task).lane : "closed";
  const groups = grouping === "priority" ? PRIORITIES : grouping === "workflow" ? BOARD_COLUMNS : [...FOLLOW_UP_LANES, ...(candidates.some(task => !activeFollowUpTask(task)) ? ["closed" as const] : [])];
  const selectedGroup = groups.includes(selection.lanes?.[grouping] as never) ? selection.lanes![grouping]!
    : selection.scope === "mine" && grouping === "state" ? "needs" : groups[0]!;
  const groupTitle = (group: string) => grouping === "state" ? titles[group as keyof typeof titles]
    : grouping === "workflow" ? workflowLabels[group]! : priorityLabels[group as typeof PRIORITIES[number]];
  const groupItems = (group: string) => active.filter(task => grouping === "priority" ? priority(task) === group
    : grouping === "workflow" ? boardColumn(task) === group : collaborationGroup(task) === group)
    .sort((a, b) => grouping === "state" && group === "needs"
      ? (dwellStart(a) ?? Infinity) - (dwellStart(b) ?? Infinity) || a.id.localeCompare(b.id)
      : a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
  useLayoutEffect(() => {
    if (compact) tabs.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [compact, grouping, selectedGroup]);
  const groupingOptions = [{ value: "state", label: t("byCollaboration") }, { value: "workflow", label: t("byWorkflow") }, { value: "priority", label: t("byPriority") }];
  const changeGrouping = (value: string) => onSelectionChange({ ...selection, grouping: value === "priority" || value === "workflow" ? value : "state" });
  const ownerOptions = <><option value="">{t("allOwners")}</option><option value="unassigned">{t("unassigned")}</option>{ownerIds.map(id => <option key={id} value={`member:${id}`}>{ownerName(id)}</option>)}</>;
  const filterAction = <Dialog.Root open={filtersOpen} onOpenChange={setFiltersOpen}><Dialog.Trigger asChild>
    <SettingsButton variant="quiet" aria-label={t("filters")} >{t("filters")}{ownerFilter ? " · 1" : ""}</SettingsButton>
  </Dialog.Trigger><Dialog.Portal><Dialog.Overlay className="modal-surface__scrim" data-layer="application" data-appearance="utility" />
    <Dialog.Content className="modal-surface tasks-dialog tasks-work-board-filters" data-layer="application" data-appearance="utility" aria-describedby={undefined}>
      <header><Dialog.Title>{t("filters")}</Dialog.Title><Dialog.Close asChild><SettingsButton variant="ghost" aria-label={t("close")}><CloseIcon size={18} aria-hidden="true" /></SettingsButton></Dialog.Close></header>
      <label>{t("search")}<SettingsTextInput type="search" value={selection.search} onChange={e => onSelectionChange({ ...selection, search: e.target.value })} /></label>
      <label>{t("ownerFilter")}<SettingsSelect value={ownerFilter} onChange={e => onOwnerFilterChange(e.target.value)}>{ownerOptions}</SettingsSelect></label>
      <footer><SettingsButton variant="quiet" onClick={() => { onOwnerFilterChange(""); onSelectionChange({ ...selection, search: "" }); }}>{t("clearFilters")}</SettingsButton><Dialog.Close asChild><SettingsButton variant="primary">{t("showResults")}</SettingsButton></Dialog.Close></footer>
    </Dialog.Content></Dialog.Portal></Dialog.Root>;
  const readRecord = (task: TaskDetail) => workBoardReadRecord(task, projection(task), !unverified(task), dwellSince);
  const readTask = active.find(task => task.id === readTaskId) ?? active[0];
  const readDocument = agentOpen ? JSON.stringify({ schemaVersion: 1, kind: "work-board-read-projection", grouping, filter: { scope: selection.scope, search: selection.search, owner: ownerFilter || null }, items: active.map(readRecord) }, null, 2) : "";
  const duration = (at: number) => {
    const minutes = Math.max(0, Math.floor((now - at) / 60_000)), hours = Math.floor(minutes / 60), days = Math.floor(hours / 24);
    return days ? t("daysHours", { days, hours: hours % 24 }) : hours ? t("hours", { hours }) : t("minutes", { minutes });
  };
  const retry = () => { for (const [id, entry] of cache.current) if (entry.failed) cache.current.delete(id); setRefresh(n => n + 1); };
  return <section className="tasks-ai-follow-up" data-compact={compact || undefined} data-condensed={compact && condensed || undefined} aria-label={t("title")}>
    <div className="tasks-ai-follow-up__grouping">
      <div className="tasks-ai-follow-up__desktop-grouping"><SegmentedControl label={t("grouping")} value={grouping} onValueChange={changeGrouping} options={groupingOptions} /></div>
      <div className="tasks-ai-follow-up__mobile-grouping"><SettingsChoiceSelect label={t("grouping")} value={grouping} options={groupingOptions} onValueChange={changeGrouping} />{filterAction}</div>
      <Dialog.Root open={agentOpen} onOpenChange={setAgentOpen}><Dialog.Trigger asChild><SettingsButton variant="quiet">{t("agentRead")}</SettingsButton></Dialog.Trigger><Dialog.Portal>
        <Dialog.Overlay className="modal-surface__scrim" data-layer="application" data-appearance="utility" />
        <Dialog.Content className="modal-surface tasks-dialog tasks-work-board-reader" data-layer="application" data-appearance="utility" aria-describedby="work-board-reader-description">
          <header><div><Dialog.Title>{t("agentRead")}</Dialog.Title><Dialog.Description id="work-board-reader-description">{t("agentDescription")}</Dialog.Description></div><Dialog.Close asChild><SettingsButton variant="ghost" aria-label={t("close")}><CloseIcon size={18} aria-hidden="true" /></SettingsButton></Dialog.Close></header>
          <div className="tasks-work-board-reader__body"><label>{t("selectItem")}<SettingsSelect value={readTask?.id ?? ""} disabled={!active.length} onChange={event => setReadTaskId(event.target.value)}>{active.length ? active.map(task => <option key={task.id} value={task.id}>{task.title}</option>) : <option value="">{t("empty")}</option>}</SettingsSelect></label>
            <pre role="region" aria-label={t("readData")}>{JSON.stringify(readTask ? readRecord(readTask) : { items: [] }, null, 2)}</pre></div>
          <footer><SettingsCopyButton value={readDocument} label={t("copySelection")} successLabel={t("copied")} errorLabel={t("copyError")} /><span>{t("readOnly")}</span></footer>
        </Dialog.Content>
      </Dialog.Portal></Dialog.Root>
    </div>
    <div className="tasks-ai-follow-up__toolbar">
      <SegmentedControl className="tasks-ai-follow-up__scope" label={t("scope")} value={selection.scope} onValueChange={scope => onSelectionChange({ ...selection, scope, ...(scope === "mine" ? { lanes: { ...selection.lanes, state: "needs" } } : {}) })} options={(compact ? ["mine", "owned", "all"] : ["all", "mine", "owned"]).map(value => ({ value, label: value === "mine" ? t("needsMe") : value === "owned" ? t("owned") : t("all") }))} />
      <SettingsControlPair className="tasks-ai-follow-up__filters"
        primary={<SettingsTextInput type="search" aria-label={t("search")} placeholder={t("searchPlaceholder")} value={selection.search} onChange={e => onSelectionChange({ ...selection, search: e.target.value })} />}
        companion={<div className="tasks-ai-follow-up__owner-filter"><label><span>{t("owner")}</span><SettingsSelect aria-label={t("ownerFilter")} value={ownerFilter} onChange={e => onOwnerFilterChange(e.target.value)}>{ownerOptions}</SettingsSelect></label></div>}
      />
    </div>
    <div className="tasks-ai-follow-up__summary">
      <span>{t("count", { count: active.length })}{selection.scope !== "all" && !myMemberId ? t("identityHint") : ""}</span>
    </div>
    {checking || unavailable ? <div className="tasks-ai-follow-up__feedback" role="status" aria-live="polite">
      {checking ? t("checking") : unavailable ? <>{t("unavailable")} {activity ? <SettingsButton variant="quiet" onClick={retry}>{t("retry")}</SettingsButton> : null}</> : null}
    </div> : null}
    <div ref={tabs} className="tasks-ai-follow-up__lane-tabs"><div className="tasks-ai-follow-up__tab-track"><SegmentedControl label={t("laneSelection")} value={selectedGroup} onValueChange={value => onSelectionChange({ ...selection, lanes: { ...selection.lanes, [grouping]: value } })} options={groups.map(group => ({ value: group, label: <>{groupTitle(group)} <span className="tasks-ai-follow-up__tab-count">{groupItems(group).length}</span></> }))} /></div></div>
    <div className="tasks-ai-follow-up__board-scroll" role="region" aria-label={t("lanes")}>
    <div className="tasks-ai-follow-up__board" style={{ gridTemplateColumns: `repeat(${groups.length}, minmax(calc(var(--spacing) * 70), 1fr))` }} aria-busy={checking}>
      {groups.map(group => {
        const lane = grouping === "state" ? group as keyof typeof titles : null;
        const items = groupItems(group);
        const title = groupTitle(group);
        const visible = !compact || selectedGroup === group;
        return <section key={`${grouping}:${group}`} className={`tasks-ai-follow-up__column tasks-ai-follow-up__column--${group}`} aria-label={title} hidden={!visible}>
          <header><div><span className="tasks-ai-follow-up__dot" aria-hidden="true" /><h3>{title}</h3><span className="tasks-ai-follow-up__count">{items.length}</span></div>{lane && lane !== "closed" ? <p>{descriptions[lane]}</p> : null}</header>
          <ColumnCards identity={`${grouping}:${group}`} positions={columnPositions} visible={visible} onPosition={position => { if (compact && visible) setCondensed(position > 64); }}>
          {!items.length ? <p className="tasks-ai-follow-up__empty">{t("empty")}</p> : <ul>{items.map(task => {
            const p = projection(task);
            const current = activeFollowUpTask(task), needs = current && p.lane === "needs", judge = !unverified(task) && needs ? p.report?.judgeId : null;
            const handlerId = judge || task.assigneeId, handler = ownerName(handlerId);
            const handling = current && unverified(task) ? t("unverified") : needs
              ? judge ? judge === myMemberId ? t("needsYou") : t("needsPerson", { name: ownerName(judge) })
                : t("actionNeeded")
              : t("noAction");
            const timed = current && !!task.assigneeId && ["todo", "needs", "ready"].includes(p.lane);
            const dwellAt = dwellStart(task);
            const dwell = !timed ? null : dwellAt === null ? t("checkingDuration")
              : t("dwell", { duration: duration(dwellAt) });
            return <li key={task.id} data-ai-follow-up-task-id={task.id}><ObjectActionSurface className="tasks-ai-follow-up__item" disabled={pending || !onOpenTask} onOpen={() => onOpenTask?.(task)}>
              <div className="tasks-ai-follow-up__content">
                <div className="tasks-ai-follow-up__card-meta"><span className={`tasks-ai-follow-up__priority tasks-ai-follow-up__priority--${priority(task)}`} aria-label={t("priorityLabel", { priority: priorityLabels[priority(task)] })}>{priorityLabels[priority(task)]}</span><span className={`tasks-ai-follow-up__handling${needs && !unverified(task) ? " tasks-ai-follow-up__handling--required" : ""}`}>{handling}</span></div>
                <h4>{onOpenTask ? <ObjectTitleButton prominence={compact ? "reading" : "default"} disabled={pending} className="tasks-ai-follow-up__title" aria-label={t("openTask", { title: task.title })} onClick={() => onOpenTask(task)}>{task.title}</ObjectTitleButton> : task.title}</h4>
                <div className={`tasks-ai-follow-up__state${!dwell ? " tasks-ai-follow-up__state--untimed" : ""}`}>{dwell ? <span className={dwellAt !== null ? "tasks-ai-follow-up__wait" : undefined} title={dwellAt !== null ? t("clockOrigin", { time: intl.formatDate(dwellAt, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZone: "Asia/Shanghai" }) }) : undefined}><Clock size={12} aria-hidden="true" />{dwell}</span> : <span>{t("notTimed")}</span>}</div>
              </div>
              <footer>
                <span className="tasks-ai-follow-up__owner" title={t("handler", { name: handler })}><MemberAvatar member={members.find(m => m.id === handlerId)} name={handler} assigned={!!handlerId} /><span>{handler}</span></span>
                {task.conversations.length && onOpenConversation ? task.conversations.length === 1 ? <SettingsButton type="button" variant="quiet" className="tasks-ai-follow-up__chat" onClick={() => onOpenConversation(task.conversations[0]!)} aria-label={t("openNamed", { title: task.title })}>{t("open")}<ArrowRight size={14} aria-hidden="true" /></SettingsButton> : <DropdownMenu.Root><DropdownMenu.Trigger asChild><SettingsButton type="button" variant="quiet" className="tasks-ai-follow-up__chat" aria-label={t("chooseNamed", { title: task.title })}>{t("open")} ({task.conversations.length})<ArrowRight size={14} aria-hidden="true" /></SettingsButton></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="tasks-card-menu" sideOffset={4}>{task.conversations.map((link, i) => <DropdownMenu.Item key={JSON.stringify([link.serverId, link.threadId])} onSelect={() => onOpenConversation(link)}>{t("conversationNumber", { number: i + 1 })}</DropdownMenu.Item>)}</DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root> : compact ? <span className="tasks-ai-follow-up__unlinked">{t("unlinked")}</span> : <SettingsButton type="button" variant="quiet" className="tasks-ai-follow-up__chat" disabled title={t("noConversation")}>{t("open")}<ArrowRight size={14} aria-hidden="true" /></SettingsButton>}
              </footer>
            </ObjectActionSurface></li>;
          })}</ul>}
          </ColumnCards>
        </section>;
      })}
    </div>
    </div>
    <p className="tasks-ai-follow-up__footnote">{t("clockHint")}</p>
  </section>;
}
