import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { LocaleRuntime } from "@opencraft/i18n";
import { IntlRuntimeProvider } from "@opencraft/i18n/react";
import { createComposerController } from "@opencraft/composer-core";
import { OpenCraftComposer } from "@opencraft/composer-editor";
import { TASKS } from "@opencraft/appserver-protocol";
import { localeCatalogs } from "../../apps/workbench-web/src/i18n/catalogs";
import { AsyncNoticesProvider } from "../../apps/workbench-web/src/components/async-notices";
import { ContinuationFailureNotice } from "../../apps/workbench-web/src/components/continuation-failure-notice";
import { ComposerOverlayAnchorContext, FloatingComposerRegistryContext, ThreadComposerPresentation } from "../../apps/workbench-web/src/components/thread-composer-presentation";
import { FloatingComposerRegistry } from "../../apps/workbench-web/src/components/floating-composer-state";
import { ShellPresentationContext } from "../../apps/workbench-web/src/components/shell-presentation";
import { initializeAppearanceTheme, setThemePreference } from "../../apps/workbench-web/src/appearance-theme";
import { createTasksView } from "../../plugins/tasks/src/view";
import "../../apps/workbench-web/src/styles/app.scss";

initializeAppearanceTheme();
const intl = new LocaleRuntime(localeCatalogs); await intl.update({ ideLocale: "en-US" });
const controller = createComposerController({ type: "existing-thread", key: { hostId: "fixture", threadId: "thread" } }, { now: Date.now, createId: () => crypto.randomUUID() });
const registry = new FloatingComposerRegistry();
const shell = { sidebarOpen: false, sidebarFloating: false, rightPanelOpen: true, rightPanelFullWidth: true,
  toggleSidebar() {}, dismissSidebarAfterSelection() {}, toggleRightPanel() {} };
const profile = { hostId: "fixture", hostKind: "local", enabled: true, revision: 1, displayName: "Fixture" };
const tasks = Array.from({ length: 12 }, (_, i) => ({ id: `task-${i}`, revision: 1, title: `Task ${i}`, description: "Retained task description", kind: "feature", status: "todo",
  projectId: null, projectServerId: null, createdAt: 1, updatedAt: 1, deletedAt: null, sortOrder: i,
  conversations: [{ serverId: "fixture", threadId: `thread-${i}` }] }));
const jobs: Array<{ signal: AbortSignal; release(): void }> = [];
let active = 0, peak = 0, calls = 0;
const listeners = new Set<(kind: "tasks" | "activity") => void>();
const Tasks = createTasksView({ storageHostId: "fixture", request: async (_host: string, method: string) => {
  if (method === TASKS.capabilities) return { version: 1, storage: "sqlite-rows" };
  if (method === TASKS.list) return { tasks, members: [], recycled: [] };
  throw new Error("Unexpected fixture mutation");
}, listThreads: async () => [], listProjects: async () => [], subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  readConversation: async (_host: string, thread: string, signal?: AbortSignal) => {
    calls++; active++; peak = Math.max(peak, active);
    try { return await new Promise((resolve, reject) => {
      const abort = () => reject(new Error("Read cancelled"));
      signal!.addEventListener("abort", abort, { once: true });
      jobs.push({ signal: signal!, release() { signal!.removeEventListener("abort", abort); resolve({ title: thread, state: "running" }); } });
    }); } finally { active--; }
  },
} as any, new AbortController().signal);

function App() {
  const [error, setError] = useState<Error | null>(null);
  const [mode, setMode] = useState("chat");
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null);
  Object.assign(window, { continuity: { setMode, fail: () => setError(new Error("AppServer request thread/resume timed out after 30000 ms")), clear: () => setError(null),
    locale: (locale: string) => intl.update({ ideLocale: locale }), theme: setThemePreference,
    counters: () => ({ active, peak, calls, aborted: jobs.filter(job => job.signal.aborted).length }),
    hint: () => { for (const listener of listeners) listener("activity"); },
  } });
  return <main style={{ height: "100dvh", background: "var(--color-background-primary)", color: "var(--color-text)" }}>
    {mode === "tasks" ? <Tasks contribution={{ id: "tasks", viewType: "tasks", title: "Tasks" }} activation={{ viewId: "tasks", resourceUri: null }} host={{ platform: "web", activeHostId: "fixture", profiles: [profile], openView() {}, pushViewResource() {}, replaceViewResource() {} } as any} /> : mode === "chat" ? <>
      <div style={{ padding: 24 }}>Conversation content remains in its reading area.</div>
      <div ref={setAnchor} style={{ position: "absolute", inset: 0, pointerEvents: "none" }} />
      <ShellPresentationContext.Provider value={shell}><FloatingComposerRegistryContext.Provider value={registry}><ComposerOverlayAnchorContext.Provider value={anchor}>
        <ThreadComposerPresentation controller={controller} scopeId="fixture" activeTabId="tool:fixture" enabled timeline={null}>
          <div className="thread-composer-region"><ContinuationFailureNotice scope="fixture:thread" error={error} />
            <OpenCraftComposer controller={controller} onSubmit={() => false} onCancel={() => {}} modelSelectionPolicy="host-default" />
          </div>
        </ThreadComposerPresentation>
      </ComposerOverlayAnchorContext.Provider></FloatingComposerRegistryContext.Provider></ShellPresentationContext.Provider>
    </> : null}
  </main>;
}
createRoot(document.getElementById("root")!).render(<IntlRuntimeProvider runtime={intl}><AsyncNoticesProvider><App /></AsyncNoticesProvider></IntlRuntimeProvider>);
