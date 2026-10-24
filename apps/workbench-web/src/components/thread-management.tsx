import type { PointerEventHandler } from "react";
import { LoadingRingIcon as LoaderCircle, MoreIcon as MoreHorizontal, EditIcon as Pencil, DeleteIcon as Trash2 } from "@opencraft/design-system-web/action-icons";
import { useAsyncNotices } from "./async-notices";
import { useIntl } from "@opencraft/i18n/react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import * as DropdownMenu from "@opencraft/design-system-web/dropdown-menu";
import { ArchiveIcon as Archive, ForkIcon as GitFork, PinIcon as Pin, PinOffIcon as PinOff } from "@opencraft/design-system-web/action-icons";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { LinkIcon as Link2 } from "@opencraft/design-system-web/action-icons";
import { useQuery } from "@tanstack/react-query";
import {
  SettingsActions,
  SettingsButton,
  SettingsGroup,
  SettingsListItem,
  SettingsNotice,
  SettingsPageHeader,
  SettingsSection,
} from "@opencraft/extension-react";
import { ConfirmationModalSurface } from "./modal/confirmation-modal-surface";
import { ConversationRenameDialog } from "./conversation-rename-dialog";
import { useWorkbenchPresentationRoot } from "./workbench-presentation-root";
import type { SidebarThreadMenuKind } from "./sidebar-thread-menu-state";
import "../styles/context-menu.scss";

export interface ThreadActionTarget { readonly hostId: string; readonly threadId: string; readonly title: string; readonly pinned?: boolean }
export interface ThreadActionCapabilities { readonly rename: boolean; readonly archive: boolean; readonly fork: boolean; readonly delete: boolean; readonly pin?: boolean; readonly reference?: boolean }
export interface ThreadActionCallbacks {
  readonly onCopyReference?: (target: ThreadActionTarget) => Promise<void>;
  readonly onRename: (target: ThreadActionTarget, title: string) => Promise<void>;
  readonly onFork: (target: ThreadActionTarget) => Promise<void>;
  readonly onArchive: (target: ThreadActionTarget) => Promise<void>;
  readonly onDelete: (target: ThreadActionTarget) => Promise<void>;
  readonly onSetPinned?: (target: ThreadActionTarget, pinned: boolean) => Promise<void>;
}

export interface ThreadRowActivity { readonly busy: boolean; readonly forking: boolean }
export type ThreadActionModal =
  | { readonly kind: "rename"; readonly target: ThreadActionTarget; readonly draft: string }
  | { readonly kind: "delete"; readonly target: ThreadActionTarget };

/**
 * Owner of per-thread action state: the rename/delete dialogs and the busy, forking and
 * feedback. Async failures use the shared notification owner. Rows remount whenever the list regroups a thread (task-flow sections move
 * a conversation as soon as its status changes), so this state lives with the list, keyed
 * by thread, instead of inside the row menu.
 */
export interface ThreadActionOwner {
  readonly callbacks: ThreadActionCallbacks;
  readonly modal: ThreadActionModal | null;
  activity(target: Pick<ThreadActionTarget, "hostId" | "threadId">): ThreadRowActivity;
  beginRename(target: ThreadActionTarget): void;
  beginDelete(target: ThreadActionTarget): void;
  setDraft(draft: string): void;
  dismiss(): void;
  run(target: ThreadActionTarget, operation: () => Promise<void>, action?: "fork" | "archive" | "pin" | "delete" | "copy" | "other"): Promise<void>;
}

export const threadActionKey = (target: Pick<ThreadActionTarget, "hostId" | "threadId">) => `${target.hostId}:${target.threadId}`;
const idleActivity: ThreadRowActivity = { busy: false, forking: false };

