import React, { useState } from "react";
import { useIntlRuntime } from "@opencraft/i18n/react";
import type { WorkbenchLocaleController } from "../../apps/workbench-web/src/i18n/workbench-locale";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { HostConnectionProfile } from "@opencraft/workbench-runtime";
import { createIntlTestRoot } from "./intl-root";
import { AgentConfigurationBrowser } from "../../apps/workbench-web/src/components/agent-configuration";
import { createModelServicesView } from "../../plugins/builtin-agents/src/model-services/view";
import { ModelServicesController } from "../../plugins/builtin-agents/src/model-services/controller";
import { LocalAgentSettingsService } from "../../plugins/builtin-agents/src/local-agent-settings-service";
import { initializeAppearanceTheme, setThemePreference, setAppearanceThemeId } from "../../apps/workbench-web/src/appearance-theme";
import "../../apps/workbench-web/src/styles/app.scss";
import "../../apps/workbench-web/src/styles/settings-page.scss";
const params = new URLSearchParams(location.search);
initializeAppearanceTheme(); setThemePreference(params.get("theme") === "dark" ? "dark" : "light");
if (params.get("theme") === "lavender") setAppearanceThemeId("opencraft.core.lavender");
const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const calls: { host: string; method: string; params: any }[] = [];
let remoteReadFailure = false;
let holdImport = false, releaseImport: (() => void) | null = null;
const agent = (id: string, engineId: string, name: string) => ({ id, engineId, displayName: name, installed: true, authenticated: true, historyImport: true,
  version: "1.0", account: null, installUrl: "https://example.invalid", canInstallPackage: false, activity: null });
const native = { historyImport: true, agents: [agent("codex", "codex", "Codex"), agent("cursor", "cursor", "Cursor"), agent("pi", "pi-cli", "Pi")] };
const models = native.agents.map(a => ({ id: `${a.engineId}:one`, model: `${a.engineId}:one`, agentId: a.engineId, agentLabel: a.displayName,
  displayName: `${a.displayName} Model`, isDefault: a.id === "codex", defaultReasoningEffort: null, supportedReasoningEfforts: [] }));
const provider = { provider: "test", displayName: "Test provider", settingsNs: "llm-pi-ai", settingsPath: ["providers", "test"], active: true, configured: true, enabled: true,
  configuration: { modelDeclarations: true, apis: ["openai-completions"], canProbe: true } };
const request = async (host: string, method: string, args: any) => {
  calls.push({ host, method, params: args });
  if (remoteReadFailure && host === "remote" && method === "opencraft/agents/onboarding/history-agents") throw new Error("Synthetic offline read");
  if (method === "opencraft/agents/onboarding/history-agents" || method === "opencraft/agents/onboarding/status") return native;
  if (method === "model/list") return { data: models, nextCursor: null };
  if (method === "opencraft/agents/onboarding/history-sources") return { sources: [] };
  if (method === "opencraft/agents/onboarding/history") return { conversations: [{ id: `${host}-${args.id}`, title: `${host} conversation`, cwd: `/${host}/workspace`, updatedAt: "2026-11-17T00:00:00Z", imported: false }], nextCursor: null };
  if (method === "opencraft/agents/onboarding/import") {
    if (holdImport) await new Promise<void>(resolve => { releaseImport = resolve; });
    return { imported: args.conversationIds.map((id: string) => ({ id, threadId: `imported-${id}` })), failed: [] };
  }
  if (method === "runtime/settings/describe") return { writable: true, namespaces: [{ ns: "llm-pi-ai", revision: 7, value: { providers: { test: { baseURL: "https://example.invalid/v1", api: "openai-completions", apiKeyEnv: "SYNTHETIC", models: [{ id: "test-model" }] } } } }] };
  if (method === "runtime/providers/list") return { providers: [provider] };
  if (method === "runtime/models/list") return { groups: [{ id: "test", models: [{ id: "test-model", name: "Test model" }] }] };
  if (method === "runtime/status/read") return {};
  if (method === "runtime/credentials/describe") return { credentials: { SYNTHETIC: { configured: false } } };
  throw new Error(`Unexpected fixture method ${method}`);
};
const controller = new ModelServicesController(new LocalAgentSettingsService(request as never, "local"));
const View = createModelServicesView(controller);
const profile = (hostId: string, remote = false): HostConnectionProfile => ({ hostId, displayName: remote ? "Remote Linux" : "Local Mac", providerId: "opencraft.websocket", providerConfig: {}, providerConfigVersion: 1,
  hostKind: remote ? "remote-control" : "local", enabled: true, autoConnect: false, includeInSidebar: true, credentialRef: null, transportEndpoint: null, executionLocation: hostId,
  workspaceBrowseRoots: [], revision: 1, agent: "OpenCraft", ...(remote ? { machinePresence: "online" as const } : {}) });
const baseProfiles = [profile("local"), profile("remote", true)];
const noop = () => {};
function FixtureRegion({ hostId, active }: { hostId: string; active: boolean }) {
  const intlRuntime = useIntlRuntime() as WorkbenchLocaleController;
  const [profiles, setProfiles] = useState(baseProfiles);
  const [disabled, setDisabled] = useState<string[]>([]);
  Object.assign(window, { agentConfigurationFixture: { calls, controller, setProfiles, baseProfiles, setThemePreference, setAppearanceThemeId,
    setLocale: (locale: string) => intlRuntime.configure({ ideLocale: locale }),
    setRemoteReadFailure: (fail: boolean) => { remoteReadFailure = fail; void query.invalidateQueries({ queryKey: ["settings-agent-directory", "fixture", "remote"] }); },
    holdImport: () => { holdImport = true; }, releaseImport: () => releaseImport?.(),
    failRead: () => query.setQueryData(["settings-agent-directory", "fixture", "remote"], undefined) } });
  return <AgentConfigurationBrowser hostId={hostId} active={active} identityScope="fixture" profiles={profiles} platform="web"
    access={{ ensureReady: async () => ({} as never), request: request as never }}
    preferences={{ enabled: (host, id) => !disabled.includes(`${host}:${id}`), setEnabled: (host, id, enabled) => setDisabled(value => enabled ? value.filter(key => key !== `${host}:${id}`) : [...value, `${host}:${id}`]), saving: false, failed: false }}
    requestMachines={async command => ({ hubId: "fixture", ownerActorId: "human:fixture", enrollmentOrigin: "https://example.invalid", machines: [], ...(command.action === "create" ? { command: "echo synthetic-enrollment" } : {}) })} />;
}
function App() {
  return <QueryClientProvider client={query}><div style={{ height: "100dvh" }}><View contribution={{} as never} host={{ platform: "web", activeHostId: "local", profiles: baseProfiles, provisionHost: noop, removeHost: noop, openView: noop, pushViewResource: noop, replaceViewResource: noop } as never}
    activation={{ viewId: "fixture", resourceUri: null }} regions={{ AgentConfiguration: FixtureRegion }} /></div></QueryClientProvider>;
}
createIntlTestRoot(document.getElementById("root")!, undefined, "zh-CN").render(<App />);
