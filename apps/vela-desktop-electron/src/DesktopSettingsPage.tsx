import {
  Archive,
  ArrowLeft,
  Bot,
  ExternalLink,
  Info,
  Loader2,
  Network,
  Plug,
  Search,
  Sparkles,
} from "lucide-react";
import React from "react";
import type {
  BackendKindWire,
  BackendUsageWireResponse,
  BackendWire,
  NodeWire,
  RuntimeTargetWire,
  VeladClient,
} from "../../../packages/vela-chat-client/src";
import {
  Sidebar,
  SidebarChromeArea,
  SidebarContent,
  SidebarContentFade,
  SidebarMaterialFrame,
  SidebarScrollRegion,
  ShellSelect,
  ShellSwitch,
  VelaSidebarChrome,
} from "../../../packages/vela-desktop-shell/src";
import {
  useVelaSetting,
  type VelaSetting,
} from "../../../packages/vela-settings/src";
import { createDesktopSettings } from "./settings/desktopSettings";

export interface DesktopSettingsSidebarProps {
  activePanel: DesktopSettingsPanelId;
  onClose: () => void;
  onPanelChange: (panel: DesktopSettingsPanelId) => void;
  showTrafficLights?: boolean;
}

export interface DesktopSettingsPageProps {
  activePanel: DesktopSettingsPanelId;
  apiBaseUrl: string;
  appVersion: string;
  backends: BackendWire[];
  backendUsages?: Partial<Record<BackendKindWire, BackendUsageWireResponse>>;
  hostLabel: string;
  client: VeladClient;
  selectedBackend: BackendKindWire | "";
  onBackendSettingsChange?: () => Promise<void> | void;
  onSelectedBackendChange: (backend: BackendKindWire) => void;
}

export type DesktopSettingsPanelId = "engine" | "nodes" | "archive" | "about";

const settingsPanels = [
  { icon: Bot, id: "engine", label: "引擎" },
  { icon: Network, id: "nodes", label: "节点" },
  { icon: Archive, id: "archive", label: "已归档对话" },
  { icon: Info, id: "about", label: "关于 LightVela" },
] satisfies Array<{
  icon: typeof Bot;
  id: DesktopSettingsPanelId;
  label: string;
}>;

const aboutLinks = [
  { href: "https://lightvela.com", label: "官网" },
  { href: "https://lightvela.com/docs", label: "产品文档" },
  { href: "https://lightvela.com/changelog", label: "更新日志" },
];

export function DesktopSettingsSidebar({
  activePanel,
  onClose,
  onPanelChange,
  showTrafficLights = false,
}: DesktopSettingsSidebarProps) {
  return (
    <Sidebar className="vela-settings-sidebar" aria-label="Settings navigation">
      <SidebarMaterialFrame>
        <VelaSidebarChrome showTrafficLights={showTrafficLights} />
        <SidebarContent className="vela-settings-sidebar-content">
          <SidebarChromeArea className="vela-settings-fixed-controls">
            <button className="vela-settings-back" type="button" onClick={onClose}>
              <ArrowLeft size={16} aria-hidden />
              <span>返回应用</span>
            </button>
            <label className="vela-settings-search">
              <Search size={15} aria-hidden />
              <input placeholder="搜索设置..." />
            </label>
          </SidebarChromeArea>
          <SidebarContentFade edge="bottom" />

          <SidebarScrollRegion className="vela-settings-nav-scroll">
            <SettingsNavGroup
              activePanel={activePanel}
              title="设置"
              items={settingsPanels}
              onPanelChange={onPanelChange}
            />
          </SidebarScrollRegion>
        </SidebarContent>
      </SidebarMaterialFrame>
    </Sidebar>
  );
}

export function DesktopSettingsPage({
  activePanel,
  apiBaseUrl,
  appVersion,
  backends,
  backendUsages = {},
  hostLabel,
  client,
  selectedBackend,
  onBackendSettingsChange,
  onSelectedBackendChange,
}: DesktopSettingsPageProps) {
  const settings = React.useMemo(
    () =>
      createDesktopSettings({
        backends,
        client,
        onBackendSettingsChange,
        onSelectedBackendChange,
        selectedBackend,
      }),
    [backends, client, onBackendSettingsChange, onSelectedBackendChange, selectedBackend],
  );

  switch (activePanel) {
    case "about":
      return <DesktopSettingsAboutPanel appVersion={appVersion} hostLabel={hostLabel} />;
    case "archive":
      return <DesktopSettingsArchivePanel />;
    case "engine":
      return (
        <DesktopSettingsEnginePanel
          apiBaseUrl={apiBaseUrl}
          backends={backends}
          backendUsages={backendUsages}
          settings={settings}
        />
      );
    case "nodes":
      return <DesktopSettingsNodesPanel client={client} />;
  }
}

