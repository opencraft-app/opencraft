import type { AnnouncementCenter } from "@opencraft/extension-runtime";
import { useMemo, useSyncExternalStore } from "react";
import { AnnouncementDialogContent } from "./announcement-dialog";
import type { ModalRequest } from "./modal-controller";

/** Projects renderer-neutral announcement requests into the one Web ModalHost. */
export function useAnnouncementModalRequests(
  center: AnnouncementCenter,
): readonly ModalRequest[] {
  const snapshot = useSyncExternalStore(
    center.subscribe,
    center.getSnapshot,
    center.getSnapshot,
  );
  return useMemo(() => snapshot.announcements.map(({ contribution, key }) => ({
    id: `announcement:${key}`,
    label: contribution.title,
    size: "workspace" as const,
    className: "announcement-modal-surface",
    dismissOnOutsidePress: contribution.dismissOnOutsidePress ?? true,
    content: (
      <AnnouncementDialogContent
        announcement={contribution}
        onAction={(actionId) => center.choose(key, actionId)}
      />
    ),
    onDismiss: (reason) => center.dismiss(key, reason),
  })), [center, snapshot]);
}
