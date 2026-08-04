package platform

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"velachat/agent/internal/common"
)

const maxRuntimeThreadResponseBytes = 2 << 20

var ErrInvalidRuntimeThread = errors.New("平台返回的 Runtime Thread 无效")

type ThreadMessageRef struct {
	Kind         string
	MessageID    string
	GroupID      string
	TopicID      string
	SenderUserID string
	Sequence     int64
	Timestamp    int64
}

type RuntimeThread struct {
	ID             string
	ServerID       string
	ChannelID      string
	RootMessageRef ThreadMessageRef
	ReplyCount     int64
	UnreadCount    int64
	LastReplyAt    *time.Time
	CreatedAt      time.Time
}

type RuntimeThreadReply struct {
	ID         string
	ThreadID   string
	MessageRef ThreadMessageRef
	CreatedAt  time.Time
}

type runtimeThreadRefPayload struct {
	Kind         string  `json:"kind"`
	MessageID    string  `json:"messageId"`
	GroupID      *string `json:"groupId,omitempty"`
	TopicID      *string `json:"topicId,omitempty"`
	SenderUserID *string `json:"senderUserId,omitempty"`
	Sequence     int64   `json:"sequence"`
	Timestamp    int64   `json:"timestamp"`
}

type runtimeThreadPayload struct {
	ID             string                  `json:"id"`
	ServerID       string                  `json:"serverId"`
	ChannelID      string                  `json:"channelId"`
	RootMessageRef runtimeThreadRefPayload `json:"rootMessageRef"`
	ReplyCount     int64                   `json:"replyCount"`
	UnreadCount    int64                   `json:"unreadCount"`
	LastReplyAt    *time.Time              `json:"lastReplyAt"`
	CreatedAt      time.Time               `json:"createdAt"`
}

type runtimeThreadReplyPayload struct {
	ID         string                  `json:"id"`
	ThreadID   string                  `json:"threadId"`
	MessageRef runtimeThreadRefPayload `json:"messageRef"`
	CreatedAt  time.Time               `json:"createdAt"`
}

