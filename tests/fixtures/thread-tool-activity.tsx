import type { ThreadItem } from "../../packages/appserver-protocol/src/generated/v2/ThreadItem";
import React, { useRef, useState } from "react";
import { Context } from "@deepseek-ai/cordis";
import { createConversationKey, createDefaultTimelineProjectorRegistry, projectTimeline, type TimelineSourceItem } from "@opencraft/chat-core";
import { buildOpenCraftThemeCssProperties } from "@opencraft/design-system/theme-engine";
import { TimelineBlockRendererProvider, TimelineBlockRendererRegistryService } from "@opencraft/timeline-render-react";
import { Conversation, type ConversationRestoreSnapshot } from "../../apps/workbench-web/src/components/conversation";
import { BuiltinTimelineRendererPlugin } from "../../apps/workbench-web/src/components/conversation-renderers/builtin-timeline-renderer-plugin";
import { createIntlTestRoot } from "./intl-root";
import "../../apps/workbench-web/src/styles/app.scss";

const context = new Context();
await context.plugin(TimelineBlockRendererRegistryService);
await context.plugin(BuiltinTimelineRendererPlugin);
const theme = new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light";
document.documentElement.dataset.theme = theme;
for (const [key, value] of Object.entries(buildOpenCraftThemeCssProperties(theme))) document.documentElement.style.setProperty(key, value);
const registry = createDefaultTimelineProjectorRegistry();
const imageScenario = new URLSearchParams(location.search).get("scenario") === "images";
function resultImage(width: number, height: number, alt: string) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const paint = canvas.getContext("2d")!;
  for (const [index, color] of ["#194982", "#56a680", "#d1a84c", "#a56070"].entries()) {
    paint.fillStyle = color;
    paint.fillRect(index % 2 * width / 2, Math.floor(index / 2) * height / 2, width / 2, height / 2);
  }
  return { type: "image", mimeType: "image/png", data: canvas.toDataURL("image/png").split(",")[1], alt };
}
const imageItems: TimelineSourceItem[] = imageScenario ? [{
  id: "mcp-images", type: "mcpToolCall", payload: {
    server: "image-probe", tool: "inspect_images", status: "completed", arguments: {},
    result: { content: [
      resultImage(1200, 800, "Landscape result"), { type: "text", text: "After landscape image" },
      resultImage(600, 1400, "Portrait result"), { type: "text", text: "After portrait image" },
      resultImage(96, 64, "Small result"), { type: "text", text: "After small image" },
    ] },
  },
}] : [];
const hostContentScenario = new URLSearchParams(location.search).get("scenario") === "host-content";
const webMcpScenario = new URLSearchParams(location.search).get("scenario") === "webmcp";
const webMcpItems: TimelineSourceItem[] = [{ id: "webmcp-browser", type: "mcpToolCall", payload: {
  server: "node_repl", tool: "browser_click", status: "completed", arguments: {},
  result: { content: [], _meta: { "codex/toolSurface": { kind: "browserUse", backend: "iab", webMcpCalls: [
    { kind: "listTools", name: "webmcp_list_tools", sourceHostname: "catalog.example.test", outputJson: JSON.stringify([{ name: "lookup_item" }]) },
    { kind: "invokeTool", name: "lookup_item", title: "Look up an item", description: "Find an item in this website", readOnlyHint: true, sourceHostname: "catalog.example.test",
      inputJson: JSON.stringify({ query: { id: "INPUT_42", region: "上海" }, options: { limit: 40 } }),
      outputJson: JSON.stringify({ items: Array.from({ length: 40 }, (_, id) => ({ id, title: "RESULT_" + id, available: true })), last: "LAST_RESULT" }) },
    { kind: "invokeTool", name: "truncated_query", title: "Partial query", readOnlyHint: false, sourceHostname: "catalog.example.test",
      inputJson: '{"query":"PARTIAL_INPUT', inputTruncated: true, outputJson: '{"result":"PARTIAL_OUTPUT', outputTruncated: true },
    { kind: "invokeTool", name: "plain_response", title: "Plain response", inputJson: "PLAIN_INPUT", outputJson: "PLAIN_OUTPUT" },
    { kind: "invokeTool", name: "empty_response", title: "Empty response", inputJson: "false", outputJson: null },
  ] } } },
} }];
const reviewScenario = new URLSearchParams(location.search).get("scenario") === "reviews";
const rawScenario = new URLSearchParams(location.search).get("scenario") === "raw";
const rawItems: TimelineSourceItem[] = [
{id:'protocol-error',type:'mcpToolCall',payload:{server:'raw-probe',tool:'protocol_error',status:'failed',arguments:{path:'/workspace/report.txt'},error:{message:'PROTOCOL_FAILURE: connection closed before a result'},durationMs:120}},
{id:'pending',type:'mcpToolCall',payload:{server:'raw-probe',tool:'missing_result',status:'completed',arguments:{request:'PENDING_REQUEST'}}},
{id:'mcp-success',type:'mcpToolCall',payload:{server:'raw-probe',tool:'complete_result',status:'completed',arguments:{query:'query'},result:{content:[{type:'text',text:'MCP_SUCCESS'}],structuredContent:{value:42}},durationMs:30}},
{id:'mcp-tool-error',type:'mcpToolCall',payload:{server:'raw-probe',tool:'reported_error',status:'completed',arguments:{query:'absent'},result:{isError:true,content:[{type:'text',text:'REPORTED_ERROR: item absent'}]}}},
{id:'dynamic-failed',type:'dynamicToolCall',payload:{namespace:'deepseek-harness',tool:'read',status:'failed',success:false,arguments:{path:'/workspace/missing.txt'},contentItems:[{type:'inputText',text:'DYNAMIC_FAILURE_CONTENT'}],durationMs:42}},
{id:'dynamic-success',type:'dynamicToolCall',payload:{namespace:'deepseek-harness',tool:'write',status:'completed',success:true,arguments:{path:'/workspace/success.txt'},contentItems:[{type:'inputText',text:'DYNAMIC_SUCCESS_CONTENT'}],durationMs:50}},
];
const inputScenario = new URLSearchParams(location.search).get("scenario") === "inputs";
const probe = window as unknown as { changeThreadToolPhase: (phase: string) => void; openedThreads: string[]; changeHostContentMode: (mode: string) => void; hostActions: string[]; hostRenderedModes: Record<string, string> };
probe.openedThreads = [];
probe.hostActions = [];
probe.hostRenderedModes = {};
function tool(id: string, name: string, arguments_: unknown, status = "completed", output?: unknown): TimelineSourceItem {
  return { id, type: "dynamicToolCall", payload: {
    namespace: "codex_app", tool: name, arguments: arguments_, status, success: status !== "failed",
    ...(output === undefined ? {} : { contentItems: [{ type: "inputText", text: JSON.stringify(output) }] }),
  } };
}

