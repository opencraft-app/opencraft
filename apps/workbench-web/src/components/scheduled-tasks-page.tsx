import { ClockIcon, ArrowUpRightIcon, RefreshIcon as RefreshCw } from "@opencraft/design-system-web/action-icons";
import type { ConversationSchedulesRequestPort } from "@opencraft/appserver-protocol";
import { useEffect, useRef, useState } from "react";

import { useIntl } from "@opencraft/i18n/react";
import { SettingsButton, SettingsIconButton, SettingsPageHeader } from "@opencraft/extension-react";
import { useScheduledTaskCatalog } from "../runtime/scheduled-task-catalog-context";
import { ConversationSchedulesPanel } from "./conversation-schedules-panel";
import { useAsyncNotices } from "./async-notices";
import { scheduledTasksMessages as messages } from "./scheduled-tasks-messages";
import { projectScheduledTaskRows } from "../runtime/scheduled-task-rows";
import "../styles/scheduled-tasks-page.scss";
import { ScheduleCreateDialog } from "./schedule-create-dialog";
import { scheduleCreateMessages } from "./schedule-create-messages";

/** Host-owned catalog with conversation-backed creation and management. */
export function ScheduledTasksPage() {
  const catalog = useScheduledTaskCatalog();
  const intl = useIntl(), notices = useAsyncNotices();
  const [selected, select] = useState<{ hostId: string; threadId: string; scope: string; port: ConversationSchedulesRequestPort } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [creating, setCreating] = useState(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const text = (key: keyof typeof messages) => intl.formatMessage(messages[key]);
  const source = selected && catalog.scheduleCatalogs.find(host => host.hostId === selected.hostId && host.scope === selected.scope);
  const hosts = catalog.scheduleCatalogs.filter(host => host.phase !== "unsupported");
  const errors = hosts.filter(host => host.phase === "error").map(host => host.scope).join("|");
  const pending = refreshing || catalog.discovery === "loading";
  useEffect(() => {
    if (errors || catalog.discovery === "error") notices.error({ key: "schedule-catalog-read", message: intl.formatMessage(messages.loadError) });
  }, [errors, catalog.discovery, notices, intl]);
  const refresh = async () => {
    setRefreshing(true);
    try { await Promise.allSettled([catalog.retryDiscovery(), ...hosts.map(host => host.retry())]); }
    finally { setRefreshing(false); }
  };
  const openConversation = async (hostId: string, threadId: string) => {
    try { if (!await catalog.openConversation(hostId, threadId)) throw new Error("Navigation not committed"); }
    catch { notices.error({ key: "schedule-catalog-navigation", message: text("openError") }); }
  };
  return <section className="scheduled-tasks-page" aria-label={text("title")}>
    <div className="scheduled-tasks-page__header">
      <SettingsPageHeader title={text("title")} description={text("description")} />
      <SettingsButton variant="primary" disabled={!hosts.some(host => host.creation && host.port)} onClick={event => { returnFocus.current = event.currentTarget; setCreating(true); }}>{intl.formatMessage(scheduleCreateMessages.title)}</SettingsButton>
    </div>
    <div className="scheduled-tasks-page__groups">
      {hosts.map(host => {
        const rows = projectScheduledTaskRows([host], catalog.threads);
        const phase = host.phase === "offline" ? "disconnected" : host.phase === "loading" ? "loading" : host.phase === "error" ? "failed" : "connected";
        return <section className="scheduled-tasks-page__group" key={host.scope} aria-label={host.hostLabel}>
          <header className="scheduled-tasks-page__group-heading">
            <h3>{host.hostLabel}</h3>
            <div className="scheduled-tasks-page__group-actions">
              {host.phase !== "ready" ? <span className="scheduled-tasks-page__host-state" data-phase={host.phase} title={host.cached && (host.phase === "offline" || host.phase === "error") ? text("cached") : undefined}>{text(phase)}</span> : null}
              <SettingsIconButton label={text("refresh")} disabled={pending} aria-busy={pending} onClick={() => void refresh()}>
                <RefreshCw size={16} aria-hidden="true" className={pending ? "scheduled-tasks-page__refresh-pending" : undefined} />
              </SettingsIconButton>
            </div>
          </header>
          {rows.length ? <ul className="scheduled-tasks-page__list">{rows.map(row => {
            const status = row.needsReview ? "review" : row.status === "paused" ? "paused" : row.status === "active" ? "active" : "completed";
            return <li className="scheduled-tasks-page__row" key={row.threadId}>
              <header className="scheduled-tasks-page__card-heading">
                <ClockIcon size={18} aria-hidden="true" className="scheduled-tasks-page__clock" />
                <h4 className="scheduled-tasks-page__copy">
                  {host.port ? <button type="button" className="scheduled-tasks-page__destination"
                    aria-label={intl.formatMessage(messages.openNamed, { title: row.title })}
                    onClick={() => void openConversation(row.hostId, row.threadId)}>{row.title}</button>
                    : <span className="scheduled-tasks-page__title">{row.title}</span>}
                </h4>
                <span className="scheduled-tasks-page__task-state" data-state={status}>{text(status)}</span>
              </header>
              <div className="scheduled-tasks-page__metadata">
                {row.status === "active" && !row.needsReview
                  ? <p className="scheduled-tasks-page__next">{intl.formatMessage(messages.next, { time: intl.formatDate(row.nextRunAt, { dateStyle: "medium", timeStyle: "short" }) })}</p>
                  : null}
                <p>{text(row.needsReview ? "reviewHint" : row.status === "paused" ? "pausedHint" : row.status === "active" ? "activeHint" : "completedHint")}</p>
              </div>
              <footer className="scheduled-tasks-page__card-actions">
                <SettingsButton variant="quiet" disabled={!host.port}
                  aria-label={intl.formatMessage(messages.viewNamed, { title: row.title })}
                  onClick={() => void openConversation(row.hostId, row.threadId)}>{text("conversation")}<ArrowUpRightIcon size={14} aria-hidden="true" /></SettingsButton>
                <SettingsButton variant="secondary" disabled={!host.port}
                  aria-label={intl.formatMessage(messages.manageNamed, { title: row.title })}
                  onClick={event => { if (!host.port) return; returnFocus.current = event.currentTarget; select({ hostId: row.hostId, threadId: row.threadId, scope: host.scope, port: host.port }); }}>{text("manage")}</SettingsButton>
              </footer>
            </li>;
          })}</ul> : <p className="scheduled-tasks-page__empty" role="status">{text(host.phase === "ready" ? "empty" : host.phase === "offline" ? "offline" : host.phase === "error" ? "loadError" : "loading")}</p>}
        </section>;
      })}
      {hosts.length === 0 ? <div className="scheduled-tasks-page__group-heading">
        <p className="scheduled-tasks-page__empty" role="status">{text(catalog.discovery === "loading" ? "loading" : catalog.discovery === "error" ? "loadError" : "unsupported")}</p>
        <SettingsIconButton className="scheduled-tasks-page__group-actions" label={text("refresh")} disabled={pending} aria-busy={pending} onClick={() => void refresh()}>
          <RefreshCw size={16} aria-hidden="true" className={pending ? "scheduled-tasks-page__refresh-pending" : undefined} />
        </SettingsIconButton>
      </div> : null}
    </div>
    {creating ? <ScheduleCreateDialog hosts={hosts} onClose={() => setCreating(false)} returnFocus={() => returnFocus.current} onCreated={() => { void refresh(); }} /> : null}
    {selected && source ? <ConversationSchedulesPanel key={`${selected.scope}:${selected.threadId}`} hostId={selected.hostId} threadId={selected.threadId} scope={selected.scope}
      onClose={() => select(null)} returnFocus={() => returnFocus.current} port={selected.port} /> : null}
  </section>;
}
