import type { ReactNode } from "react";
import type { WorkbenchThread } from "@opencraft/workbench-runtime";
import { FormattedMessage, useIntl } from "@opencraft/i18n/react";
import { ClockIcon as Clock, TargetIcon as Target, LoadingRingIcon } from "@opencraft/design-system-web/action-icons";

function ThreadActivity({
  id,
  pending,
  status,
  unread,
  goalActive,
}: {
  readonly id?: string;
  readonly pending: boolean;
  readonly status: WorkbenchThread["status"];
  readonly unread: boolean;
  readonly goalActive: boolean;
}) {
  const intl = useIntl();
  if (!pending && goalActive && (status === "ready" || status === "running")) {
    const goalLabel = intl.formatMessage({ id: "sidebar.status.goal", defaultMessage: "Pursuing goal" });
    return <span id={id} className="sidebar-activity-item__status is-goal" role="img" aria-label={goalLabel} title={goalLabel}><Target size={15} aria-hidden="true" /></span>;
  }
  const state = pending ? "pending" : status;
  const label = pending
    ? "Opening"
    : status === "running"
      ? "Running"
      : status === "review"
        ? "Ready for review"
        : status === "error"
          ? "Thread unavailable"
          : unread ? "Unread" : null;
  return (
    <span
      id={id}
      className={`sidebar-activity-item__status is-${state}${unread ? " is-unread" : ""}`}
      role={label === null ? undefined : "img"}
      aria-label={label ?? undefined}
      aria-hidden={label === null ? true : undefined}
    >{state === "running" || state === "pending" ? <LoadingRingIcon size={14} /> : null}</span>
  );
}

export function SidebarActivityItem({
  activityId,
  active,
  disabled = false,
  twoLine = false,
  badge = null,
  resources = null,
  badgePlacement = "trailing",
  goalActive = false,
  onInvoke,
  pending,
  project,
  selected,
  schedule,
  status,
  title,
  tooltip,
  unread,
}: {
  readonly activityId?: string;
  readonly schedule?: import("@opencraft/appserver-protocol").ConversationScheduleSummary;
  readonly active: boolean;
  readonly disabled?: boolean;
  readonly twoLine?: boolean;
  readonly badge?: ReactNode;
  readonly resources?: ReactNode;
  readonly badgePlacement?: "trailing" | "metadata" | "title";
  readonly goalActive?: boolean;
  readonly onInvoke: () => void;
  readonly pending: boolean;
  readonly project: string;
  readonly selected: boolean;
  readonly status: WorkbenchThread["status"];
  readonly title: string;
  readonly tooltip: string;
  readonly unread: boolean;
}) {
  const intl = useIntl();
  const metadataBadge = Boolean(badge) && badgePlacement === "metadata";
  const stateLabel = twoLine ? <span className="sidebar-activity-item__state-label">{status === "running" ? <FormattedMessage id="sidebar.status.running" defaultMessage="Running" /> : status === "review" ? <FormattedMessage id="sidebar.status.review" defaultMessage="Ready for review" /> : status === "error" ? <FormattedMessage id="sidebar.status.error" defaultMessage="Conversation error" /> : <FormattedMessage id="sidebar.status.unread" defaultMessage="New reply" />}</span> : null;
  const titleOnly = badgePlacement === "title";
  const scheduleLabel = !schedule ? null : schedule.needsReview
    ? intl.formatMessage({ id: "sidebar.schedule.review", defaultMessage: "Scheduled task: needs checking" })
    : schedule.status === "paused"
      ? intl.formatMessage({ id: "sidebar.schedule.paused", defaultMessage: "Scheduled task: paused" })
      : intl.formatMessage({ id: "sidebar.schedule.next", defaultMessage: "Scheduled task: next run {time}" }, { time: intl.formatDate(schedule.nextRunAt, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) });
  return (
    <div className="sidebar-activity-item-container" data-has-badge={badge ? "true" : undefined} data-badge-placement={titleOnly ? "title" : metadataBadge ? "metadata" : undefined} data-row-lines={!titleOnly && (metadataBadge || twoLine || project) ? "two" : "one"}><button
      type="button"
      disabled={disabled}
      className={[
        "sidebar-activity-item",
        selected ? "is-selected" : "",
        active ? "is-active" : "",
        pending ? "is-pending" : "",
      ].filter(Boolean).join(" ")}
      onClick={onInvoke}
      aria-current={selected ? "page" : undefined}
      aria-busy={pending || undefined}
      title={tooltip}
    >
      <span className="sidebar-activity-item__body">
        <span className="sidebar-activity-item__title-line"><span className="sidebar-activity-item__title">{title}</span>
          {scheduleLabel ? <span className="sidebar-activity-item__schedule" role="img" aria-label={scheduleLabel} title={scheduleLabel}><Clock size={16} aria-hidden="true" /></span> : null}</span>
        {!titleOnly && !metadataBadge && (twoLine || project) ? <span className="sidebar-activity-item__metadata">
          {stateLabel}
          {twoLine && project ? <span aria-hidden="true">·</span> : null}
          {project ? <span className="sidebar-activity-item__project">{project}</span> : null}
        </span> : null}
      </span>
      <span className="sidebar-activity-item__trailing">
        <ThreadActivity id={activityId} pending={pending} status={status} unread={unread} goalActive={goalActive} />
      </span>
    </button>{resources ? <div className="sidebar-activity-item__resources-slot">{resources}</div> : null}{badge ? <div className="sidebar-activity-item__badge-slot" data-placement={badgePlacement}>{badge}{metadataBadge ? stateLabel : null}</div> : null}</div>
  );
}
