import React, { useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { IntlRuntimeProvider, useIntl } from "@opencraft/i18n/react";
import { LocaleRuntime } from "@opencraft/i18n";
import { UiPreferencesRuntime } from "@opencraft/ui-preferences";
import { createComposerController } from "@opencraft/composer-core";
import { createConversationKey, createDefaultTimelineProjectorRegistry, projectTimeline } from "@opencraft/chat-core";
import { DictationFooter } from "../../packages/composer-editor/src/dictation-footer";
import { ComposerQueueTray } from "../../packages/composer-editor/src/queue-tray";
import { WebChatDocument } from "@opencraft/chat-render-web";
import { OpenCraftComposer } from "@opencraft/composer-editor";
import { UiPreferencesProvider } from "../../apps/workbench-web/src/runtime/ui-preferences-runtime";
import { IndexedDbUiPreferenceStore } from "../../apps/workbench-web/src/runtime/indexeddb-ui-preference-store";
import { WorkbenchLocaleController, WorkbenchIntlProvider } from "../../apps/workbench-web/src/i18n/workbench-locale";
import { LanguageSetting } from "../../apps/workbench-web/src/i18n/language-setting";
import { localeCatalogs } from "../../apps/workbench-web/src/i18n/catalogs";
import { CommandBlock } from "../../apps/workbench-web/src/components/conversation-renderers/activity/command-and-review-renderers";
import { CommandViewStateContext, type CommandViewState } from "../../apps/workbench-web/src/components/conversation/command-view-state";
import "../../apps/workbench-web/src/styles/app.scss";

import { ExtensionContributionStore } from "@opencraft/extension-runtime";
import { SettingsNavigation } from "../../apps/workbench-web/src/components/settings-page";
const contributions = new ExtensionContributionStore();
contributions.prepare({ extensionId: "test.menu", activationId: "fixture", generation: 1 }, {
  commands: [], views: [{ id: "test.menu.view", title: "Fixture", viewType: "test.menu.fixture" }], navigation: [], sidebarCatalogs: [], settingsSchemas: [], workbenchSurfaces: [], themes: [], bots: [],
  settingsPages: [
    { id: "test.menu.models", viewId: "test.menu.view", title: "Model services", titleMessage: { id: "settings.contributions.modelServices", defaultMessage: "Model services" }, group: "Server", groupMessage: { id: "settings.groups.server", defaultMessage: "Server" } },
    { id: "test.menu.legacy", viewId: "test.menu.view", title: "Legacy plugin", group: "Legacy group" },
  ],
})();
const preferences = await UiPreferencesRuntime.open({ installation: await IndexedDbUiPreferenceStore.open({ databaseName: "opencraft-i18n-test" }) });
const locale = new WorkbenchLocaleController(preferences, { ideLocale: "en-US" });
await locale.initialize();
const second = new LocaleRuntime(localeCatalogs);
await second.update({ localeOverride: "en-US" });
let id = 0;
const composer = createComposerController({ type: "existing-thread", key: createConversationKey("test", "i18n") }, { now: Date.now, createId: () => String(++id) });
const commandCases = [
  { id: "success", status: "completed", exitCode: 0 },
  { id: "stopped", status: "interrupted", exitCode: null },
  { id: "failed", status: "failed", exitCode: 7 },
  { id: "unknown", status: "completed", exitCode: null },
  { id: "missing", status: "completed", exitCode: null, resultMissing: true },
  { id: "reading", status: "completed", exitCode: 0, output: "Success\nNo output\n" + Array.from({ length: 80 }, (_, line) => `${line}: ${"original output ".repeat(40)}`).join("\n") },
];
const commands = projectTimeline({ key: createConversationKey("test", "command-locale"), revision: 1, authoritative: true, phase: "live", turns: [{
  id: "command-results", status: "complete", items: commandCases.map(entry => ({ id: entry.id, type: "commandExecution", payload: {
    command: `printf fixture-${entry.id}`, status: entry.status, exitCode: entry.exitCode, aggregatedOutput: entry.output ?? "", resultMissing: entry.resultMissing,
  } })),
}] }, createDefaultTimelineProjectorRegistry()).frames.flatMap(frame => frame.blocks).filter(block => block.type === "command-execution");
const commandViews = new Map<string, CommandViewState>(commands.map(block => [block.id, { open: true, scrollTop: 0, scrollLeft: 0, followOutput: true }]));
function Probe() {
  const intl = useIntl();
  return <output data-locale-probe>{intl.formatMessage({ id: "settings.title", defaultMessage: "Settings" })}</output>;
}
function App() {
  const [section, setSection] = useState("test.menu.models");
  const snapshot = useSyncExternalStore(locale.subscribe, locale.getSnapshot);
  return <main style={{ padding: 32 }}>
    <UiPreferencesProvider runtime={preferences}>
      <WorkbenchIntlProvider controller={locale} target={document.documentElement}>
        <LanguageSetting />
        <div data-settings-menu style={{ height: 180, overflow: "auto" }}><SettingsNavigation section={section} onSectionChange={setSection} extensionContributions={contributions} profiles={[]} machines={[]} activeHostId="" onBack={() => {}} presentation="dialog" showArchivedConversations /></div>
        <Probe />
        <div data-imperative>{snapshot.intl.formatMessage({ id: "settings.title", defaultMessage: "Settings" })}</div>
        <OpenCraftComposer controller={composer} onSubmit={() => false} onCancel={() => {}}
          selectionCatalog={{ agents: [], models: [{ id: "fixture", value: "fixture", label: "Fixture", isDefault: true, description: null, efforts: [], defaultEffort: null, inputModalities: ["text"] }], permissionProfiles: [] }} />
        <section data-shared-i18n>
          <DictationFooter interaction={{ kind: "dictation", phase: "starting", startedAt: null, audioLevels: { subscribe: () => () => {} }, cancel() {}, finish: async () => false }} canSend={false} onSend={() => {}} onCancel={() => {}} />
          <ComposerQueueTray items={[{ id: "unknown", preview: "User-authored queue message", state: "unknown", operation: "idle", actionable: false, unconfirmedTargetTurnId: "unknown-turn" }]} isResponseInProgress={false} onDiscardUnconfirmed={async () => {}} />
          <WebChatDocument documentId="locale-table" source={"| User heading | Value |\n| --- | --- |\n| User cell | 42 |"} />
          <WebChatDocument documentId="locale-image" source={"![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=)"} />
        </section>
        <section data-command-results><CommandViewStateContext.Provider value={commandViews}>
          {commands.map(block => <div key={block.id} data-command-result={block.callId}><CommandBlock block={block} /></div>)}
        </CommandViewStateContext.Provider></section>
      </WorkbenchIntlProvider>
    </UiPreferencesProvider>
    <section data-independent><IntlRuntimeProvider runtime={second}><Probe /></IntlRuntimeProvider></section>
  </main>;
}
(window as any).__localeFixture = {
  contributions,
  switch: (value: string) => preferences.set("locale.override", value),
  inherited: (ideLocale: string) => locale.configure({ ideLocale }),
  flush: () => preferences.flush(),
  second: (value: string) => second.update({ localeOverride: value }),
};
createRoot(document.getElementById("root")!).render(<App />);
