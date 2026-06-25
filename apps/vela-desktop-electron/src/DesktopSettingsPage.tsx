import {
  Archive,
  ArrowLeft,
  Bot,
  Check,
  ExternalLink,
  Info,
  Search,
  Settings,
  Sparkles,
  TerminalSquare,
} from "lucide-react";
import React from "react";
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
  hostLabel: string;
  logPath?: string;
  selectedBackend: BackendKindWire | "";
  sessionsCount: number;
  onSelectedBackendChange: (backend: BackendKindWire) => void;
}

export type DesktopSettingsPanelId = "general" | "archive" | "about";

const settingsPanels = [
  { icon: Settings, id: "general", label: "常规" },
  { icon: Archive, id: "archive", label: "已归档对话" },
  { icon: Info, id: "about", label: "关于 LightVela" },
] satisfies Array<{
  icon: typeof Settings;
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
  hostLabel,
  logPath,
  selectedBackend,
  sessionsCount,
  onSelectedBackendChange,
}: DesktopSettingsPageProps) {
  const settings = React.useMemo(
    () =>
      createDesktopSettings({
        backends,
        onSelectedBackendChange,
        selectedBackend,
      }),
    [backends, onSelectedBackendChange, selectedBackend],
  );

  if (activePanel === "about") {
    return <DesktopSettingsAboutPanel appVersion={appVersion} hostLabel={hostLabel} />;
  }

  if (activePanel === "archive") {
    return <DesktopSettingsArchivePanel />;
  }

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
            {settings.map((setting) => (
              <SettingsSettingRow key={setting.id} setting={setting} />
            ))}
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
  activePanel,
  items,
  onPanelChange,
  title,
}: {
  activePanel: DesktopSettingsPanelId;
  items: Array<{ icon: typeof Settings; id: DesktopSettingsPanelId; label: string }>;
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
    return (
      <input
        aria-label={setting.title}
        className="vela-settings-text-input"
        disabled={!state.canSave || state.isLoading || state.isSaving}
        spellCheck={false}
        type={setting.inputType ?? "text"}
        value={state.value === undefined ? "" : String(state.value)}
        onChange={(event) => {
          void state.setValue(event.currentTarget.value as T);
        }}
      />
    );
  }

  return <output>{state.isLoading ? "加载中" : String(state.value ?? "")}</output>;
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
