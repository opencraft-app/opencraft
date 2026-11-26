import React, { useState } from "react";
import { createIntlTestRoot } from "./intl-root";
import { createComposerController } from "@opencraft/composer-core";
import { OpenCraftComposer, type ComposerAgentModelGroup, type ComposerModelOption } from "@opencraft/composer-editor";
import { resolveConversationAgentId } from "@opencraft/workbench-runtime";
import { WorkbenchPresentationActivityProvider } from "../../apps/workbench-web/src/components/workbench-presentation-activity";
import { initializeAppearanceTheme, setThemePreference, setAppearanceThemeId } from "../../apps/workbench-web/src/appearance-theme";
import "../../apps/workbench-web/src/styles/app.scss";

initializeAppearanceTheme();
const params = new URLSearchParams(location.search);
const existingThread = params.has("thread");
const bridgeThread = params.has("bridge");
const threadId = bridgeThread ? "bridge:codex:source" : "codex_thread";
const singleAgent = params.has("single");
const lateCatalog = params.has("lateCatalog");
const handoffEnabled = params.get("handoff") !== "0";
let sequence = 0;
const controller = createComposerController((existingThread ? {
  type: "existing-thread", key: { hostId: "fixture", threadId },
} : {
  type: "new-thread", draftId: "model-browser", execution: {
    hostId: "fixture", workspace: { cwd: "/workspace", runtimeWorkspaceRoots: ["/workspace"] },
  },
}) as Parameters<typeof createComposerController>[0], { now: Date.now, createId: () => String(++sequence) });
controller.dispatch({ type: "set-selections", patch: { model: "codex:one[high]", effort: "high" } });
const model = (id: string, label: string): ComposerModelOption => ({ id, value: id, label, agentId: id.split(":")[0], agentLabel: ({ codex: "Codex", cursor: "Cursor", api: "API models" } as Record<string, string>)[id.split(":")[0]!], description: null, isDefault: false, efforts: [], defaultEffort: null });
const models: ComposerModelOption[] = [
  ...["one", "two", "three", ...Array.from({ length: 15 }, (_, i) => `extra-${i}`)].flatMap(name => ["low", "medium", "high", "xhigh", "max", "ultra"].map(effort => model(`codex:${name}[${effort}]`, `${name === "one" ? "Model One" : name === "two" ? "Model Two" : name} (${effort})`))),
  model("cursor:one", "Model One"), model("api:plain", "Plain model"),
  { ...model("cursor:thinking", "Cursor Thinking"), defaultEffort: "high", efforts: [{ value: "low", label: "Low", description: null }, { value: "high", label: "High", description: null }], serviceTiers: [{ id: "fast", name: "Fast", description: "" }] },
  ...Array.from({ length: 10 }, (_, i) => model(`api:extra-${i}`, `API model ${i + 1}`)),
  { ...model("api:dense", "Six-level thinking"), defaultEffort: "medium",
    efforts: ["low", "medium", "high", "xhigh", "max", "ultra"].map(value => ({ value, label: value, description: null })),
    serviceTiers: [{ id: "fast", name: "Fast", description: "Faster" }] },
  { ...model("api:thinking", "Thinking model"), defaultEffort: "medium", efforts: [{ value: "medium", label: "Medium", description: null }, { value: "high", label: "High", description: null }], serviceTiers: [{ id: "fast", name: "Fast", description: "Faster" }] },
];
const sent: unknown[] = [], remembered: unknown[] = [], handoffs: string[] = [];
const cycleAgentShortcut = (event: KeyboardEvent) => event.altKey && (event.code === "KeyP" || event.key.toLowerCase() === "p") ? event.shiftKey ? -1 : 1 : 0;
function Fixture() {
  const [chatActive, setChatActive] = useState(true);
  const [disabledAgents, setDisabledAgents] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isFetching, setFetching] = useState(false);
  const [catalogReady, setCatalogReady] = useState(!lateCatalog);
  Object.assign(window, { modelBrowserFixture: { controller, models, sent, remembered, handoffs, existingThread, singleAgent, handoffEnabled, setError, setFetching, setDisabledAgents, setChatActive, setCatalogReady,
    setThemePreference, setAppearanceThemeId,
    selections: () => controller.getSnapshot().draft.selections,
  } });
  const available = catalogReady ? models.filter(model => !disabledAgents.includes(model.agentId!) && (!singleAgent || model.agentId === "codex")) : [];
  if (lateCatalog && catalogReady) available.push({ ...model("legacy-model", "Legacy Host model"), agentId: null, agentLabel: null });
  const currentAgentId = bridgeThread ? resolveConversationAgentId(threadId, undefined, {
    "opencraft/agent-bridge": { version: 1, providerId: "codex", threadPrefix: "bridge:codex:" },
    "opencraft/execution-engines": { defaultEngine: "codex", providers: [{ id: "codex-bridge", threadPrefix: "bridge:codex:" }] },
  }, []) : "codex";
  const agentGroup: ComposerAgentModelGroup = { id: "fixture", label: lateCatalog ? "Codex" : "Fixture", active: true, models: available, loading: !catalogReady,
    select: async model => {
      if (existingThread && model.agentId && model.agentId !== currentAgentId) { handoffs.push(model.value); return { selection: "handled" as const }; }
      if (existingThread) return;
    },
  };
  const agentGroups = lateCatalog ? [agentGroup, {
    id: "other-host", label: "Codex", active: false, models: [model("codex:other", "Other Host model")],
  }] : [agentGroup];
  const composer = <OpenCraftComposer controller={controller} resolveAgentCycleShortcut={cycleAgentShortcut}
    selectionCatalog={{ agentsDisabled: disabledAgents.length > 0, models: available, permissionProfiles: [], modelError: error,
      ...(existingThread ? {
        agentGroups, currentAgentId, currentAgentLabel: "Codex",
        ...(handoffEnabled ? { agentContinuation: { startsNewThread: true } } : {}),
      } : {}),
      onConfigureAgents: () => remembered.push("agents"),
      isFetching, retryModels: () => { setError(null); setFetching(false); }, onConfigureModels: () => {
        remembered.push("configure");
        if (params.has("retire")) setChatActive(false);
      },
      onRememberModelDefaults: value => remembered.push(value),
    }} onSubmit={intent => { sent.push(intent.selections); return false; }} />;
  return <>
    <WorkbenchPresentationActivityProvider active={chatActive}>
      <div data-fixture-chat hidden={!chatActive} inert={!chatActive || undefined}>{composer}</div>
    </WorkbenchPresentationActivityProvider>
    {!chatActive ? <button type="button" autoFocus onClick={() => setChatActive(true)}>Return to chat</button> : null}
  </>;
}
const locale = params.get("locale") ?? "en-US";
createIntlTestRoot(document.getElementById("root")!, undefined, locale).render(<Fixture />);