function hostToolItems(failed: boolean): TimelineSourceItem[] {
  type Dynamic = Extract<ThreadItem, { type: "dynamicToolCall" }>;
  const native = (id: string, tool: string, args: Dynamic["arguments"], output: unknown, fail = failed): Dynamic => ({
    id, type: "dynamicToolCall", namespace: "codex_app", tool, arguments: args,
    status: fail ? "failed" : "completed", success: !fail, durationMs: 12,
    contentItems: [{ type: "inputText", text: JSON.stringify(output) }],
  });
  return [
    native("create", "create_thread", { target: { type: "project" } }, { threadId: "created-ai" }),
    native("read", "read_thread", { threadId: "read-ai" }, { threadId: "read-ai" }),
    native("handoff", "handoff_thread", { threadId: "source-ai" }, { status: "warning", threadTitle: "Review", steps: [
      { id: "prepare-host-transfer", status: "done" }, { id: "transfer-host-artifacts", status: "failed" },
      { id: "create-new-worktree", status: "pending" },
    ] }),
    native("empty", "handoff_thread", { threadId: "queued-ai" }, { status: "queued", steps: [] }),
    native("poll", "get_handoff_status", { operationId: "waiting-ai" }, { status: "queued", steps: [] }, false),
  ].map(({ id, type, ...payload }) => ({ id, type, payload }));
}

