import * as Dialog from "@radix-ui/react-dialog";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { Ellipsis, Globe2, LogOut, Plus, RefreshCw, Settings, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { SettingsActions, SettingsButton, SettingsGroup, SettingsIconButton, SettingsListItem, SettingsNotice, SettingsPageHeader, SettingsRow, SettingsSection, SettingsSwitch, SettingsTextInput } from "@opencraft/extension-react";
import type { SshConnectionEdit, SshConnectionView } from "@opencraft/app-host-protocol";
import { SshConnectionsController } from "./controller";

const stateLabels: Record<SshConnectionView["state"], string> = {
  idle: "未连接", connecting: "正在连接", open: "已连接", closing: "正在断开", closed: "未连接", failed: "连接失败", disabled: "已停用",
};
type Editor = { row: SshConnectionView | null; kind: "edit" | "delete" };

function ConnectionEditor({ editor, controller, onClose }: { editor: Editor; controller: SshConnectionsController; onClose(): void }) {
  const row = editor.row;
  const [draft, setDraft] = useState({ displayName: row?.displayName ?? "", hostname: row?.hostname ?? "", port: String(row?.port ?? 22), username: row?.username ?? "root", root: row?.workspaceBrowseRoots[0] ?? "/", password: "" });
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [trust, setTrust] = useState<{ challengeId: string; fingerprint: string } | null>(null), [trusted, setTrusted] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const edit = (key: keyof typeof draft, value: string) => {
    setDraft(previous => ({ ...previous, [key]: value }));
    if (key === "hostname" || key === "port") { setTrust(null); setTrusted(false); }
  };
  const run = async (action: () => Promise<void>) => {
    if (busy) return; setBusy(true); setError(null);
    try { await action(); }
    catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : "操作失败，请重试。"); }
    finally { if (alive.current) setBusy(false); }
  };
  const title = editor.kind === "delete" ? "删除连接" : row ? "连接设置" : "添加远程连接";
  const input: SshConnectionEdit = { displayName: draft.displayName.trim() || draft.hostname.trim(), hostname: draft.hostname.trim(), port: Number(draft.port), username: draft.username.trim(), enabled: row?.enabled ?? true,
    workspaceBrowseRoots: draft.root.trim() ? [draft.root.trim(), ...(row?.workspaceBrowseRoots.slice(1) ?? [])] : [], ...(draft.password ? { password: draft.password } : {}) };
  return <Dialog.Root open onOpenChange={open => { if (!open && !busy) onClose(); }}><Dialog.Portal>
    <Dialog.Overlay className="ssh-connections-dialog__overlay" />
    <Dialog.Content className="ssh-connections-dialog" onEscapeKeyDown={event => { if (busy) event.preventDefault(); }} onPointerDownOutside={event => { if (busy) event.preventDefault(); }}>
      <header><Dialog.Title>{title}</Dialog.Title><Dialog.Close asChild><SettingsIconButton label="关闭连接设置" disabled={busy}><X size={18} /></SettingsIconButton></Dialog.Close></header>
      <Dialog.Description>{editor.kind === "delete" ? "仅移除这个连接，远端文件和 Codex 服务不会删除或停止。" : "从 OpenCraft 服务器连接远端。密码只交给后端保存，不会返回浏览器。"}</Dialog.Description>
      {editor.kind === "delete" ? <SettingsNotice>确认删除“{row?.displayName}”？此处已有会话将暂时无法访问。</SettingsNotice> : <form id="ssh-connection-form" onSubmit={event => { event.preventDefault(); void run(async () => {
        if (!row && (!trust || !trusted)) return;
        await controller.save(row, input, row ? undefined : trust!);
        if (alive.current) onClose();
      }); }}>
        <SettingsGroup appearance="plain">
          <SettingsRow label="名称" htmlFor="ssh-name"><SettingsTextInput id="ssh-name" value={draft.displayName} placeholder="连接名称" disabled={busy} maxLength={100} onChange={event => edit("displayName", event.target.value)} /></SettingsRow>
          <SettingsRow label="地址" htmlFor="ssh-address" description={row ? "更换服务器请添加新连接。" : undefined}><SettingsTextInput id="ssh-address" value={draft.hostname} required disabled={busy || !!row} autoComplete="off" onChange={event => edit("hostname", event.target.value)} /></SettingsRow>
          <SettingsRow label="端口" htmlFor="ssh-port"><SettingsTextInput id="ssh-port" type="number" min={1} max={65535} value={draft.port} required disabled={busy || !!row} onChange={event => edit("port", event.target.value)} /></SettingsRow>
          <SettingsRow label="用户名" htmlFor="ssh-user"><SettingsTextInput id="ssh-user" value={draft.username} required disabled={busy || !!row} autoComplete="off" onChange={event => edit("username", event.target.value)} /></SettingsRow>
          <SettingsRow label="密码" htmlFor="ssh-password" description={row ? "留空则保留原密码。" : undefined}><SettingsTextInput id="ssh-password" type="password" value={draft.password} required={!row} disabled={busy} autoComplete="new-password" onChange={event => edit("password", event.target.value)} /></SettingsRow>
          <SettingsRow label="工作目录" htmlFor="ssh-root"><SettingsTextInput id="ssh-root" value={draft.root} placeholder="/" disabled={busy} onChange={event => edit("root", event.target.value)} /></SettingsRow>
        </SettingsGroup>
        {row ? <details><summary>服务器身份</summary><code>{row.fingerprint}</code></details> : <SettingsGroup appearance="plain">
          <SettingsRow label="服务器身份" description="先核对指纹，确认是你信任的服务器。"><SettingsButton type="button" disabled={busy || !draft.hostname || !draft.port} onClick={() => { void run(async () => {
            const result = await controller.probe(input.hostname, input.port); if (alive.current) { setTrust(result); setTrusted(false); }
          }); }}>核对身份</SettingsButton></SettingsRow>
          {trust ? <><code className="ssh-connections__fingerprint">{trust.fingerprint}</code><SettingsRow label="我确认信任此服务器"><SettingsSwitch checked={trusted} label="信任此服务器" disabled={busy} onCheckedChange={setTrusted} /></SettingsRow></> : null}
        </SettingsGroup>}
      </form>}
      {error ? <SettingsNotice tone="error">{error}</SettingsNotice> : null}
      <SettingsActions><Dialog.Close asChild><SettingsButton disabled={busy}>取消</SettingsButton></Dialog.Close>
        {editor.kind === "delete" ? <SettingsButton variant="danger" disabled={busy} onClick={() => { void run(async () => { await controller.remove(row!); if (alive.current) onClose(); }); }}>{busy ? "处理中…" : "删除"}</SettingsButton>
          : <SettingsButton variant="primary" type="submit" form="ssh-connection-form" disabled={busy || (!row && (!trust || !trusted))}>{busy ? "处理中…" : "保存"}</SettingsButton>}
      </SettingsActions>
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>;
}

