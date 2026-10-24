import { useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { defineMessages } from "@opencraft/i18n";
import { useIntl } from "@opencraft/i18n/react";
import { AddIcon, MinusIcon, ChevronDownIcon, CheckIcon, FilesActivityIcon, TerminalIcon, AgentActivityIcon, TargetIcon } from "@opencraft/design-system-web/action-icons";
import type { ConversationSummaryProps } from "@opencraft/workbench-panels-react";
import { deriveThreadSummary } from "./model";
import "./styles.scss";

const messages = defineMessages({
  goal: { id: "threadSummary.goal", defaultMessage: "Goal" },
  plan: { id: "threadSummary.plan", defaultMessage: "Plan" },
  files: { id: "threadSummary.files", defaultMessage: "Changed files" },
  activity: { id: "threadSummary.activity", defaultMessage: "Activity" },
  waiting: { id: "threadSummary.waiting", defaultMessage: "Waiting" },
  working: { id: "threadSummary.working", defaultMessage: "Working" },
  complete: { id: "threadSummary.complete", defaultMessage: "Complete" },
  failed: { id: "threadSummary.failed", defaultMessage: "Failed" },
  stopped: { id: "threadSummary.stopped", defaultMessage: "Stopped" },
  recent: { id: "threadSummary.recent", defaultMessage: "Recent activity" },
  added: { id: "threadSummary.added", defaultMessage: "Added" },
  deleted: { id: "threadSummary.deleted", defaultMessage: "Deleted" },
  modified: { id: "threadSummary.modified", defaultMessage: "Modified" },
  emptyTitle: { id: "threadSummary.emptyTitle", defaultMessage: "The task at a glance" },
  empty: { id: "threadSummary.empty", defaultMessage: "Plans, changed files and activity will appear here as work progresses." },
  history: { id: "threadSummary.history", defaultMessage: "From loaded conversation history" },
});

export default function ThreadSummaryContent({ context, viewState, onViewStateChange }: ConversationSummaryProps) {
  const intl = useIntl();
  const scroll = useRef<HTMLDivElement>(null);
  const model = useMemo(() => deriveThreadSummary(context.timeline), [context.timeline]);
  const t = (key: keyof typeof messages) => intl.formatMessage(messages[key]);
  useLayoutEffect(() => { if (scroll.current) scroll.current.scrollTop = viewState.scrollTop; }, [context.scopeKey]);
  const section = (id: string, title: string, count: ReactNode, content: ReactNode) => <section className="thread-summary__section" key={id}>
    <button type="button" className="thread-summary__section-heading" aria-expanded={!viewState.collapsed.has(id)}
      onClick={() => { const collapsed = new Set(viewState.collapsed); if (!collapsed.delete(id)) collapsed.add(id); onViewStateChange({ ...viewState, collapsed }); }}>
      <span>{title}</span><span className="thread-summary__count">{count}</span>
      <ChevronDownIcon size={14} aria-hidden="true" className={viewState.collapsed.has(id) ? "is-collapsed" : undefined} />
    </button>
    {!viewState.collapsed.has(id) ? <div className="thread-summary__rows">{content}</div> : null}
  </section>;
  const status = (value: string) => ({
    pending: t("waiting"), running: t("working"), complete: t("complete"),
    failed: t("failed"), interrupted: t("stopped"), unknown: t("recent"),
  })[value];
  const hasContent = context.goal || model.steps.length || model.files.length || model.activities.length;
  return <div ref={scroll} className="thread-summary__scroll" onScroll={event => onViewStateChange({ ...viewState, scrollTop: event.currentTarget.scrollTop })}>
    {context.goal ? section("goal", t("goal"), null, <div className="thread-summary__row"><TargetIcon size={16} aria-hidden="true" /><p>{context.goal.objective}</p></div>) : null}
    {model.steps.length ? section("plan", t("plan"), `${model.steps.filter(step => step.status === "complete").length}/${model.steps.length}`,
      <ol className="thread-summary__list">{model.steps.map(step => <li className="thread-summary__row" key={step.id} data-step-status={step.status}>
        <span className="thread-summary__step" aria-label={step.status === "complete" ? t("complete") : step.status === "in-progress" ? t("working") : t("waiting")}>
          {step.status === "complete" ? <CheckIcon size={14} aria-hidden="true" /> : <span className="thread-summary__step-dot" />}
        </span><span>{step.text}</span>
      </li>)}</ol>) : null}
    {model.files.length ? section("files", t("files"), model.files.length,
      <ul className="thread-summary__list">{model.files.map(file => <li key={file.path}><button type="button" className="thread-summary__row thread-summary__link" title={file.path}
        disabled={!context.current || file.kind === "delete"} onClick={() => context.onOpenResource(file.path)}>
        <FilesActivityIcon size={16} aria-hidden="true" /><span className="thread-summary__filename">{file.path.split(/[\\/]/u).at(-1)}<small>{file.path}</small></span>
        <span className="thread-summary__file-kind" aria-label={file.kind === "add" ? t("added") : file.kind === "delete" ? t("deleted") : t("modified")}>{file.kind === "add" ? <AddIcon size={14} /> : file.kind === "delete" ? <MinusIcon size={14} /> : null}</span>
      </button></li>)}</ul>) : null}
    {model.activities.length ? section("activity", t("activity"), model.activities.length,
      <ul className="thread-summary__list">{model.activities.map(activity => <li key={activity.id}>
        {activity.threadId ? <button type="button" className="thread-summary__row thread-summary__link" disabled={!context.current} onClick={() => context.onOpenThread(activity.threadId!)}>
          <AgentActivityIcon size={16} aria-hidden="true" /><span>{activity.label}<small>{status(activity.status)}</small></span>
        </button> : <div className="thread-summary__row"><TerminalIcon size={16} aria-hidden="true" /><span className="thread-summary__command" title={activity.label}>{activity.label}<small>{status(activity.status)}</small></span></div>}
      </li>)}</ul>) : null}
    {!hasContent ? <div className="thread-summary__empty"><span>{t("emptyTitle")}</span><p>{t("empty")}</p></div> : null}
    {hasContent ? <p className="thread-summary__footnote">{t("history")}</p> : null}
  </div>;
}
