package im

import "context"

// Transport is the Vela Host's only dependency on the chat data plane.
type Transport interface {
	Start(context.Context, Session) error
	SendText(context.Context, SendTextRequest) (SendReceipt, error)
	SendCustom(context.Context, SendCustomRequest) (SendReceipt, error)
	Events() <-chan Event
	Close(context.Context) error
}

// HistoryTransport is an optional extension used after login to replay unread
// roaming messages. Tencent IM remains the source of truth for message bodies.
type HistoryTransport interface {
	UnreadConversations(context.Context) ([]UnreadConversation, error)
	History(context.Context, HistoryRequest) (HistoryPage, error)
	MarkRead(context.Context, Conversation) error
}

// ConversationTransport returns the complete SDK conversation projection,
// including zero-unread conversations. It is separate from recovery history.
type ConversationTransport interface {
	Conversations(context.Context) (ConversationSnapshot, error)
}

// SearchTransport exposes Tencent cloud search without moving message bodies
// into the platform control plane.
type SearchTransport interface {
	Search(context.Context, SearchRequest) (SearchPage, error)
}

// ReactionTransport mutates a reaction on the exact Tencent message referred
// to by MessageRef. Implementations must not retry an uncertain mutation.
type ReactionTransport interface {
	SetReaction(context.Context, MessageRef, string, bool) error
}

// RecallTransport revokes one exact Tencent message without exposing the SDK
// message object outside the trusted IM adapter.
type RecallTransport interface {
	Recall(context.Context, MessageRef) error
}

// AttachmentTransport uploads attachment bytes through Tencent IM and returns
// the stable SDK message/file reference. The platform control plane never
// receives the file body.
type AttachmentTransport interface {
	SendAttachment(
		context.Context,
		SendAttachmentRequest,
	) (SendAttachmentReceipt, error)
}