export function useThreadActionOwner(callbacks: ThreadActionCallbacks): ThreadActionOwner {
  const notices = useAsyncNotices();
  const intl = useIntl();
  const [activity, setActivity] = useState<ReadonlyMap<string, ThreadRowActivity>>(() => new Map());
  const [modal, setModal] = useState<ThreadActionModal | null>(null);
  const mounted = useRef(true);
  const inFlight = useRef(new Set<string>());
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const patch = (key: string, update: Partial<ThreadRowActivity>) => setActivity(current => {
    const next = new Map(current), merged = { ...(current.get(key) ?? idleActivity), ...update };
    if (!merged.busy && !merged.forking) next.delete(key); else next.set(key, merged);
    return next;
  });
  const run = async (target: ThreadActionTarget, operation: () => Promise<void>, action: "fork" | "archive" | "pin" | "delete" | "copy" | "other" = "other") => {
    const key = threadActionKey(target);
    if (inFlight.current.has(key)) return;
    inFlight.current.add(key);
    patch(key, { busy: true, forking: action === "fork" });
    if (action === "archive") notices.loading({ key: `thread-action:${key}`, detail: target.title,
      message: intl.formatMessage({ id: "chat.archive.pending", defaultMessage: "Archiving conversation…" }) });
    if (action === "pin") notices.loading({ key: `thread-action:${key}`, detail: target.title,
      message: intl.formatMessage({ id: "sidebar.thread.saving", defaultMessage: "Saving…" }) });
    if (action === "delete" || action === "copy") notices.loading({ key: `thread-action:${key}`, detail: target.title,
      message: intl.formatMessage(action === "delete" ? { id: "chat.delete.pending", defaultMessage: "Deleting conversation…" } : { id: "conversation.reference.copying", defaultMessage: "Preparing conversation reference…" }) });
    try { await operation();
      if (action === "pin" && mounted.current) notices.dismiss(`thread-action:${key}`);
      if (action === "archive" && mounted.current) notices.success({ key: `thread-action:${key}`, detail: target.title,
        message: intl.formatMessage({ id: "chat.archive.done", defaultMessage: "Conversation archived" }) });
      if ((action === "delete" || action === "copy") && mounted.current) notices.success({ key: `thread-action:${key}`, detail: target.title,
        message: intl.formatMessage(action === "delete" ? { id: "chat.delete.done", defaultMessage: "Conversation deleted" } : { id: "common.copied", defaultMessage: "Copied" }) });
      if (mounted.current) setModal(current => current && threadActionKey(current.target) === key ? null : current); }
    catch {
      if (mounted.current) notices.error({ key: `thread-action:${key}`, detail: target.title,
        message: intl.formatMessage({ id: "tasks.relation.saveError", defaultMessage: "Could not confirm the change. Review the current selection and retry." }) });
    }
    finally { inFlight.current.delete(key); if (!mounted.current && ["archive", "delete", "pin", "copy"].includes(action)) notices.dismiss(`thread-action:${key}`); if (mounted.current) patch(key, { busy: false, forking: false }); }
  };
  return useMemo<ThreadActionOwner>(() => ({
    callbacks, modal, run,
    activity: target => activity.get(threadActionKey(target)) ?? idleActivity,
    beginRename: target => { setModal({ kind: "rename", target, draft: target.title }); },
    beginDelete: target => { setModal({ kind: "delete", target }); },
    setDraft: draft => setModal(current => current?.kind === "rename" ? { ...current, draft } : current),
    dismiss: () => setModal(null),
  }), [callbacks, activity, modal, notices, intl]);
}

export function ThreadActionModals({ owner }: { owner: ThreadActionOwner }) {
  const intl = useIntl();
  const portalContainer = useWorkbenchPresentationRoot();
  const modal = owner.modal;
  if (modal === null) return null;
  const { busy } = owner.activity(modal.target);
  if (modal.kind === "rename") return <ConversationRenameDialog value={modal.draft} pending={busy}
    onChange={owner.setDraft} onDismiss={owner.dismiss}
    onSubmit={title => { void owner.run(modal.target, () => owner.callbacks.onRename(modal.target, title)); }} />;
  return <ConfirmationModalSurface
    portalContainer={portalContainer}
    label={intl.formatMessage({ id: "sidebar.thread.deleteTitle", defaultMessage: "Delete conversation" })}
    size="compact"
    confirmation={{ confirmLabel: intl.formatMessage({ id: "sidebar.thread.delete", defaultMessage: "Delete" }), onConfirm: () => { void owner.run(modal.target, () => owner.callbacks.onDelete(modal.target), "delete"); } }}
    onDismiss={owner.dismiss}
  ><section className="thread-delete-confirmation"><h2>{intl.formatMessage({ id: "sidebar.thread.deleteQuestion", defaultMessage: "Delete “{title}”?" }, { title: modal.target.title })}</h2><p>{intl.formatMessage({ id: "sidebar.thread.deleteDescription", defaultMessage: "This conversation will be permanently removed and cannot be recovered." })}</p></section></ConfirmationModalSurface>;
}

