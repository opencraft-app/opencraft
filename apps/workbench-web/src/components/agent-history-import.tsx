import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useInfiniteQuery, useQueryClient, useIsFetching } from "@tanstack/react-query";
import { canImportAgentHistory, historyAgentLabel } from "./history-import-agents";
import type { HistoryImportAgentId, OnboardingSnapshot } from "@opencraft/appserver-protocol";
import type { AppServerMethodParams, AppServerMethodResult } from "@opencraft/appserver-protocol";
import { useIntl } from "@opencraft/i18n/react";
import { Button, IconButton } from "@opencraft/design-system-web/button";
import { CheckboxIcon, FolderIcon, ChevronRightIcon, ChevronLeftIcon, ResetIcon } from "@opencraft/design-system-web/action-icons";

import { SettingsTextInput, SettingsSelect } from "@opencraft/extension-react";
import { AgentIdentityIcon } from "./agent-directory";
import { groupAgentHistory, filterAgentHistory } from "./agent-history-groups";

type HistoryMethod = "opencraft/agents/onboarding/history-agents" | "opencraft/agents/onboarding/history-sources" | "opencraft/agents/onboarding/history" | "opencraft/agents/onboarding/import";
export type HistoryRequest = <M extends HistoryMethod>(method: M, params: AppServerMethodParams<M>) => Promise<AppServerMethodResult<M>>;

