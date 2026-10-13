import type { ReactNode } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { stableIdentityColor } from "@opencraft/design-system/identity-color";
import type { ServerRouteLocality, ThreadServerOrigin, WorkbenchThread } from "@opencraft/workbench-runtime";
import { useIntl } from "@opencraft/i18n/react";
import { Folder, Globe2 } from "lucide-react";
import { useWorkbenchPresentationRoot } from "./workbench-presentation-root";

function ServerOriginBadge({
  origin,
  routeLocality,
}: {
  readonly origin: ThreadServerOrigin;
  readonly routeLocality: ServerRouteLocality;
}) {
  const intl = useIntl();
  const portalContainer = useWorkbenchPresentationRoot();
  const remote = routeLocality === "remote";
  const label = remote ? intl.formatMessage({
    id: "sidebar.serverOrigin",
    defaultMessage: "From {server}",
    description: "Accessible label for the remote Server that owns a sidebar task",
  }, { server: origin.label }) : undefined;
  const badge = (
    <span
      className="sidebar-activity-item__server-origin"
      data-route-locality={routeLocality}
      role={remote ? "img" : undefined}
      aria-label={label}
      aria-hidden={remote ? undefined : true}
      title=""
      tabIndex={remote ? 0 : undefined}
    >
      {remote ? <Globe2 size={14} strokeWidth={1.75} style={{ color: stableIdentityColor(origin.serverId) }} /> : null}
    </span>
  );
  if (!remote) return badge;
  return (
    <Tooltip.Provider delayDuration={250}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>{badge}</Tooltip.Trigger>
        <Tooltip.Portal container={portalContainer ?? undefined}>
          <Tooltip.Content className="sidebar-server-origin-tooltip" side="top" align="center" sideOffset={8} collisionPadding={8}>
            {label}
            <Tooltip.Arrow className="sidebar-server-origin-tooltip__arrow" width={8} height={4} />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
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
