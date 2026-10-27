/** Declaration belongs to IM. Authorization and delivery remain in ImPlugin. */
export const IM_REPLY_TOOL = Object.freeze({
  name: "im_reply",
  approval: "preauthorized" as const,
  description: "Reply once to an admitted IM arrival using its opaque replyRef. Send complete text, not fragments. The destination is fixed by the original message; normal assistant final is not sent to IM. Repeating identical text returns the existing receipt. Check uncertain sends in channel delivery history; never resend blindly.",
  inputSchema: { type: "object", properties: { replyRef: { type: "string" }, text: { type: "string", minLength: 1, maxLength: 20000 } }, required: ["replyRef", "text"], additionalProperties: false },
});
