import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useIntl } from "@opencraft/i18n/react";
import type { SidebarThread } from "../../components/sidebar";
import type { ConversationOverviewSource } from "./source";
import { MiniChat } from "./mini-chat";

export function useForeground() {
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}

export function ConversationPreview({ thread, source, foreground }: {
  readonly thread: SidebarThread;
  readonly source: ConversationOverviewSource | undefined;
  readonly foreground: boolean;
}) {
  const intl = useIntl();
  const root = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!root.current) return;
    const observer = new IntersectionObserver(entries => setVisible(entries.some(entry => entry.isIntersecting)), { rootMargin: "120px" });
    observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  const active = visible && foreground && !!source?.available && source.supported;
  const queryClient = useQueryClient();
  const queryKey = ["conversation-overview", source?.key, thread.connectionHostId, thread.id];
  const scope = JSON.stringify(queryKey);
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => source!.read(thread.id, signal),
    enabled: active, staleTime: 15_000, gcTime: 0, retry: false,
    refetchInterval: active && (thread.status === "running" || thread.goalActive) ? 4_000 : false,
    refetchOnWindowFocus: true,
  });
  useEffect(() => {
    if (!active) void queryClient.cancelQueries({ queryKey, exact: true });
  }, [active, scope, queryClient]);
  const version = `${thread.updatedAt}:${thread.status}:${thread.unread}`;
  const previousVersion = useRef(version);
  useEffect(() => {
    if (!active) return;
    const changed = previousVersion.current !== version;
    previousVersion.current = version;
    if (changed) void query.refetch({ cancelRefetch: false });
  }, [version, active, query.refetch]);
  // Detaching the last observer aborts queued reads and drops this private cache.
  // Invisible cards never mount an execution lease or mark a Thread as read.
  return <div className={`conversation-overview__preview${query.isError ? " conversation-overview__preview--error" : ""}`} ref={root} aria-busy={query.isFetching || undefined}>
    {query.data?.length ? <MiniChat turns={query.data} emptyLabel={intl.formatMessage({ id: "overview.noText", defaultMessage: "No text in this exchange" })} /> : <div className="conversation-overview__placeholder ui-text--metadata">
      {intl.formatMessage(!source?.available ? { id: "overview.disconnected", defaultMessage: "Connect to view recent exchanges" }
        : !source.supported ? { id: "overview.unsupported", defaultMessage: "Preview unavailable on this server" }
        : query.isError ? { id: "overview.previewError", defaultMessage: "Could not load the preview" }
        : query.isPending ? { id: "overview.loading", defaultMessage: "Loading recent exchanges…" }
        : { id: "overview.emptyPreview", defaultMessage: "No exchanges yet" })}
    </div>}
    {query.isError && active ? <button type="button" className="conversation-overview__preview-retry ui-text--metadata" onClick={() => { void query.refetch(); }}>
      {intl.formatMessage({ id: "sidebar.search.retry", defaultMessage: "Retry" })}
    </button> : null}
  </div>;
}