const reviewViewScenario = new URLSearchParams(location.search).get("scenario") === "review-view";
function reviewViewItems(phase: string): TimelineSourceItem[] {
  const review = (id: string, label: string) => ({ reviewId: id, startedAtMs: 100,
    completedAtMs: phase === "inProgress" ? null : 200,
    status: phase === "inProgress" ? "inProgress" : phase === "completed" ? "denied" : "timedOut",
    riskLevel: "high", userAuthorization: "low", decisionSource: "agent",
    rationale: phase === "inProgress" ? null : `${label}: ${phase}`,
    action: { type: "networkAccess", target: "network.example.test:443", host: "network.example.test", protocol: "https", port: 443 },
  });
  return [
    { id: "view-standalone-1", type: "automaticApprovalReview", payload: review("view-review-1", "DE_REASON_STANDALONE") },
    { id: "view-standalone-2", type: "automaticApprovalReview", payload: review("view-review-2", "DE_REASON_SECOND") },
    { id: "view-tool", type: "mcpToolCall", payload: { server: "audit", tool: "reviewed", status: "completed", arguments: {},
      result: { content: [{ type: "text", text: "DE_TOOL_RESULT" }] },
      automaticApprovalReviews: [review("view-tool-review", "DE_REASON_TOOL"), review("view-tool-second", "DE_REASON_TOOL_SECOND")] } },
    { id: "view-patch", type: "fileChange", payload: { status: "completed", changes: [{ path: "/fixture/review.txt", kind: "update", diff: "@@ -1 +1 @@\n-old\n+new" }],
      automaticApprovalReviews: [review("view-tool-review", "DE_REASON_PATCH")] } },
    { id: "view-command", type: "commandExecution", payload: { command: "printf DE_command", status: "completed", exitCode: 0,
      aggregatedOutput: "DE_COMMAND_RESULT", automaticApprovalReviews: [review("view-command-review", "DE_REASON_COMMAND")] } },
  ];
}