function DesktopSettingsEnginePanel({
  apiBaseUrl,
  backends,
  backendUsages,
  settings,
}: {
  apiBaseUrl: string;
  backends: BackendWire[];
  backendUsages: Partial<Record<BackendKindWire, BackendUsageWireResponse>>;
  settings: ReturnType<typeof createDesktopSettings>;
}) {
  return (
    <main className="vela-settings-page" aria-label="Engine settings">
      <div className="vela-settings-content">
        <h1>引擎</h1>

        <section className="vela-settings-section" aria-labelledby="engine-default-title">
          <div className="vela-settings-section-heading">
            <h2 id="engine-default-title">默认 backend</h2>
            <p>选择新建会话默认连接的 agent backend</p>
          </div>
          <div className="vela-settings-card">
            {settings.engine.backend.map((setting) => (
              <SettingsSettingRow key={setting.id} setting={setting} />
            ))}
            <SettingsInfoRow label="velad API" value={apiBaseUrl} />
          </div>
        </section>

        <section className="vela-settings-section" aria-labelledby="backend-usage-title">
          <div className="vela-settings-section-heading">
            <h2 id="backend-usage-title">Backend 用量</h2>
            <p>展示当前 backend 实例的账号级剩余用量</p>
          </div>
          <div className="vela-settings-card">
            {backends
              .filter((backend) => backend.capabilities.usage_snapshot === true)
              .map((backend) => (
                <BackendUsageSettingsRow
                  backend={backend}
                  key={backend.kind}
                  usage={backendUsages[backend.kind]}
                />
              ))}
            {backends.some((backend) => backend.capabilities.usage_snapshot === true) ? null : (
              <SettingsInfoRow label="状态" value="当前 backend 暂无用量接口" />
            )}
          </div>
        </section>

        <section className="vela-settings-section" aria-labelledby="vela-engine-title">
          <div className="vela-settings-section-heading">
            <h2 id="vela-engine-title">Vela 内置引擎</h2>
            <p>配置本机 runtime 启动时注入的 Chat Completions 兼容引擎</p>
          </div>
          <div className="vela-settings-card">
            {settings.engine.velaEngine.map((setting) => (
              <SettingsSettingRow key={setting.id} setting={setting} />
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}

function BackendUsageSettingsRow({
  backend,
  usage,
}: {
  backend: BackendWire;
  usage?: BackendUsageWireResponse;
}) {
  const value = usage?.summary?.label ?? "加载中";
  return (
    <div className="vela-settings-row" data-setting-id={`backendUsage.${backend.kind}`}>
      <span>
        <strong>{backend.display_name}</strong>
        <small>{usageDetail(usage)}</small>
      </span>
      <output data-usage-tone={usage?.summary?.tone ?? "neutral"}>{value}</output>
    </div>
  );
}

interface SshNodeDraft {
  displayName: string;
  host: string;
  port: string;
  username: string;
  password: string;
  targetOs: string;
  targetArch: string;
}

function DesktopSettingsNodesPanel({ client }: { client: VeladClient }) {
  const [nodes, setNodes] = React.useState<NodeWire[]>([]);
  const [targets, setTargets] = React.useState<RuntimeTargetWire[]>([]);
  const [isLoading, setIsLoading] = React.useState(true);
  const [isSaving, setIsSaving] = React.useState(false);
  const [busyTargetId, setBusyTargetId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState<SshNodeDraft>({
    displayName: "",
    host: "",
    password: "",
    port: "22",
    targetArch: "x86_64",
    targetOs: "linux",
    username: "",
  });

  const loadNodes = React.useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      await client.getNodeProviders();
      const [nodesResponse, targetsResponse] = await Promise.all([
        client.listNodes(),
        client.getRuntimeTargets(),
      ]);
      setNodes(nodesResponse.nodes);
      setTargets(targetsResponse.targets);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setIsLoading(false);
    }
  }, [client]);

  React.useEffect(() => {
    void loadNodes();
  }, [loadNodes]);

  const targetByNodeId = React.useMemo(() => {
    const map = new Map<string, RuntimeTargetWire>();
    for (const target of targets) {
      if (target.node_id) map.set(target.node_id, target);
    }
    return map;
  }, [targets]);

  const updateInputDraft = React.useCallback(
    (field: keyof SshNodeDraft) =>
      (event: React.FormEvent<HTMLInputElement>) => {
        const value = event.currentTarget.value;
        setDraft((current) => ({ ...current, [field]: value }));
      },
    [],
  );
  const updateSelectDraft = React.useCallback(
    (field: keyof SshNodeDraft) =>
      (event: React.ChangeEvent<HTMLSelectElement>) => {
        const value = event.currentTarget.value;
        setDraft((current) => ({ ...current, [field]: value }));
      },
    [],
  );

  const createAndConnectNode = React.useCallback(async () => {
    const host = draft.host.trim();
    const username = draft.username.trim();
    const password = draft.password;
    const port = Number.parseInt(draft.port, 10);
    if (!host || !username || !password || !Number.isInteger(port) || port < 1 || port > 65535) {
      setError("请填写有效的 host、username、password 和 port。");
      return;
    }
    setIsSaving(true);
    setError(null);
    try {
      const created = await client.createNode({
        auth: {
          method: "password",
          password,
        },
        displayName: draft.displayName.trim() || host,
        provider: "ssh",
        ssh: {
          host,
          port,
          username,
        },
        target: {
          arch: draft.targetArch,
          os: draft.targetOs,
        },
      });
      setDraft((current) => ({ ...current, password: "" }));
      const targetId = `target:${created.node.id}`;
      setBusyTargetId(targetId);
      await client.connectRuntimeTarget(targetId);
      await loadNodes();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyTargetId(null);
      setIsSaving(false);
    }
  }, [client, draft, loadNodes]);

  const connectTarget = React.useCallback(
    async (targetId: string) => {
      setBusyTargetId(targetId);
      setError(null);
      try {
        await client.connectRuntimeTarget(targetId);
        await loadNodes();
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setBusyTargetId(null);
      }
    },
    [client, loadNodes],
  );

  const disconnectTarget = React.useCallback(
    async (targetId: string) => {
      setBusyTargetId(targetId);
      setError(null);
      try {
        await client.disconnectRuntimeTarget(targetId);
        await loadNodes();
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setBusyTargetId(null);
      }
    },
    [client, loadNodes],
  );

  return (
    <main className="vela-settings-page" aria-label="Node settings">
      <div className="vela-settings-content">
        <h1>节点</h1>

        <section className="vela-settings-section" aria-labelledby="node-ssh-title">
          <div className="vela-settings-section-heading">
            <h2 id="node-ssh-title">SSH 主机</h2>
            <p>新增一台 Unix-like 主机，本机 velad 会通过原生 SSH 上传并启动远端 runtime。</p>
          </div>
          <div className="vela-settings-card">
            <div className="vela-settings-form-grid">
              <SettingsFormField label="名称">
                <input
                  className="vela-settings-text-input"
                  aria-label="SSH 节点名称"
                  placeholder="Remote dev"
                  value={draft.displayName}
                  onInput={updateInputDraft("displayName")}
                />
              </SettingsFormField>
              <SettingsFormField label="Host">
                <input
                  aria-label="SSH Host"
                  className="vela-settings-text-input"
                  placeholder="dev.example.com"
                  value={draft.host}
                  onInput={updateInputDraft("host")}
                />
              </SettingsFormField>
              <SettingsFormField label="Port">
                <input
                  aria-label="SSH Port"
                  className="vela-settings-text-input"
                  inputMode="numeric"
                  value={draft.port}
                  onInput={updateInputDraft("port")}
                />
              </SettingsFormField>
              <SettingsFormField label="Username">
                <input
                  aria-label="SSH Username"
                  className="vela-settings-text-input"
                  autoComplete="username"
                  value={draft.username}
                  onInput={updateInputDraft("username")}
                />
              </SettingsFormField>
              <SettingsFormField label="Password">
                <input
                  aria-label="SSH Password"
                  className="vela-settings-text-input"
                  autoComplete="current-password"
                  type="password"
                  value={draft.password}
                  onInput={updateInputDraft("password")}
                />
              </SettingsFormField>
              <SettingsFormField label="Target">
                <div className="vela-settings-inline-fields">
                  <select
                    aria-label="Target OS"
                    className="vela-settings-select-input"
                    value={draft.targetOs}
                    onChange={updateSelectDraft("targetOs")}
                  >
                    <option value="linux">Linux</option>
                    <option value="darwin">macOS</option>
                  </select>
                  <select
                    aria-label="Target architecture"
                    className="vela-settings-select-input"
                    value={draft.targetArch}
                    onChange={updateSelectDraft("targetArch")}
                  >
                    <option value="x86_64">x86_64</option>
                    <option value="amd64">amd64</option>
                  </select>
                </div>
              </SettingsFormField>
            </div>
            <div className="vela-settings-action-row">
              <span>
                <strong>连接策略</strong>
                <small>密码保存到系统 keyring；第一版会立即尝试连接并启动远端 velad。</small>
              </span>
              <button
                className="vela-settings-primary-button"
                disabled={isSaving}
                type="button"
                onClick={createAndConnectNode}
              >
                {isSaving ? <Loader2 size={15} aria-hidden /> : <Plug size={15} aria-hidden />}
                <span>{isSaving ? "连接中" : "新增并连接"}</span>
              </button>
            </div>
            {error ? <div className="vela-settings-error-row">{error}</div> : null}
          </div>
        </section>

        <section className="vela-settings-section" aria-labelledby="node-runtime-title">
          <div className="vela-settings-section-heading">
            <h2 id="node-runtime-title">Runtime targets</h2>
            <p>查看本机和 SSH 节点对应的 runtime 连接状态。</p>
          </div>
          <div className="vela-settings-card">
            {isLoading ? <SettingsInfoRow label="状态" value="加载中" /> : null}
            {!isLoading && targets.length === 0 ? (
              <SettingsInfoRow label="状态" value="暂无 runtime target" />
            ) : null}
            {targets.map((target) => (
              <RuntimeTargetRow
                busy={busyTargetId === target.id}
                key={target.id}
                target={target}
                onConnect={connectTarget}
                onDisconnect={disconnectTarget}
              />
            ))}
          </div>
        </section>

        <section className="vela-settings-section" aria-labelledby="node-saved-title">
          <div className="vela-settings-section-heading">
            <h2 id="node-saved-title">已保存节点</h2>
          </div>
          <div className="vela-settings-card">
            {!isLoading && nodes.length === 0 ? (
              <SettingsInfoRow label="状态" value="还没有 SSH 节点" />
            ) : null}
            {nodes.map((node) => (
              <NodeSettingsRow
                key={node.id}
                node={node}
                target={targetByNodeId.get(node.id)}
              />
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}

function SettingsFormField({
  children,
  label,
}: {
  children: React.ReactNode;
  label: string;
}) {
  return (
    <label className="vela-settings-form-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function RuntimeTargetRow({
  busy,
  onConnect,
  onDisconnect,
  target,
}: {
  busy: boolean;
  onConnect: (targetId: string) => void;
  onDisconnect: (targetId: string) => void;
  target: RuntimeTargetWire;
}) {
  const isConnected = target.status === "ready" || target.status === "connected";
  const isTransitioning = target.status === "connecting" || target.status === "reconnecting";
  const canConnect = target.kind === "remote" && !isConnected && !isTransitioning;
  const canDisconnect = target.kind === "remote" && isConnected;
  return (
    <div className="vela-settings-row" data-runtime-target-id={target.id}>
      <span>
        <strong>{target.display_name}</strong>
        <small>{runtimeTargetDetail(target)}</small>
      </span>
      <div className="vela-settings-row-actions">
        <output data-runtime-status={target.status}>{runtimeStatusLabel(target.status)}</output>
        {canConnect ? (
          <button
            className="vela-settings-secondary-button"
            disabled={busy}
            type="button"
            onClick={() => onConnect(target.id)}
          >
            {busy ? "连接中" : "连接"}
          </button>
        ) : null}
        {canDisconnect ? (
          <button
            className="vela-settings-secondary-button"
            disabled={busy}
            type="button"
            onClick={() => onDisconnect(target.id)}
          >
            {busy ? "断开中" : "断开"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function NodeSettingsRow({ node, target }: { node: NodeWire; target?: RuntimeTargetWire }) {
  return (
    <div className="vela-settings-row" data-node-id={node.id}>
      <span>
        <strong>{node.display_name}</strong>
        <small>
          {node.ssh.username}@{node.ssh.host}:{node.ssh.port} · {node.target.os}/
          {node.target.arch}
        </small>
      </span>
      <output>{target ? runtimeStatusLabel(target.status) : "未连接"}</output>
    </div>
  );
}

function runtimeTargetDetail(target: RuntimeTargetWire) {
  if (target.kind === "local") return "本机 velad";
  const apiBaseUrl =
    typeof target.transport.api_base_url === "string" ? target.transport.api_base_url : "";
  const remoteAddr =
    typeof target.transport.remote_listen_addr === "string"
      ? target.transport.remote_listen_addr
      : "";
  return [remoteAddr, apiBaseUrl].filter(Boolean).join(" · ") || "SSH remote velad";
}

function runtimeStatusLabel(status: RuntimeTargetWire["status"]) {
  switch (status) {
    case "ready":
    case "connected":
      return "已连接";
    case "connecting":
      return "连接中";
    case "reconnecting":
      return "重连中";
    case "degraded":
      return "降级";
    case "failed":
    case "error":
      return "失败";
    case "disconnected":
      return "未连接";
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function usageDetail(usage: BackendUsageWireResponse | undefined) {
  if (!usage) return "正在读取 backend usage";
  if (usage.detail) return usage.detail;
  const limits = usage.limits.map((limit) =>
    limit.used_percent === undefined
      ? limit.label
      : `${limit.label} 已用 ${Math.round(limit.used_percent)}%`,
  );
  return limits.length > 0 ? limits.join(" · ") : usage.source;
}

function SettingsNavGroup({
  activePanel,
  items,
  onPanelChange,
  title,
}: {
  activePanel: DesktopSettingsPanelId;
  items: Array<{ icon: typeof Bot; id: DesktopSettingsPanelId; label: string }>;
  onPanelChange: (panel: DesktopSettingsPanelId) => void;
  title: string;
}) {
  return (
    <div className="vela-settings-nav-group">
      <div className="vela-settings-nav-title">{title}</div>
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <button
            className="vela-settings-nav-item"
            data-active={item.id === activePanel ? "true" : undefined}
            key={item.label}
            onClick={() => onPanelChange(item.id)}
            type="button"
          >
            <Icon size={16} aria-hidden />
            <span>{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function DesktopSettingsArchivePanel() {
  return (
    <main className="vela-settings-page" aria-label="Archived chats settings">
      <div className="vela-settings-content">
        <h1>已归档对话</h1>
        <section className="vela-settings-section" aria-labelledby="archive-title">
          <div className="vela-settings-section-heading">
            <h2 id="archive-title">归档对话</h2>
            <p>这里将用于管理从会话列表中归档的对话。</p>
          </div>
          <div className="vela-settings-card">
            <SettingsInfoRow label="状态" value="即将支持" />
          </div>
        </section>
      </div>
    </main>
  );
}

function DesktopSettingsAboutPanel({
  appVersion,
  hostLabel,
}: {
  appVersion: string;
  hostLabel: string;
}) {
  return (
    <main className="vela-settings-page" aria-label="About LightVela">
      <div className="vela-settings-content">
        <section className="vela-settings-about-hero" aria-labelledby="about-title">
          <div className="vela-settings-about-mark" aria-hidden>
            <Sparkles size={28} />
          </div>
          <div>
            <h1 id="about-title">关于 LightVela</h1>
            <p>云端专属个人 Agent，随时唤醒，数据由你掌控。</p>
          </div>
        </section>

        <section className="vela-settings-section" aria-labelledby="about-version-title">
          <div className="vela-settings-card">
            <SettingsInfoRow label="当前版本" value={appVersion} />
            <SettingsInfoRow label="运行环境" value={hostLabel} />
          </div>
        </section>

        <section className="vela-settings-section" aria-labelledby="about-lightvela-title">
          <div className="vela-settings-section-heading">
            <h2 id="about-lightvela-title">LightVela</h2>
            <p>参考 LightVela 云端原生体验：轻量、在线、可掌控。</p>
          </div>
          <div className="vela-settings-about-grid">
            <AboutFeatureCard
              title="7×24H 在线"
              description="智能伙伴在云端保持可用，电脑和手机都可以随时继续。"
            />
            <AboutFeatureCard
              title="数据归属"
              description="会话和运行数据保存在你的专属空间，后续可管理、可迁移。"
            />
            <AboutFeatureCard
              title="本地运行时"
              description="桌面版内置运行时能力，尽量减少对本机外部服务的依赖。"
            />
          </div>
        </section>

        <section className="vela-settings-section" aria-labelledby="about-links-title">
          <div className="vela-settings-section-heading">
            <h2 id="about-links-title">探索 LightVela</h2>
          </div>
          <div className="vela-settings-about-links">
            {aboutLinks.map((link) => (
              <a href={link.href} key={link.href} rel="noreferrer" target="_blank">
                {link.label}
                <ExternalLink size={13} aria-hidden />
              </a>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}

function AboutFeatureCard({
  description,
  title,
}: {
  description: string;
  title: string;
}) {
  return (
    <article className="vela-settings-about-card">
      <strong>{title}</strong>
      <p>{description}</p>
    </article>
  );
}

function SettingsSettingRow<T extends string | boolean>({
  setting,
}: {
  setting: VelaSetting<T>;
}) {
  const state = useVelaSetting(setting);
  const errorDescription = state.error ? `保存失败：${state.error.message}` : null;
  const description = errorDescription ?? setting.description;

  return (
    <div className="vela-settings-row" data-setting-id={setting.id}>
      <span>
        <strong>{setting.title}</strong>
        {description ? <small>{description}</small> : null}
      </span>
      <SettingsSettingControl setting={setting} state={state} />
    </div>
  );
}

function SettingsSettingControl<T extends string | boolean>({
  setting,
  state,
}: {
  setting: VelaSetting<T>;
  state: ReturnType<typeof useVelaSetting<T>>;
}) {
  if (setting.control === "readonly") {
    return <output>{state.isLoading ? "加载中" : String(state.value ?? "")}</output>;
  }

  if (setting.control === "select") {
    const options = setting.options ?? [];
    return (
      <ShellSelect
        ariaLabel={setting.title}
        disabled={!state.canSave || state.isLoading || state.isSaving || options.length === 0}
        emptyLabel="未连接"
        options={options.map((option) => ({
          id: String(option.value),
          label: option.label,
          description: option.description,
        }))}
        placeholder="未连接"
        value={state.value === undefined ? "" : String(state.value)}
        onValueChange={(value) => {
          const optionValue =
            options.find((option) => String(option.value) === value)?.value ??
            (value as T);
          void state.setValue(optionValue);
        }}
      />
    );
  }

  if (setting.control === "switch") {
    return (
      <ShellSwitch
        ariaLabel={setting.title}
        defaultChecked={Boolean(state.value)}
        key={`${setting.id}:${String(state.value)}`}
        onCheckedChange={(checked) => {
          void state.setValue(checked as T);
        }}
      />
    );
  }

  if (setting.control === "text") {
    return <SettingsTextInput setting={setting} state={state} />;
  }

  return <output>{state.isLoading ? "加载中" : String(state.value ?? "")}</output>;
}

function SettingsTextInput<T extends string | boolean>({
  setting,
  state,
}: {
  setting: VelaSetting<T>;
  state: ReturnType<typeof useVelaSetting<T>>;
}) {
  const [draft, setDraft] = React.useState("");
  const isFocusedRef = React.useRef(false);
  const loadedValue = state.value === undefined ? "" : String(state.value);

  React.useEffect(() => {
    if (!isFocusedRef.current) setDraft(loadedValue);
  }, [loadedValue]);

  const commitDraft = React.useCallback(async () => {
    if (!state.canSave || draft === loadedValue) return;
    await state.setValue(draft as T);
  }, [draft, loadedValue, state]);

  return (
    <input
      aria-label={setting.title}
      className="vela-settings-text-input"
      disabled={!state.canSave || (state.isLoading && state.value === undefined)}
      spellCheck={false}
      type={setting.inputType ?? "text"}
      value={draft}
      onBlur={() => {
        isFocusedRef.current = false;
        void commitDraft();
      }}
      onInput={(event) => {
        setDraft(event.currentTarget.value);
      }}
      onFocus={() => {
        isFocusedRef.current = true;
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.currentTarget.blur();
        }
      }}
    />
  );
}

function SettingsInfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="vela-settings-row">
      <span>
        <strong>{label}</strong>
      </span>
      <output>{value}</output>
    </div>
  );
}
