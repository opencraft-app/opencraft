import { Context } from '@deepseek-ai/cordis';
import { TimelineBlockRendererProvider, TimelineBlockRendererRegistryService } from '@opencraft/timeline-render-react';
import { BuiltinTimelineRendererPlugin } from '../../apps/workbench-web/src/components/conversation-renderers/builtin-timeline-renderer-plugin';
import { Conversation } from '../../apps/workbench-web/src/components/conversation';
import { submissionRecoveryPresentation } from '../../apps/workbench-web/src/submission-recovery-presentation';
import { SubmissionRecoveryNotice } from "../../apps/workbench-web/src/components/submission-recovery-notice";
import React, { useSyncExternalStore } from "react";
import { createIntlTestRoot } from "./intl-root";
import { OpenCraftComposer } from "@opencraft/composer-editor";
import { createComposerController } from "@opencraft/composer-core";
import { createConversationKey } from "@opencraft/chat-core";
import { WebSocketTransport } from "@opencraft/appserver-transport-websocket";
import { createAppServerWorkbenchRuntime } from "@opencraft/workbench-runtime";
import { createBrowserConversationOutbox } from "../../apps/workbench-web/src/runtime/browser-conversation-outbox";
import { queuedSubmissionPresentation } from "../../apps/workbench-web/src/queued-submission-presentation";
import { completeConversationComposerSubmission } from "../../apps/workbench-web/src/runtime/composer-submission-admission";
import { initializeAppearanceTheme, setThemePreference } from "../../apps/workbench-web/src/appearance-theme";
import "../../apps/workbench-web/src/styles/app.scss";
initializeAppearanceTheme();
const ctx = new Context();
await ctx.plugin(TimelineBlockRendererRegistryService);
await ctx.plugin(BuiltinTimelineRendererPlugin);
let account: string | null = "account-one";
const canDispatch = () => account !== null;
const store = createBrowserConversationOutbox({ storage: sessionStorage, scope: () => account, canDispatch });
const runtime = createAppServerWorkbenchRuntime({ hostId: "fixture", outbox: store.forProfile(1),
  canDispatchOutbox: canDispatch,
  autoReconnect: true, reconnectDelaysMs: [100, 200], requestTimeoutMs: 2000,
  createTransport: () => new WebSocketTransport({ url: location.origin.replace(/^http/, "ws") + "/fixture-rpc" }),
});
await runtime.connect();
const lease = await runtime.acquireThread("thread-one"); lease.setRecoveryVisibility(true);
const controller = createComposerController({ type: new URLSearchParams(location.search).get("target") === "queue" ? "enqueue-follow-up" : "existing-thread", key: createConversationKey("fixture", "thread-one") }, { now: Date.now, createId: () => crypto.randomUUID() });
const submittedIntents: import("@opencraft/composer-core").SubmitIntent[] = [];
(window as any).fixture = { runtime: runtime.getSnapshot, snapshot: lease.getSnapshot, setThemePreference,
  account: (next: string | null) => { account = next; store.refreshScope(); }, draft: () => controller.getSnapshot().draft,
  submissions: () => submittedIntents,
  addAttachment: () => controller.dispatch({ type: "add-attachment", attachment: {
    id: "kept-image", name: "keep.png", mimeType: "image/png", size: 1,
    uri: "https://example.test/keep.png", lifecycle: "ready", error: null,
  } }),
  failStorage: () => { Storage.prototype.setItem = () => { throw new Error("Storage unavailable"); }; },
};
function App() {
  const snapshot = useSyncExternalStore(lease.subscribe, lease.getSnapshot);
  const recovery = submissionRecoveryPresentation(snapshot.pendingSubmissions, snapshot.queuedSubmissions, snapshot.timeline);
  const recoveryActions = { byClientId: recovery.byClientId, onAbandon: lease.abandonUnknownSubmission, onRetry: lease.retryQueuedSubmission };
  const footer = <>
    {recovery.detached.map(row => <div className="submission-recovery-detached thread-layout-width" key={row.commandId}>
      <span>{row.preview}</span><SubmissionRecoveryNotice submission={row} {...recoveryActions} />
    </div>)}
    <OpenCraftComposer controller={controller} awaitSubmission isStreaming={snapshot.activeTurn !== null}
      availableFollowUpActions={!snapshot.authoritative || snapshot.queuedSubmissions.some(row => row.local)
        ? ["queue"] : (["steer", "queue"] as const).filter(action => runtime.resources.host.canRequest?.(action === "queue" ? "thread/queue/add" : "turn/steer") !== false)}
      queuedSubmissions={snapshot.queuedSubmissions.filter(row => !recovery.byClientId.has(row.clientMessageId)).map(row => queuedSubmissionPresentation(row, false))}
      onSubmit={intent => { submittedIntents.push(intent); return completeConversationComposerSubmission(intent, lease.submit(intent), () => {}); }} onCancel={() => {}}
      onDeleteQueuedSubmission={id => lease.deleteQueuedSubmission(id)} />
  </>;
  return <main style={{ height: '100dvh', position: 'relative' }} data-authoritative={String(snapshot.authoritative)}>
    <TimelineBlockRendererProvider registry={ctx.timelineBlockRenderers}>
      <Conversation timeline={snapshot.timeline} threadDetailLevel="STEPS_PROSE" scrollPolicy="response-placement"
        documentContext={{ conversationId: 'thread-one', hostId: 'fixture', cwd: '/fixture', theme: 'light', submissionRecovery: recoveryActions }}
        footer={footer} />
    </TimelineBlockRendererProvider>
  </main>;
}
createIntlTestRoot(document.getElementById("root")!, undefined, new URLSearchParams(location.search).get("locale") ?? "en-US").render(<App />);
