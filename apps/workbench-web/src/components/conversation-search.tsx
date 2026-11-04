import { useCallback, useEffect } from "react";
import { createDeferredView } from "@opencraft/extension-react";
import { useIntl } from "@opencraft/i18n/react";
import { ModalSurface } from "./modal/modal-surface";
import "./conversation-search.scss";
import type { SidebarThread } from "./sidebar";
import type { ConversationSearchSource } from "../runtime/conversation-content-search";
import { canHandleWorkbenchShortcut } from "../workbench-shortcuts";
import { conversationSearchShortcut } from "./conversation-search-shortcut";

const NO_SOURCES: readonly ConversationSearchSource[] = [];
const ConversationSearchContent = createDeferredView(async () =>
  (await import("./conversation-search-dialog")).ConversationSearchDialogContent);

export interface ConversationSearchTarget { readonly turnId: string | null; readonly itemId: string | null; readonly requestId: string }

export function ConversationSearch({ enabled, open, onOpenChange, threads, loading, incomplete = false, sources = NO_SOURCES, onSelectThread }: {
  enabled: boolean;
  open: boolean;
  onOpenChange(open: boolean): void;
  threads: readonly SidebarThread[];
  loading: boolean;
  incomplete?: boolean;
  sources?: readonly ConversationSearchSource[];
  onSelectThread(hostId: string, threadId: string, target?: ConversationSearchTarget): void;
}) {
  useEffect(() => {
    if (!enabled) return;
    const keydown = (event: KeyboardEvent) => {
      if (!canHandleWorkbenchShortcut(event, ".conversation-search") || !conversationSearchShortcut(event, navigator.platform)) return;
      // Leave another modal's keyboard ownership intact. Our own input can use
      // the same command again without closing or losing its search draft.
      const dialog = (event.target as Element | null)?.closest?.('[role="dialog"], [role="alertdialog"]');
      if (dialog && !dialog.classList.contains("conversation-search")) return;
      event.preventDefault();
      onOpenChange(true);
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [enabled, onOpenChange]);
  const intl = useIntl();
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  return enabled && open ? <ModalSurface
    label={intl.formatMessage({ id: "sidebar.search", defaultMessage: "Search conversations" })}
    appearance="utility" size="wide" className="conversation-search" onDismiss={close}>
    <ConversationSearchContent threads={threads} loading={loading} incomplete={incomplete} sources={sources}
      onClose={close} onSelectThread={onSelectThread} />
  </ModalSurface> : null;
}
