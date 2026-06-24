export type ConversationBottomAnchorReason = "message_sent" | "jump_to_bottom";

export interface ConversationViewportHandle {
  requestBottomAnchor: (reason: ConversationBottomAnchorReason) => void;
  prepareForViewportChange: () => void;
}
