import { lazy } from "react";

// ModalHost suspends the complete surface until content and its styles are ready.
const AnnouncementExperience = lazy(() => import("./announcement-experience").then(module => ({ default: module.AnnouncementExperience })));
import { useIntl } from "@opencraft/i18n/react";
import type { AnnouncementContribution } from "@opencraft/extension-contract";
import { Button } from "../ui/button";

export interface AnnouncementDialogContentProps {
  readonly announcement: AnnouncementContribution;
  readonly onAction: (actionId: string) => void;
}

/**
 * Reusable announcement content recipe. ModalSurface remains the sole owner of
 * the window, close affordance, focus, portal and z-axis.
 */
export function AnnouncementDialogContent({
  announcement,
  onAction,
}: AnnouncementDialogContentProps) {
  const intl = useIntl();
  const actions = (
    <div
      className="announcement-dialog__actions"
      data-layout={announcement.actionLayout ?? "inline"}
    >
      {announcement.secondaryAction === undefined ? null : (
        <Button
          size="md"
          variant="ghost"
          onClick={() => onAction(announcement.secondaryAction!.id)}
        >
          {announcement.secondaryAction.labelMessage ? intl.formatMessage(announcement.secondaryAction.labelMessage) : announcement.secondaryAction.label}
        </Button>
      )}
      {announcement.primaryAction === undefined ? null : (
        <Button
          size="md"
          variant="primary"
          onClick={() => onAction(announcement.primaryAction!.id)}
        >
          {announcement.primaryAction.labelMessage ? intl.formatMessage(announcement.primaryAction.labelMessage) : announcement.primaryAction.label}
        </Button>
      )}
    </div>
  );

  if (announcement.preview) return <AnnouncementExperience announcement={announcement} onAction={onAction}/>;
  return (
    <article className="announcement-dialog" data-compact={!!announcement.anchorNavigationId}>
      <header className="announcement-dialog__header">
        <h2>{announcement.titleMessage ? intl.formatMessage(announcement.titleMessage) : announcement.title}</h2>
        {announcement.body === undefined ? null : <p>{announcement.bodyMessage ? intl.formatMessage(announcement.bodyMessage) : announcement.body}</p>}
        {announcement.anchorNavigationId ? null : actions}
      </header>
      {announcement.media === undefined ? null : (
        <div className="announcement-dialog__media">
          <img alt={announcement.media.alt} src={announcement.media.url} />
        </div>
      )}
      {announcement.anchorNavigationId ? actions : null}
    </article>
  );
}