export function createSshConnectionsView(controller: SshConnectionsController) {
  return function SshConnectionsView() {
    const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
    const [accessKey, setAccessKey] = useState(""), [unlocking, setUnlocking] = useState(false), [unlockError, setUnlockError] = useState<string | null>(null);
    const [menuId, setMenuId] = useState<string | null>(null), [editor, setEditor] = useState<Editor | null>(null);
    const [pending, setPending] = useState<ReadonlySet<string>>(new Set()), [errors, setErrors] = useState<Record<string, string>>({});
    const rowOperations = useRef(new Set<string>());
    const alive = useRef(true);
    useEffect(() => {
      alive.current = true;
      return () => { alive.current = false; };
    }, []);
    useEffect(() => { if (!snapshot.authenticated) { setEditor(null); setMenuId(null); } }, [snapshot.authenticated]);
    const runRow = async (id: string, action: () => Promise<void>) => {
      if (rowOperations.current.has(id)) return;
      rowOperations.current.add(id); setPending(new Set(rowOperations.current)); setErrors(previous => ({ ...previous, [id]: "" }));
      try { await action(); }
      catch (cause) { if (alive.current) setErrors(previous => ({ ...previous, [id]: cause instanceof Error ? cause.message : "操作失败。" })); }
      finally { rowOperations.current.delete(id); if (alive.current) setPending(new Set(rowOperations.current)); }
    };
    return <div className="ssh-connections">
      <SettingsPageHeader title="远程连接" description="连接由 OpenCraft 服务器保存和管理。" />
      {!snapshot.available || (!snapshot.authenticated && snapshot.accessMode !== "access-key") ? <><SettingsNotice>{snapshot.available === false ? "当前服务器尚未开放远程连接管理。" : "暂时无法读取连接设置，请重试。"}</SettingsNotice><SettingsActions><SettingsButton disabled={snapshot.refreshing} onClick={() => { void controller.refresh(); }}>重试</SettingsButton></SettingsActions></> : !snapshot.authenticated ? <SettingsSection title="解锁远程连接" description="使用管理员提供的访问密钥，保护远端服务器。">
        <form onSubmit={event => { event.preventDefault(); if (unlocking) return; setUnlocking(true); setUnlockError(null);
          void controller.unlock(accessKey).then(() => { if (alive.current) setAccessKey(""); }).catch(cause => { if (alive.current) setUnlockError(cause.message); }).finally(() => { if (alive.current) setUnlocking(false); }); }}>
          <SettingsGroup><SettingsRow label="访问密钥" htmlFor="ssh-access"><SettingsTextInput id="ssh-access" type="password" autoComplete="off" value={accessKey} required disabled={unlocking} onChange={event => setAccessKey(event.target.value)} /></SettingsRow></SettingsGroup>
          {unlockError ? <SettingsNotice tone="error">{unlockError}</SettingsNotice> : null}
          <SettingsActions><SettingsButton variant="primary" type="submit" disabled={unlocking || !accessKey.trim()}>{unlocking ? "处理中…" : "解锁"}</SettingsButton></SettingsActions>
        </form>
      </SettingsSection> : <SettingsSection title="来自这台服务器的 SSH 连接" action={<SettingsButton variant="primary" onClick={() => { setMenuId(null); setEditor({ row: null, kind: "edit" }); }}><Plus size={16} />添加</SettingsButton>}>
        {snapshot.items.length === 0 ? <SettingsNotice>尚未添加远程连接。</SettingsNotice> : <SettingsGroup>
          {snapshot.items.map(row => <SettingsListItem key={row.serverId} label={row.displayName} description={`${row.username} · ${row.hostname}:${row.port}`} icon={<Globe2 size={20} />}
            metadata={<span className="ssh-connections__status" data-state={row.state}><i aria-hidden="true" />{stateLabels[row.state]}</span>} error={errors[row.serverId] || undefined}
            actions={<><SettingsSwitch label={`启用连接：${row.displayName}`} checked={row.enabled} disabled={pending.has(row.serverId)} onCheckedChange={enabled => { void runRow(row.serverId, () => controller.toggle(row, enabled)); }} />
              <Menu.Root open={menuId === row.serverId} onOpenChange={open => setMenuId(current => open ? row.serverId : current === row.serverId ? null : current)}>
                <Menu.Trigger asChild><SettingsIconButton label={`连接操作：${row.displayName}`} disabled={pending.has(row.serverId)}><Ellipsis size={18} /></SettingsIconButton></Menu.Trigger>
                <Menu.Portal><Menu.Content className="ssh-connections-menu" align="end" sideOffset={6} collisionPadding={12} onCloseAutoFocus={event => { if (editor) event.preventDefault(); }}>
                  <Menu.Item className="ssh-connections-menu__item" onSelect={() => setEditor({ row, kind: "edit" })}><Settings /><span>设置</span></Menu.Item>
                  <Menu.Item className="ssh-connections-menu__item" disabled={!row.enabled || row.state === "connecting" || row.state === "closing"} onSelect={() => { void runRow(row.serverId, () => row.state === "open" ? controller.reconnect(row) : controller.connect(row)); }}><RefreshCw /><span>{row.state === "open" ? "重新连接" : "连接"}</span></Menu.Item>
                  <Menu.Item className="ssh-connections-menu__item" disabled={!row.enabled} onSelect={() => { void runRow(row.serverId, () => controller.toggle(row, false)); }}><LogOut /><span>断开并停用</span></Menu.Item>
                  <Menu.Separator className="ssh-connections-menu__separator" /><Menu.Item className="ssh-connections-menu__item ssh-connections-menu__item--danger" onSelect={() => setEditor({ row, kind: "delete" })}><Trash2 /><span>删除</span></Menu.Item>
                </Menu.Content></Menu.Portal>
              </Menu.Root></>} />)}
        </SettingsGroup>}
        <SettingsActions align="between"><SettingsButton variant="quiet" disabled={snapshot.refreshing} onClick={() => { void controller.refresh(); }}><RefreshCw size={16} />刷新</SettingsButton>
          {snapshot.accessMode === "access-key" ? <SettingsButton variant="quiet" onClick={() => { void runRow("session", () => controller.lock()); }} disabled={pending.has("session")}>锁定管理</SettingsButton> : null}</SettingsActions>
        {errors.session ? <SettingsNotice tone="error">{errors.session}</SettingsNotice> : null}
        {snapshot.legacyServers.length ? <SettingsSection title="配置文件中的连接" description="这些连接由服务器配置文件管理。"><SettingsGroup>{snapshot.legacyServers.map(server => <SettingsListItem key={server.serverId} label={server.displayName} icon={<Globe2 size={20} />} />)}</SettingsGroup></SettingsSection> : null}
      </SettingsSection>}
      {snapshot.error ? <SettingsNotice tone="error">{snapshot.error}</SettingsNotice> : null}
      {editor && snapshot.authenticated ? <ConnectionEditor key={`${editor.row?.serverId ?? "new"}:${editor.kind}`} editor={editor} controller={controller} onClose={() => setEditor(null)} /> : null}
    </div>;
  };
}
