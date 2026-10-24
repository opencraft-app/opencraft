import { CheckIcon as Check, AddIcon as Plus, SearchIcon as Search } from "@opencraft/design-system-web/action-icons";
import { useEffect, useState, useSyncExternalStore } from "react";
import { ArrowUpRightIcon as ArrowUpRight } from "@opencraft/design-system-web/action-icons";
import { CONNECTOR_CATALOG, connectorDefinition, type ConnectorInstance } from "@opencraft/connector-core";
import { connectorErrorMessage, type ConnectorOperation, type ConnectorManager } from "@opencraft/workbench-runtime";
import { SegmentedControl, SettingsNotice, SettingsSelect, SettingsTextInput } from "@opencraft/extension-react";
import { useAppServerHosts } from "../../runtime/appserver-runtime-context";
import { ModalHost } from "../modal/modal-host";
import { Button } from "../ui/button";
import { ConnectorIcon } from "./connector-icon";
import { ConnectorNativeServices } from "./connector-native-services";
import { ConnectorSetup } from "./connector-setup";
import "./connector-library.scss";

export function WorkbenchConnectorLibrary({ hostId }: { hostId: string }) {
  const { connectorManager } = useAppServerHosts();
  return <ConnectorLibrary key={hostId} hostId={hostId} manager={connectorManager} />;
}

