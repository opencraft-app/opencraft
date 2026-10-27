import type { InteractionResponse, PendingInteraction } from "./models";

type InterruptResponseFactory = (requestId: string) => InteractionResponse | null;


const interruptResponses = {
  "item/tool/call": () => null,
  "mcpServer/elicitation/request": (requestId) => ({
    requestId, type: "elicitation", action: "decline",
  }),
  "item/tool/requestUserInput": (requestId) => ({
    requestId, type: "question", answers: {},
  }),
  "item/tool/requestOptionPicker": (requestId) => ({
    requestId, type: "option-picker", action: "dismiss",
    selectedOptions: [], freeformAnswer: null,
  }),
  "item/tool/requestSetupCodexContextPicker": (requestId) => ({
    requestId, type: "setup-context-picker", action: "dismiss", selectedSources: [],
  }),
  "item/permissions/requestApproval": (requestId) => ({
    requestId, type: "permissions-approval", permissions: {}, scope: "turn",
  }),
  "item/fileChange/requestApproval": (requestId) => ({
    requestId, type: "file-change-approval", decision: "decline",
  }),
  "item/commandExecution/requestApproval": (requestId) => ({
    requestId, type: "command-approval", decision: "decline",
  }),
} satisfies Record<PendingInteraction["method"], InterruptResponseFactory>;

export function createInterruptInteractionResponse(
  interaction: PendingInteraction,
): InteractionResponse | null {
  return interruptResponses[interaction.method](interaction.requestId);
}
