import { Plug, RefreshCw, Search, X } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { SettingsButton, SettingsNotice, SettingsPageHeader } from "@opencraft/extension-react";
import type { LightVelaAccountService } from "../account/lightvela-account-service";
import { HermesConnectorClient, prototypeUnsupported, isConnectorVisible, type ConnectorInstance, type ConnectorRelease } from "./connector-client";
import { connectorCatalog, type BrowseConnector } from "./catalog-snapshot";
import { CliAuthPanel } from "./cli-auth-panel";
import { ConnectorSession, initialConnectorSession, type ConnectorSessionSnapshot } from "./connector-session";

const labels = { idle: "尚未检查运行服务", probing: "正在检查运行服务…", missing: "运行服务尚未安装",
  installing: "正在下载、校验并安装…", ready: "已连接当前 Bot", updating: "正在更新连接器…", error: "未能确认运行服务状态" };

/** Presentation remains usable without any VM connection. */
export function ConnectorBrowser({ session, canManage, onProbe, onInstall, onCancel, onAuthorize, onDisable, release, createCliClient,
  catalog = connectorCatalog }: {
  session: ConnectorSessionSnapshot; canManage: boolean; release?: ConnectorRelease; catalog?: BrowseConnector[];
  createCliClient?: () => HermesConnectorClient;
  onProbe(): void; onInstall(release: ConnectorRelease): void; onCancel(): void;
  onAuthorize(card: BrowseConnector, values: Record<string, string>): void; onDisable(instanceId: string): void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "available" | "installed">("all");
  const [limit, setLimit] = useState(12);
  const [selected, setSelected] = useState<BrowseConnector | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [archiveUrl, setArchiveUrl] = useState(release?.url ?? "");
  const [sha256, setSha256] = useState(release?.sha256 ?? "");
  const ready = session.phase === "ready" || session.phase === "updating";
  const busy = session.phase === "installing" || session.phase === "updating";
  const waiting = busy || session.phase === "probing";
  const visibleCatalog = catalog.filter(isConnectorVisible);
  const visibleIds = new Set(visibleCatalog.map((card) => card.id));
  const configuredCount = session.instances.filter((item) => visibleIds.has(item.packageId)).length;
  useEffect(() => {
    setValues({});
    if (!selected) return;
    const dialog = dialogRef.current; dialog?.showModal();
    return () => dialog?.close();
  }, [selected]);
  useEffect(() => { if (!ready || session.phase === "updating") setValues({}); }, [ready, session.phase]);
  const install = () => onInstall({ url: archiveUrl, sha256 });
  const instanceFor = (id: string) => session.instances.find((item) => item.packageId === id);
  const selectedInstance = selected ? instanceFor(selected.id) : undefined;
  const selectedState = session.states.find((item) => item.id === selectedInstance?.instanceId);
  const matching = visibleCatalog.filter((card) => (filter !== "available" || !prototypeUnsupported(card)) &&
    (filter !== "installed" || (ready && instanceFor(card.id))) &&
    `${card.name} ${card.description} ${card.id}`.toLowerCase().includes(query.toLowerCase()));
  const available = visibleCatalog.filter((card) => !prototypeUnsupported(card)).length;
  return <div className="hermes-connectors">
    <SettingsPageHeader title="连接器" description="发现并连接你的工作服务，让 Hermes 获取所需工具与技能。" />
    <div className="hermes-connectors__runtime" role="status">
      <div><strong>{canManage ? labels[session.phase] : "先浏览，登录并选择 Bot 后即可连接"}</strong>
        <p>{ready ? `当前目录中已配置 ${configuredCount} 个连接器。凭据留在 VM，关闭页面不会停止服务。`
          : "服务目录无需安装即可浏览。首次使用时，安装运行服务到当前 Bot。"}</p></div>
      {canManage && <div className="hermes-connectors__runtime-actions">
        {!ready && <SettingsButton disabled={busy || !archiveUrl || !sha256} onClick={install}>{session.phase === "installing" ? "正在安装…" : "安装运行服务"}</SettingsButton>}
        <SettingsButton disabled={busy} onClick={onProbe}><RefreshCw size={14} /> {session.phase === "probing" ? "重新检查" : "检查状态"}</SettingsButton>
        {waiting && <SettingsButton onClick={onCancel}>{session.phase === "probing" ? "取消检查" : "停止等待"}</SettingsButton>}
      </div>}
    </div>
    {session.message && <SettingsNotice tone={session.phase === "error" ? "error" : undefined}>{session.message}</SettingsNotice>}
    <div className="hermes-connectors__toolbar">
      <div role="group" aria-label="连接器分类">
        <button aria-pressed={filter === "all"} onClick={() => { setFilter("all"); setLimit(12); }}>全部 {visibleCatalog.length}</button>
        <button aria-pressed={filter === "available"} onClick={() => { setFilter("available"); setLimit(12); }}>原型可接入 {available}</button>
        <button aria-pressed={filter === "installed"} onClick={() => { setFilter("installed"); setLimit(12); }}>已配置{ready ? ` ${configuredCount}` : " · 待检查"}</button>
      </div>
      <label className="hermes-connectors__search"><Search size={16} /><input aria-label="搜索连接器" placeholder="搜索服务…" value={query} onChange={(e) => { setQuery(e.target.value); setLimit(12); }} /></label>
    </div>
    <div className="hermes-connectors__grid">{matching.slice(0, limit).map((card) => {
      const instance = instanceFor(card.id);
      const state = session.states.find((item) => item.id === instance?.instanceId);
      return <button className="hermes-connectors__card" key={card.id} onClick={() => setSelected(card)}>
        <span className="hermes-connectors__icon">{card.icon ? <img src={card.icon} alt="" loading="lazy" /> : <Plug size={22} />}</span>
        <strong>{card.name}</strong><p>{card.description}</p>
        <span>{ready && state?.status === "connected" ? "已连接" : ready && instance ? "已配置"
          : prototypeUnsupported(card) ? "查看详情 · 暂未支持" : "查看并连接"}</span>
      </button>;
    })}</div>
    {matching.length === 0 && <p>{filter === "installed" && !ready ? "检查当前 Bot 的运行服务后，才能确认已配置的连接器。" : "没有匹配的连接器。"}</p>}
    {matching.length > limit && <SettingsButton onClick={() => setLimit(limit + 12)}>加载更多（还有 {matching.length - limit} 个）</SettingsButton>}
    <p className="hermes-connectors__hint">目录不代表已授权。CLI 支持远端标准输入输出；需要完整终端或 localhost 回调的登录方式尚不支持。</p>
    {canManage && <details className="hermes-connectors__setup"><summary>高级：测试运行服务版本</summary>
      <p>Linux x64 · 下载后校验 SHA256 · 保留其他 Hermes MCP 配置。</p>
      <label>产物地址<input type="url" value={archiveUrl} onChange={(e) => setArchiveUrl(e.target.value)} /></label>
      <label>SHA256<input value={sha256} onChange={(e) => setSha256(e.target.value.trim())} spellCheck={false} /></label>
    </details>}
    {selected && <dialog ref={dialogRef} className="hermes-connectors__detail" aria-label="连接器详情" onCancel={() => setSelected(null)}>
      <div className="hermes-connectors__toolbar"><h3>{selected.name}</h3><button aria-label="关闭详情" onClick={() => setSelected(null)}><X size={18} /></button></div>
      <p>{selected.description}</p>
      {selected.definition.examples_zh?.length ? <ul>{selected.definition.examples_zh.slice(0, 3).map((example) => <li key={example}>{example}</li>)}</ul> : null}
      {prototypeUnsupported(selected) ? <SettingsNotice>{prototypeUnsupported(selected)}</SettingsNotice> : !canManage
        ? <SettingsNotice>请在 LightVela 设置中登录并选择 Bot，之后可配置此连接器。</SettingsNotice> : !ready
          ? <><p>首次使用需要安装运行服务，安装完成后即可在这里配置 {selected.name}。</p><SettingsButton disabled={busy || !archiveUrl || !sha256} onClick={install}>{busy ? "正在安装…" : "安装运行服务以继续"}</SettingsButton></>
          : selected.type === "cli" ? createCliClient ? <CliAuthPanel key={selected.id} createClient={createCliClient} packageId={selected.id} name={selected.name} /> : <SettingsNotice>当前 Host 未提供 CLI 授权通道。</SettingsNotice>
          : <form onSubmit={(event) => { event.preventDefault(); onAuthorize(selected, values); setValues({}); }}>
            {selectedState?.error && <SettingsNotice tone="error">{selectedState.error}</SettingsNotice>}
            {selected.tokenSchema?.fields.map((field) => <label key={field.key}>{field.label ?? field.key}<input type={field.secret === false ? "text" : "password"}
              autoComplete="off" required={field.required && !selectedInstance} disabled={busy} value={values[field.key] ?? ""}
              onChange={(e) => setValues({ ...values, [field.key]: e.target.value })} /></label>)}
            <SettingsButton type="submit" disabled={busy}>{busy ? "连接中…" : selectedInstance ? "保存并连接" : "添加并连接"}</SettingsButton>
            {selectedInstance && <SettingsButton type="button" disabled={busy} onClick={() => onDisable(selectedInstance.instanceId)}>停用</SettingsButton>}
            <p className="hermes-connectors__hint">更新后请新建会话，或在 Hermes 执行 /reload-mcp。</p>
          </form>}
    </dialog>}
  </div>;
}

function BotConnectors({ account, botId, release }: { account: LightVelaAccountService; botId: string | null; release?: ConnectorRelease }) {
  const ownerRef = useRef<ConnectorSession | null>(null);
  const [snapshot, setSnapshot] = useState(initialConnectorSession);
  useEffect(() => {
    if (!botId) return;
    const owner = new ConnectorSession(() => new HermesConnectorClient(account, botId));
    ownerRef.current = owner;
    const unsubscribe = owner.subscribe(setSnapshot);
    void owner.probe();
    return () => { unsubscribe(); ownerRef.current = null; owner.dispose(); };
  }, [account, botId]);
  return <ConnectorBrowser session={snapshot} canManage={Boolean(botId)} release={release}
    createCliClient={botId ? () => new HermesConnectorClient(account, botId) : undefined}
    onProbe={() => { void ownerRef.current?.probe(); }} onInstall={(value) => { void ownerRef.current?.install(value); }}
    onCancel={() => ownerRef.current?.cancel()}
    onAuthorize={(card, values) => {
      void ownerRef.current?.update(async (client) => {
        const { instances } = await client.request<{ instances: ConnectorInstance[] }>("/v1/instances");
        const instance = instances.find((item) => item.packageId === card.id) ?? await client.request<ConnectorInstance>("/v1/instances", { packageId: card.id, displayName: card.name, defaultOpen: true });
        const route = `/v1/connectors/${encodeURIComponent(instance.instanceId)}`;
        if (Object.keys(values).length) await client.request(`${route}/credentials`, { values });
        await client.request(`${route}/connect`, {});
      });
    }} onDisable={(id) => { void ownerRef.current?.update(async (client) => { await client.request(`/v1/connectors/${encodeURIComponent(id)}/disable`, {}); }); }} />;
}

export function createConnectorsSettingsView(account: LightVelaAccountService, release?: ConnectorRelease) {
  return function ConnectorsSettingsView() {
    const snapshot = useSyncExternalStore(account.subscribe, account.getSnapshot, account.getSnapshot);
    const botId = snapshot.phase === "authenticated" ? snapshot.activeBotId : null;
    return <BotConnectors key={botId ?? "browse"} account={account} botId={botId} release={release} />;
  };
}
