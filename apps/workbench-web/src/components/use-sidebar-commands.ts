import { useMemo, type ComponentProps } from "react";
import { useStableEvent } from "@opencraft/react-runtime";
import type { Sidebar } from "./sidebar";
import type { ThreadActionCallbacks } from "./thread-management";

type SidebarCommands = Required<Pick<ComponentProps<typeof Sidebar>,
  "onSelectThread" | "onNewTask" | "onOpenSettings" | "onRetryThreadCatalog" | "onRetryThreadCatalogDiscovery" | "threadActions">>;

/** Commands use the latest committed route without invalidating catalog paint.
 * Render-time readers (titles/capabilities) keep explicit revision dependencies. */
export function useSidebarCommands(commands: SidebarCommands): SidebarCommands {
  const onSelectThread = useStableEvent(commands.onSelectThread);
  const onNewTask = useStableEvent(commands.onNewTask);
  const onOpenSettings = useStableEvent(commands.onOpenSettings);
  const onRetryThreadCatalog = useStableEvent(commands.onRetryThreadCatalog);
  const onRetryThreadCatalogDiscovery = useStableEvent(commands.onRetryThreadCatalogDiscovery);
  const onRename = useStableEvent(commands.threadActions.onRename);
  const onFork = useStableEvent(commands.threadActions.onFork);
  const onArchive = useStableEvent(commands.threadActions.onArchive);
  const onDelete = useStableEvent(commands.threadActions.onDelete);
  const onSetPinned = useStableEvent<NonNullable<ThreadActionCallbacks["onSetPinned"]>>(
    async (...args) => { await commands.threadActions.onSetPinned?.(...args); },
  );
  const onCopyReference = useStableEvent<NonNullable<ThreadActionCallbacks["onCopyReference"]>>(async target => {await commands.threadActions.onCopyReference?.(target);});
  const canReference = commands.threadActions.onCopyReference !== undefined;
  const canPin = commands.threadActions.onSetPinned !== undefined;
  const threadActions = useMemo(() => ({ onRename, onFork, onArchive, onDelete,
    ...(canPin ? { onSetPinned } : {}), ...(canReference ? {onCopyReference} : {}),
  }), [onRename, onFork, onArchive, onDelete, onSetPinned, canPin, onCopyReference, canReference]);
  return { onSelectThread, onNewTask, onOpenSettings, onRetryThreadCatalog, onRetryThreadCatalogDiscovery, threadActions };
}
