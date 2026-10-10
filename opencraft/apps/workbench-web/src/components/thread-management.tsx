import * as ContextMenu from "@radix-ui/react-context-menu";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { LoaderCircle, MoreHorizontal } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  SettingsActions,
  SettingsButton,
  SettingsGroup,
  SettingsListItem,
  SettingsNotice,
  SettingsPageHeader,
  SettingsPanel,
  SettingsSection,
  SettingsTextInput,
} from "@opencraft/extension-react";
import { ConfirmationModalSurface } from "./modal/confirmation-modal-surface";
import { ModalSurface } from "./modal";
import { useWorkbenchPresentationRoot } from "./workbench-presentation-root";
import type { SidebarThreadMenuKind } from "./sidebar-thread-menu-state";
import "../styles/context-menu.scss";

export interface ThreadActionTarget { readonly hostId: string; readonly threadId: string; readonly title: string; readonly pinned?: boolean }
export interface ThreadActionCapabilities { readonly rename: boolean; readonly archive: boolean; readonly fork: boolean; readonly delete: boolean; readonly pin?: boolean }
export interface ThreadActionCallbacks {
  readonly onRename: (target: ThreadActionTarget, title: string) => Promise<void>;
  readonly onFork: (target: ThreadActionTarget) => Promise<void>;
  readonly onArchive: (target: ThreadActionTarget) => Promise<void>;
  readonly onDelete: (target: ThreadActionTarget) => Promise<void>;
  readonly onSetPinned?: (target: ThreadActionTarget, pinned: boolean) => Promise<void>;
}

