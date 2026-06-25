import {
  Archive,
  ArrowLeft,
  Bot,
  ExternalLink,
  Info,
  Search,
  Sparkles,
} from "lucide-react";
import React from "react";
import type {
  BackendKindWire,
  BackendWire,
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
  hostLabel: string;
  client: VeladClient;
  selectedBackend: BackendKindWire | "";
  onBackendSettingsChange?: () => Promise<void> | void;
  onSelectedBackendChange: (backend: BackendKindWire) => void;
}

export type DesktopSettingsPanelId = "engine" | "archive" | "about";

const settingsPanels = [
  { icon: Bot, id: "engine", label: "引擎" },
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
      return <DesktopSettingsEnginePanel apiBaseUrl={apiBaseUrl} settings={settings} />;
  }
}

function DesktopSettingsEnginePanel({
  apiBaseUrl,
  settings,
}: {
  apiBaseUrl: string;
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
