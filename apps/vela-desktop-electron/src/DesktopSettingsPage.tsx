import {
  Archive,
  ArrowLeft,
  Bot,
  Check,
  CircleUserRound,
  Code2,
  FolderTree,
  Gauge,
  GitBranch,
  Keyboard,
  MonitorCog,
  Palette,
  PlugZap,
  Search,
  ServerCog,
  Settings,
  SlidersHorizontal,
  Sparkles,
  TerminalSquare,
} from "lucide-react";
import type {
  BackendKindWire,
  BackendWire,
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

export interface DesktopSettingsSidebarProps {
  onClose: () => void;
  showTrafficLights?: boolean;
}

export interface DesktopSettingsPageProps {
  apiBaseUrl: string;
  backends: BackendWire[];
  hostLabel: string;
  logPath?: string;
  selectedBackend: BackendKindWire | "";
  sessionsCount: number;
  onSelectedBackendChange: (backend: BackendKindWire) => void;
}

const personalSettings = [
  { icon: Settings, label: "常规", active: true },
  { icon: CircleUserRound, label: "个人资料" },
  { icon: Palette, label: "外观" },
  { icon: SlidersHorizontal, label: "配置" },
  { icon: Sparkles, label: "个性化" },
  { icon: Bot, label: "Pets" },
  { icon: Keyboard, label: "键盘快捷键" },
  { icon: Gauge, label: "使用情况和计费" },
];

const integrationSettings = [
  { icon: MonitorCog, label: "应用快照" },
  { icon: PlugZap, label: "MCP 服务器" },
  { icon: ServerCog, label: "浏览器" },
  { icon: Bot, label: "电脑操控" },
];

const codingSettings = [
  { icon: TerminalSquare, label: "钩子" },
  { icon: PlugZap, label: "连接" },
  { icon: GitBranch, label: "Git" },
  { icon: Code2, label: "环境" },
  { icon: FolderTree, label: "工作树" },
];

export function DesktopSettingsSidebar({
  onClose,
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
          <SettingsNavGroup title="个人" items={personalSettings} />
          <SettingsNavGroup title="集成" items={integrationSettings} />
          <SettingsNavGroup title="编码" items={codingSettings} />
          <SettingsNavGroup
            title="已归档"
            items={[{ icon: Archive, label: "已归档对话" }]}
          />
          </SidebarScrollRegion>
        </SidebarContent>
      </SidebarMaterialFrame>
    </Sidebar>
  );
}

export function DesktopSettingsPage({
  apiBaseUrl,
  backends,
  hostLabel,
  logPath,
  selectedBackend,
  sessionsCount,
  onSelectedBackendChange,
}: DesktopSettingsPageProps) {
  const resolvedBackend =
    backends.find((backend) => backend.kind === selectedBackend) ?? backends[0] ?? null;

  return (
    <main className="vela-settings-page" aria-label="Settings">
      <div className="vela-settings-content">
        <h1>常规</h1>

        <section className="vela-settings-section" aria-labelledby="work-mode-title">
          <div className="vela-settings-section-heading">
            <h2 id="work-mode-title">工作模式</h2>
            <p>选择 Vela 显示多少技术细节</p>
          </div>
          <div className="vela-settings-choice-grid">
            <button className="vela-settings-choice is-selected" type="button">
              <TerminalSquare size={18} aria-hidden />
              <span>
                <strong>适用于编程</strong>
                <small>更具技术性的回复和控制</small>
              </span>
              <span className="vela-settings-radio" aria-hidden />
            </button>
            <button className="vela-settings-choice" type="button">
              <Bot size={18} aria-hidden />
              <span>
                <strong>适用于日常工作</strong>
                <small>同样强大，技术细节更少</small>
              </span>
              <span className="vela-settings-radio" aria-hidden />
            </button>
          </div>
        </section>

        <section className="vela-settings-section" aria-labelledby="backend-title">
          <div className="vela-settings-section-heading">
            <h2 id="backend-title">Backend</h2>
            <p>选择新建会话默认连接的 agent backend</p>
          </div>
          <div className="vela-settings-card">
            <div className="vela-settings-row">
              <span>
                <strong>默认 backend</strong>
                <small>
                  当前可用：{resolvedBackend?.display_name ?? "等待 velad 返回 backends"}
                </small>
              </span>
              <ShellSelect
                ariaLabel="Select default backend"
                disabled={backends.length === 0}
                emptyLabel="未连接"
                options={backends.map((backend) => ({
                  id: backend.kind,
                  label: backend.display_name,
                  description:
                    backend.status === "available"
                      ? "Available"
                      : backend.status === "degraded"
                        ? "Degraded"
                        : "Unavailable",
                }))}
                placeholder="未连接"
                value={resolvedBackend?.kind ?? ""}
                onValueChange={(backend) =>
                  onSelectedBackendChange(backend as BackendKindWire)
                }
              />
            </div>
            <SettingsInfoRow label="velad API" value={apiBaseUrl} />
            <SettingsInfoRow label="Shell host" value={hostLabel} />
            {logPath ? <SettingsInfoRow label="Local logs" value={logPath} /> : null}
            <SettingsInfoRow label="Session cache" value={`${sessionsCount} sessions`} />
          </div>
        </section>

        <section className="vela-settings-section" aria-labelledby="permission-title">
          <div className="vela-settings-section-heading">
            <h2 id="permission-title">权限</h2>
          </div>
          <div className="vela-settings-card">
            <SettingsToggleRow
              title="默认权限"
              description="默认情况下，Vela 可以读取并编辑其工作区中的文件。"
            />
            <SettingsToggleRow
              title="自动审核"
              description="Vela 会自动审核额外访问权限请求。自动审核可能会出错。"
            />
            <SettingsToggleRow
              title="完全访问权限"
              description="以完全访问权限运行时，无需你批准即可编辑文件并运行联网命令。"
            />
          </div>
        </section>

        <section className="vela-settings-section" aria-labelledby="general-title">
          <div className="vela-settings-section-heading">
            <h2 id="general-title">常规</h2>
          </div>
          <div className="vela-settings-card">
            <SettingsInfoRow label="默认打开目标" value="VS Code" />
            <SettingsInfoRow label="语言" value="自动检测" />
            <SettingsToggleRow
              title="在菜单栏中显示"
              description="关闭主窗口后，仍在 macOS 菜单栏中保留 Vela"
            />
            <SettingsToggleRow
              title="底部面板"
              description="在应用标题栏中显示底部面板控件"
            />
            <SettingsSegmentRow label="默认终端位置" values={["底部", "右侧"]} />
            <SettingsToggleRow
              title="运行时防止休眠"
              description="在 Vela 运行对话时，让电脑保持唤醒状态"
            />
          </div>
        </section>
      </div>
    </main>
  );
}

function SettingsNavGroup({
  items,
  title,
}: {
  items: Array<{ active?: boolean; icon: typeof Settings; label: string }>;
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
            data-active={item.active ? "true" : undefined}
            key={item.label}
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

function SettingsToggleRow({
  description,
  defaultChecked = true,
  onCheckedChange,
  title,
}: {
  defaultChecked?: boolean;
  description: string;
  onCheckedChange?: (checked: boolean) => void;
  title: string;
}) {
  return (
    <div className="vela-settings-row">
      <span>
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
      <ShellSwitch
        ariaLabel={title}
        defaultChecked={defaultChecked}
        onCheckedChange={onCheckedChange}
      />
    </div>
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

function SettingsSegmentRow({
  label,
  values,
}: {
  label: string;
  values: string[];
}) {
  return (
    <div className="vela-settings-row">
      <span>
        <strong>{label}</strong>
        <small>选择终端快捷键和环境操作在何处打开终端标签页</small>
      </span>
      <div className="vela-settings-segment" role="group" aria-label={label}>
        {values.map((value, index) => (
          <button
            className={index === 0 ? "is-selected" : undefined}
            key={value}
            type="button"
          >
            {index === 0 ? <Check size={13} aria-hidden /> : null}
            {value}
          </button>
        ))}
      </div>
    </div>
  );
}
