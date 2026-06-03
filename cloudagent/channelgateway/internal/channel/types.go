package channel

import (
	"context"
	"encoding/json"
	"time"
)

type Type string

const (
	TypeWeCom Type = "wecom"
)

type ChatType string

const (
	ChatDM    ChatType = "dm"
	ChatGroup ChatType = "group"
)

type MessageKind string

const (
	MessageText  MessageKind = "text"
	MessageFile  MessageKind = "file"
	MessageImage MessageKind = "image"
)

type Message struct {
	ChannelAccountID       string
	ChannelType            Type
	ExternalMessageID      string
	ExternalConversationID string
	ExternalUserID         string
	ExternalUserName       string
	ChatType               ChatType
	ThreadID               string
	Kind                   MessageKind
	Text                   string
	Media                  []Media
	Raw                    json.RawMessage
	ReceivedAt             time.Time
}

type Media struct {
	ID          string
	URL         string
	ContentType string
	Filename    string
	Bytes       int64
}

type Reply struct {
	ChannelAccountID       string
	ExternalConversationID string
	ExternalMessageID      string
	Text                   string
	Raw                    json.RawMessage
}

type SendResult struct {
	MessageID string
	Raw       json.RawMessage
}

type InboundHandler interface {
	HandleInbound(ctx context.Context, msg Message) error
}

type Adapter interface {
	Start(ctx context.Context, handler InboundHandler) error
	Stop(ctx context.Context) error
	Send(ctx context.Context, reply Reply) (SendResult, error)
}

func BuildSessionKey(agentID string, msg Message, groupSessionsPerUser, threadSessionsPerUser bool) string {
	keyParts := []string{"agent", agentID, string(msg.ChannelType)}
	chatType := string(msg.ChatType)
	if chatType == "" {
		chatType = string(ChatDM)
	}
	keyParts = append(keyParts, chatType)
	if msg.ExternalConversationID != "" {
		keyParts = append(keyParts, msg.ExternalConversationID)
	}
	if msg.ThreadID != "" {
		keyParts = append(keyParts, msg.ThreadID)
	}
	isolateUser := groupSessionsPerUser
	if msg.ThreadID != "" && !threadSessionsPerUser {
		isolateUser = false
	}
	if msg.ChatType == ChatDM {
		isolateUser = false
	}
	if isolateUser && msg.ExternalUserID != "" {
		keyParts = append(keyParts, msg.ExternalUserID)
	}
	return joinNonEmpty(keyParts, ":")
}

func joinNonEmpty(parts []string, sep string) string {
	out := ""
	for _, part := range parts {
		if part == "" {
			continue
		}
		if out == "" {
			out = part
		} else {
			out += sep + part
		}
	}
	return out
}
