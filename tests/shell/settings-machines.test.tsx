import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IntlProvider, useIntl } from "react-intl";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import { groupWorkInMachines, type HostConnectionProfile, type EnvironmentEntry } from "@opencraft/workbench-runtime";
import { createApplicationNavigation } from "../../apps/workbench-web/src/runtime/workbench-navigation";
import { SidebarLayoutStore } from "@opencraft/sidebar-layout";
import messages from "../../apps/workbench-web/src/i18n/locales/zh-CN.json";

const identity = { machineId: "12345678-1234-4123-8123-123456789abc", name: "我的服务器", platform: "linux" as const };
function profile(hostId: string, agent: string): HostConnectionProfile {
  return { hostId, agent, machineIdentity: identity, displayName: hostId, providerId: "opencraft.builtin-agents", providerConfig: { url: `ws://server/${hostId}?token=secret` }, providerConfigVersion: 1, hostKind: "local", enabled: true, autoConnect: false, includeInSidebar: true, credentialRef: null, transportEndpoint: null, executionLocation: null, workspaceBrowseRoots: [], revision: 0 };
}

test("settings render machine ownership, cold/failed connections, first-level navigation history and localized sidebar labels", async context => {
  const directory = await mkdtemp(join(process.cwd(), "node_modules/.settings-machines-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const bundle = join(directory, "page.cjs");
  await build({
    stdin: { contents: 'export * from "./apps/workbench-web/src/components/settings-machines"; export { SettingsNavigation } from "./apps/workbench-web/src/components/settings-page"; export { ConnectionLabel } from "./apps/workbench-web/src/components/target-connection-status"; export { SidebarBots, SidebarEntityDndCoordinator } from "./apps/workbench-web/src/components/sidebar-bots"; export { NavigationContent } from "./apps/workbench-web/src/components/shell-navigation/navigation-content";', resolveDir: process.cwd(), loader: "ts" },
    outfile: bundle, bundle: true, platform: "node", format: "cjs", jsx: "automatic",
    external: ["react", "react/*", "react-dom", "react-dom/*", "react-intl"],
    define: { "import.meta.env": "{}" },
    loader: { ".scss": "empty", ".css": "empty", ".svg": "dataurl" },
    plugins: [{ name: "runtime-boundary", setup(builder) {
      builder.onResolve({ filter: /appearance-theme$/ }, () => ({ path: "appearance", namespace: "test-appearance" }));
      builder.onLoad({ filter: /.*/, namespace: "test-appearance" }, () => ({ contents: 'export const getAppearanceThemePreviewProperties = () => ({});', loader: "js" }));
      builder.onResolve({ filter: /appserver-runtime-context$/ }, () => ({ path: "runtime", namespace: "test" }));
      builder.onLoad({ filter: /.*/, namespace: "test" }, () => ({ contents: 'export const useMachineConnectionPhase = () => "ready"; export const useHostConnectionPhase = id => id === "local-codex" ? "error" : "ready";', loader: "js" }));
    }}], logLevel: "silent",
  });
  const { SettingsMachines, SettingsMachine, MachineConnectionsAvailable, SettingsNavigation, ConnectionLabel, SidebarBots, SidebarEntityDndCoordinator, NavigationContent } = createRequire(import.meta.url)(bundle);
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { href: "http://fixture.test" }, history: { state: null } } });
  context.after(() => previous ? Object.defineProperty(globalThis, "window", previous) : Reflect.deleteProperty(globalThis, "window"));
  const hosts = [profile("local", "OpenCraft"), profile("local-codex", "Codex"), profile("alias", "OpenCraft")];
  const unknown = { ...profile("unknown", "Hermes"), machineIdentity: null };
  const cloud = { ...profile("cloud", "Hermes"), displayName: "云环境", enabled: false };
  const entry: EnvironmentEntry = { id: "cloud", sourceId: "fixture-cloud", name: "云环境", location: "region", profile: cloud, connectable: true,
    resource: { providerId: "fixture-cloud", phase: "suspended", rawPhase: "stopped", message: null, capabilities: { suspend: false, resume: true, remove: true } } };
  const machines = groupWorkInMachines([...hosts, unknown, cloud], [entry]);
  const render = (component: React.ReactNode) => renderToStaticMarkup(<IntlProvider locale="zh-CN" defaultLocale="en" messages={messages}>{component}</IntlProvider>);
  const onSectionChange = () => { throw new Error("render must be read-only"); };
  const list = render(<SettingsMachines machines={machines} platform="web" onSectionChange={onSectionChange} />);
  assert.equal((list.match(/settings-control-list-item"/g) ?? []).length, 3);
  assert.equal((list.match(/>机器<\/h[123]>/g) ?? []).length, 1);
  assert.match(list, /我的服务器/); assert.match(list, /未知机器 · unknown/); assert.match(list, /云端/); assert.match(list, /已暂停/);
  const pages = [
    { id: "model", title: "模型服务", targetHostId: "local", viewId: "model-view" },
    { id: "codex", title: "Codex 账户", targetHostId: "local-codex", viewId: "codex-view" },
    { id: "other", title: "其他机器设置", targetHostId: "unknown", viewId: "other-view" },
  ];
  const detail = render(<SettingsMachine machine={machines[0]} pages={pages} platform="web" onSectionChange={onSectionChange} />);
  assert.match(detail, /Linux · 服务端/); assert.match(detail, /模型服务/); assert.match(detail, /Codex 账户/);
  assert.doesNotMatch(detail, /其他机器设置|secret|项目|这台/);
  assert.equal((detail.match(/settings-control-row__label">OpenCraft/g) ?? []).length, 3, "one Agent row and two connection rows");
  assert.match(detail, /ws:\/\/server\/local-codex/); assert.match(detail, /连接失败/);
  const desktop = render(<SettingsMachine machine={machines[0]} pages={pages} platform="electron" onSectionChange={onSectionChange} />);
  assert.match(desktop, /这台电脑/);
  const mac = { ...machines[0], identity: { ...identity, platform: "macos" } };
  assert.match(render(<SettingsMachine machine={mac} pages={pages} platform="electron" onSectionChange={onSectionChange} />), /这台 Mac/);
  const empty = render(<SettingsMachines machines={[]} platform="web" onSectionChange={onSectionChange} />);
  assert.match(empty, /暂无机器/);
  const hostless = render(<MachineConnectionsAvailable.Provider value={false}><SettingsMachine machine={machines[2]} pages={[]} platform="web" onSectionChange={onSectionChange} /></MachineConnectionsAvailable.Provider>);
  assert.match(render(<ConnectionLabel phase="idle" showLabel />), /未启动/);
  assert.match(render(<ConnectionLabel phase="error" showLabel />), /连接失败/);
  assert.match(render(<ConnectionLabel phase="reconnecting" showLabel />), /重新连接中/);
  assert.match(hostless, /未启动/); assert.match(hostless, /已暂停/); assert.doesNotMatch(hostless, /已连接/);
  const layout = await SidebarLayoutStore.open({ load: async () => null, save: async (_scope, document) => document });
  context.after(() => layout.close());
  const creation = { noun: "Bot", targets: [], create: async () => { throw new Error("render must not create a Bot"); } };
  const sidebar = <SidebarEntityDndCoordinator items={[]} layout={layout}><SidebarBots items={[]} creation={creation} /></SidebarEntityDndCoordinator>;
  const chineseSidebar = render(sidebar);
  assert.match(chineseSidebar, /aria-label="机器人"/);
  assert.match(chineseSidebar, /aria-label="创建机器人"/);
  assert.doesNotMatch(chineseSidebar, />Bots</);
  const englishSidebar = renderToStaticMarkup(<IntlProvider locale="en" defaultLocale="en">{sidebar}</IntlProvider>);
  assert.match(englishSidebar, /aria-label="Bots"/); assert.match(englishSidebar, />Bots</); assert.match(englishSidebar, /aria-label="Create Bot"/);
  assert.match(render(<NavigationContent config={{ actions: [], account: null, onOpenSettings: onSectionChange }} surface="applications" onInvoke={onSectionChange} />), /aria-label="应用"/);
  function BotNavigationFixture() {
    const intl = useIntl();
    return <NavigationContent config={{ actions: [{ id: "opencraft.bot-management.navigation", title: intl.formatMessage({ id: "sidebar.bots", defaultMessage: "Bots" }), icon: "bot", active: false, onInvoke: () => {} }], account: null, onOpenSettings: () => {} }} surface="applications" compact onInvoke={() => {}} />;
  }
  const botNavigation = <BotNavigationFixture />;
  assert.match(render(botNavigation), /aria-label="机器人"/);
  assert.doesNotMatch(render(botNavigation), />Bots</);
  assert.match(renderToStaticMarkup(<IntlProvider locale="en" defaultLocale="en">{botNavigation}</IntlProvider>), /aria-label="Bots"/);
  const modelId = "opencraft.builtin-agents.model-services";
  const codexId = "opencraft.builtin-agents.codex-accounts";
  const customId = "example.engine.models";
  const snapshot = { settingsPages: [
    { contribution: { ...pages[0], id: modelId } },
    { contribution: { ...pages[1], id: codexId } },
    { contribution: { id: customId, title: "Custom engine models", viewId: "example.engine.view", targetHostId: "alias", order: 2 } },
    { contribution: { id: "example.disabled", title: "Disabled engine", viewId: "example.disabled.view", targetHostId: "cloud" } },
  ] };
  const contributions = { subscribe: () => () => {}, getSnapshot: () => snapshot };
  const nav = createApplicationNavigation(null, { mode: "memory", initialEntries: ["/settings/appearance"] });
  context.after(() => nav.dispose());
  const assertDestination = (slug: string, label: string) => {
    assert.deepEqual(nav.getSnapshot().applicationRoute, { kind: "settings", slug });
    const markup = render(<SettingsNavigation section={slug} onSectionChange={next => nav.openSettings(next)} extensionContributions={contributions} profiles={hosts} machines={machines} activeHostId="local" onBack={() => nav.back()} />);
    const selected = [...markup.matchAll(/<button[^>]*aria-current="page"[^>]*>(.*?)<\/button>/g)];
    assert.equal(selected.length, 1);
    assert.ok(selected[0]![1]!.includes(label), `${label} must be the only highlighted entry`);
    assert.ok(markup.indexOf("模型服务") < markup.indexOf("Codex 账户"));
    assert.ok(markup.indexOf("Codex 账户") < markup.indexOf(">机器<"));
  };
  const genericNavigation = render(<SettingsNavigation section={customId} onSectionChange={next => nav.openSettings(next)} extensionContributions={contributions} profiles={[...hosts, cloud]} machines={machines} activeHostId="local" onBack={() => nav.back()} />);
  assert.match(genericNavigation, /aria-current="page"[^>]*><[^>]*[\s\S]*Custom engine models/);
  assert.doesNotMatch(genericNavigation, /Disabled engine/);
  nav.openSettings(modelId); assert.equal(nav.getSnapshot().action, "push"); assertDestination(modelId, "模型服务");
  nav.openSettings(codexId); assertDestination(codexId, "Codex 账户");
  nav.back(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(nav.getSnapshot().action, "pop"); assertDestination(modelId, "模型服务");
  nav.forward(); await new Promise(resolve => setImmediate(resolve)); assertDestination(codexId, "Codex 账户");
  nav.openSettings(customId); assertDestination(customId, "Custom engine models");
  nav.openSettings("machines"); assertDestination("machines", "机器");
  const machineSection = `machine-${encodeURIComponent(machines[0]!.id)}`;
  nav.openSettings(machineSection); assertDestination(machineSection, "机器");
  nav.openSettings(modelId); assertDestination(modelId, "模型服务");
  nav.back(); await new Promise(resolve => setImmediate(resolve)); assertDestination(machineSection, "机器");
  nav.forward(); await new Promise(resolve => setImmediate(resolve)); assertDestination(modelId, "模型服务");
});
