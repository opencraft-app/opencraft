import React, { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createComposerController } from "@opencraft/composer-core";
import { OpenCraftComposer } from "@opencraft/composer-editor";
import type { AgentUsageSnapshot } from "@opencraft/appserver-protocol";
import { AgentUsageView } from "../../apps/workbench-web/src/components/agent-usage";
import { initializeAppearanceTheme, setThemePreference, setAppearanceThemeId } from "../../apps/workbench-web/src/appearance-theme";
import { createIntlTestRoot } from "./intl-root";
import "../../apps/workbench-web/src/styles/app.scss";

initializeAppearanceTheme();
const client = new QueryClient();
const calls: unknown[] = [];
let resolvePending: (value: AgentUsageSnapshot) => void, rejectPending: (e: Error) => void;
let pending = false;
const now = Date.now();
const controller = createComposerController({ type: "new-thread", draftId: "usage", execution: { hostId: "fixture", workspace: { cwd: "/workspace", runtimeWorkspaceRoots: ["/workspace"] } } }, { now: Date.now, createId: () => "usage" });
const snapshot = (threadId?: string): AgentUsageSnapshot => ({ readAt: now, providers: [
  { id: "codex", status: "ok", plan: "Pro", observedAt: now, windows: [{ kind: "rateLimit", durationMinutes: 300, usedPercent: 32, resetsAt: now + 3600000, cost: null }] },
  { id: "cursor", status: "ok", plan: "Team", observedAt: now, windows: [{ kind: "plan", durationMinutes: null, usedPercent: 81, resetsAt: now + 86400000, cost: null }] },
], conversation: threadId ? { threadId, providerId: threadId.startsWith("cursor") ? "cursor" : "codex", observedAt: now,
  context: threadId.startsWith("unknown") ? null : { usedTokens: 12345, limitTokens: 200000 },
  total: threadId.startsWith("codex") ? { totalTokens: 22000, inputTokens: 21000, outputTokens: 1000, cachedInputTokens: 18000, reasoningOutputTokens: 200 } : null, last: null } : null });
async function request(params: { threadId?: string; force?: boolean }) {
  calls.push(params); if (pending) return new Promise<AgentUsageSnapshot>((resolve, reject) => { resolvePending = resolve; rejectPending = reject; });
  return snapshot(params.threadId);
}
function Fixture() {
  const [threadId, setThread] = useState<string | null>("codex_fixture");
  Object.assign(window, { usageFixture: { calls, setThread, setThemePreference, setAppearanceThemeId,
    defer: () => { pending = true; }, resolve: () => { pending = false; resolvePending(snapshot(threadId ?? undefined)); }, reject: () => { pending = false; rejectPending(new Error("offline")); } } });
  return <QueryClientProvider client={client}><div style={{ display: "flex", height: "100vh", gap: 24, padding: 12 }}>
    <aside style={{ width: 280, maxWidth: "70vw", flexShrink: 0, display: "flex", flexDirection: "column", justifyContent: "end" }}>
      <AgentUsageView hostId="fixture" threadId={threadId} busy={false} connected request={request} />
    </aside>
    <div style={{ minWidth: 0, flex: 1, alignSelf: "end" }}><OpenCraftComposer controller={controller} onSubmit={() => false} /></div>
  </div></QueryClientProvider>;
}
createIntlTestRoot(document.getElementById("root")!).render(<Fixture />);
