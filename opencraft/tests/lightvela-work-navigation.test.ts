import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildCodexThemeCssProperties } from "@opencraft/design-system/theme-engine";
import { isLightVelaStandaloneManagementSection } from "../apps/workbench-web/src/components/lightvela-management-route";
import { machineResourcePhaseLabel } from "../apps/workbench-web/src/components/machine-resource-presentation";

test("Skills and Cloud Storage use standalone management routes from the Work sidebar group", () => {
  assert.equal(isLightVelaStandaloneManagementSection("lightvela.hermes.skills"), true);
  assert.equal(isLightVelaStandaloneManagementSection("lightvela.hermes.storage"), true);
  assert.equal(isLightVelaStandaloneManagementSection("lightvela.hermes.channels"), false);
  assert.equal(isLightVelaStandaloneManagementSection("lightvela.hermes.schedules"), false);
  assert.equal(isLightVelaStandaloneManagementSection("lightvela.hermes.runtime"), false);
});

test("the active Work route keeps the shared sidebar selected state", () => {
  const navigation = readFileSync(
    new URL("../apps/workbench-web/src/components/lightvela-work-navigation.tsx", import.meta.url),
    "utf8",
  );
  const styles = readFileSync(
    new URL("../apps/workbench-web/src/styles/app.scss", import.meta.url),
    "utf8",
  );
  const workNavigationStyles = styles.slice(
    styles.indexOf(".lightvela-work-navigation__items"),
    styles.indexOf(".lightvela-management-route"),
  );
  const controls = readFileSync(
    new URL("../packages/design-system/src/controls.web.scss", import.meta.url),
    "utf8",
  );
  const shellNavigation = readFileSync(
    new URL("../apps/workbench-web/src/components/shell-navigation/shell-navigation.scss", import.meta.url),
    "utf8",
  );

  assert.match(navigation, /aria-current=\{section === page\.id \? "page" : undefined\}/u);
  assert.match(workNavigationStyles, /@include controls\.navigation-control/u);
  assert.doesNotMatch(workNavigationStyles, /color-background-tertiary/u);
  assert.match(controls, /color-background-navigation-hover/u);
  assert.match(controls, /color-background-navigation-current/u);
  assert.match(controls, /color-background-navigation-pressed/u);
  assert.doesNotMatch(shellNavigation, /\[aria-current="page"\]\s*\{\s*background/u);

  for (const mode of ["light", "dark"] as const) {
    const theme = buildCodexThemeCssProperties(mode);
    assert.ok(theme["--color-background-navigation-hover"]);
    assert.ok(theme["--color-background-navigation-current"]);
    assert.ok(theme["--color-background-navigation-pressed"]);
    assert.notEqual(
      theme["--color-background-navigation-hover"],
      theme["--color-background-navigation-current"],
    );
    const alpha = (value: string) => Number(value.match(/,\s*([\d.]+)\)$/u)?.[1]);
    assert.ok(
      alpha(theme["--color-background-navigation-hover"]!)
        < alpha(theme["--color-background-navigation-current"]!),
    );
    assert.ok(
      alpha(theme["--color-background-navigation-current"]!)
        < alpha(theme["--color-background-navigation-pressed"]!),
    );
  }
});

test("both workbench boot paths render standalone pages outside the management dialog", () => {
  for (const path of [
    "../apps/workbench-web/src/app.tsx",
    "../apps/workbench-web/src/components/hostless-workbench.tsx",
  ]) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.match(source, /LightVelaWorkNavigation/u);
    assert.match(source, /managementSettingsOpen && !standaloneManagementOpen/u);
    assert.match(source, /className="lightvela-management-route"/u);
  }
});

