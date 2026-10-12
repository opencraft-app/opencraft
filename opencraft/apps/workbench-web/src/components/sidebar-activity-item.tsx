import type { ReactNode } from "react";
import { stableIdentityColor } from "@opencraft/design-system/identity-color";
import type { ServerRouteLocality, ThreadServerOrigin, WorkbenchThread } from "@opencraft/workbench-runtime";
import { useIntl } from "@opencraft/i18n/react";
import { Folder, Globe2 } from "lucide-react";

function ServerOriginBadge({
  origin,
  routeLocality,
}: {
  readonly origin: ThreadServerOrigin;
  readonly routeLocality: ServerRouteLocality;
}) {
  const intl = useIntl();
  const remote = routeLocality === "remote";
  const label = remote ? intl.formatMessage({
    id: "sidebar.serverOrigin",
    defaultMessage: "From {server}",
    description: "Accessible label for the remote Server that owns a sidebar task",
  }, { server: origin.label }) : undefined;
  return (
    <span
      className="sidebar-activity-item__server-origin"
      data-route-locality={routeLocality}
      role={remote ? "img" : undefined}
      aria-label={label}
      aria-hidden={remote ? undefined : true}
      title={label}
    >
      {remote ? <Globe2 size={14} strokeWidth={1.75} style={{ color: stableIdentityColor(origin.serverId) }} /> : null}
    </span>
  );
}

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
  badge = null,
  serverOrigin,
  serverRouteLocality,
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
  readonly badge?: ReactNode;
  readonly serverOrigin: ThreadServerOrigin;
  readonly serverRouteLocality: ServerRouteLocality;
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
    <div className="sidebar-activity-item-container" data-has-badge={badge ? "true" : undefined}><button
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
        </span>
      </span>
      <span className="sidebar-activity-item__trailing">
        <ServerOriginBadge origin={serverOrigin} routeLocality={serverRouteLocality} />
        <ThreadActivity pending={pending} status={status} unread={unread} />
      </span>
    </button>{badge ? <div className="sidebar-activity-item__badge-slot">{badge}</div> : null}</div>
  );
}
