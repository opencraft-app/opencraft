import React, { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OnboardingAgentSnapshot } from "@opencraft/appserver-protocol";
import { createIntlTestRoot } from "./intl-root";
import { AgentOnboarding } from "../../apps/workbench-web/src/components/agent-onboarding";
import { initializeAppearanceTheme, setThemePreference, setAppearanceThemeId } from "../../apps/workbench-web/src/appearance-theme";
import "../../apps/workbench-web/src/styles/app.scss";

initializeAppearanceTheme();
const queryClient = new QueryClient();
const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
const calls: string[] = [], finished: string[] = [];
let signedIn = true;
let holdFinish = false;
let releaseFinish: (() => void) | null = null;
const agents = (): OnboardingAgentSnapshot[] => ["codex", "cursor"].map(id => ({
  id: id as "codex" | "cursor", engineId: id, installed: true, authenticated: signedIn, account: null,
  activity: null, version: "1", installUrl: "https://example.invalid", canInstallPackage: false,
}));
function App() {
  const [disabledAgents, setDisabledAgents] = useState<string[]>([]);
  const [hostId, setHostId] = useState("host-a");
  const [presentation, setPresentation] = useState<"gate" | "sheet">("gate");
  Object.assign(window, { onboardingFixture: {
    holdFinish() { holdFinish = true; },
    releaseFinish() { releaseFinish?.(); },
    calls, finished, setDisabledAgents, setHostId, setPresentation, setThemePreference, setAppearanceThemeId,
    resolve(key: string, value: unknown) { pending.get(key)!.resolve(value); pending.delete(key); },
    fail(key: string) { pending.get(key)!.reject(new Error("Unavailable")); pending.delete(key); },
    refresh(ready: boolean) { signedIn = ready; return queryClient.invalidateQueries({ queryKey: ["agent-onboarding", hostId], exact: true }); },
  } });
  return <QueryClientProvider client={queryClient}><AgentOnboarding hostId={hostId}
    agentPreferences={{ enabled: id => !disabledAgents.includes(id), setEnabled: (id, enabled) => setDisabledAgents(current => enabled ? current.filter(value => value !== id) : [...current, id]), saving: false, failed: false }}
    catalogModels={[{ agentId: "codex", id: "codex:current", name: "Codex", isDefault: true }]}
    presentation={presentation} onClose={() => finished.push("close")} onUseModels={() => finished.push("api")}
    onFinish={async model => { if (holdFinish) await new Promise<void>(resolve => { releaseFinish = resolve; }); finished.push(model); }} request={async (method, params) => {
      if (method === "opencraft/agents/onboarding/models") {
        const key = `${hostId}:${(params as { id: string }).id}`;
        calls.push(key);
        return await new Promise((resolve, reject) => pending.set(key, { resolve, reject })) as never;
      }
      return { agents: agents() } as never;
    }} /></QueryClientProvider>;
}
createIntlTestRoot(document.getElementById("root")!, undefined, new URLSearchParams(location.search).get("locale") ?? "en-US").render(<App />);