type HistoryProps = {
  hostId: string; identityScope: string; nativeScope?: string; agentId: HistoryImportAgentId; enabled: boolean; request: HistoryRequest;
  mode?: "summary" | "browse"; onOpen?(): void;
  onBusyChange(busy: boolean): void; onImported?(): void | Promise<void>;
};
export function AgentHistoryImport(props: HistoryProps) {
  return <AgentHistoryHomeSelector key={JSON.stringify([props.hostId,props.identityScope,props.agentId,props.nativeScope])} {...props}/>;
}
function AgentHistoryHomeSelector(props:HistoryProps) {
  const intl=useIntl();
  const [sourceId,setSourceId]=useState<string>();
  const [busy,setBusy]=useState(false);
  const sources=useQuery({queryKey:["agent-history-sources",props.hostId,props.identityScope,props.agentId,props.nativeScope],enabled:props.enabled && props.agentId === "codex",retry:false,staleTime:30_000,queryFn:()=>props.request("opencraft/agents/onboarding/history-sources",{id:props.agentId})});
  const choices=sources.data?.sources ?? [];
  // Prefer the native resume naming index for browsing only. Execution remains
  // bound to the explicitly imported source; existing conversations never move.
  const preferred=choices.find(source=>source.hasNames) ?? choices.find(source=>source.configured);
  useEffect(()=>{if(sourceId === undefined && preferred)setSourceId(preferred.id);},[sourceId,preferred?.id]);
  const selected=sourceId ?? preferred?.id ?? "default";
  return <>
    {sources.isError && props.mode !== "summary" ? <div role="status" className="agent-history__actions"><span>{intl.formatMessage({id:"onboard.history.sourcesFailed",defaultMessage:"Could not read Codex data directories. Retry, or update this machine’s companion if it is outdated."})}</span><Button variant="ghost" size="sm" disabled={busy || sources.isFetching} onClick={()=>void sources.refetch()}>{intl.formatMessage({id:"onboard.agent.retry",defaultMessage:"Retry"})}</Button></div> : null}
    {props.mode !== "summary" && choices.length > 0 ? <label className="agent-history__source">
      <span>{intl.formatMessage({id:"onboard.history.dataSource",defaultMessage:"Codex data directory"})}</span>
      <SettingsSelect value={selected} disabled={busy} onChange={event=>setSourceId(event.target.value)} aria-label={intl.formatMessage({id:"onboard.history.dataSource",defaultMessage:"Codex data directory"})}>
        {choices.map(source=><option key={source.id} value={source.id}>{source.path}</option>)}
      </SettingsSelect>
    </label> : null}
    <AgentHistorySource key={selected} {...props} enabled={props.enabled && !sources.isFetching} sourceId={selected} sourceScanning={sources.isPending && sources.fetchStatus === "fetching"} onBusyChange={value=>{setBusy(value);props.onBusyChange(value);}} />
  </>;
}
function AgentHistorySource({ hostId, identityScope, agentId, enabled, request, onBusyChange, onImported, mode = "browse", onOpen, sourceId, sourceScanning, nativeScope }: {
  hostId: string; identityScope: string; nativeScope?: string; agentId: HistoryImportAgentId; enabled: boolean; request: HistoryRequest;
  sourceScanning?:boolean; sourceId?: string; mode?: "summary" | "browse"; onOpen?(): void;
  onBusyChange(busy: boolean): void; onImported?(): void | Promise<void>;
}) {
  const intl = useIntl();
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [imported, setImported] = useState<Set<string>>(() => new Set());
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<"updated" | "created">("updated");
  const [archived, setArchived] = useState(false);
  const [supportsArchived, setSupportsArchived] = useState(false);
  const query = useInfiniteQuery({
    queryKey: ["agent-history", hostId, identityScope, agentId, sourceId, archived, nativeScope], enabled, gcTime: 0, retry: false, initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => request("opencraft/agents/onboarding/history", { id: agentId, ...(sourceId !== "default" ? {sourceId} : {}), ...(archived ? { archived: true } : {}), ...(pageParam ? { cursor: pageParam } : {}) }),
    getNextPageParam: (last, pages) => last.nextCursor && !pages.slice(0, -1).some(page => page.nextCursor === last.nextCursor) ? last.nextCursor : undefined,
  });
  useEffect(() => { if (query.data?.pages.some(page=>page.supportsArchived)) setSupportsArchived(true); }, [query.data]);
  const conversations = [...new Map((query.data?.pages.flatMap(page => page.conversations) ?? []).map(entry => [entry.id, entry])).values()];
  const groups = useMemo(() => groupAgentHistory(conversations), [query.data]);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const sourceRef = useRef<HTMLButtonElement>(null);
  const previousMode = useRef(mode);
  const [folder, setFolder] = useState<string | null>(null);
  const current = groups.find(group => group.id === folder);
  const visible = filterAgentHistory(current?.conversations ?? [], search, sort);
  const visibleGroups = groups.filter(group => !search.trim() || (group.name ?? "").toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()) || filterAgentHistory(group.conversations, search, sort).length > 0);
  const dateLabel = (value: string | null | undefined) => {
    const at = value ? Date.parse(value) : NaN;
    if (!Number.isFinite(at)) return intl.formatMessage({id:"onboard.history.unknownTime",defaultMessage:"Unknown time"});
    const days = Math.trunc((at-Date.now())/86400000);
    return Math.abs(days)<1 ? intl.formatDate(at,{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"}) : intl.formatRelativeTime(days,"day",{numeric:"auto"});
  };
  useEffect(() => {
    if (mode === "browse") headingRef.current?.focus({preventScroll:true});
    else if (previousMode.current === "browse") sourceRef.current?.focus({preventScroll:true});
    previousMode.current = mode;
  }, [mode, folder]);
  const agentName = historyAgentLabel(agentId);
  const scanning = sourceScanning || query.isFetching || (query.hasNextPage && conversations.length < 5000 && !query.isError);
  useEffect(() => {
    if (enabled && query.hasNextPage && !query.isFetching && !query.isError && conversations.length < 5000) void query.fetchNextPage();
  }, [enabled, query.hasNextPage, query.isFetching, query.isError, query.dataUpdatedAt, conversations.length]);
  const count = intl.formatMessage({ id: "onboard.history.sourceCounts", defaultMessage: "{folders, plural, one {# folder} other {# folders}} · {conversations, plural, one {# conversation} other {# conversations}}" },
    { folders: groups.filter(group => group.name !== null).length, conversations: conversations.length });
  const progress = scanning ? intl.formatMessage({ id: "onboard.history.scanning", defaultMessage: "Reading local records… {counts}" }, { counts: count }) : count;
  const run = async () => {
    if (busy || selected.size === 0) return;
    setBusy(true); onBusyChange(true); setFailed(false);
    try {
      const result = await request("opencraft/agents/onboarding/import", { id: agentId, ...(sourceId !== "default" ? {sourceId} : {}), conversationIds: [...selected] });
      if (!live.current) return;
      setImported(previous => new Set([...previous, ...result.imported.map(entry => entry.id)]));
      setSelected(new Set(result.failed)); setFailed(result.failed.length > 0);
      if (result.imported.length) await onImported?.();
    } catch { if (live.current) setFailed(true); }
    finally { if (live.current) { setBusy(false); onBusyChange(false); } }
  };
  const retry = <Button size="sm" variant="ghost" disabled={query.isFetching || busy} onClick={() => { void query.refetch(); }}>{intl.formatMessage({ id: "onboard.agent.retry", defaultMessage: "Retry" })}</Button>;
  if (mode === "summary") return <section className="agent-history-source" data-agent={agentId} aria-busy={scanning}>
    <Button ref={sourceRef} variant="ghost" contentLayout="row" onClick={onOpen}>
      <AgentIdentityIcon id={agentId} /><span className="agent-history__identity"><span>{agentName}</span>
      <small role="status">{progress}</small>{query.isError ? <small>{intl.formatMessage({ id: "onboard.history.sourceFailed", defaultMessage: "Couldn't read local records. Open to retry." })}</small> : null}</span><ChevronRightIcon size={16} />
    </Button>
    {query.isError ? retry : null}
  </section>;
  return <section className="agent-history" data-agent={agentId} aria-busy={busy || scanning}>
    <header className="agent-history__heading"><AgentIdentityIcon id={agentId} /><h3 ref={current ? undefined : headingRef} tabIndex={-1}>{agentName}</h3><span role="status">{progress}</span></header>
    <p>{intl.formatMessage({ id: "onboard.history.description", defaultMessage: "Choose saved conversations to import and continue from your conversation list." })}</p>
    {query.isPending ? <p role="status">{intl.formatMessage({ id: "onboard.history.loading", defaultMessage: "Reading local conversations…" })}</p> : null}
    {query.isError ? <div role="status"><p>{intl.formatMessage({ id: "onboard.history.loadFailed", defaultMessage: "Couldn't read local conversations. Retry or continue without importing." })}</p>{retry}</div> : null}
    <div className="agent-history__filters">
      <SettingsTextInput aria-label={intl.formatMessage({id:"onboard.history.search",defaultMessage:"Search conversations"})} placeholder={intl.formatMessage({id:"onboard.history.search",defaultMessage:"Search conversations"})} value={search} onChange={event=>setSearch(event.target.value)} />
      <SettingsSelect aria-label={intl.formatMessage({id:"onboard.history.sort",defaultMessage:"Sort conversations"})} value={sort} onChange={event=>setSort(event.target.value as "updated"|"created")}>
        <option value="updated">{intl.formatMessage({id:"onboard.history.updated",defaultMessage:"Updated"})}</option>
        {conversations.some(entry=>entry.createdAt) ? <option value="created">{intl.formatMessage({id:"onboard.history.created",defaultMessage:"Created"})}</option> : null}
      </SettingsSelect>
      {agentId === "codex" && supportsArchived ? <SettingsSelect aria-label={intl.formatMessage({id:"onboard.history.status",defaultMessage:"Conversation status"})} value={archived?"archived":"active"} disabled={busy} onChange={event=>{setArchived(event.target.value==='archived');setFolder(null);}}>
        <option value="active">{intl.formatMessage({id:"onboard.history.active",defaultMessage:"Active"})}</option>
        <option value="archived">{intl.formatMessage({id:"onboard.history.archived",defaultMessage:"Archived"})}</option>
      </SettingsSelect> : null}
    </div>
    {current ? <>
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => setFolder(null)} contentLayout="row"><ChevronLeftIcon size={16} />{intl.formatMessage({id:"onboard.history.backFolders",defaultMessage:"All folders"})}</Button>
      <h4 ref={headingRef} tabIndex={-1} className="agent-history__folder-title"><FolderIcon size={16}/>{current.name ?? intl.formatMessage({id:"onboard.history.ungrouped",defaultMessage:"Other conversations"})}<span className="agent-history__folder-count">{intl.formatMessage({id:"onboard.history.folderCount",defaultMessage:"{count, plural, one {# conversation} other {# conversations}}"},{count:visible.length})}</span></h4>
      <p className="agent-history__folder-path">{current.path}</p>
      <div className="agent-history__actions"><Button size="sm" variant="ghost" disabled={busy || visible.every(entry=>entry.imported || imported.has(entry.id))} onClick={() => setSelected(previous => new Set([...previous, ...visible.filter(entry => !entry.imported && !imported.has(entry.id)).map(entry => entry.id)].slice(0, 100)))}>{intl.formatMessage({ id: "onboard.history.selectFolder", defaultMessage: "Select this folder (up to 100)" })}</Button>
        <Button size="sm" variant="ghost" disabled={busy || selected.size === 0} onClick={() => setSelected(new Set())}>{intl.formatMessage({ id: "onboard.history.clear", defaultMessage: "Clear selection" })}</Button></div>
      <ul className="agent-history__list">{visible.map(entry => {
        const done = entry.imported || imported.has(entry.id);
        return <li key={entry.id}><Button className="agent-history__conversation" variant="ghost" size="sm" contentLayout="row" role="checkbox" aria-checked={done || selected.has(entry.id)} disabled={busy || done || (!selected.has(entry.id) && selected.size >= 100)} onClick={() => setSelected(previous => { const next = new Set(previous); if (next.has(entry.id)) next.delete(entry.id); else next.add(entry.id); return next; })}>
          <CheckboxIcon size={18} checked={done || selected.has(entry.id)} aria-hidden="true" />
          <span className="agent-history__identity"><span className="agent-history__title" title={entry.title ?? undefined}>{entry.title || intl.formatMessage({ id: "onboard.history.untitled", defaultMessage: "Untitled conversation" })}</span>{entry.cwd !== current.path ? <small>{entry.cwd}</small> : null}</span>
          <time className="agent-history__time" dateTime={(sort==="created"?entry.createdAt:entry.updatedAt)??undefined} title={(sort==="created"?entry.createdAt:entry.updatedAt)??undefined}>{dateLabel(sort==="created"?entry.createdAt:entry.updatedAt)}</time>
          {done ? <span>{intl.formatMessage({ id: "onboard.history.imported", defaultMessage: "Imported" })}</span> : null}
        </Button></li>;
      })}</ul>
    </> : groups.length ? <ul className="agent-history__list agent-history__folders">{visibleGroups.map(group => <li key={group.id}><Button variant="ghost" contentLayout="row" disabled={busy} onClick={() => setFolder(group.id)}>
      <FolderIcon size={18}/><span className="agent-history__identity"><span>{group.name ?? intl.formatMessage({id:"onboard.history.ungrouped",defaultMessage:"Other conversations"})}</span><small>{group.path}</small></span><span>{intl.formatMessage({id:"onboard.history.folderCount",defaultMessage:"{count, plural, one {# conversation} other {# conversations}}"},{count:group.conversations.length})}</span><ChevronRightIcon size={16}/>
    </Button></li>)}</ul> : query.isSuccess && !scanning ? <p>{intl.formatMessage({ id: "onboard.history.empty", defaultMessage: "No resumable local conversations found." })}</p> : null}
    {search.trim() && (current ? visible.length === 0 : visibleGroups.length === 0) ? <p role="status">{intl.formatMessage({id:"onboard.history.noMatches",defaultMessage:"No matching conversations."})}</p> : null}
    {query.hasNextPage && conversations.length >= 5000 ? <p>{intl.formatMessage({id:"onboard.history.scanLimit",defaultMessage:"Showing the first {count} conversations."},{count:conversations.length})}</p> : null}
    {failed ? <p role="alert">{intl.formatMessage({ id: "onboard.history.importFailed", defaultMessage: "Some conversations couldn't be imported. Your selection is kept so you can retry." })}</p> : null}
    {imported.size ? <p role="status">{intl.formatMessage({ id: "onboard.history.success", defaultMessage: "{count} conversations imported. Open them from the conversation list to continue." }, { count: imported.size })}</p> : null}
    <Button size="sm" variant="secondary" disabled={busy || selected.size === 0} onClick={() => { void run(); }}>{busy ? intl.formatMessage({ id: "onboard.history.importing", defaultMessage: "Importing…" }) : intl.formatMessage({ id: "onboard.history.import", defaultMessage: "Import selected ({count})" }, { count: selected.size })}</Button>
  </section>;
}