function Demo() {
  const [mounted, setMounted] = useState(true);
  const restore = useRef<ConversationRestoreSnapshot | null>(null);
  const restoreScenario = new URLSearchParams(location.search).get("restore") === "1";
  const websiteScenario = new URLSearchParams(location.search).get("scenario") === "webmcp-restore";
  Object.assign(probe, { setThreadToolMounted: setMounted, clearThreadToolRestore: () => { restore.current = null; } });
  const [phase, setPhase] = useState("inProgress");
  probe.changeThreadToolPhase = setPhase;
  const [hostMode, setHostMode] = useState("content");
  probe.changeHostContentMode = mode => { setHostMode(mode); setPhase("inProgress"); };
  const items: TimelineSourceItem[] = reviewViewScenario ? reviewViewItems(phase) : imageScenario ? imageItems : hostContentScenario ? hostToolItems(phase === "failed") : webMcpScenario ? webMcpItems : websiteScenario ? [{ id: "website", type: "mcpToolCall", payload: {
    server: "node_repl", tool: "browser_click", status: "completed", arguments: {}, result: { content: [], _meta: { "codex/toolSurface": {
      kind: "browserUse", backend: "iab", webMcpCalls: [
        { kind: "invokeTool", name: "lookup_item", title: "Look up an item", inputJson: '{"id":42}', outputJson: '{"result":"WEBSITE_RESULT"}' },
        { kind: "invokeTool", name: "plain_response", title: "Plain response", outputJson: 'SECOND_RESULT' },
      ],
    } } },
  } }] : reviewScenario ? [
    ...["mcpToolCall", "dynamicToolCall"].map((type, index) => ({
      id: `reviewed-${index}`, type, payload: {
        server: "audit", namespace: "audit", tool: index === 0 ? "reviewed" : "inspect",
        status: phase === "completed" ? "failed" : "inProgress",
        automaticApprovalReviews: [{
          reviewId: `review-${index}`, startedAtMs: 100,
          completedAtMs: phase === "inProgress" ? null : 200,
          status: phase === "inProgress" ? "inProgress" : "denied",
          riskLevel: "high", userAuthorization: "low", decisionSource: "agent",
          rationale: phase === "inProgress" ? null : `REVIEW_REASON_${index}: add permission context.`,
          action: { type: "mcpToolCall", server: "audit", toolName: "reviewed" },
        }],
      },
    })),
    { id: "unreviewed", type: "mcpToolCall", payload: { server: "audit", tool: "plain", status: "inProgress" } },
  ] : rawScenario ? rawItems : inputScenario ? [
    { id: "dsh-write", type: "dynamicToolCall", payload: { namespace: "deepseek-harness", tool: "write", status: phase,
      arguments: { path: "/workspace/input-probe.txt", content: "DSH_WRITE_BODY\nsecond line" },
      contentItems: phase === "inProgress" ? null : [{ type: "inputText", text: "Write completed" }], success: phase === "inProgress" ? null : true } },
    { id: "dsh-edit", type: "dynamicToolCall", payload: { namespace: "deepseek-harness", tool: "edit", status: "completed",
      arguments: { path: "/workspace/input-probe.txt", old_string: "DSH_OLD_TEXT", new_string: "DSH_NEW_TEXT" },
      contentItems: [{ type: "inputText", text: "Replacement completed" }], success: true } },
    { id: "dsh-read", type: "dynamicToolCall", payload: { namespace: "deepseek-harness", tool: "read", status: "failed",
      arguments: { path: "/workspace/input-probe.txt", offset: 120, limit: 60 },
      contentItems: [{ type: "inputText", text: "Read failed" }], success: false } },
    { id: "mcp-input", type: "mcpToolCall", payload: { server: "input-probe", tool: "inspect_input", status: "completed",
      arguments: { value: "MCP_ARGUMENT_STAYS_IN_RAW" }, result: { content: [{ type: "text", text: "MCP returned content" }] } } },
  ] : [
    tool("fork", "fork_thread", { environment: { type: "worktree" } }, phase),
    tool("read", "read_thread", { threadId: "read-target" }),
    tool("create", "create_thread", { target: { type: "project" } }, "completed", { threadId: "created-target", hostId: "local" }),
    tool("transfer", "handoff_thread", { threadId: "other", destinationHostId: "remote" }, "completed", {
      operationId: "transfer", status: "warning", threadTitle: "Review", destinationHostDisplayName: "Remote",
      destinationThreadId: "remote-target", steps: [{ id: "prepare-host-transfer", status: "done" }, { id: "transfer-host-artifacts", status: "failed" }, { id: "create-new-worktree", status: "pending" }],
    }),
    tool("poll", "get_handoff_status", { operationId: "missing" }, "failed"),
    tool("queued", "handoff_thread", { threadId: "queued-target" }, "completed", {
      operationId: "queued", status: "queued", steps: [{ id: "custom-prepare-step", status: "pending" }],
    }),
    { id: "browser", type: "mcpToolCall", payload: { server: "browser", tool: "browser_click", status: phase,
      arguments: {}, result: { content: [], _meta: { "codex/toolSurface": { kind: "browserUse", backend: "chrome" } } } } },
    { id: "computer", type: "mcpToolCall", payload: { server: "computer-use", tool: "scroll", status: phase,
      arguments: { direction: "down", app: "Notes" } } },
    { id: "custom", type: "dynamicToolCall", payload: { namespace: "custom", tool: "inspect_workspace", status: phase, success: phase !== "failed" } },
  ];
  const timeline = projectTimeline({ key: createConversationKey("fixture", "thread-tools"), revision: reviewScenario ? (phase === "inProgress" ? 0 : phase === "denied" ? 1 : 2) : ["inProgress", "completed", "failed", "interrupted"].indexOf(phase),
    authoritative: true, phase: "live", turns: [{ id: "turn", status: hostContentScenario || phase === "inProgress" || (reviewScenario && phase === "denied") ? "streaming" : "complete", items }] }, registry);
  return <div data-phase={phase} data-host-mode={hostMode} style={{ width: "100vw", height: "100dvh" }}>
    <TimelineBlockRendererProvider registry={context.timelineBlockRenderers}>
      {mounted ? <Conversation key={hostContentScenario ? hostMode : undefined} timeline={timeline} scrollPolicy="natural" threadDetailLevel="STEPS_PROSE"
        initialRestoreSnapshot={restoreScenario ? restore.current : undefined}
        onRestoreSnapshotChange={restoreScenario ? snapshot => { restore.current = snapshot; } : undefined}
        onOpenSubagent={id => probe.openedThreads.push(id)}
        renderToolCallContent={hostContentScenario && hostMode !== "absent" ? block => { probe.hostRenderedModes[block.callId ?? block.id] = hostMode; return hostMode === "fallback" ? undefined
          : hostMode === "null" ? null : hostMode === "false" ? false
          : <section data-host-body={block.callId}>
              <label>Host note {block.callId}<input aria-label={"Host note " + block.callId} defaultValue="" /></label>
              <button type="button" onClick={() => probe.hostActions.push(block.callId ?? block.id)}>Host action {block.callId}</button>
            </section>; } : undefined}
        footer={<div style={{ height: 48 }}>Composer fixture</div>} /> : null}
    </TimelineBlockRendererProvider>
  </div>;
}
const liveQuery = new URLSearchParams(location.search);
const liveProbe = window as unknown as {
  setPhase: (phase: string) => void;
  setMounted: (mounted: boolean) => void;
  capturedRestore?: ConversationRestoreSnapshot;
  observed: Record<string, { status: string; content?: string }>;
  setHostMode: (mode: string) => void;
  hostPresentation?: { state: string; canExpand: boolean; phase: string; mode: string };
};
liveProbe.observed = {};
function LiveToolsDemo() {
  const [mounted, setMounted] = useState(true);
  const restore = useRef<ConversationRestoreSnapshot | null>(null);
  const restoreScenario = liveQuery.get("restore") === "1";
  liveProbe.setMounted = setMounted;
  const hostScenario = liveQuery.get("scenario") === "host-live";
  const [hostMode, setHostMode] = useState("content");
  liveProbe.setHostMode = mode => { setHostMode(mode); setPhase("running"); };
  const [phase, setPhase] = useState(liveQuery.get("initial") ?? "running");
  liveProbe.setPhase = setPhase;
  type Dynamic = Extract<ThreadItem, { type: "dynamicToolCall" }>;
  const running = phase === "running" || phase === "progress";
  const status: Dynamic["status"] = running ? "inProgress" : phase === "failed" ? "failed" : "completed";
  const dynamic = (id: string, namespace: string, tool: string, args: Dynamic["arguments"], state = status): Dynamic => ({
    type: "dynamicToolCall", id, namespace, tool, arguments: args, status: state,
    success: state === "inProgress" ? null : state !== "failed", durationMs: state === "inProgress" ? null : 12,
    contentItems: [{ type: "inputText", text: phase === "progress" ? "UPDATED_WRITE_BODY" : "LIVE_WRITE_BODY" }],
  });
  const native: ThreadItem[] = [
    dynamic("live-write", "deepseek-harness", "write", {
      path: "/workspace/live.txt", content: phase === "progress" ? "UPDATED_WRITE_BODY" : "LIVE_WRITE_BODY",
    }),
    dynamic("settled-write", "deepseek-harness", "write", {
      path: "/workspace/settled.txt", content: "SETTLED_WRITE_BODY",
    }, "completed"),
    dynamic("compact", "unregistered", "inspect", { secret: "COMPACT_PAYLOAD_CONTROL" }),
    { type: "mcpToolCall", id: "mcp", server: "fixture", tool: "mcp_probe", arguments: {},
      appContext: null, mcpAppUi: null, pluginId: null, readOnlyHint: null, status: "inProgress",
      result: { _meta: null, content: [{ type: "text", text: "MCP_RESULT_CONTROL" }], structuredContent: null },
      error: null, durationMs: null },
  ];
  const items: TimelineSourceItem[] = native.filter(item => liveQuery.get("single") !== "1" || item.id === "live-write")
    .map(({ id, type, ...payload }) => ({ id, type, payload }));
  const historical = liveQuery.get("history") === "1";
  const timeline = projectTimeline({
    key: createConversationKey("fixture", "live-tools"), revision: ["running", "progress", "completed", "failed"].indexOf(phase),
    authoritative: true, phase: historical ? "painted" : "live",
    turns: [{ id: "turn", status: historical ? "complete" : "streaming", items }],
  }, registry);
  return <div data-phase={phase} data-host-mode={hostMode} style={{ width: "100vw", height: "100dvh" }}>
    <TimelineBlockRendererProvider registry={context.timelineBlockRenderers}>
      {mounted ? <Conversation timeline={timeline} scrollPolicy="natural" threadDetailLevel="STEPS_PROSE"
        initialRestoreSnapshot={restoreScenario ? restore.current : undefined}
        onRestoreSnapshotChange={restoreScenario ? snapshot => { restore.current = snapshot; liveProbe.capturedRestore = snapshot; } : undefined}
        renderToolCallContent={hostScenario && hostMode !== "absent" ? (block, presentation) => {
          if (block.callId !== "compact") return undefined;
          liveProbe.hostPresentation = { state: presentation.state, canExpand: presentation.canExpand, phase, mode: hostMode };
          return hostMode === "fallback" ? undefined : hostMode === "null" ? null : hostMode === "false" ? false
            : <section data-live-host-body><label>Host details {phase}<input aria-label="Host detail input" defaultValue="HOST_LIVE_BODY" /></label></section>;
        } : undefined}
        renderToolCallIcon={block => {
          if (block.callId !== null) liveProbe.observed[block.callId] = {
            status: block.status, content: (block.input as { content?: string } | null)?.content,
          };
          return hostScenario && block.callId === "compact" ? <span data-live-host-icon>H</span> : undefined;
        }} footer={<div style={{ height: 48 }}>Composer fixture</div>} /> : null}
    </TimelineBlockRendererProvider>
  </div>;
}