func (c *Client) ResolveRuntimeThread(
	ctx context.Context,
	token AccessToken,
	serverID string,
	channelID string,
	root ThreadMessageRef,
	idempotencyKey string,
) (RuntimeThread, error) {
	if !validUUIDv7(serverID) || !validUUIDv7(channelID) ||
		strings.TrimSpace(idempotencyKey) == "" || !validThreadMessageRef(root, false) {
		return RuntimeThread{}, ErrInvalidConfig
	}
	body, err := common.Marshal(struct {
		ChannelID      string                  `json:"channelId"`
		RootMessageRef runtimeThreadRefPayload `json:"rootMessageRef"`
	}{ChannelID: channelID, RootMessageRef: runtimeThreadRefToPayload(root)})
	if err != nil {
		return RuntimeThread{}, ErrInvalidConfig
	}
	request, err := c.runtimeTaskRequest(
		ctx, token, http.MethodPost, "/runtime/threads:resolve", bytes.NewReader(body),
	)
	if err != nil {
		return RuntimeThread{}, err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Idempotency-Key", strings.TrimSpace(idempotencyKey))
	response, err := c.doRuntimeRequest(request, http.StatusOK)
	if err != nil {
		return RuntimeThread{}, err
	}
	defer response.Body.Close()
	data, err := readBounded(response.Body, maxRuntimeThreadResponseBytes)
	if err != nil {
		return RuntimeThread{}, ErrInvalidRuntimeThread
	}
	var payload runtimeThreadPayload
	if err := common.Unmarshal(data, &payload); err != nil {
		return RuntimeThread{}, ErrInvalidRuntimeThread
	}
	value, err := validateRuntimeThread(payload)
	if err != nil || value.ServerID != serverID || value.ChannelID != channelID {
		return RuntimeThread{}, ErrInvalidRuntimeThread
	}
	return value, nil
}

func (c *Client) RegisterRuntimeThreadReply(
	ctx context.Context,
	token AccessToken,
	channelID string,
	threadID string,
	reference ThreadMessageRef,
	idempotencyKey string,
) (RuntimeThreadReply, error) {
	if !validUUIDv7(channelID) || !validUUIDv7(threadID) ||
		strings.TrimSpace(idempotencyKey) == "" || !validThreadMessageRef(reference, true) {
		return RuntimeThreadReply{}, ErrInvalidConfig
	}
	body, err := common.Marshal(struct {
		ChannelID  string                  `json:"channelId"`
		MessageRef runtimeThreadRefPayload `json:"messageRef"`
	}{ChannelID: channelID, MessageRef: runtimeThreadRefToPayload(reference)})
	if err != nil {
		return RuntimeThreadReply{}, ErrInvalidConfig
	}
	request, err := c.runtimeTaskRequest(
		ctx, token, http.MethodPost,
		"/runtime/threads/"+url.PathEscape(threadID)+"/replies", bytes.NewReader(body),
	)
	if err != nil {
		return RuntimeThreadReply{}, err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Idempotency-Key", strings.TrimSpace(idempotencyKey))
	response, err := c.doRuntimeRequest(request, http.StatusCreated)
	if err != nil {
		return RuntimeThreadReply{}, err
	}
	defer response.Body.Close()
	data, err := readBounded(response.Body, maxRuntimeThreadResponseBytes)
	if err != nil {
		return RuntimeThreadReply{}, ErrInvalidRuntimeThread
	}
	var payload runtimeThreadReplyPayload
	if err := common.Unmarshal(data, &payload); err != nil {
		return RuntimeThreadReply{}, ErrInvalidRuntimeThread
	}
	value, err := validateRuntimeThreadReply(payload)
	if err != nil || value.ThreadID != threadID {
		return RuntimeThreadReply{}, ErrInvalidRuntimeThread
	}
	return value, nil
}

func validateRuntimeThread(payload runtimeThreadPayload) (RuntimeThread, error) {
	root, err := runtimeThreadRefFromPayload(payload.RootMessageRef, false)
	if err != nil || !validUUIDv7(payload.ID) || !validUUIDv7(payload.ServerID) ||
		!validUUIDv7(payload.ChannelID) || payload.ReplyCount < 0 ||
		payload.UnreadCount < 0 || payload.CreatedAt.IsZero() ||
		payload.LastReplyAt != nil && payload.LastReplyAt.IsZero() {
		return RuntimeThread{}, ErrInvalidRuntimeThread
	}
	return RuntimeThread{
		ID: payload.ID, ServerID: payload.ServerID, ChannelID: payload.ChannelID,
		RootMessageRef: root, ReplyCount: payload.ReplyCount,
		UnreadCount: payload.UnreadCount, LastReplyAt: payload.LastReplyAt,
		CreatedAt: payload.CreatedAt.UTC(),
	}, nil
}

func validateRuntimeThreadReply(
	payload runtimeThreadReplyPayload,
) (RuntimeThreadReply, error) {
	reference, err := runtimeThreadRefFromPayload(payload.MessageRef, true)
	if err != nil || !validUUIDv7(payload.ID) || !validUUIDv7(payload.ThreadID) ||
		payload.CreatedAt.IsZero() {
		return RuntimeThreadReply{}, ErrInvalidRuntimeThread
	}
	return RuntimeThreadReply{
		ID: payload.ID, ThreadID: payload.ThreadID,
		MessageRef: reference, CreatedAt: payload.CreatedAt.UTC(),
	}, nil
}

func validThreadMessageRef(value ThreadMessageRef, requireSender bool) bool {
	return value.Kind == "group" && strings.TrimSpace(value.MessageID) != "" &&
		len(value.MessageID) <= 512 && strings.TrimSpace(value.GroupID) != "" &&
		(value.TopicID == "" || strings.TrimSpace(value.TopicID) != "") &&
		value.Sequence > 0 && value.Timestamp > 0 &&
		(!requireSender || strings.TrimSpace(value.SenderUserID) != "")
}

func runtimeThreadRefToPayload(value ThreadMessageRef) runtimeThreadRefPayload {
	return runtimeThreadRefPayload{
		Kind: value.Kind, MessageID: value.MessageID,
		GroupID:      stringPointerIfNotEmpty(value.GroupID),
		TopicID:      stringPointerIfNotEmpty(value.TopicID),
		SenderUserID: stringPointerIfNotEmpty(value.SenderUserID),
		Sequence:     value.Sequence, Timestamp: value.Timestamp,
	}
}

func runtimeThreadRefFromPayload(
	value runtimeThreadRefPayload,
	requireSender bool,
) (ThreadMessageRef, error) {
	result := ThreadMessageRef{
		Kind: value.Kind, MessageID: value.MessageID,
		GroupID: optionalString(value.GroupID), TopicID: optionalString(value.TopicID),
		SenderUserID: optionalString(value.SenderUserID),
		Sequence:     value.Sequence, Timestamp: value.Timestamp,
	}
	if !validThreadMessageRef(result, requireSender) {
		return ThreadMessageRef{}, ErrInvalidRuntimeThread
	}
	return result, nil
}

func stringPointerIfNotEmpty(value string) *string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return &value
}

func optionalString(value *string) string {
	if value == nil {
		return ""
	}
	return strings.TrimSpace(*value)
}
