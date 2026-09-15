// Package im defines the SDK-independent realtime messaging contract used by
// the Vela Host. Tencent SDK objects must not cross this package boundary.
package im

import (
	"encoding/json"
	"errors"
	"strings"
)

var (
	ErrInvalidConversation = errors.New("IM 会话目标无效")
	ErrInvalidMessageRef   = errors.New("IM 消息引用无效")
	ErrInvalidAttachment   = errors.New("IM 附件无效")
	ErrInvalidUserSig      = errors.New("UserSig 无效")
	ErrSensitiveMarshal    = errors.New("敏感值禁止通用 JSON 序列化")
)

type ConversationType string

const (
	ConversationC2C   ConversationType = "c2c"
	ConversationGroup ConversationType = "group"
	ConversationTopic ConversationType = "topic"
)

// Conversation contains only the stable routing fields needed by the Host.
type Conversation struct {
	kind       ConversationType
	peerUserID string
	groupID    string
	topicID    string
}

func NewC2CConversation(peerUserID string) (Conversation, error) {
	peerUserID = strings.TrimSpace(peerUserID)
	if peerUserID == "" {
		return Conversation{}, ErrInvalidConversation
	}
	return Conversation{
		kind:       ConversationC2C,
		peerUserID: peerUserID,
	}, nil
}

func NewGroupConversation(groupID string) (Conversation, error) {
	groupID = strings.TrimSpace(groupID)
	if groupID == "" {
		return Conversation{}, ErrInvalidConversation
	}
	return Conversation{
		kind:    ConversationGroup,
		groupID: groupID,
	}, nil
}

func NewTopicConversation(groupID, topicID string) (Conversation, error) {
	groupID = strings.TrimSpace(groupID)
	topicID = strings.TrimSpace(topicID)
	if groupID == "" || topicID == "" {
		return Conversation{}, ErrInvalidConversation
	}
	return Conversation{
		kind:    ConversationTopic,
		groupID: groupID,
		topicID: topicID,
	}, nil
}

func (c Conversation) Kind() ConversationType {
	return c.kind
}

func (c Conversation) PeerUserID() string {
	return c.peerUserID
}

func (c Conversation) GroupID() string {
	return c.groupID
}

func (c Conversation) TopicID() string {
	return c.topicID
}

func (c Conversation) Valid() bool {
	switch c.kind {
	case ConversationC2C:
		return c.peerUserID != "" &&
			c.groupID == "" &&
			c.topicID == ""
	case ConversationGroup:
		return c.peerUserID == "" &&
			c.groupID != "" &&
			c.topicID == ""
	case ConversationTopic:
		return c.peerUserID == "" &&
			c.groupID != "" &&
			c.topicID != ""
	default:
		return false
	}
}

type MessageRef struct {
	conversation Conversation
	messageID    string
	sequence     int64
	timestampMS  int64
}

func (r MessageRef) Valid() bool {
	return r.conversation.Valid() && strings.TrimSpace(r.messageID) != "" &&
		r.sequence >= 0 && r.timestampMS > 0
}

func NewMessageRef(
	conversation Conversation,
	messageID string,
	sequence int64,
	timestampMS int64,
) (MessageRef, error) {
	messageID = strings.TrimSpace(messageID)
	if !conversation.Valid() ||
		messageID == "" ||
		sequence < 0 ||
		timestampMS <= 0 {
		return MessageRef{}, ErrInvalidMessageRef
	}
	return MessageRef{
		conversation: conversation,
		messageID:    messageID,
		sequence:     sequence,
		timestampMS:  timestampMS,
	}, nil
}

func (r MessageRef) Conversation() Conversation {
	return r.conversation
}

func (r MessageRef) MessageID() string {
	return r.messageID
}

func (r MessageRef) Sequence() int64 {
	return r.sequence
}

func (r MessageRef) TimestampMS() int64 {
	return r.timestampMS
}

// UserSig can only be revealed at the Bridge login boundary.
type UserSig struct {
	value string
}

func NewUserSig(raw string) (UserSig, error) {
	if strings.TrimSpace(raw) == "" {
		return UserSig{}, ErrInvalidUserSig
	}
	return UserSig{value: raw}, nil
}

func (s UserSig) Reveal() string {
	return s.value
}

func (UserSig) String() string {
	return "[REDACTED]"
}

func (UserSig) GoString() string {
	return "[REDACTED]"
}

func (UserSig) MarshalJSON() ([]byte, error) {
	return nil, ErrSensitiveMarshal
}

type Session struct {
	SDKAppID int
	UserID   string
	UserSig  UserSig
	LaunchID string
}

type SendTextRequest struct {
	Conversation    Conversation
	Text            string
	MentionUserIDs  []string
	CloudCustomData string
}

type SendCustomRequest struct {
	Conversation Conversation
	CustomType   string
	Data         json.RawMessage
}

type SendAttachmentRequest struct {
	Conversation    Conversation
	Filename        string
	MIMEType        string
	Data            []byte
	CloudCustomData string
}

type SendReceipt struct {
	MessageID   string
	TimestampMS int64
	Sequence    int64
}

type Attachment struct {
	ID        string
	Filename  string
	MIMEType  string
	SizeBytes int64
	URL       string
}

type SendAttachmentReceipt struct {
	SendReceipt
	Attachment Attachment
}

type ElementType string

const (
	ElementText       ElementType = "text"
	ElementCustom     ElementType = "custom"
	ElementMention    ElementType = "mention"
	ElementAttachment ElementType = "attachment"
	ElementUnknown    ElementType = "unknown"
)

type Element struct {
	Type       ElementType
	Text       string
	CustomType string
	Data       json.RawMessage
	UserIDs    []string
	Attachment *Attachment
}

type IncomingMessage struct {
	Ref             MessageRef
	SenderUserID    string
	CloudCustomData string
	Elements        []Element
}

type UnreadConversation struct {
	Conversation Conversation
	UnreadCount  int
}

type ConversationSummary struct {
	Conversation Conversation
	UnreadCount  int
	Title        string
}

type ConversationSnapshot struct {
	Items           []ConversationSummary
	IsSyncCompleted bool
}

type HistoryRequest struct {
	Conversation      Conversation
	Cursor            string
	AfterSequence     int64
	AroundSequence    int64
	AroundTimestampMS int64
}

type HistoryPage struct {
	Messages   []IncomingMessage
	NextCursor string
	Completed  bool
}

type SearchRequest struct {
	Conversation *Conversation
	Query        string
	Cursor       string
	Limit        int
}

type SearchPage struct {
	Messages   []IncomingMessage
	NextCursor string
	Completed  bool
	TotalCount int
}

type EventType string

const (
	EventReady               EventType = "ready"
	EventLoginSucceeded      EventType = "login_succeeded"
	EventLoginFailed         EventType = "login_failed"
	EventMessage             EventType = "message"
	EventConversationUpdated EventType = "conversation_updated"
	EventNetworkChanged      EventType = "network_changed"
	EventUserSigExpiring     EventType = "usersig_expiring"
	EventKickedOut           EventType = "kicked_out"
	EventSDKError            EventType = "sdk_error"
	EventStopped             EventType = "stopped"
)

type Event struct {
	ID            string
	LaunchID      string
	Type          EventType
	Message       *IncomingMessage
	Conversations []ConversationSummary
	Retryable     bool
	Code          string
	Reason        string
}
