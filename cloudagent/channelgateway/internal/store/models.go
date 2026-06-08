package store

import "time"

type ChannelAccount struct {
	ChannelAccountID string
	ChannelType      string
	TenantID         string
	ProjectID        string
	AgentID          string
	ConfigJSON       string
	Status           string
}

type ChannelLease struct {
	ChannelAccountID string
	OwnerID          string
	FencingToken     int64
	ExpiresAt        time.Time
}

type Conversation struct {
	ConversationID         string
	ChannelAccountID       string
	ChannelType            string
	ExternalConversationID string
	ExternalUserID         string
	ChatType               string
	ThreadID               string
	AgentID                string
	ACPSessionID           string
	WorkspaceKey           string
	SessionKey             string
	RuntimeClosedAt        string
	UpdatedAt              string
}

type MessageRecord struct {
	MessageID              string
	ChannelAccountID       string
	ChannelType            string
	ExternalMessageID      string
	ExternalConversationID string
	ACPSessionID           string
	Direction              string
	Status                 string
	PayloadJSON            string
	ClaimOwnerID           string
	ClaimFencingToken      int64
	RetryCount             int
	NextRetryAt            time.Time
	LastError              string
}

type OutboxRecord struct {
	OutboxID               string
	ChannelAccountID       string
	ChannelType            string
	ExternalConversationID string
	ACPSessionID           string
	PayloadJSON            string
	Status                 string
	ClaimOwnerID           string
	ClaimFencingToken      int64
	RetryCount             int
	NextRetryAt            time.Time
	LastError              string
}
