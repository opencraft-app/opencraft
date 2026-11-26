import { useEffect, useMemo } from "react";
import { composerDocumentToMessageText } from "@opencraft/composer-core";
import {
  draftSubmissionOwnsNavigation,
  type ConversationScopeRegistry,
  type ConversationScopeRegistrySnapshot,
} from "@opencraft/workbench-runtime";

type SidebarDraftRow = { draftId: string; hostId: string; preview: string; threadId?: string };

export function useSidebarDraftRows(
  scopes: ConversationScopeRegistry,
  snapshot: ConversationScopeRegistrySnapshot,
  threads: readonly { connectionHostId: string; id: string }[],
  scope: { hostId: string; selected: string },
): readonly SidebarDraftRow[] {
  const known = useMemo(() => new Set(threads.map((row) => JSON.stringify([row.connectionHostId, row.id]))), [threads]);
  useEffect(() => {
    for (const preview of snapshot.promotedPreviews) {
      if (known.has(JSON.stringify([preview.hostId, preview.threadId])))
        scopes.forgetPromotedPreview(preview.hostId, preview.threadId);
    }
  }, [scopes, snapshot.promotedPreviews, known]);

  return useMemo(() => {
    const visible = (hostId: string, spaceId: string, threadId?: string) =>
      hostId === scope.hostId &&
      spaceId === scope.selected &&
      (threadId === undefined || !known.has(JSON.stringify([hostId, threadId])));
    const submitting = snapshot.drafts.flatMap((draft) => {
      const { hostId, collaborationSpaceId } = draft.target.execution;
      if (
        !draft.submission ||
        !draftSubmissionOwnsNavigation(draft.phase) ||
        !visible(hostId, collaborationSpaceId ?? "myself", draft.receipt?.threadId)
      )
        return [];
      return [
        {
          draftId: draft.id,
          hostId,
          preview: composerDocumentToMessageText(draft.submission.document).trim().slice(0, 120),
        },
      ];
    });
    return [
      ...submitting,
      ...snapshot.promotedPreviews.filter((row) => visible(row.hostId, row.spaceId, row.threadId)),
    ];
  }, [scope.hostId, scope.selected, snapshot, known]);
}
