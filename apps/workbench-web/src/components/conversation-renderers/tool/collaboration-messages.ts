import { defineMessages } from "@opencraft/i18n";

export const collaborationMessages = defineMessages({
  create: { id: "chat.collaboration.create", defaultMessage: "Create conversation" },
  send: { id: "chat.collaboration.send", defaultMessage: "Send message" },
  resume: { id: "chat.collaboration.resume", defaultMessage: "Resume conversation" },
  wait: { id: "chat.collaboration.wait", defaultMessage: "Wait for conversation" },
  close: { id: "chat.collaboration.close", defaultMessage: "Close conversation" },
  collaborate: { id: "chat.collaboration.collaborate", defaultMessage: "Collaborate" },
  pending: { id: "chat.collaboration.pending", defaultMessage: "Waiting" },
  working: { id: "chat.collaboration.working", defaultMessage: "Working" },
  recovering: { id: "chat.collaboration.recovering", defaultMessage: "Recovering" },
  done: { id: "chat.collaboration.done", defaultMessage: "Completed" },
  failed: { id: "chat.collaboration.failed", defaultMessage: "Failed" },
  interrupted: { id: "chat.collaboration.interrupted", defaultMessage: "Interrupted" },
  unknown: { id: "chat.collaboration.unknown", defaultMessage: "Unconfirmed" },
  attention: { id: "chat.collaboration.attention", defaultMessage: "Needs attention" },
  updated: { id: "chat.collaboration.updated", defaultMessage: "Updated" },
  accepted: { id: "chat.collaboration.accepted", defaultMessage: "Accepted" },
  transferring: { id: "chat.collaboration.transferring", defaultMessage: "Delivering" },
  queued: { id: "chat.collaboration.queued", defaultMessage: "Queued" },
  submitted: { id: "chat.collaboration.submitted", defaultMessage: "Submitted" },
  injected: { id: "chat.collaboration.injected", defaultMessage: "Injected" },
  rejected: { id: "chat.collaboration.rejected", defaultMessage: "Rejected" },
  cancelled: { id: "chat.collaboration.cancelled", defaultMessage: "Cancelled" },
  none: { id: "chat.collaboration.none", defaultMessage: "No delivery" },
  open: { id: "chat.collaboration.open", defaultMessage: "Open {name} conversation" },
  more: { id: "chat.collaboration.more", defaultMessage: "{count} more" },
  input: { id: "chat.collaboration.input", defaultMessage: "Input: {input}" },
  reasoning: { id: "chat.collaboration.reasoning", defaultMessage: "Reasoning: {effort}" },
  axes: { id: "chat.collaboration.axes", defaultMessage: "Tool call: {tool} \u00b7 Delivery: {delivery} \u00b7 Child: {child}" },
  inline: { id: "chat.collaboration.inline", defaultMessage: "{name} \u00b7 {status}" },
});

export function collaborationStateMessage(state:string) {
  if (["pending","pending init","starting","waiting"].includes(state)) return collaborationMessages.pending;
  if (["running","active","working","started working"].includes(state)) return collaborationMessages.working;
  if (state === "recovering") return collaborationMessages.recovering;
  if (["complete","completed","idle","shutdown","finished","done"].includes(state)) return collaborationMessages.done;
  if (["failed","errored","not found","error","exhausted"].includes(state)) return collaborationMessages.failed;
  if (["awaiting attention","awaiting_interaction","unconfirmed"].includes(state)) return collaborationMessages.attention;
  if (state === "interrupted") return collaborationMessages.interrupted;
  if (state === "updated") return collaborationMessages.updated;
  return collaborationMessages.unknown;
}
