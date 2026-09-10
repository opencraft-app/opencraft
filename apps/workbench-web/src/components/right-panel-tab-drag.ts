export const RIGHT_PANEL_TAB_DROP_TAIL_ID = "right-panel-tab-strip:tail";

export function reorderPanelTabPreview(
  ids: readonly string[],
  activeId: string,
  overId: string,
): readonly string[] {
  const fromIndex = ids.indexOf(activeId);
  if (fromIndex === -1) return ids;
  const overIndex =
    overId === RIGHT_PANEL_TAB_DROP_TAIL_ID
      ? ids.length - 1
      : ids.indexOf(overId);
  if (overIndex === -1 || overIndex === fromIndex) return ids;

  const next = [...ids];
  const [moving] = next.splice(fromIndex, 1);
  if (moving === undefined) return ids;
  next.splice(overIndex, 0, moving);
  return next;
}

/** Converts a preview order into the panel model's one final move command. */
export function resolvePanelTabCommit(
  committedIds: readonly string[],
  previewIds: readonly string[],
  activeId: string,
): { readonly tabId: string; readonly beforeTabId: string | null } | null {
  if (
    committedIds.length !== previewIds.length ||
    committedIds.every((id, index) => id === previewIds[index])
  )
    return null;
  if (!committedIds.includes(activeId)) return null;
  const previewIndex = previewIds.indexOf(activeId);
  if (previewIndex === -1) return null;
  return {
    tabId: activeId,
    beforeTabId: previewIds[previewIndex + 1] ?? null,
  };
}
