import type { InteractionResponse, PendingInteraction } from "./models";

/**
 * Source-equivalent Desktop cleanup before turn/interrupt. Dynamic item/tool/call
 * requests are intentionally left to AppServer's serverRequest/resolved event.
 */
export function createInterruptInteractionResponse(interaction: PendingInteraction): InteractionResponse | null {
  const requestId = interaction.requestId;
  switch (interaction.method) {
    case "item/commandExecution/requestApproval":
      return { type: "command-approval", requestId, decision: "decline" };
    case "item/fileChange/requestApproval":
      return { type: "file-change-approval", requestId, decision: "decline" };
    case "item/permissions/requestApproval":
      return { type: "permissions-approval", requestId, permissions: {}, scope: "turn" };
    case "item/tool/requestUserInput":
      return { type: "question", requestId, answers: {} };
    case "item/tool/requestOptionPicker":
      return { type: "option-picker", requestId, action: "dismiss", selectedOptions: [], freeformAnswer: null };
    case "item/tool/requestSetupCodexContextPicker":
      return { type: "setup-context-picker", requestId, action: "dismiss", selectedSources: [] };
    case "mcpServer/elicitation/request":
      return { type: "elicitation", requestId, action: "decline" };
    case "item/tool/call":
      return null;
  }
}
