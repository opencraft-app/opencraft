import { ANTHROPIC_THINKING_PREFIX, anthropicSummary } from "./anthropic-request.js";

/**
 * Codex keeps one conversation history across a model switch. Items produced through the Anthropic bridge carry
 * locally minted `item_` IDs and Anthropic-signed thinking; OpenAI Responses rejects both (IDs must use its own
 * prefixes and reasoning must be its own encrypted state). Before an OpenAI dispatch, drop bridge-only reasoning and
 * clear bridge IDs; the visible messages, tool calls and results remain. Returns null when nothing changes so the
 * original request bytes are forwarded untouched.
 */
export function responsesPayloadForOpenAI(payload: Record<string, unknown>): Record<string, unknown> | null {
  if (!Array.isArray(payload.input)) return null;
  let changed = false;
  const input: unknown[] = [];
  for (const value of payload.input) {
    if (!value || typeof value !== "object" || Array.isArray(value)) { input.push(value); continue; }
    const item = value as Record<string, unknown>;
    const summary = anthropicSummary(item);
    if (summary !== null) {
      input.push({ type: "message", role: "user", content: [{ type: "input_text", text: summary }] });
      changed = true; continue;
    }
    if (item.type === "reasoning" && typeof item.encrypted_content === "string" && item.encrypted_content.startsWith(ANTHROPIC_THINKING_PREFIX)) {
      changed = true; continue;
    }
    if (typeof item.id === "string" && item.id.startsWith("item_")) {
      const { id: _bridgeId, ...rest } = item;
      input.push(rest); changed = true; continue;
    }
    input.push(item);
  }
  return changed ? { ...payload, input } : null;
}
