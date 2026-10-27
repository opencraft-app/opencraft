import { useEffect, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { BellIcon as Bell, AlertIcon as CircleAlert, CheckedCircleIcon as CircleCheck, InfoIcon as Info, WarningIcon as TriangleAlert } from "@opencraft/design-system-web/action-icons";
import { useIntl } from "@opencraft/i18n/react";
import { useAsyncNotices, useNoticeHistory } from "./async-notices";
import { useWorkbenchPresentationRoot } from "./workbench-presentation-root";
import "./notification-center.scss";

const icons = { info: Info, success: CircleCheck, warning: TriangleAlert, error: CircleAlert };

export function NotificationCenter() {
  const intl = useIntl();
  const portal = useWorkbenchPresentationRoot();
  const notices = useAsyncNotices();
  const { records, markRead, clear } = useNoticeHistory();
  const [open, setOpen] = useState(false);
  const unread = records.filter(record => !record.read).length;
  useEffect(() => { if (open && unread > 0) markRead(); }, [open, unread, markRead]);
  const title = intl.formatMessage({ id: "notices.title", defaultMessage: "Notifications" });
  return <Popover.Root open={open} onOpenChange={next => {
    setOpen(next);
    if (next) { markRead(); notices.dismissAll(); }
  }}>
    <Popover.Trigger asChild>
      <button type="button" className="chrome-button notice-center-trigger" aria-label={title}>
        <Bell size={18} aria-hidden="true" />
        {unread > 0 ? <span className="notice-center-badge">{Math.min(unread, 50)}</span> : null}
      </button>
    </Popover.Trigger>
    <Popover.Portal container={portal}>
      <Popover.Content className="notice-center" align="end" sideOffset={8} collisionPadding={12} aria-label={title}>
        <header><h2>{title}</h2>{records.length > 0 ? <button type="button" onClick={() => { clear(); notices.dismissAll(); }}>
          {intl.formatMessage({ id: "notices.clear", defaultMessage: "Clear history" })}
        </button> : null}</header>
        <p className="notice-center-scope">{intl.formatMessage({ id: "notices.scope", defaultMessage: "This page session · Up to 50 recent notifications" })}</p>
        {records.length === 0 ? <p className="notice-center-empty">{intl.formatMessage({ id: "notices.empty", defaultMessage: "No notifications yet" })}</p> :
          <ul>{records.map(record => {
            const Icon = icons[record.tone];
            return <li key={record.key} data-tone={record.tone}>
              <Icon size={18} aria-hidden="true" />
              <div><p>{record.message}</p>{record.detail ? <p className="notice-center-detail">{record.detail}</p> : null}
                <time dateTime={new Date(record.receivedAt).toISOString()}>{intl.formatTime(record.receivedAt, { hour: "2-digit", minute: "2-digit" })}</time>
                {record.occurrences > 1 ? <span className="notice-center-occurrences"> ×{record.occurrences}</span> : null}
              </div>
            </li>;
          })}</ul>}
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}
