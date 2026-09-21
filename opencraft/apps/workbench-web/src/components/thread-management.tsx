import * as ContextMenu from "@radix-ui/react-context-menu";
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
import { ModalSurface } from "./modal";
import { useWorkbenchPresentationRoot } from "./workbench-presentation-root";
import "../styles/context-menu.scss";

export interface ThreadActionTarget { readonly hostId: string; readonly threadId: string; readonly title: string }
export interface ThreadActionCapabilities { readonly rename: boolean; readonly archive: boolean; readonly fork: boolean }
export interface ThreadActionCallbacks {
  readonly onRename: (target: ThreadActionTarget, title: string) => Promise<void>;
  readonly onFork: (target: ThreadActionTarget) => Promise<void>;
  readonly onArchive: (target: ThreadActionTarget) => Promise<void>;
}

export interface ThreadHostActionCallbacks {
  readonly label: string;
  readonly onNewTask?: (hostId: string) => Promise<unknown>;
  readonly onOpenSettings?: (hostId: string) => void;
}

export function ThreadRowMenu({ target, capabilities, children, hostActions, onRename, onFork, onArchive }: ThreadActionCallbacks & {
  target: ThreadActionTarget; capabilities: ThreadActionCapabilities; children: ReactNode;
  hostActions?: ThreadHostActionCallbacks;
}) {
  const portalContainer = useWorkbenchPresentationRoot();
  const [renaming, setRenaming] = useState(false), [draft, setDraft] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const mounted = useRef(true), formId = useId();
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const run = async (operation: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await operation(); if (mounted.current) setRenaming(false); }
    catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : String(error)); }
    finally { if (mounted.current) setBusy(false); }
  };
  const hasThreadActions = capabilities.rename || capabilities.archive || capabilities.fork;
  const hasHostActions = hostActions?.onNewTask !== undefined || hostActions?.onOpenSettings !== undefined;
  if (!hasThreadActions && !hasHostActions) return children;
  return <>
    <ContextMenu.Root><ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal container={portalContainer}><ContextMenu.Content className="workbench-context-menu" onCloseAutoFocus={event => { if (renaming) event.preventDefault(); }}>
        {capabilities.rename ? <ContextMenu.Item disabled={busy} onSelect={() => { setDraft(target.title); setError(null); setRenaming(true); }}>重命名</ContextMenu.Item> : null}
        {capabilities.fork ? <ContextMenu.Item disabled={busy} onSelect={() => { void run(() => onFork(target)); }}>新建分支</ContextMenu.Item> : null}
        {capabilities.archive ? <ContextMenu.Item disabled={busy} onSelect={() => { void run(() => onArchive(target)); }}>归档</ContextMenu.Item> : null}
        {hasThreadActions && hasHostActions ? <ContextMenu.Separator className="workbench-context-menu__separator" /> : null}
        {hostActions?.onNewTask ? <ContextMenu.Item disabled={busy} onSelect={() => {
          void run(async () => { await hostActions.onNewTask?.(target.hostId); });
        }}>在 {hostActions.label} 上新建任务</ContextMenu.Item> : null}
        {hostActions?.onOpenSettings ? <ContextMenu.Item disabled={busy} onSelect={() => {
          hostActions.onOpenSettings?.(target.hostId);
        }}>{hostActions.label} 设置</ContextMenu.Item> : null}
      </ContextMenu.Content></ContextMenu.Portal>
    </ContextMenu.Root>
    {renaming ? <ModalSurface portalContainer={portalContainer} label="重命名会话" size="compact" appearance="utility" onDismiss={() => setRenaming(false)}>
      <SettingsPanel title="重命名会话" footer={<><SettingsButton onClick={() => setRenaming(false)}>取消</SettingsButton><SettingsButton form={formId} type="submit" variant="primary" disabled={busy || !draft.trim()}>{busy ? "保存中…" : "保存"}</SettingsButton></>}>
        <form id={formId} onSubmit={event => { event.preventDefault(); void run(() => onRename(target, draft.trim())); }}>
          <SettingsTextInput autoFocus aria-label="会话名称" aria-describedby={error ? `${formId}-error` : undefined} aria-invalid={error ? true : undefined}
            maxLength={60} value={draft} disabled={busy} onChange={event => setDraft(event.target.value)} />
          {error ? <p id={`${formId}-error`} className="settings-control-notice" role="alert">{error}</p> : null}
        </form>
      </SettingsPanel>
    </ModalSurface> : error ? <p className="settings-control-notice" role="alert">{error}</p> : null}
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