export function ThreadRowMenu({ target, capabilities, children, openMenuKind, onOpenMenuChange, onRename, onFork, onArchive, onDelete, onSetPinned }: ThreadActionCallbacks & {
  target: ThreadActionTarget; capabilities: ThreadActionCapabilities; children: ReactNode;
  openMenuKind: SidebarThreadMenuKind | null;
  onOpenMenuChange: (kind: SidebarThreadMenuKind, open: boolean) => void;
}) {
  const portalContainer = useWorkbenchPresentationRoot();
  const [renaming, setRenaming] = useState(false), [draft, setDraft] = useState(""), [busy, setBusy] = useState(false), [forking, setForking] = useState(false), [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ThreadActionTarget | null>(null);
  const modalHandoff = useRef(false);
  const mounted = useRef(true), formId = useId();
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const run = async (operation: () => Promise<void>, action: "fork" | "other" = "other") => {
    setBusy(true); setForking(action === "fork"); setError(null);
    try { await operation(); if (mounted.current) setRenaming(false); }
    catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : String(error)); }
    finally { if (mounted.current) { setBusy(false); setForking(false); } }
  };
  // Shared item model for both the right-click context menu and the row
  // "..." dropdown, mirroring the actions(entry).map pattern in bot-management.
  const menuItems = [
    capabilities.pin && onSetPinned ? { key: "pin", label: target.pinned ? "取消置顶" : "置顶", onSelect: () => { void run(() => onSetPinned(target, target.pinned !== true)); } } : null,
    capabilities.rename ? { key: "rename", label: "重命名", onSelect: () => { modalHandoff.current = true; setDraft(target.title); setError(null); setRenaming(true); } } : null,
    capabilities.fork ? { key: "fork", label: "新建分支", onSelect: () => { void run(() => onFork(target), "fork"); } } : null,
    capabilities.archive ? { key: "archive", label: "归档", onSelect: () => { void run(() => onArchive(target)); } } : null,
    capabilities.delete ? { key: "delete", label: "删除", onSelect: () => { modalHandoff.current = true; setError(null); setDeleting(target); } } : null,
  ].filter((item): item is NonNullable<typeof item> => item !== null);
  if (menuItems.length === 0) return children;
  const onMenuCloseAutoFocus = (event: Event) => {
    if (!modalHandoff.current) return;
    event.preventDefault();
    modalHandoff.current = false;
  };
  return <>
    <div className="sidebar-activity-row">
      {/* Keep the dropdown outside this trigger: portal pointer events still bubble through the React tree. */}
      <ContextMenu.Root open={openMenuKind === "context"} onOpenChange={open => onOpenMenuChange("context", open)}>
        <ContextMenu.Trigger asChild>
          <div className="sidebar-activity-row__target">{children}</div>
        </ContextMenu.Trigger>
        <ContextMenu.Portal container={portalContainer}><ContextMenu.Content className="workbench-context-menu" onCloseAutoFocus={onMenuCloseAutoFocus}>
          {menuItems.map(({ key, label, onSelect }) => <ContextMenu.Item key={key} disabled={busy} onSelect={onSelect}>{label}</ContextMenu.Item>)}
        </ContextMenu.Content></ContextMenu.Portal>
      </ContextMenu.Root>
      <DropdownMenu.Root open={openMenuKind === "dropdown"} onOpenChange={open => onOpenMenuChange("dropdown", open)}>
        <DropdownMenu.Trigger asChild>
          <button type="button" className="sidebar-activity-item__menu-trigger" aria-label={forking ? `${target.title} 正在新建分支` : `${target.title} 的操作`} aria-busy={forking || undefined} data-forking={forking || undefined} disabled={busy}>
            {forking ? <LoaderCircle size={14} aria-hidden="true" /> : <MoreHorizontal size={14} aria-hidden="true" />}
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal container={portalContainer}>
          <DropdownMenu.Content className="workbench-context-menu" align="end" sideOffset={4} onCloseAutoFocus={onMenuCloseAutoFocus}>
            {menuItems.map(({ key, label, onSelect }) => <DropdownMenu.Item key={key} disabled={busy} onSelect={onSelect}>{label}</DropdownMenu.Item>)}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
    {renaming ? <ModalSurface portalContainer={portalContainer} label="重命名会话" size="compact" appearance="utility" onDismiss={() => setRenaming(false)}>
      <SettingsPanel title="重命名会话" footer={<><SettingsButton onClick={() => setRenaming(false)}>取消</SettingsButton><SettingsButton form={formId} type="submit" variant="primary" disabled={busy || !draft.trim()}>{busy ? "保存中…" : "保存"}</SettingsButton></>}>
        <form id={formId} onSubmit={event => { event.preventDefault(); void run(() => onRename(target, draft.trim())); }}>
          <SettingsTextInput autoFocus aria-label="会话名称" aria-describedby={error ? `${formId}-error` : undefined} aria-invalid={error ? true : undefined}
            maxLength={60} value={draft} disabled={busy} onChange={event => setDraft(event.target.value)} />
          {error ? <p id={`${formId}-error`} className="settings-control-notice" role="alert">{error}</p> : null}
        </form>
      </SettingsPanel>
    </ModalSurface> : deleting ? <ConfirmationModalSurface
      portalContainer={portalContainer}
      label="删除会话"
      size="compact"
      confirmation={{ confirmLabel: "删除", onConfirm: () => { void run(async () => { await onDelete(deleting); setDeleting(null); }); } }}
      onDismiss={() => setDeleting(null)}
    ><section className="thread-delete-confirmation"><h2>删除“{deleting.title}”？</h2><p>删除后该会话将被永久移除，且无法恢复。</p></section></ConfirmationModalSurface> : error ? <p className="settings-control-notice" role="alert">{error}</p> : null}
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
  const [restoreError, setRestoreError] = useState<{ threadId: string; message: string } | null>(null);
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
          error={restoreError?.threadId === thread.id ? restoreError.message : undefined}
          actions={<SettingsButton
            disabled={busy !== null}
            aria-busy={busy === thread.id}
            onClick={() => {
              setBusy(thread.id);
              setRestoreError(null);
              void restore(hostId, thread.id)
                .catch(error => {
                  if (mounted.current) setRestoreError({
                    threadId: thread.id,
                    message: error instanceof Error ? error.message : String(error),
                  });
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
