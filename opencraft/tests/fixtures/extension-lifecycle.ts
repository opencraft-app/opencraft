import { Context } from "@deepseek-ai/cordis";
import { ExtensionSupervisor, ExtensionManager, createPersistentExtensionInstallations, provideExtensionInstallationRepository } from "@opencraft/extension-runtime";
import { openIndexedDbExtensionPersistence } from "../../apps/workbench-web/src/runtime/indexeddb-extension-persistence";
import { BrowserModuleUrlExtensionLoader } from "../../apps/workbench-web/src/runtime/module-url-extension-loader";
import React from "react";
import { createPortal } from "react-dom";
import { HermesSkillsManagementView } from "../../plugins/lightvela-hermes/src/settings/hermes-skills-management-view";
import type { LightVelaAccountService } from "../../plugins/lightvela-hermes/src/account/lightvela-account-service";
import { ExtensionLibrary } from "../../apps/workbench-web/src/components/extensions/extension-library";
import { AppShellToolbarSelect } from "../../apps/workbench-web/src/components/app-shell-toolbar-select";
import { createIntlTestRoot } from "./intl-root";
import { SettingsContent } from "../../apps/workbench-web/src/components/settings-page";
import { setInternalDeveloperMode } from "../../apps/workbench-web/src/internal-developer-mode";
import { PlatformViewRendererRegistry } from "@opencraft/extension-react";
import "../../apps/workbench-web/src/styles/app.scss";
import { initializeAppearanceTheme } from "../../apps/workbench-web/src/appearance-theme";

initializeAppearanceTheme();

const backend = await openIndexedDbExtensionPersistence("extension-browser-proof");
const persistence = await createPersistentExtensionInstallations(backend);
const context = new Context();
await context.plugin(provideExtensionInstallationRepository(persistence));
const supervisor = new ExtensionSupervisor({ platform: "web" });
const manager = new ExtensionManager({ installations: context.extensionInstallations, supervisor, loader: new BrowserModuleUrlExtensionLoader() });
await manager.restore();
setInternalDeveloperMode(true);
const root = document.createElement("div");
document.body.append(root);
const skills = new URLSearchParams(location.search).has("skills");
const settings = React.createElement(SettingsContent, {
  section: "plugins", onSectionChange() {}, profiles: [], activeHostId: "", themes: [], themeId: "vela.core.codex",
  themePreference: "light", onThemeChange() {}, onThemePreferenceChange() {}, onOpenAnnouncementLab() {},
  onRemove: async () => false, onProvisionHost: async () => { throw new Error("No provisioning in this fixture"); },
  onOpenView() {}, onPushViewResource() {}, onReplaceViewResource() {},
  extensionContributions: supervisor.contributions, extensionManager: manager, platformViewRenderers: new PlatformViewRendererRegistry(),
});
if (skills) {
  await supervisor.activate({ manifest: { manifestVersion: 1, id: "example.builtin", name: "Built-in example", version: "1.0.0", apiVersion: 1, trust: "trusted", platforms: ["web"], activationEvents: ["onStartupFinished"] }, activate() {} });
  const header = document.createElement("header"); document.body.prepend(header);
  const account = { execDebugCommand: async () => "", execDebugCommandStream: async () => {}, resetInstanceConfig: async () => {}, request: async () => ({}) } as unknown as LightVelaAccountService;
  createIntlTestRoot(root).render(React.createElement(HermesSkillsManagementView, {
    account, botId: "", host: { platform: "web", activeHostId: "", profiles: [], provisionHost: async () => { throw Error("unavailable"); }, removeHost: async () => false, openView() {}, pushViewResource() {}, replaceViewResource() {} },
    headerRegion: ({ children }) => createPortal(children, header), toolbarSelect: AppShellToolbarSelect,
    extensionLibrary: () => React.createElement(ExtensionLibrary, { manager, supervisor }),
  }));
} else createIntlTestRoot(root).render(settings);
Object.assign(window, { extensionProof: {
  developer: setInternalDeveloperMode,
  install: () => manager.installModuleUrl(`${location.origin}/candidate.mjs`),
  reload: () => manager.reload("example.browser"),
  toggle: (enabled: boolean) => manager.setEnabled("example.browser", enabled),
  remove: () => manager.remove("example.browser"),
  run: () => supervisor.contributions.executeCommand("example.browser.run"),
  snapshot: () => manager.getSnapshot().extensions.map(({ installation, status }) => ({ status, enabled: installation.enabled, version: installation.lastResolvedManifest?.version })),
} });
document.body.dataset.ready = "true";