export function ThreadRowMenu({ activityLabelId, target, capabilities, disabled = false, children, contextMenuExtra, openMenuKind, onOpenMenuChange, onCloseAutoFocus, onPointerDown, owner }: {
  activityLabelId?: string;
  target: ThreadActionTarget; capabilities: ThreadActionCapabilities; children: ReactNode;
  disabled?: boolean;
  contextMenuExtra?: ReactNode;
  openMenuKind: SidebarThreadMenuKind | null;
  onOpenMenuChange: (kind: SidebarThreadMenuKind, open: boolean) => void;
  onCloseAutoFocus?: (event: Event) => void;
  onPointerDown?: PointerEventHandler<HTMLElement>;
  owner: ThreadActionOwner;
}) {
  const portalContainer = useWorkbenchPresentationRoot();
  const intl = useIntl();
  const { onFork, onArchive, onSetPinned } = owner.callbacks;
  const { busy, forking } = owner.activity(target);
  const modalHandoff = useRef(false);
  const [touchContext, setTouchContext] = useState(false);
  const run = (operation: () => Promise<void>, action: "fork" | "archive" | "pin" | "delete" | "copy" | "other" = "other") => { void owner.run(target, operation, action); };
  // Shared item model for both the right-click context menu and the row
  // "..." dropdown, mirroring the actions(entry).map pattern in bot-management.
  const menuItems = [
    capabilities.reference && owner.callbacks.onCopyReference ? {key:"reference",icon:Link2,label:intl.formatMessage({id:"conversation.reference.copy",defaultMessage:"Copy conversation reference"}),onSelect:()=>{run(()=>owner.callbacks.onCopyReference!(target), "copy");}} : null,
    capabilities.pin && onSetPinned ? { key: "pin", icon: target.pinned ? PinOff : Pin, label: intl.formatMessage(target.pinned ? { id: "sidebar.thread.unpin", defaultMessage: "Unpin" } : { id: "sidebar.thread.pin", defaultMessage: "Pin" }), onSelect: () => { run(() => onSetPinned(target, target.pinned !== true), "pin"); } } : null,
    capabilities.rename ? { key: "rename", icon: Pencil, label: intl.formatMessage({ id: "sidebar.thread.rename", defaultMessage: "Rename" }), onSelect: () => { modalHandoff.current = true; owner.beginRename(target); } } : null,
    capabilities.fork ? { key: "fork", icon: GitFork, label: intl.formatMessage({ id: "sidebar.thread.fork", defaultMessage: "Create branch" }), onSelect: () => { run(() => onFork(target), "fork"); } } : null,
    capabilities.archive ? { key: "archive", icon: Archive, label: intl.formatMessage({ id: "sidebar.thread.archive", defaultMessage: "Archive" }), onSelect: () => { run(() => onArchive(target), "archive"); } } : null,
    capabilities.delete ? { key: "delete", icon: Trash2, label: intl.formatMessage({ id: "sidebar.thread.delete", defaultMessage: "Delete" }), onSelect: () => { modalHandoff.current = true; owner.beginDelete(target); } } : null,
  ].filter((item): item is NonNullable<typeof item> => item !== null);
  // Keep the navigation subtree mounted when a runtime loses capabilities.
  const hasMenu = menuItems.length > 0 || !!contextMenuExtra;
  const onMenuCloseAutoFocus = (event: Event) => {
    onCloseAutoFocus?.(event);
    if (!modalHandoff.current) return;
    event.preventDefault();
    modalHandoff.current = false;
  };
  return <>
    <div className="sidebar-activity-row" data-has-menu={hasMenu ? "true" : "false"}>
      {/* Keep the dropdown outside this trigger: portal pointer events still bubble through the React tree. */}
      <ContextMenu.Root modal={touchContext} open={!disabled && hasMenu && openMenuKind === "context"} onOpenChange={open => onOpenMenuChange("context", open)}>
        <ContextMenu.Trigger asChild disabled={disabled || !hasMenu} onPointerDown={event => {
          setTouchContext(event.pointerType === "touch");
          onPointerDown?.(event);
        }}
          onClickCapture={event => {
            // Touch release retains its original target even after a context menu opens.
            if (openMenuKind === "context" && "pointerType" in event.nativeEvent && event.nativeEvent.pointerType === "touch") {
              event.preventDefault(); event.stopPropagation();
            }
          }}>
          <div className="sidebar-activity-row__target">{children}</div>
        </ContextMenu.Trigger>
        <ContextMenu.Portal container={portalContainer}><ContextMenu.Content className="workbench-context-menu" onCloseAutoFocus={onMenuCloseAutoFocus}>
          {menuItems.map(({ key, icon: Icon, label, onSelect }) => <ContextMenu.Item key={key} disabled={busy || disabled} onSelect={onSelect}><Icon size={16} aria-hidden="true" />{label}</ContextMenu.Item>)}
          {contextMenuExtra ? <><ContextMenu.Separator />{contextMenuExtra}</> : null}
        </ContextMenu.Content></ContextMenu.Portal>
      </ContextMenu.Root>
      <DropdownMenu.Root modal={false} open={!disabled && hasMenu && openMenuKind === "dropdown"} onOpenChange={open => onOpenMenuChange("dropdown", open)}>
        {hasMenu ? <DropdownMenu.Trigger asChild>
          <button type="button" className="sidebar-activity-item__menu-trigger" aria-describedby={activityLabelId} aria-label={intl.formatMessage(forking ? { id: "sidebar.thread.forking", defaultMessage: "Creating branch for {title}" } : { id: "sidebar.thread.actions", defaultMessage: "Actions for {title}" }, { title: target.title })} aria-busy={forking || undefined} data-forking={forking || undefined} disabled={busy || disabled}>
            {forking ? <LoaderCircle size={14} aria-hidden="true" /> : <MoreHorizontal className="sidebar-activity-item__menu-dots" size={14} aria-hidden="true" />}
          </button>
        </DropdownMenu.Trigger> : null}
        <DropdownMenu.Portal container={portalContainer}>
          <DropdownMenu.Content className="workbench-context-menu" align="end" sideOffset={4} onCloseAutoFocus={onMenuCloseAutoFocus}>
            {menuItems.map(({ key, icon: Icon, label, onSelect }) => <DropdownMenu.Item key={key} disabled={busy || disabled} onSelect={onSelect}><Icon size={16} aria-hidden="true" />{label}</DropdownMenu.Item>)}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  </>;
}

