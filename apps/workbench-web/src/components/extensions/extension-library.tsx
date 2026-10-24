import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import { projectExtensionCatalog, type ExtensionManager, type ExtensionSupervisor } from "@opencraft/extension-runtime";
import { SettingsGroup, SettingsListItem, SettingsNotice, SettingsSelect, SettingsSwitch, SettingsTextInput } from "@opencraft/extension-react";
import { useInternalDeveloperMode } from "../../internal-developer-mode";
import { Button } from "../ui/button";
import { ConfirmationModalSurface } from "../modal/confirmation-modal-surface";
import { useWorkbenchPresentationRoot } from "../workbench-presentation-root";
import "./extension-library.scss";

const statusLabels: Record<string, string> = { active: "运行中", disabled: "已停用", loading: "正在加载", activating: "正在启动", deactivating: "正在停止", incompatible: "需要兼容版本", failed: "运行失败" };

export function ExtensionLibrary({ supervisor, manager }: { supervisor: Pick<ExtensionSupervisor, "subscribe" | "getSnapshot" | "contributions">; manager: ExtensionManager }) {
  const runtime = useSyncExternalStore(supervisor.subscribe, supervisor.getSnapshot, supervisor.getSnapshot);
  const installations = useSyncExternalStore(manager.subscribe, manager.getSnapshot, manager.getSnapshot);
  const contributions = useSyncExternalStore(supervisor.contributions.subscribe, supervisor.contributions.getSnapshot, supervisor.contributions.getSnapshot);
  const catalog = useMemo(() => projectExtensionCatalog(runtime, installations, contributions), [runtime, installations, contributions]);
  const developer = useInternalDeveloperMode();
  const portal = useWorkbenchPresentationRoot();
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [remove, setRemove] = useState<string | null>(null);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const inFlight = useRef(new Set<string>());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const detail = catalog.find(row => row.id === selected);
  const filtered = catalog.filter(row => (source === "all" || source === row.source)
    && `${row.name} ${row.id} ${row.version}`.toLowerCase().includes(query.trim().toLowerCase()));
  async function change(id: string, action: () => Promise<unknown>) {
    if (inFlight.current.has(id)) return;
    inFlight.current.add(id); setPending(new Set(inFlight.current));
    setErrors(current => ({ ...current, [id]: "" }));
    try { await action(); }
    catch (error) { setErrors(current => ({ ...current, [id]: error instanceof Error ? error.message : String(error) })); }
    finally { inFlight.current.delete(id); setPending(new Set(inFlight.current)); }
  }
  return <section className="extension-library" aria-label="扩展管理">
    {installations.installationLoadErrors.length > 0 ? <SettingsNotice tone="error">
      {installations.installationLoadErrors.length} 条无效插件安装记录已隔离。
    </SettingsNotice> : null}
    {installations.discoveryErrors.map(error => <SettingsNotice key={error.extensionId} tone="error">{error.extensionId}：{error.message}</SettingsNotice>)}
    {detail ? <>
      <Button variant="ghost" onClick={() => setSelected(null)}>返回扩展列表</Button>
      <SettingsGroup>
        <SettingsListItem label={detail.name} description={detail.id} metadata={`${detail.version} · ${detail.source === "builtin" ? "内建" : "用户安装"}`} />
        <SettingsListItem label="运行状态" description={statusLabels[detail.status] ?? detail.status} error={detail.error ?? undefined} />
        <SettingsListItem label="启用意图" description={detail.enabled ? "已启用" : "已停用"} />
        <SettingsListItem label="当前贡献" description={detail.capabilities.length ? detail.capabilities.join("、") : "当前没有已注册的公开贡献"} />
        {detail.sourceUrl ? <SettingsListItem label="安装来源" description={detail.sourceUrl} /> : null}
        {detail.updateError ? <SettingsListItem label="上次操作未完成" description="当前版本仍在运行" error={detail.updateError} /> : null}
      </SettingsGroup>
      {detail.canManage ? <div className="extension-library__actions">
        <Button disabled={pending.has(detail.id)} onClick={() => void change(detail.id, () => manager.setEnabled(detail.id, !detail.enabled))}>{detail.enabled ? "停用" : "启用"}</Button>
        {detail.canReload ? <Button disabled={pending.has(detail.id)} onClick={() => void change(detail.id, () => manager.reload(detail.id))}>从来源更新</Button> : null}
        {detail.canRemove ? <Button disabled={pending.has(detail.id)} onClick={() => setRemove(detail.id)}>移除扩展</Button> : null}
      </div> : <p>内建扩展随应用更新，暂不支持单独停用或移除。</p>}
      {errors[detail.id] ? <SettingsNotice tone="error">{errors[detail.id]}</SettingsNotice> : null}
    </> : <>
      <div className="extension-library__toolbar">
        <SettingsTextInput aria-label="搜索扩展" placeholder="搜索扩展" value={query} onChange={event => setQuery(event.target.value)} />
        <SettingsSelect aria-label="扩展来源" value={source} onChange={event => setSource(event.target.value)}>
          <option value="all">全部来源</option><option value="builtin">内建</option><option value="installed">用户安装</option>
        </SettingsSelect>
      </div>
      <SettingsGroup>{filtered.map(row => <SettingsListItem key={row.id}
        label={row.name} description={row.description || row.capabilities.join("、") || row.id}
        metadata={`${row.source === "builtin" ? "内建" : "用户安装"} · ${row.version} · ${statusLabels[row.status] ?? row.status}`}
        error={errors[row.id] || row.error || (row.updateError ? "上次操作失败，当前版本仍在运行" : undefined)}
        actions={<>
          {row.canManage ? <SettingsSwitch label={`${row.enabled ? "停用" : "启用"} ${row.name}`} checked={row.enabled} disabled={pending.has(row.id)} onCheckedChange={value => void change(row.id, () => manager.setEnabled(row.id, value))} /> : null}
          <Button variant="ghost" onClick={() => setSelected(row.id)} aria-label={`查看 ${row.name} 详情`}>详情</Button>
        </>} />)}</SettingsGroup>
      {filtered.length === 0 ? <p role="status">{catalog.length ? "没有匹配的扩展。" : "暂无扩展。"}</p> : null}
      {developer ? <form className="extension-library__install" onSubmit={event => {
        event.preventDefault(); void change("install", async () => { await manager.installModuleUrl(url); setUrl(""); });
      }}>
        <label htmlFor="extension-library-url">从 URL 安装可信扩展</label>
        <div className="extension-library__toolbar"><SettingsTextInput id="extension-library-url" type="url" required disabled={pending.has("install")} value={url} onChange={event => setUrl(event.target.value)} placeholder="https://example.com/extension.mjs" />
        <Button type="submit" disabled={pending.has("install")}>安装</Button></div>
        {errors.install ? <SettingsNotice tone="error">{errors.install}</SettingsNotice> : null}
      </form> : null}
    </>}
    {remove ? <ConfirmationModalSurface label="移除扩展" portalContainer={portal} onDismiss={() => setRemove(null)} confirmation={{ confirmLabel: "移除", onConfirm: () => {
      const id = remove; setRemove(null); void change(id, () => manager.remove(id));
    } }}>移除此扩展并撤销其贡献。已保存的扩展数据将保留。</ConfirmationModalSurface> : null}
  </section>;
}
