import { useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { defineMessages } from "@opencraft/i18n";
import { useIntl } from "@opencraft/i18n/react";
import { ChevronDownIcon, CheckIcon, FilesActivityIcon, TextFileIcon, CodeFileIcon, TerminalIcon, AgentActivityIcon, TargetIcon, OrderedListIcon, InfoIcon } from "@opencraft/design-system-web/action-icons";
import type { ConversationSummaryProps } from "@opencraft/workbench-panels-react";
import { deriveThreadSummary } from "./model";
import { presentSummaryFiles } from "./file-presentation";
import "./styles.scss";

const messages = defineMessages({
  goal: { id: "threadSummary.goal", defaultMessage: "Goal" },
  plan: { id: "threadSummary.plan", defaultMessage: "Plan" },
  files: { id: "threadSummary.files", defaultMessage: "Changed files" },
  background: { id: "threadSummary.background", defaultMessage: "Background processes" },
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
  const filePresentation = useMemo(() => presentSummaryFiles(model.files.map(file => file.path)), [model.files]);
  const background = model.activities.filter(activity => activity.threadId === null);
  const agents = model.activities.filter(activity => activity.threadId !== null);
  const t = (key: keyof typeof messages) => intl.formatMessage(messages[key]);
  useLayoutEffect(() => { if (scroll.current) scroll.current.scrollTop = viewState.scrollTop; }, [context.scopeKey]);
  const section = (id: string, title: string, count: ReactNode, content: ReactNode) => {
    const Icon = id === "goal" ? TargetIcon : id === "plan" ? OrderedListIcon : id === "files" ? FilesActivityIcon : id === "background" ? TerminalIcon : AgentActivityIcon;
    return <section className="thread-summary__section" key={id}>
    <button type="button" className={`thread-summary__section-heading${id === "background" || id === "activity" ? " thread-summary__section-heading--quiet" : ""}`} aria-expanded={!viewState.collapsed.has(id)}
      onClick={() => { const collapsed = new Set(viewState.collapsed); if (!collapsed.delete(id)) collapsed.add(id); onViewStateChange({ ...viewState, collapsed }); }}>
      {id !== "background" && id !== "activity" ? <Icon size={18} aria-hidden="true" /> : null}<span>{title}</span>
      {count !== null ? <span className="thread-summary__count">{count}</span> : null}
      <ChevronDownIcon size={14} aria-hidden="true" className={`thread-summary__disclosure${viewState.collapsed.has(id) ? " is-collapsed" : ""}`} />
    </button>
    {!viewState.collapsed.has(id) ? <div className="thread-summary__rows">{content}</div> : null}
  </section>; };
  const status = (value: string) => ({
    pending: t("waiting"), running: t("working"), complete: t("complete"),
    failed: t("failed"), interrupted: t("stopped"), unknown: t("recent"),
  })[value];
  const hasContent = context.goal || model.steps.length || model.files.length || model.activities.length;
  return <div ref={scroll} className="thread-summary__scroll" onScroll={event => onViewStateChange({ ...viewState, scrollTop: event.currentTarget.scrollTop })}>
    {context.goal ? <p className="thread-summary__goal" aria-label={t("goal")}><TargetIcon size={16} aria-hidden="true" /><span>{context.goal.objective}</span></p> : null}
    {model.steps.length ? section("plan", t("plan"), `${model.steps.filter(step => step.status === "complete").length}/${model.steps.length}`,
      <ol className="thread-summary__list">{model.steps.map(step => <li className="thread-summary__row" key={step.id} data-step-status={step.status}>
        <span className="thread-summary__step" aria-label={step.status === "complete" ? t("complete") : step.status === "in-progress" ? t("working") : t("waiting")}>
          {step.status === "complete" ? <CheckIcon size={14} aria-hidden="true" /> : <span className="thread-summary__step-dot" />}
        </span><span>{step.text}</span>
      </li>)}</ol>) : null}
    {model.files.length ? section("files", t("files"), model.files.length, <>
      {filePresentation.root ? <div className="thread-summary__root" title={filePresentation.root}><FilesActivityIcon size={14} aria-hidden="true" /><span dir="auto">{filePresentation.rootLabel}</span></div> : null}
      <ul className="thread-summary__list">{model.files.map((file, index) => {
        const display = filePresentation.files[index]!;
        const FileIcon = /\.(?:[cm]?[jt]sx?|json|css|scss|html|py|rs|go|sh|ya?ml)$/iu.test(display.name) ? CodeFileIcon : TextFileIcon;
        return <li key={file.path}><button type="button" className="thread-summary__row thread-summary__link thread-summary__file" title={file.path} data-file-kind={file.kind}
        disabled={!context.current || file.kind === "delete"} onClick={() => context.onOpenResource(file.path)}>
        <FileIcon size={16} aria-hidden="true" /><span className="thread-summary__filename"><span className="thread-summary__file-label" dir="auto"><span>{display.stem}</span><span className="thread-summary__extension">{display.extension}</span></span>{display.directory ? <small dir="auto">{display.directory}</small> : null}</span>
        {file.kind !== "unknown" ? <span className="thread-summary__file-kind" aria-label={file.kind === "add" ? t("added") : file.kind === "delete" ? t("deleted") : t("modified")}><span aria-hidden="true">{file.kind === "add" ? "A" : file.kind === "delete" ? "D" : "M"}</span></span> : null}
      </button></li>; })}</ul></>) : null}
    {[{ id: "background", label: t("background"), entries: background }, { id: "activity", label: t("activity"), entries: agents }].map(group => group.entries.length ? section(group.id, group.label, group.entries.length,
      <ul className="thread-summary__list">{group.entries.map(activity => <li key={activity.id}>
        {activity.threadId ? <button type="button" className="thread-summary__row thread-summary__link" disabled={!context.current} onClick={() => context.onOpenThread(activity.threadId!)}>
          <AgentActivityIcon size={16} aria-hidden="true" /><span>{activity.label}<small>{status(activity.status)}</small></span>
        </button> : <div className="thread-summary__row"><TerminalIcon size={16} aria-hidden="true" /><span className="thread-summary__command" title={activity.label}>{activity.label}<small>{status(activity.status)}</small></span></div>}
      </li>)}</ul>) : null)}
    {!hasContent ? <div className="thread-summary__empty"><InfoIcon size={20} aria-hidden="true" /><div><span>{t("emptyTitle")}</span><p>{t("empty")}</p></div></div> : null}
    {hasContent ? <p className="thread-summary__footnote">{t("history")}</p> : null}
  </div>;
}
