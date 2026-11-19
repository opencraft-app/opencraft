import { useIntl } from "@opencraft/i18n/react";
import { LoadingRingIcon } from "@opencraft/design-system-web/action-icons";
import type { SidebarActivitySummary as ActivitySummary } from "../sidebar-activity";

/** A read-only projection in the existing disclosure row, never a second badge owner. */
export function SidebarActivitySummary({ id, counts }: { readonly id: string; readonly counts: ActivitySummary }) {
  const intl = useIntl();
  const entries = [
    {
      kind: "unread",
      count: counts.unread,
      marker: "is-ready is-unread",
      label: intl.formatMessage(
        { id: "sidebar.summary.unread", defaultMessage: "Unread conversations: {count}" },
        { count: counts.unread },
      ),
    },
    {
      kind: "attention",
      count: counts.attention,
      marker: "is-review",
      label: intl.formatMessage(
        { id: "sidebar.summary.attention", defaultMessage: "Needs attention: {count}" },
        { count: counts.attention },
      ),
    },
    {
      kind: "running",
      count: counts.running,
      marker: "is-running",
      label: intl.formatMessage(
        { id: "sidebar.summary.running", defaultMessage: "In progress: {count}" },
        { count: counts.running },
      ),
    },
  ].filter((entry) => entry.count > 0);
  if (!entries.length) return null;
  const label = entries.map((entry) => entry.label).join(" · ");
  return (
    <span id={id} className="sidebar-activity-summary" role="img" aria-label={label} title={label}>
      {entries.map((entry) => (
        <span
          key={entry.kind}
          className="sidebar-activity-summary__count"
          data-activity-kind={entry.kind}
          aria-hidden="true"
        >
          <span className="sidebar-activity-summary__marker">
            <span className={`sidebar-activity-item__status ${entry.marker}`}>
              {entry.kind === "running" ? <LoadingRingIcon size={14} /> : null}
            </span>
          </span>
          <span>{intl.formatNumber(entry.count)}</span>
        </span>
      ))}
    </span>
  );
}
