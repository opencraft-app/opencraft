import { CheckIcon as Check } from "@opencraft/design-system-web/action-icons";
import "./styles.scss";
import { useEffect, useMemo, useRef, useState } from "react";
import { useIntl } from "@opencraft/i18n/react";
import { MessageIcon as MessageSquare } from "@opencraft/design-system-web/action-icons";
import { ModalSurface } from "../../components/modal/modal-surface";
import { useShellPresentation } from "../../components/shell-presentation";
import { useAsyncNotices } from "../../components/async-notices-context";
import type { SidebarThread } from "../../components/sidebar";
import type { HostThreadCatalogState } from "../../runtime/thread-catalog-query";
import { conversationKey, orderConversations } from "./model";
import { ConversationPreview, useForeground } from "./preview";
import type { ConversationOverviewSource } from "./source";

export function ConversationOverview({ threads, sources, catalogs, loading, onClose, onSelect, onRetry, onRetryDiscovery, discovery }: {
  readonly threads: readonly SidebarThread[];
  readonly sources: readonly ConversationOverviewSource[];
  readonly catalogs: readonly HostThreadCatalogState[];
  readonly loading: boolean;
  readonly discovery: "loading" | "error" | null;
  readonly onClose: () => void;
  readonly onSelect: (hostId: string, threadId: string) => Promise<boolean>;
  readonly onRetry: (hostId: string) => Promise<void>;
  readonly onRetryDiscovery: () => Promise<void>;
}) {
  const intl = useIntl();
  const shell = useShellPresentation();
  const notices = useAsyncNotices();
  const foreground = useForeground();
  const [recent, setRecent] = useState(false);
  const [count, setCount] = useState(12);
  const [pending, setPending] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const ordered = useMemo(() => orderConversations(threads, recent), [threads, recent]);
  const title = intl.formatMessage({ id: "overview.title", defaultMessage: "Conversation overview" });
  const select = async (thread: SidebarThread) => {
    if (pending) return;
    setPending(conversationKey(thread));
    const reportFailure = () => notices.error({ key: `conversation-overview:${conversationKey(thread)}`,
      message: intl.formatMessage({ id: "overview.openError", defaultMessage: "Could not open this conversation. Try again." }) });
    try {
      const activated = await onSelect(thread.connectionHostId, thread.id);
      if (!mounted.current) return;
      if (!activated) { reportFailure(); return; }
      shell?.dismissSidebarAfterSelection(); onClose();
    } catch { if (mounted.current) reportFailure(); }
    finally { if (mounted.current) setPending(null); }
  };
  return <ModalSurface label={title} className="conversation-overview" size="wide" showCloseButton={false} onDismiss={onClose}>
    <header className="conversation-overview__header">
      <div><h2 className="ui-text--panel-title">{title}</h2><p className="ui-text--metadata">{intl.formatMessage({ id: "overview.count", defaultMessage: "{count} conversations" }, { count: threads.length })}</p></div>
      <button type="button" className="conversation-overview__done" onClick={onClose} aria-label={intl.formatMessage({ id: "overview.done", defaultMessage: "Done" })}><Check size={20} aria-hidden="true" /></button>
    </header>
    <div className="conversation-overview__toolbar ui-text--metadata">
      <div className="conversation-overview__sort" role="group" aria-label={intl.formatMessage({ id: "overview.order", defaultMessage: "Conversation order" })}>
        {[false, true].map(value => <button type="button" className="ui-text--control-small" key={String(value)} aria-pressed={recent === value} onClick={() => setRecent(value)}>{intl.formatMessage(value
          ? { id: "overview.recent", defaultMessage: "Most recent" }
          : { id: "overview.attention", defaultMessage: "Attention first" })}</button>)}
      </div>
    </div>
    <div className="conversation-overview__scroll">
      {(discovery === "error" || catalogs.some(catalog => catalog.phase !== "ready")) ? <div className="conversation-overview__notices ui-text--metadata" role="status">
        {discovery === "error" ? <button type="button" className="ui-text--control-small" onClick={() => { void onRetryDiscovery().catch(() => {}); }}>{intl.formatMessage({ id: "overview.discoveryRetry", defaultMessage: "Retry server discovery" })}</button> : null}
        {catalogs.filter(catalog => catalog.phase !== "ready").map(catalog => <div key={catalog.hostId}>
          {catalog.label} · {intl.formatMessage(catalog.phase === "loading" ? { id: "overview.catalogLoading", defaultMessage: "Loading conversations…" }
            : catalog.phase === "error" ? { id: "overview.catalogError", defaultMessage: "Conversation list could not be updated" }
            : { id: "overview.disconnected", defaultMessage: "Connect to view recent exchanges" })}
          {catalog.phase === "error" ? <button type="button" className="ui-text--control-small" onClick={() => { void onRetry(catalog.hostId).catch(() => {}); }}>{intl.formatMessage({ id: "sidebar.search.retry", defaultMessage: "Retry" })}</button> : null}
        </div>)}
      </div> : null}
      <div className="conversation-overview__grid" aria-busy={loading || undefined}>
        {ordered.slice(0, count).map(thread => {
          const status = thread.status === "review" || thread.schedule?.needsReview ? { id: "overview.review", defaultMessage: "Needs attention" }
            : thread.status === "error" ? { id: "overview.error", defaultMessage: "Failed" }
            : thread.unread ? { id: "overview.unread", defaultMessage: "Unread result" }
            : thread.status === "running" || thread.goalActive ? { id: "overview.running", defaultMessage: "In progress" }
            : { id: "overview.ready", defaultMessage: "Recent conversation" };
          return <article className="conversation-overview__card ui-text--body" key={conversationKey(thread)}
            data-conversation-key={conversationKey(thread)} data-status={thread.status} data-unread={thread.unread || undefined}
            aria-busy={pending === conversationKey(thread) || undefined}>
            <div className="conversation-overview__frame">
              <div className="conversation-overview__card-top ui-text--label"><MessageSquare size={13} aria-hidden="true" /><span>{thread.serverOrigin.label}</span><span className="conversation-overview__project">{thread.project}</span></div>
              <ConversationPreview thread={thread} source={sources.find(source => source.hostId === thread.connectionHostId)} foreground={foreground} />
            </div>
            <button type="button" className="conversation-overview__caption" aria-label={`${thread.title} · ${thread.serverOrigin.label}`}
              disabled={thread.interactionAvailable === false || pending !== null} onClick={() => { void select(thread); }}>
              <strong className="ui-text--thread-list-title">{thread.title}</strong><span className="conversation-overview__status ui-text--metadata"><span className="conversation-overview__status-dot" aria-hidden="true" />{intl.formatMessage(status)}</span>
            </button>
          </article>;
        })}
      </div>
      {!threads.length ? <p className="conversation-overview__empty ui-text--metadata" role="status">{intl.formatMessage(loading
        ? { id: "overview.catalogLoading", defaultMessage: "Loading conversations…" }
        : { id: "overview.noConversations", defaultMessage: "No conversations to display" })}</p> : null}
      {count < ordered.length ? <button type="button" className="conversation-overview__more ui-text--control-small" onClick={() => setCount(value => value + 12)}>{intl.formatMessage({ id: "sidebar.catalog.showMore", defaultMessage: "Show more" })}</button> : null}
    </div>
  </ModalSurface>;
}