const handoffParams = new URLSearchParams(location.search);
const handoffProbe = window as unknown as {
  setPhase: (phase: string) => void;
  presentations: Record<string, { phase: string; canExpand: boolean; state: string }>;
};
handoffProbe.presentations = {};
function HandoffToolsDemo() {
  const [mounted, setMounted] = useState(true);
  const restore = useRef<ConversationRestoreSnapshot | null>(null);
  Object.assign(handoffProbe, { setHandoffMounted: setMounted, clearHandoffRestore: () => { restore.current = null; } });
  const [phase, setPhase] = useState(handoffParams.get("initial") ?? "queued");
  handoffProbe.setPhase = setPhase;
  const live = phase === "queued" || phase === "running";
  const status = phase === "transport-failed" ? "failed" : "completed";
  const item: Extract<ThreadItem, { type: "dynamicToolCall" }> = {
    type: "dynamicToolCall", id: "handoff-live", namespace: "codex_app", tool: "handoff_thread",
    arguments: { threadId: "source-al", destinationHostId: "target-al" },
    status, success: status === "completed", durationMs: 23,
    contentItems: [{ type: "inputText", text: JSON.stringify({
      operationId: "transfer-al",
      status: phase === "empty" ? "queued" : phase === "transport-failed" ? "running" : phase,
      threadTitle: "AL transfer", destinationHostDisplayName: "Synthetic target",
      steps: phase === "empty" ? [] : [
        { id: "prepare-host-transfer", status: live ? "running" : "done" },
        { id: "transfer-host-artifacts", status: live ? "pending" : phase === "error" ? "failed" : "done" },
      ],
    }) }],
  };
  const { id, type, ...payload } = item;
  const items: TimelineSourceItem[] = [{ id, type, payload }];
  const history = handoffParams.has("history");
  const timeline = projectTimeline({
    key: createConversationKey("fixture", "handoff-live-al"),
    revision: ["queued", "running", "success", "error", "empty", "transport-failed"].indexOf(phase),
    authoritative: true, phase: history ? "painted" : "live",
    turns: [{ id: "turn", status: history ? "complete" : "streaming", items }],
  }, registry);
  return <div data-phase={phase} style={{ width: "100vw", height: "100dvh" }}>
    <TimelineBlockRendererProvider registry={context.timelineBlockRenderers}>
      {mounted ? <Conversation timeline={timeline} scrollPolicy="natural" threadDetailLevel="STEPS_PROSE"
        initialRestoreSnapshot={restore.current}
        onRestoreSnapshotChange={snapshot => { restore.current = snapshot; }}
        renderToolCallIcon={(block, presentation) => {
          handoffProbe.presentations[block.callId ?? block.id] = {
            phase, canExpand: presentation.canExpand, state: presentation.state,
          };
          return undefined;
        }} footer={<div style={{ height: 48 }}>Composer fixture</div>} /> : null}
    </TimelineBlockRendererProvider>
  </div>;
}

createIntlTestRoot(document.getElementById("root")!).render(handoffParams.get("scenario") === "handoff-live" ? <HandoffToolsDemo /> : ["live", "host-live"].includes(new URLSearchParams(location.search).get("scenario") ?? "") ? <LiveToolsDemo /> : <Demo />);
