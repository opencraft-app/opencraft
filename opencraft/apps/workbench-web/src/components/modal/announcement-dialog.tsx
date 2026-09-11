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
          {announcement.secondaryAction.label}
        </Button>
      )}
      {announcement.primaryAction === undefined ? null : (
        <Button
          size="md"
          variant="primary"
          onClick={() => onAction(announcement.primaryAction!.id)}
        >
          {announcement.primaryAction.label}
        </Button>
      )}
    </div>
  );

  return (
    <article className="announcement-dialog">
      <header className="announcement-dialog__header">
        <h2>{announcement.title}</h2>
        {announcement.body === undefined ? null : <p>{announcement.body}</p>}
        {actions}
      </header>
      {announcement.media === undefined ? null : (
        <div className="announcement-dialog__media">
          <img alt={announcement.media.alt} src={announcement.media.url} />
        </div>
      )}
    </article>
  );
}
