// Current work is an observation, never a completion or delivery receipt.
// Keep the wire status union backwards compatible with older Hosts.
const current = new Set(["queued", "running", "waiting_input", "awaiting_review", "awaiting_delivery", "blocked"]);
export function isCurrentAssistantWork(status) {
  return current.has(status);
}