test("new-thread Local status reads the Host connection rather than View activation", () => {
  const source = readFileSync(
    new URL("../apps/workbench-web/src/app.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /useHostConnectionPhase\(snapshot\.hostId\)/u);
  assert.match(source, /connectionPhase=\{activeHostConnectionPhase\}/u);
  assert.doesNotMatch(source, /connectionPhase=\{snapshot\.phase\}/u);

  const draftSource = readFileSync(
    new URL("../apps/workbench-web/src/components/new-thread-draft-page.tsx", import.meta.url),
    "utf8",
  );
  assert.match(draftSource, /<ConnectionStatus phase=\{switchingHostId === null \? connectionPhase : "connecting"\}/u);
  assert.doesNotMatch(draftSource, /"Connecting…"/u);
});

test("machine resource lifecycle is secondary copy, independent from connection status", () => {
  assert.equal(machineResourcePhaseLabel(null), null);
  assert.equal(machineResourcePhaseLabel({ phase: "creating" } as never), "Creating resource");
  assert.equal(machineResourcePhaseLabel({ phase: "suspended" } as never), "Suspended");
  assert.equal(machineResourcePhaseLabel({ phase: "failed" } as never), "Resource failed");
  assert.equal(machineResourcePhaseLabel({ phase: "unknown", rawPhase: "provider-state" } as never), "provider-state");
});

test("Host menu copy layout never stretches the shared connection status dot", () => {
  const styles = readFileSync(
    new URL("../apps/workbench-web/src/styles/app.scss", import.meta.url),
    "utf8",
  );
  const itemStyles = styles.slice(
    styles.indexOf(".new-thread-project-menu__item"),
    styles.indexOf(".new-thread-project-menu__separator"),
  );
  assert.match(itemStyles, /> span:not\(\.workbench-connection-status\)/u);
  assert.doesNotMatch(itemStyles, /> span\s*\{[\s\S]*?flex:\s*1/u);
});

test("standalone management routes preserve the shared AppShell window chrome", () => {
  for (const path of [
    "../apps/workbench-web/src/app.tsx",
    "../apps/workbench-web/src/components/hostless-workbench.tsx",
  ]) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.match(source, /header=\{header\}/u);
    assert.doesNotMatch(source, /header=\{standaloneManagementOpen \? null : header\}/u);
  }

  const shell = readFileSync(
    new URL("../apps/workbench-web/src/components/app-shell.tsx", import.meta.url),
    "utf8",
  );
  assert.match(shell, /header: ReactElement;/u);
});

test("New chat navigates Home instead of waiting for a Host behind the active management route", () => {
  const app = readFileSync(
    new URL("../apps/workbench-web/src/app.tsx", import.meta.url),
    "utf8",
  );
  const runtime = readFileSync(
    new URL("../apps/workbench-web/src/runtime/appserver-runtime-context.tsx", import.meta.url),
    "utf8",
  );
  const hostless = readFileSync(
    new URL("../apps/workbench-web/src/components/hostless-workbench.tsx", import.meta.url),
    "utf8",
  );

  assert.match(app, /const navigateToHome = useCallback/u);
  assert.match(app, /hostCatalog\.navigateToHome\(/u);
  assert.doesNotMatch(app, /const createTask = useCallback/u);
  assert.match(runtime, /input\.navigation\.navigateToHome\(location, options\.mode\)/u);
  assert.match(hostless, /onNewTask=\{closeApplicationRoute\}/u);
});

test("the Home action is presented as Start without changing its navigation contract", () => {
  const sidebar = readFileSync(
    new URL("../apps/workbench-web/src/components/sidebar.tsx", import.meta.url),
    "utf8",
  );

  assert.match(sidebar, /<span>Start<\/span>/u);
  assert.doesNotMatch(sidebar, /<span>New chat<\/span>/u);
  assert.match(sidebar, /onClick=\{onNewTask\}/u);
});

test("Skills is the complete chat-demo workspace rather than an installed-only management list", () => {
  const source = readFileSync(
    new URL("../plugins/lightvela-hermes/src/settings/hermes-skills-management-view.tsx", import.meta.url),
    "utf8",
  );
  const panel = readFileSync(
    new URL("../plugins/lightvela-hermes/src/upstream/mono2/pages/marketing/agent-skills-panel.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /HermesAgentSkillsPanel/u);
  assert.match(source, /showHeader=\{false\}/u);
  assert.match(source, /headerRegion=\{headerRegion\}/u);
  assert.match(source, /headerEnd=\{installTargetSelector\}/u);
  assert.match(source, /createProfileSkillsDataLayer/u);
  assert.match(source, /execDebugCommand=\{account\.execDebugCommand\.bind\(account\)\}/u);
  assert.doesNotMatch(source, /Installed Skills for Hermes Profile/u);
  assert.match(panel, /ExpertsPanel/u);
  assert.match(panel, /SkillsDemoPanel/u);
  assert.match(panel, /LearnSkillSourceKind/u);
});

test("Skills marketplace is not gated by a LightVela account session", () => {
  const management = readFileSync(
    new URL("../plugins/lightvela-hermes/src/settings/lightvela-hermes-management-view.tsx", import.meta.url),
    "utf8",
  );
  const skillsRoute = management.slice(
    management.indexOf('if (page === "skills")'),
    management.indexOf('if (page === "storage")'),
  );

  assert.doesNotMatch(skillsRoute, /LightVelaLoginOptions|snapshot\.session\.status/u);
  assert.doesNotMatch(skillsRoute, /SettingsPageHeader/u);
  assert.match(skillsRoute, /<HermesSkillsManagementView/u);
  assert.match(skillsRoute, /botId=\{activeBot\?\.instanceId \?\? ""\}/u);
});

test("Cloud Storage uses the chat-demo management page and a complete login surface", () => {
  const management = readFileSync(
    new URL("../plugins/lightvela-hermes/src/settings/lightvela-hermes-management-view.tsx", import.meta.url),
    "utf8",
  );
  const storage = readFileSync(
    new URL("../plugins/lightvela-hermes/src/settings/hermes-storage-management-view.tsx", import.meta.url),
    "utf8",
  );

  assert.match(management, /page === "storage"[\s\S]*className="lightvela-management-page"/u);
  assert.match(management, /<LightVelaLoginOptions[\s\S]*reason="account-entry"/u);
  assert.match(management, /<HermesStorageManagementView account=\{account\} botId=\{activeBot\.instanceId\}/u);
  assert.doesNotMatch(storage, /opencraftDesktop|On this Mac|DesktopStorage/u);
});

test("local DSH discovers OpenCraft and native Agent skill roots without crossing workspaces", () => {
  const source = readFileSync(
    new URL("../apps/local-agent-host/src/main.ts", import.meta.url),
    "utf8",
  );
  const plugin = readFileSync(
    new URL("../apps/local-agent-host/src/dsh-capability-plugin.mjs", import.meta.url),
    "utf8",
  );

  assert.match(source, /join\(homedir\(\), "\.opencraft", "skills"\)/u);
  assert.match(source, /persistentSkillsRoot/u);
  assert.match(plugin, /customSkillDirs/u);
  assert.match(plugin, /config\.persistentSkillsRoot/u);
  assert.match(plugin, /join\(cwd, "\.opencraft", "skills"\)/u);
  assert.match(plugin, /includeDefaultRoots: false/u);
  assert.match(plugin, /typeof options\.cwd !== "string" \|\| !isAbsolute\(options\.cwd\)/u);
  assert.match(plugin, /source: "project-opencraft"/u);
});

test("Skills exposes an install target selector for local DSH and Hermes Profiles", () => {
  const view = readFileSync(
    new URL("../plugins/lightvela-hermes/src/settings/hermes-skills-management-view.tsx", import.meta.url),
    "utf8",
  );
  const dataLayer = readFileSync(
    new URL("../plugins/lightvela-hermes/src/settings/profile-skills-data-layer.ts", import.meta.url),
    "utf8",
  );
  const localHost = readFileSync(
    new URL("../apps/local-agent-host/src/dsh-profile-skills.ts", import.meta.url),
    "utf8",
  );

  assert.match(view, /label="选择技能安装位置"/u);
  assert.doesNotMatch(view, /<p[^>]*>安装位置<\/p>|~\/\.opencraft\/skills/u);
  assert.match(view, /const installTargetSelector = ToolbarSelect/u);
  assert.match(view, /<ToolbarSelect/u);
  assert.doesNotMatch(view, /<Select|SelectTrigger|skills-install-target/u);
  assert.doesNotMatch(view, /sm:absolute sm:right-0 sm:top-0/u);
  assert.match(view, /本机 DSH/u);
  assert.match(view, /Hermes · \$\{entry\.bot\.runtimeProfileId\}/u);
  assert.match(view, /scope: \{ type: "local-dsh", root: "user" \}/u);
  assert.match(view, /runtimeProfileId/u);
  assert.match(dataLayer, /fetchSkillFiles/u);
  assert.match(dataLayer, /fetchSkillFile/u);
  assert.match(dataLayer, /artifact: \{ name: localArtifactName\(skill\), files: artifactFiles \}/u);
  assert.match(localHost, /Moved to the recoverable Skill trash/u);
});

test("Skills uses the shell-owned edge-to-edge layout without stacked document insets", () => {
  const extension = readFileSync(
    new URL("../plugins/lightvela-hermes/src/extension.ts", import.meta.url),
    "utf8",
  );
  const contract = readFileSync(
    new URL("../packages/extension-contract/src/index.ts", import.meta.url),
    "utf8",
  );
  const styles = readFileSync(
    new URL("../apps/workbench-web/src/styles/app.scss", import.meta.url),
    "utf8",
  );

  assert.match(extension, /key: "skills"[\s\S]*?layout: "edge-to-edge"/u);
  assert.match(contract, /layout\?: "document" \| "master-detail" \| "edge-to-edge"/u);
  const edgeToEdgeStyles = styles.slice(
    styles.indexOf('.settings-page__viewport[data-layout="edge-to-edge"]'),
    styles.indexOf(".adaptive-panel"),
  );
  assert.match(edgeToEdgeStyles, /overflow-x:\s*hidden/u);
  assert.match(edgeToEdgeStyles, /overflow-y:\s*auto/u);
  assert.match(edgeToEdgeStyles, /scrollbar-gutter:\s*stable/u);
  assert.match(edgeToEdgeStyles, /> \.settings-page__content[\s\S]*?height:\s*auto/u);
  assert.match(edgeToEdgeStyles, /min-height:\s*100%/u);
  assert.doesNotMatch(edgeToEdgeStyles, /overflow:\s*hidden/u);
});

test("standalone Skills registers its toolbar into the route-scoped AppShell Header", () => {
  const regions = readFileSync(
    new URL("../apps/workbench-web/src/components/app-shell-route-regions.tsx", import.meta.url),
    "utf8",
  );
  const settings = readFileSync(
    new URL("../apps/workbench-web/src/components/settings-page.tsx", import.meta.url),
    "utf8",
  );
  const header = readFileSync(
    new URL("../apps/workbench-web/src/components/app-shell-header.tsx", import.meta.url),
    "utf8",
  );

  assert.match(regions, /export function AppShellRouteHeaderRegion/u);
  assert.match(regions, /entry\?\.scopeKey === scopeKey/u);
  assert.match(settings, /regions=\{regions\}/u);
  assert.match(header, /routeHeader/u);
});

test("the AppShell owns the shared Codex-style toolbar selector primitive", () => {
  const regions = readFileSync(
    new URL("../apps/workbench-web/src/components/app-shell-route-regions.tsx", import.meta.url),
    "utf8",
  );
  const selector = readFileSync(
    new URL("../apps/workbench-web/src/components/app-shell-toolbar-select.tsx", import.meta.url),
    "utf8",
  );
  const styles = readFileSync(
    new URL("../apps/workbench-web/src/styles/app.scss", import.meta.url),
    "utf8",
  );
  const toolbarContract = readFileSync(
    new URL("../packages/design-system/src/toolbar.web.scss", import.meta.url),
    "utf8",
  );
  const tokens = readFileSync(
    new URL("../packages/design-system/src/tokens.web.scss", import.meta.url),
    "utf8",
  );

  assert.match(regions, /ToolbarSelect: AppShellToolbarSelect/u);
  assert.match(selector, /DropdownMenu\.Root/u);
  assert.match(selector, /size="toolbar"/u);
  assert.match(selector, /variant="secondary"/u);
  assert.match(selector, /DropdownMenu\.Label/u);
  assert.match(selector, /DropdownMenu\.Item/u);
  assert.match(selector, /Laptop/u);
  assert.match(selector, /optionVisual\(selected\?\.visual\)/u);
  assert.match(toolbarContract, /@mixin trigger/u);
  assert.match(toolbarContract, /@mixin menu-surface/u);
  assert.match(tokens, /--height-toolbar-control: 32px/u);
  assert.match(tokens, /--radius-toolbar-control: var\(--radius-lg\)/u);
  assert.match(styles, /@include toolbar\.trigger/u);
  assert.match(styles, /@include toolbar\.menu-surface/u);
  assert.doesNotMatch(styles, /skills-install-target/u);
});
