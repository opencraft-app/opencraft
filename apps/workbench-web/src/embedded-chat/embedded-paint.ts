/**
 * Whether the embedded conversation surface has painted. A new conversation
 * paints its local startup Draft before the Host connects. A restored Thread
 * has no startup Draft, so its first paint is the activated (ready) view.
 */
export function isEmbeddedConversationPainted(
  draft: { readonly submission: unknown } | null,
  activationPhase: string,
): boolean {
  return (draft !== null && draft.submission === null) || activationPhase === "ready";
}
