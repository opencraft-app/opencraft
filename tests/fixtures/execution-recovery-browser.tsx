import React, {useSyncExternalStore} from "react";
import {Context} from "@deepseek-ai/cordis";
import {createIntlTestRoot} from "./intl-root";
import {createAppServerWorkbenchRuntime} from "@opencraft/workbench-runtime";
import {WebSocketTransport} from "@opencraft/appserver-transport-websocket";
import {ClientObserverList, type DuplexTransport, type TransportStatus} from "@opencraft/appserver-client/transport";
import {createComposerController} from "@opencraft/composer-core";
import {createConversationKey} from "@opencraft/chat-core";
import {OpenCraftComposer} from "@opencraft/composer-editor";
import {TimelineBlockRendererProvider, TimelineBlockRendererRegistryService} from "@opencraft/timeline-render-react";
import {BuiltinTimelineRendererPlugin} from "../../apps/workbench-web/src/components/conversation-renderers/builtin-timeline-renderer-plugin";
import {Conversation} from "../../apps/workbench-web/src/components/conversation";
import {ExecutionRecoveryNotice} from "../../apps/workbench-web/src/components/execution-recovery-notice";
import {queuedSubmissionPresentation} from "../../apps/workbench-web/src/queued-submission-presentation";
import {buildOpenCraftThemeCssProperties} from "@opencraft/design-system/theme-engine";
import "../../apps/workbench-web/src/styles/app.scss";
const theme = new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light";
document.documentElement.dataset.theme = theme;
for (const [key, value] of Object.entries(buildOpenCraftThemeCssProperties(theme))) document.documentElement.style.setProperty(key, value);
const ctx = new Context(); await ctx.plugin(TimelineBlockRendererRegistryService); await ctx.plugin(BuiltinTimelineRendererPlugin);
const socket = new WebSocketTransport({url: location.origin.replace(/^http/, "ws") + "/fixture-rpc"});
const statuses = new ClientObserverList<TransportStatus>();
let status: TransportStatus = socket.status;
socket.subscribeStatus(value => {status = value; statuses.emit(value);});
const transport: DuplexTransport = {get status() {return status;}, connect: signal => socket.connect(signal), send: frame => socket.send(frame),
  close: () => socket.close(), subscribeMessage: listener => socket.subscribeMessage(listener), subscribeStatus: listener => statuses.subscribe(listener)};
const runtime = createAppServerWorkbenchRuntime({hostId: "fixture", transport, autoReconnect: false});
await runtime.connect();
const lease = await runtime.acquireThread("one"); lease.setRecoveryVisibility(true);
const controller = createComposerController({type: "existing-thread", key: createConversationKey("fixture", "one")}, {now: Date.now, createId: () => crypto.randomUUID()});
(window as any).fixture = {snapshot: lease.getSnapshot, runtime: runtime.getSnapshot, recover: (recovering: boolean) => {
  status = {...status, execution: recovering ? "recovering" : "ready", executionUnavailableThreadIds: recovering ? ["one"] : []}; statuses.emit(status);
}};
function App() {
  const host = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot), conversation = useSyncExternalStore(lease.subscribe, lease.getSnapshot);
  return <div style={{height: "100dvh", width: "100%", position: "relative"}}>
    <ExecutionRecoveryNotice hostId="fixture" execution={host.transport.execution} />
    <TimelineBlockRendererProvider registry={ctx.timelineBlockRenderers}>
      <Conversation timeline={conversation.timeline} threadDetailLevel="STEPS_PROSE" footer={
        <OpenCraftComposer controller={controller} awaitSubmission isStreaming={conversation.activeTurn !== null}
          queuedSubmissions={conversation.queuedSubmissions.map(row => queuedSubmissionPresentation(row, false))}
          onSubmit={intent => lease.submit(intent).then(() => true)} onCancel={() => {}} />
      } />
    </TimelineBlockRendererProvider>
  </div>;
}
createIntlTestRoot(document.getElementById("root")!).render(<App />);
