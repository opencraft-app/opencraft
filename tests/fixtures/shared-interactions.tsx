import React, { useState } from "react";
import { buildOpenCraftThemeCssProperties } from "@opencraft/design-system/theme-engine";
import type { ApprovalTimelineBlock } from "@opencraft/chat-core";
import { JsonRpcAppServerClient } from "@opencraft/appserver-client";
import { WebSocketTransport } from "@opencraft/appserver-transport-websocket";
import { SHARED_INTERACTIONS_EXTENSION } from "@opencraft/appserver-protocol";
import { AppServerInteractionBroker } from "@opencraft/composer-appserver";
import { ConversationPendingInteractionPanel } from "../../apps/workbench-web/src/components/conversation-renderers/interaction/interaction-renderers";
import { createIntlTestRoot } from "./intl-root";
import "../../apps/workbench-web/src/styles/app.scss";

const theme = new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light";
document.documentElement.dataset.theme = theme;
for (const [key, value] of Object.entries(buildOpenCraftThemeCssProperties(theme))) document.documentElement.style.setProperty(key, value);
const probe = window as any, values = new Map<string, any>();
let render = () => {};
const client = new JsonRpcAppServerClient({ hostId: "host", transport: new WebSocketTransport(new URLSearchParams(location.search).get("ws")!) });
const broker = new AppServerInteractionBroker({ hostId: "host", client, sharedClient: client, store: {
  upsertPendingInteraction: value => { values.set(value.requestId, value); render(); },
  removePendingInteraction: (_thread, id) => { values.delete(id); render(); },
} });
probe.ready = false;
probe.client = client;
function Demo() {
  const [, update] = useState(0); render = () => update(v => v + 1);
  return <main style={{ padding: 16 }}>{[...values.values()].map(value => {
    const block: ApprovalTimelineBlock = {
      id: value.requestId, type: "approval", sourceItemIds: [value.requestId], requestId: value.requestId,
      targetItemId: null, method: "item/commandExecution/requestApproval", approvalKind: "command", title: "Allow this action?",
      detail: null, command: "echo safe", reason: "A test action requires your permission", cwd: null, grantRoot: null,
      permissions: null, networkApprovalContext: null, proposedExecpolicyAmendment: [], proposedNetworkPolicyAmendments: [],
      additionalPermissions: null, availableDecisions: ["accept", "decline"], state: "pending", responseState: value.responseState,
      canRespond: value.canRespond,
    };
    return <ConversationPendingInteractionPanel key={value.requestId} block={block} onRespondInteraction={async (_id, action) => {
      await broker.respond({ hostId: "host", threadId: "thread" }, { type: "command-approval", requestId: value.requestId,
        decision: action.type === "decline" ? "decline" : "accept" });
    }} />;
  })}</main>;
}
createIntlTestRoot(document.getElementById("root")!).render(<Demo />);
void client.connect({ clientInfo: { name: "interaction-smoke", version: "1" }, capabilities: {
  extensions: { [SHARED_INTERACTIONS_EXTENSION]: { version: 1 } },
} }).then(() => broker.sync("thread")).then(() => { probe.ready = true; });
