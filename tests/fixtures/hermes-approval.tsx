import React, { useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { ApprovalTimelineBlock } from "@opencraft/chat-core";
import { ConversationPendingInteractionPanel } from "../../apps/workbench-web/src/components/conversation-renderers/interaction/interaction-renderers";
import { createIntlTestRoot } from "./intl-root";
import "../../apps/workbench-web/src/styles/app.scss";

const probe = window as typeof window & { approvalActions: unknown[]; setApprovalScopes(scopes: ApprovalTimelineBlock["approvalScopes"]): void; resetApproval(): string };
probe.approvalActions = [];
const initial: ApprovalTimelineBlock = {
  id: "approval", type: "approval", sourceItemIds: ["approval"], requestId: "approval", targetItemId: null,
  method: "item/commandExecution/requestApproval", approvalKind: "command", title: "Allow this action?",
  detail: null, command: "echo safe", reason: "A test action requires your permission", cwd: null, grantRoot: null,
  permissions: null, networkApprovalContext: null, proposedExecpolicyAmendment: [], proposedNetworkPolicyAmendments: [],
  additionalPermissions: null, availableDecisions: ["accept", "acceptForSession", "decline"],
  approvalScopes: ["once", "session", "always", "deny"], state: "pending",
};
let sequence = 0;
function Demo() {
  const [block, setBlock] = useState(initial);
  probe.setApprovalScopes = scopes => setBlock(current => ({ ...current, requestId: current.requestId + "-next", approvalScopes: scopes }));
  probe.resetApproval = () => {
    const next = { ...initial, requestId: `approval-${++sequence}` };
    probe.approvalActions = []; setBlock(next); return next.requestId;
  };
  return <main style={{ padding: 16 }}>
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild><button type="button">Review options</button></DropdownMenu.Trigger>
      <DropdownMenu.Portal><DropdownMenu.Content className="workbench-context-menu"><DropdownMenu.Item>Review details</DropdownMenu.Item></DropdownMenu.Content></DropdownMenu.Portal>
    </DropdownMenu.Root>
    <ConversationPendingInteractionPanel block={block} onRespondInteraction={async (_id, action) => {
    probe.approvalActions.push(action);
  }} /></main>;
}
createIntlTestRoot(document.getElementById("root")!).render(<Demo />);
