import React, { useRef, useState } from "react";
import { normalizeMcpElicitationMetadata, type McpElicitationTimelineBlock } from "@opencraft/chat-core";
import { ConversationPendingInteractionPanel } from "../../apps/workbench-web/src/components/conversation-renderers/interaction/interaction-renderers";
import { InteractionDraftStore } from "../../apps/workbench-web/src/components/conversation-renderers/interaction/interaction-drafts";
import { buildOpenCraftThemeCssProperties } from "@opencraft/design-system/theme-engine";
import { createIntlTestRoot } from "./intl-root";
import "../../apps/workbench-web/src/styles/app.scss";

document.documentElement.dataset.theme = "light";
for (const [key, value] of Object.entries(buildOpenCraftThemeCssProperties("light"))) document.documentElement.style.setProperty(key, value);

const probe = window as typeof window & { mcpActions: unknown[]; mcpOpened: string[]; showMcpCase(name: string): void; hideMcpForm(): void; replayMcpForm(change?: "request" | "schema" | "tool" | "turn"): void };
probe.mcpActions = []; probe.mcpOpened = [];
window.open = ((url: string) => { probe.mcpOpened.push(String(url)); return null; }) as typeof window.open;
const formSchema = { type: "object", required: ["name", "count"], properties: {
  name: { type: "string", title: "Name", minLength: 2 }, count: { type: "integer", title: "Count", minimum: 1, maximum: 3, default: 2 },
  enabled: { type: "boolean", title: "Enabled", default: true }, environment: { type: "string", title: "Environment", enum: ["stage", "prod"] },
  tags: { type: "array", title: "Tags", items: { enum: ["safe", "fast"] }, default: ["safe"] },
} };
const multiSchema = { type: "object", required: ["tags"], properties: {
  tags: { type: "array", title: "Tags", items: { anyOf: [{ const: "safe", title: "Safe mode" }, { const: "fast", title: "Fast mode" }] } },
} };
let sequence = 0;
function example(name: string): McpElicitationTimelineBlock {
  const mode = name === "auth" || name === "url" ? "url" : "form";
  const serverName = name === "auth" ? "codex_apps" : name === "browser" ? "browser" : "fixture";
  const requestedSchema = name === "form" ? formSchema : name === "multi" ? multiSchema : {};
  const message = name === "tool" || name === "multiline" ? "Allow this synthetic tool?" : name === "browser" ? "Allow access to https://example.test?" : "Provide the requested information";
  const raw = name === "tool" || name === "multiline" ? { codex_approval_kind: "mcp_tool_call", connector_id: "issues", connector_name: "Issues", tool_name: "create_issue", riskLevel: "high", subtitle: "Creates a synthetic issue", persist: ["session", "always"],
    tool_params: name === "multiline" ? { steps: Array.from({ length: 35 }, (_, index) => String(index + 1)).join("\n") } : { payload: { body: "x".repeat(140) }, title: "Release", flag: true, count: 3, extra: "extra" } }
    : name === "browser" ? { origin: "https://example.test", persist: ["session", "always"] }
    : name === "suggestion" ? { codex_approval_kind: "tool_suggestion", suggest_type: "install", suggest_reason: "Track this work", tool_type: "connector", tool_id: "issues", tool_name: "Issues", install_url: "https://example.test/install", persist: "always" }
    : name === "auth" ? { _codex_apps: { connector_auth_failure: { is_auth_failure: true, connector_id: "drive", connector_name: "Drive", install_url: "https://example.test/auth", auth_reason: "missing_link", requested_scopes: ["files.read"] } } } : {};
  return { type: "elicitation", id: name, sourceItemIds: [], requestId: `${name}-${sequence++}`, targetItemId: null,
    method: "mcpServer/elicitation/request", state: "pending", mode, serverName, message,
    requestedSchema, url: mode === "url" ? "https://example.test/continue" : null,
    elicitationId: null, ...normalizeMcpElicitationMetadata(mode, raw, { serverName, message, requestedSchema }) };
}
function Demo() {
  const [block, setBlock] = useState<McpElicitationTimelineBlock | null>(() => example("form"));
  const lastBlock = useRef(block!);
  const [draftStore] = useState(() => new InteractionDraftStore());
  const [requestTurnId, setRequestTurnId] = useState("fixture-turn");
  probe.showMcpCase = name => { lastBlock.current = example(name); setBlock(lastBlock.current); };
  probe.hideMcpForm = () => setBlock(null);
  probe.replayMcpForm = change => {
    const next = JSON.parse(JSON.stringify(lastBlock.current)) as McpElicitationTimelineBlock;
    if (change === "turn") setRequestTurnId(value => `${value}-next`);
    lastBlock.current = change === "request" ? { ...next, requestId: `${next.requestId}-replacement` }
      : change === "tool" && next.toolApproval !== null ? { ...next, toolApproval: { ...next.toolApproval, toolParams: { ...next.toolApproval.toolParams, payload: { body: "y".repeat(140) } } } }
      : change === "schema" ? { ...next, requestedSchema: { ...formSchema, properties: { ...formSchema.properties, count: { ...formSchema.properties.count, default: 1 } } } } : next;
    setBlock(lastBlock.current);
  };
  return <main data-scenario={block?.id ?? "hidden"} style={{ padding: 16, maxWidth: 760, margin: "auto" }}><ConversationPendingInteractionPanel block={block} draftStore={draftStore} draftScope="fixture-view" requestTurnId={requestTurnId}
    onRespondInteraction={async (_requestId, action) => { probe.mcpActions.push(action); }} /></main>;
}
createIntlTestRoot(document.getElementById("root")!).render(<Demo />);
