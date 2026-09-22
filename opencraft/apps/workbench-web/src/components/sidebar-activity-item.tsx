import type { WorkbenchThread } from "@opencraft/workbench-runtime";
import { Folder } from "lucide-react";

function ThreadActivity({
  pending,
  status,
  unread,
}: {
  readonly pending: boolean;
  readonly status: WorkbenchThread["status"];
  readonly unread: boolean;
}) {
  const state = pending ? "pending" : status;
  const label = pending
    ? "Opening"
    : status === "running"
      ? "Running"
      : status === "review"
        ? "Ready for review"
        : status === "error"
          ? "Thread unavailable"
          : unread
            ? "Unread"
            : null;
  return (
    <span
      className={`sidebar-activity-item__status is-${state}${unread ? " is-unread" : ""}`}
      role={label === null ? undefined : "img"}
      aria-label={label ?? undefined}
      aria-hidden={label === null ? true : undefined}
    />
  );
}

export function SidebarActivityItem({
  active,
  host,
  onInvoke,
  pending,
  project,
  selected,
  status,
  title,
  tooltip,
  unread,
}: {
  readonly active: boolean;
  readonly host: string | null;
  readonly onInvoke: () => void;
  readonly pending: boolean;
  readonly project: string;
  readonly selected: boolean;
  readonly status: WorkbenchThread["status"];
  readonly title: string;
  readonly tooltip: string;
  readonly unread: boolean;
}) {
  return (
    <button
      type="button"
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
        <span className="sidebar-activity-item__title">{title}</span>
        <span className="sidebar-activity-item__metadata">
          <Folder size={12} aria-hidden="true" />
          <span>{project}</span>
          {host === null ? null : <><span aria-hidden="true">·</span><span>{host}</span></>}
        </span>
      </span>
      <span className="sidebar-activity-item__trailing">
        <ThreadActivity pending={pending} status={status} unread={unread} />
      </span>
    </button>
  );
}
