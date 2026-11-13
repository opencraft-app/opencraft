import { Fragment, useEffect, useRef, useState } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import type { AppServerMethodParams, AppServerMethodResult } from "@opencraft/appserver-protocol";
import { useIntl } from "@opencraft/i18n/react";
import { Button } from "@opencraft/design-system-web/button";
import { CheckboxIcon, FolderIcon } from "@opencraft/design-system-web/action-icons";

type HistoryMethod = "opencraft/agents/onboarding/history" | "opencraft/agents/onboarding/import";
export type HistoryRequest = <M extends HistoryMethod>(method: M, params: AppServerMethodParams<M>) => Promise<AppServerMethodResult<M>>;

export function AgentHistoryImport({ hostId, identityScope, agentId, enabled, request, onBusyChange, onImported }: {
  hostId: string; identityScope: string; agentId: "codex" | "cursor"; enabled: boolean; request: HistoryRequest;
  onBusyChange(busy: boolean): void; onImported?(): void | Promise<void>;
}) {
  const intl = useIntl();
  const queryClient = useQueryClient();
  useEffect(() => () => { queryClient.removeQueries({ queryKey: ["agent-history", hostId, identityScope, agentId], exact: true }); }, [queryClient, hostId, identityScope, agentId]);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [imported, setImported] = useState<Set<string>>(() => new Set());
  const query = useInfiniteQuery({
    queryKey: ["agent-history", hostId, identityScope, agentId], enabled, retry: false, initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => request("opencraft/agents/onboarding/history", { id: agentId, ...(pageParam ? { cursor: pageParam } : {}) }),
    getNextPageParam: (last, pages) => last.nextCursor && !pages.slice(0, -1).some(page => page.nextCursor === last.nextCursor) ? last.nextCursor : undefined,
  });
  const conversations = [...new Map((query.data?.pages.flatMap(page => page.conversations) ?? []).map(entry => [entry.id, entry])).values()];
  const ordered = [...conversations].sort((a, b) => {
    if (!a.nativeProject || !b.nativeProject) return a.nativeProject ? -1 : b.nativeProject ? 1 : 0;
    return a.nativeProject.position - b.nativeProject.position || a.nativeProject.id.localeCompare(b.nativeProject.id);
  });
  const available = conversations.filter(entry => !entry.imported && !imported.has(entry.id));
  const run = async () => {
    if (busy || selected.size === 0) return;
    setBusy(true); onBusyChange(true); setFailed(false);
    try {
      const result = await request("opencraft/agents/onboarding/import", { id: agentId, conversationIds: [...selected] });
      if (!live.current) return;
      setImported(previous => new Set([...previous, ...result.imported.map(entry => entry.id)]));
      setSelected(new Set(result.failed)); setFailed(result.failed.length > 0);
      if (result.imported.length) await onImported?.();
    } catch { if (live.current) setFailed(true); }
    finally { if (live.current) { setBusy(false); onBusyChange(false); } }
  };
  return <section className="agent-history" aria-busy={busy}>
    <h3>{intl.formatMessage({ id: "onboard.history.title", defaultMessage: "Bring your local conversations" })}</h3>
    <p>{intl.formatMessage({ id: "onboard.history.description", defaultMessage: "Choose conversations to import into myself. They will appear in your conversation list, ready to continue. You can also skip this step." })}</p>
    {query.isPending ? <p role="status">{intl.formatMessage({ id: "onboard.history.loading", defaultMessage: "Reading local conversations…" })}</p> : null}
    {query.isError ? <div role="status"><p>{intl.formatMessage({ id: "onboard.history.loadFailed", defaultMessage: "Couldn't read local conversations. Retry or continue without importing." })}</p><Button size="sm" variant="ghost" disabled={query.isFetching || busy} onClick={() => { void query.refetch(); }}>{intl.formatMessage({ id: "onboard.agent.retry", defaultMessage: "Retry" })}</Button></div> : null}
    {conversations.length ? <>
      <div className="agent-history__actions"><Button size="sm" variant="ghost" disabled={busy || available.length === 0} onClick={() => setSelected(new Set(available.slice(0, 100).map(entry => entry.id)))}>{intl.formatMessage({ id: "onboard.history.selectPage", defaultMessage: "Select up to 100" })}</Button>
        <Button size="sm" variant="ghost" disabled={busy || selected.size === 0} onClick={() => setSelected(new Set())}>{intl.formatMessage({ id: "onboard.history.clear", defaultMessage: "Clear selection" })}</Button></div>
      {conversations.some(entry => entry.nativeProject) ? <p>{intl.formatMessage({ id: "onboard.history.projects", defaultMessage: "Original project groups are preserved." })}</p> : null}
      <ul className="agent-history__list">{ordered.map((entry, index) => {
        const done = entry.imported || imported.has(entry.id);
        const heading = entry.nativeProject && entry.nativeProject.id !== ordered[index - 1]?.nativeProject?.id;
        return <Fragment key={entry.id}>{heading ? <li className="agent-history__project"><FolderIcon size={16} aria-hidden="true" /><span>{entry.nativeProject!.name}</span></li> : null}<li><Button variant="ghost" size="sm" contentLayout="row" role="checkbox" aria-checked={done || selected.has(entry.id)} disabled={busy || done || (!selected.has(entry.id) && selected.size >= 100)} onClick={() => setSelected(previous => { const next = new Set(previous); if (next.has(entry.id)) next.delete(entry.id); else next.add(entry.id); return next; })}>
          <CheckboxIcon size={18} checked={done || selected.has(entry.id)} aria-hidden="true" />
          <span className="agent-history__identity"><span>{entry.title || intl.formatMessage({ id: "onboard.history.untitled", defaultMessage: "Untitled conversation" })}</span><small>{entry.cwd}</small></span>
          {done ? <span>{intl.formatMessage({ id: "onboard.history.imported", defaultMessage: "Imported" })}</span> : null}
        </Button></li></Fragment>;
      })}</ul>
    </> : query.isSuccess ? <p>{intl.formatMessage({ id: "onboard.history.empty", defaultMessage: "No resumable local conversations found." })}</p> : null}
    {query.hasNextPage ? <Button size="sm" variant="ghost" disabled={query.isFetching || busy} onClick={() => { void query.fetchNextPage(); }}>{intl.formatMessage({ id: "onboard.history.more", defaultMessage: "Load more" })}</Button> : null}
    {failed ? <p role="alert">{intl.formatMessage({ id: "onboard.history.importFailed", defaultMessage: "Some conversations couldn't be imported. Your selection is kept so you can retry." })}</p> : null}
    {imported.size ? <p role="status">{intl.formatMessage({ id: "onboard.history.success", defaultMessage: "{count} conversations imported. Open them from the conversation list to continue." }, { count: imported.size })}</p> : null}
    <Button size="sm" variant="secondary" disabled={busy || selected.size === 0} onClick={() => { void run(); }}>{busy ? intl.formatMessage({ id: "onboard.history.importing", defaultMessage: "Importing…" }) : intl.formatMessage({ id: "onboard.history.import", defaultMessage: "Import selected ({count})" }, { count: selected.size })}</Button>
  </section>;
}