export function AgentHistoryPicker(props: Omit<Parameters<typeof AgentHistoryImport>[0], "agentId" | "mode" | "onOpen">) {
  const intl = useIntl();
  const queryClient = useQueryClient();
  const queryKey = ["agent-history", props.hostId, props.identityScope];
  const fetching = useIsFetching({queryKey});
  const [active, setActive] = useState<HistoryImportAgentId | null>(null);
  const [busy, setBusy] = useState(false);
  const statusKey = ["agent-history-agents", props.hostId, props.identityScope];
  const status = useQuery({ queryKey: statusKey, enabled: props.enabled, retry: false, staleTime: 30_000,
    queryFn: async (): Promise<OnboardingSnapshot> => {
      try { return await props.request("opencraft/agents/onboarding/history-agents", {}); }
      catch (error) {
        if ((error as { code?: number })?.code !== -32601) throw error;
        // Older Hosts implement these two sources; never run auth checks here.
        return { historyImport: true, agents: (["codex", "cursor"] as const).map(id => ({ id, installed: true, authenticated: null, account: null, activity: null, version: null, installUrl: "", canInstallPackage: false })) };
      }
    } });
  const available = status.data?.agents.filter(canImportAgentHistory) ?? [];
  return <div className="agent-history-picker">
    <div className="agent-onboard__toolbar">
    {active ? <Button variant="ghost" size="sm" disabled={busy} onClick={() => setActive(null)} contentLayout="row"><ChevronLeftIcon size={16}/>{intl.formatMessage({id:"onboard.history.backAgents",defaultMessage:"Choose another Agent"})}</Button> : <p>{intl.formatMessage({id:"onboard.history.chooseAgent",defaultMessage:"Choose an Agent, then select folders and conversations to import."})}</p>}
    <IconButton size="accessory" variant="ghost" disabled={busy || fetching > 0} aria-label={intl.formatMessage({id:"common.refresh",defaultMessage:"Refresh"})} onClick={() => {void queryClient.invalidateQueries({queryKey:["agent-history-sources",props.hostId,props.identityScope]});void queryClient.invalidateQueries({queryKey});void queryClient.invalidateQueries({queryKey:statusKey});}}><ResetIcon size={16}/></IconButton>
    </div>
    {status.isPending ? <p role="status">{intl.formatMessage({id:"onboard.history.loading",defaultMessage:"Reading local conversations…"})}</p> : null}
    {status.isError ? <p role="status">{intl.formatMessage({id:"onboard.history.loadFailed",defaultMessage:"Couldn't read local conversations. Retry or continue without importing."})}</p> : null}
    {available.map(agent => { const agentId = agent.id; return <div key={agentId} hidden={active !== null && active !== agentId}>
      <AgentHistoryImport {...props} nativeScope={agent.historyScope} agentId={agentId} mode={active === agentId ? "browse" : "summary"} onOpen={() => setActive(agentId)} onBusyChange={value => {setBusy(value);props.onBusyChange(value);}} />
    </div>; })}
    {active === null ? status.data?.agents.filter(agent => !canImportAgentHistory(agent)).map(agent => <section className="agent-history-source" key={agent.id} data-agent={agent.id}>
      <Button disabled variant="ghost" contentLayout="row"><AgentIdentityIcon id={agent.engineId ?? agent.id} />
        <span className="agent-history__identity agent-history__identity--unavailable"><span>{agent.displayName || historyAgentLabel(agent.id)}</span>
          <small>{intl.formatMessage(!agent.installed ? {id:"onboard.history.installNeeded",defaultMessage:"Install this agent on this machine to import its saved conversations."} : agent.id === "codebuddy-ide" ? {id:"onboard.history.ideSetup",defaultMessage:"Connect CodeBuddy IDE, sign in and open the original project to import its saved conversations."} : {id:"onboard.history.unavailable",defaultMessage:"This agent does not expose saved conversations for import yet."})}</small>
        </span>
      </Button>
    </section>) : null}
  </div>;
}