export function ConnectorLibrary({ hostId, manager }: { hostId: string; manager: ConnectorManager }) {
  const controller = manager.managed;
  const snapshot = useSyncExternalStore(controller.subscribe, () => controller.snapshot(hostId), () => controller.snapshot(hostId));
  const [view, setView] = useState("catalog");
  const [category, setCategory] = useState("全部");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<{ kind: string; instance: ConnectorInstance | null } | null>(null);
  const [removing, setRemoving] = useState<ConnectorInstance | null>(null);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(() => { void controller.load(hostId); }, [controller, hostId]);
  const needle = query.trim().toLowerCase();
  const matches = (name: string, description: string) => `${name} ${description}`.toLowerCase().includes(needle);
  const entries = CONNECTOR_CATALOG.filter(row => (category === "全部" || category === row.category) && matches(row.name, row.description));
  const instances = snapshot.data?.instances ?? [];
  const visibleInstances = instances.filter(row => matches(row.title, connectorDefinition(row.definitionId).name));

  async function change(row: ConnectorInstance, operation: ConnectorOperation, work: () => Promise<unknown>) {
    setPending(previous => new Set([...previous, row.id]));
    setErrors(previous => { const next = new Map(previous); next.delete(row.id); return next; });
    try { await work(); }
    catch (error) { setErrors(previous => new Map(previous).set(row.id, connectorErrorMessage(operation, error))); }
    finally { setPending(previous => { const next = new Set(previous); next.delete(row.id); return next; }); }
  }

  return <div className="connector-library">
    <header className="connector-library__heading"><h2>连接器</h2><p>把常用服务连接到你的工作流。</p></header>
    <div className="connector-library__toolbar">
      <SegmentedControl label="连接器视图" value={view} onValueChange={setView} options={[
        { value: "catalog", label: "全部服务" }, { value: "configured", label: `已配置${instances.length ? ` ${instances.length}` : ""}` },
      ]} />
      <div className="connector-library__filters">
        {view === "catalog" ? <SettingsSelect aria-label="服务分类" value={category} onChange={event => setCategory(event.target.value)}>
          <option value="全部">全部分类</option>
          {[...new Set(CONNECTOR_CATALOG.map(row => row.category))].map(value => <option key={value} value={value}>{value}</option>)}
        </SettingsSelect> : null}
        <label className="connector-library__search"><Search size={16} aria-hidden="true" />
          <SettingsTextInput aria-label="搜索连接器" placeholder="搜索服务" value={query} onChange={event => setQuery(event.target.value)} />
        </label>
      </div>
    </div>
    {snapshot.error ? <SettingsNotice tone="error">{snapshot.error}<Button variant="ghost" onClick={() => void controller.load(hostId)}>重试</Button></SettingsNotice> : null}
    <div className="connector-library__result-label" role="status">{snapshot.phase === "loading" ? "正在更新连接状态…" : view === "catalog" ? `${entries.length} 项服务` : `${visibleInstances.length} 个连接`}</div>
    {view === "catalog" ? <section aria-label="服务目录" className="connector-library__grid">
      {entries.map(entry => {
        const supported = snapshot.data?.supportedDefinitions.includes(entry.id) === true;
        const count = instances.filter(row => row.definitionId === entry.id).length;
        return <button key={entry.id} type="button" className="connector-service-card" aria-label={`${entry.name} · 查看接入详情`} onClick={() => setEditing({ kind: entry.id, instance: null })}>
          <span className="connector-service-card__identity"><ConnectorIcon id={entry.id} /><strong>{entry.name}</strong></span>
          <span className="connector-service-card__description">{entry.description}</span>
          <span className="connector-service-card__footer"><span>{count ? <><Check size={13} aria-hidden="true" /> 已配置 {count}</> : entry.category}</span>
            {supported ? <Plus size={15} aria-hidden="true" /> : <span>接入说明 <ArrowUpRight size={13} aria-hidden="true" /></span>}
          </span>
        </button>;
      })}
    </section> : <section aria-label="已配置的连接" className="connector-library__instances">
      {visibleInstances.map(row => <article key={row.id} className="connector-instance">
        <ConnectorIcon id={row.definitionId} />
        <div className="connector-instance__copy"><h3>{row.title}</h3><p>{connectorDefinition(row.definitionId).name}</p>
          <span>{!row.enabled ? "已停用" : row.authorization === "required" ? "需要授权" : "已配置"}</span>
          {errors.has(row.id) ? <p role="alert">{errors.get(row.id)}</p> : null}
        </div>
        <div className="connector-instance__actions">
          <Button variant="secondary" size="sm" disabled={pending.has(row.id)} onClick={() => setEditing({ kind: row.definitionId, instance: row })}>配置</Button>
          <Button variant="ghost" size="sm" disabled={pending.has(row.id)} onClick={() => void change(row, row.enabled ? "disable" : "enable", () => controller.enable(hostId, row, !row.enabled))}>{row.enabled ? "停用" : "启用"}</Button>
          <Button variant="ghost" size="sm" disabled={pending.has(row.id)} onClick={() => setRemoving(row)}>删除</Button>
          {errors.has(row.id) ? <Button variant="ghost" size="sm" onClick={() => void controller.load(hostId).then(() => {
            if (controller.snapshot(hostId).phase === "ready") setErrors(previous => { const next = new Map(previous); next.delete(row.id); return next; });
          })}>刷新列表</Button> : null}
        </div>
      </article>)}
    </section>}
    {(view === "catalog" ? !entries.length : !visibleInstances.length) ? <div className="connector-library__empty">
      <h3>{view === "configured" && !query ? "还没有配置连接器" : "没有找到匹配的服务"}</h3>
      <p>{view === "configured" && !query ? "先选一个常用服务，按引导完成连接。" : "换个关键词，或查看全部服务。"}</p>
      <Button variant="secondary" onClick={() => { setView("catalog"); setQuery(""); setCategory("全部"); }}>浏览全部服务</Button>
    </div> : null}
    <ConnectorNativeServices key={hostId} hostId={hostId} manager={manager} />
    <ModalHost requests={[
      editing ? { id: "connector-setup", label: `${connectorDefinition(editing.kind).name}接入配置`, presentation: "inspector", appearance: "utility", dismissOnOutsidePress: false,
        onDismiss: () => setEditing(null), content: <ConnectorSetup key={`${hostId}:${editing.kind}:${editing.instance?.id ?? "new"}`} hostId={hostId} definition={connectorDefinition(editing.kind)} instance={editing.instance}
          controller={controller} supported={snapshot.data?.supportedDefinitions.includes(editing.kind) === true} onDone={() => { setEditing(null); setView("configured"); setQuery(""); }} /> } : null,
      removing ? { id: "connector-remove", label: "删除连接器", size: "wide", appearance: "utility", layer: "confirmation", onDismiss: () => setRemoving(null),
        confirmation: { confirmLabel: "删除配置和凭据", onConfirm: () => { const row = removing; setRemoving(null); void change(row, "remove", () => controller.remove(hostId, row)); } },
        content: <section className="connector-delete-confirmation"><h2>删除“{removing.title}”？</h2><p>此设备上的配置和凭据将被删除，现有会话将无法再使用。外部服务数据不受影响；第三方授权需到服务网站撤销。</p></section> } : null,
    ]} />
  </div>;
}
