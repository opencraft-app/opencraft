import * as ContextMenu from "@radix-ui/react-context-menu";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { SettingsPanel, SettingsButton, SettingsTextInput } from "@opencraft/extension-react";
import { ModalSurface } from "./modal";
import "../styles/context-menu.scss";

export interface ThreadActionTarget { readonly hostId: string; readonly threadId: string; readonly title: string }
export interface ThreadActionCapabilities { readonly rename: boolean; readonly archive: boolean; readonly fork: boolean }
export interface ThreadActionCallbacks {
  readonly onRename: (target: ThreadActionTarget, title: string) => Promise<void>;
  readonly onFork: (target: ThreadActionTarget) => Promise<void>;
  readonly onArchive: (target: ThreadActionTarget) => Promise<void>;
}

export function ThreadRowMenu({ target, capabilities, children, onRename, onFork, onArchive }: ThreadActionCallbacks & {
  target: ThreadActionTarget; capabilities: ThreadActionCapabilities; children: ReactNode;
}) {
  const [renaming, setRenaming] = useState(false), [draft, setDraft] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const mounted = useRef(true), formId = useId();
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const run = async (operation: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await operation(); if (mounted.current) setRenaming(false); }
    catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : String(error)); }
    finally { if (mounted.current) setBusy(false); }
  };
  if (!capabilities.rename && !capabilities.archive && !capabilities.fork) return children;
  return <>
    <ContextMenu.Root><ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal><ContextMenu.Content className="workbench-context-menu" onCloseAutoFocus={event => { if (renaming) event.preventDefault(); }}>
        {capabilities.rename ? <ContextMenu.Item disabled={busy} onSelect={() => { setDraft(target.title); setError(null); setRenaming(true); }}>重命名</ContextMenu.Item> : null}
        {capabilities.fork ? <ContextMenu.Item disabled={busy} onSelect={() => { void run(() => onFork(target)); }}>新建分支</ContextMenu.Item> : null}
        {capabilities.archive ? <ContextMenu.Item disabled={busy} onSelect={() => { void run(() => onArchive(target)); }}>归档</ContextMenu.Item> : null}
      </ContextMenu.Content></ContextMenu.Portal>
    </ContextMenu.Root>
    {renaming ? <ModalSurface label="重命名会话" size="compact" appearance="utility" onDismiss={() => setRenaming(false)}>
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

export function ArchivedThreadsDialog({ hostId, load, restore, onDismiss }: {
  hostId: string;
  load(hostId: string): Promise<ReadonlyArray<{ id: string; name?: string | null; preview?: string }>>;
  restore(hostId: string, threadId: string): Promise<void>;
  onDismiss(): void;
}) {
  const query = useQuery({ queryKey: ["appserver", hostId, "threads", "archived", "management"], queryFn: () => load(hostId) });
  const [busy, setBusy] = useState<string | null>(null), [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  return <ModalSurface label="已归档会话" appearance="utility" onDismiss={onDismiss}>
    <SettingsPanel title="已归档会话">
      {query.isPending ? <p role="status">正在读取归档…</p> : null}
      {query.error ? <p role="alert">{query.error.message}<SettingsButton onClick={() => { void query.refetch(); }}>重试</SettingsButton></p> : null}
      {!query.isPending && !query.error && !query.data?.length ? <p>暂无已归档会话</p> : null}
      <ul className="thread-management-list">{query.data?.map(thread => <li key={thread.id}>
        <span>{thread.name ?? thread.preview ?? "New chat"}</span>
        <SettingsButton disabled={busy !== null} onClick={() => {
          setBusy(thread.id); setError(null);
          void restore(hostId, thread.id).then(() => query.refetch()).catch(error => { if (mounted.current) setError(String(error.message ?? error)); })
            .finally(() => { if (mounted.current) setBusy(null); });
        }}>{busy === thread.id ? "恢复中…" : "恢复"}</SettingsButton>
      </li>)}</ul>
      {error ? <p role="alert">{error}</p> : null}
    </SettingsPanel>
  </ModalSurface>;
}