export interface ArchivedThreadsSettingsProps {
  hostId: string;
  load(hostId: string): Promise<ReadonlyArray<{ id: string; name?: string | null; preview?: string }>>;
  restore(hostId: string, threadId: string): Promise<void>;
}

export function ArchivedThreadsSettings({ hostId, load, restore }: ArchivedThreadsSettingsProps) {
  const query = useQuery({ queryKey: ["appserver", hostId, "threads", "archived", "management"], queryFn: () => load(hostId) });
  const [busy, setBusy] = useState<string | null>(null);
  const notices = useAsyncNotices();
  const intl = useIntl();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const empty = !query.isPending && query.error == null && query.data?.length === 0;
  return <>
    <SettingsPageHeader
      title="Archived conversations"
      description="Review conversations removed from the main sidebar and restore them when needed."
    />
    <SettingsSection title="Archive" description="Restoring a conversation returns it to its original execution host.">
      {query.isPending ? <SettingsNotice role="status">Loading archived conversations…</SettingsNotice> : null}
      {query.error ? <SettingsNotice role="alert" tone="error">{query.error.message}</SettingsNotice> : null}
      {empty ? <div className="settings-empty-state">No archived conversations.</div> : null}
      {query.data?.length ? <SettingsGroup aria-label="Archived conversations">
        {query.data.map(thread => <SettingsListItem
          key={thread.id}
          label={thread.name ?? thread.preview ?? "New chat"}
          description={thread.name != null && thread.preview && thread.preview !== thread.name ? thread.preview : undefined}
          actions={<SettingsButton
            disabled={busy !== null}
            aria-busy={busy === thread.id}
            onClick={() => {
              setBusy(thread.id);
              void restore(hostId, thread.id)
                .catch(() => {
                  if (mounted.current) notices.error({ key: `restore:${hostId}:${thread.id}`, detail: thread.name ?? thread.preview,
                    message: intl.formatMessage({ id: "tasks.relation.saveError", defaultMessage: "Could not confirm the change. Review the current selection and retry." }) });
                })
                .finally(() => { if (mounted.current) setBusy(null); });
            }}
          >{busy === thread.id ? "Restoring…" : "Restore"}</SettingsButton>}
        />)}
      </SettingsGroup> : null}
      {empty || query.error ? <SettingsActions>
        <SettingsButton type="button" onClick={() => { void query.refetch(); }}>Refresh</SettingsButton>
      </SettingsActions> : null}
    </SettingsSection>
  </>;
}
