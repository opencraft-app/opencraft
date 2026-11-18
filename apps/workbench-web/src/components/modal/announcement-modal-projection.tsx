import { useIntl } from "@opencraft/i18n/react";
import type { AnnouncementCenter } from "@opencraft/extension-runtime";
import { useMemo, useSyncExternalStore } from "react";
import { AnnouncementDialogContent } from "./announcement-dialog";
import type { ModalRequest } from "./modal-controller";

/** Projects renderer-neutral announcement requests into the one Web ModalHost. */
export function useAnnouncementModalRequests(
  center: AnnouncementCenter,
): readonly ModalRequest[] {
  const intl = useIntl();
  const snapshot = useSyncExternalStore(
    center.subscribe,
    center.getSnapshot,
    center.getSnapshot,
  );
  return useMemo(() => snapshot.announcements.map(({ contribution, key }) => ({
    id: `announcement:${key}`,
    label: contribution.titleMessage ? intl.formatMessage(contribution.titleMessage) : contribution.title,
    size: "workspace" as const,
    anchorNavigationId: contribution.anchorNavigationId,
    // Clear material must sample the page before dimming. This surface paints
    // its own exterior-only scrim; ModalSurface still owns all interaction.
    dimBackground: contribution.preview ? false : undefined,
    className: contribution.preview ? "announcement-modal-surface announcement-experience-surface" : "announcement-modal-surface",
    dismissOnOutsidePress: contribution.dismissOnOutsidePress ?? true,
    content: (
      <AnnouncementDialogContent
        announcement={contribution}
        onAction={(actionId) => center.choose(key, actionId)}
      />
    ),
    onDismiss: (reason) => center.dismiss(key, reason),
  })), [center, snapshot, intl]);
}
