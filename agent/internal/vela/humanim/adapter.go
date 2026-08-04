package humanim

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"velachat/agent/internal/common"
	"velachat/agent/internal/vela/humanplatform"
	"velachat/agent/internal/vela/im"
)

var (
	ErrInvalidConfig   = errors.New("Human IM Adapter 配置无效")
	ErrNotConnected    = errors.New("Human IM 尚未连接")
	ErrAlreadyStarted  = errors.New("Human IM 已连接")
	ErrUnsupported     = errors.New("Human IM 能力不受支持")
	ErrMessageNotFound = errors.New("Human IM 消息引用不存在")
	ErrOutsideScope    = errors.New("会话不属于当前 Server scope")
	ErrInvalidScope    = errors.New("Human IM Server scope 无效")
)

const maxAttachmentBytes int64 = 50 << 20

type codedError struct {
	cause error
	code  string
}

func (e codedError) Error() string      { return e.cause.Error() }
func (e codedError) Unwrap() error      { return e.cause }
func (e codedError) NativeCode() string { return e.code }

type SessionIssuer interface {
	IssueIMSession(context.Context) (humanplatform.IMSession, error)
}

type Config struct {
	Issuer       SessionIssuer
	NewTransport func() (im.Transport, error)
}

type Address struct {
	ChannelID      string  `json:"channelId,omitempty"`
	ConversationID string  `json:"conversationId"`
	DirectUserID   string  `json:"directUserId,omitempty"`
	IMGroupID      string  `json:"imGroupId,omitempty"`
	IMTopicID      *string `json:"imTopicId,omitempty"`
	TargetID       string  `json:"targetId"`
}

type MessageReference struct {
	Kind         string  `json:"kind"`
	MessageID    string  `json:"messageId"`
	Sequence     int64   `json:"sequence,omitempty"`
	Timestamp    int64   `json:"timestamp,omitempty"`
	GroupID      *string `json:"groupId,omitempty"`
	TopicID      *string `json:"topicId,omitempty"`
	SenderUserID *string `json:"senderUserId,omitempty"`
}

func messageReference(reference im.MessageRef) *MessageReference {
	if !reference.Valid() {
		return nil
	}
	value := &MessageReference{
		Kind: string(reference.Conversation().Kind()), MessageID: reference.MessageID(),
		Sequence: reference.Sequence(), Timestamp: reference.TimestampMS(),
	}
	conversation := reference.Conversation()
	switch conversation.Kind() {
	case im.ConversationC2C:
		peer := conversation.PeerUserID()
		value.SenderUserID = &peer
	case im.ConversationGroup:
		groupID := conversation.GroupID()
		value.GroupID = &groupID
	case im.ConversationTopic:
		groupID := conversation.GroupID()
		topicID := conversation.TopicID()
		value.GroupID = &groupID
		value.TopicID = &topicID
	}
	return value
}

type Message struct {
	ClientRequestID string            `json:"clientRequestId,omitempty"`
	Content         any               `json:"content"`
	ConversationID  string            `json:"conversationId"`
	CreatedAt       string            `json:"createdAt"`
	Delivery        map[string]any    `json:"delivery"`
	Direction       string            `json:"direction"`
	ID              string            `json:"id"`
	Kind            string            `json:"kind"`
	Mentions        []string          `json:"mentions"`
	Quote           any               `json:"quote,omitempty"`
	RawType         string            `json:"rawType"`
	Reactions       []any             `json:"reactions"`
	Read            map[string]any    `json:"read"`
	Reference       *MessageReference `json:"reference,omitempty"`
	SenderID        string            `json:"senderId"`
	SenderName      string            `json:"senderName"`
	Text            string            `json:"text"`
	Thread          map[string]any    `json:"thread,omitempty"`
}

type MessagePage struct {
	Completed  bool      `json:"completed"`
	Messages   []Message `json:"messages"`
	NextCursor string    `json:"nextCursor,omitempty"`
}

type HistoryInput struct {
	Channel Address `json:"channel"`
	Cursor  string  `json:"cursor,omitempty"`
}

type ReferencesInput struct {
	Channel    Address            `json:"channel"`
	References []MessageReference `json:"references"`
}

type ContextInput struct {
	Channel   Address          `json:"channel"`
	Reference MessageReference `json:"reference"`
}

type SendTextInput struct {
	Channel         Address `json:"channel"`
	ClientRequestID string  `json:"clientRequestId"`
	Mentions        []struct {
		IMUserID string `json:"imUserId"`
	} `json:"mentions"`
	Quote  any    `json:"quote,omitempty"`
	Text   string `json:"text"`
	Thread any    `json:"thread,omitempty"`
}

type SendTaskInput struct {
	Channel         Address        `json:"channel"`
	ClientRequestID string         `json:"clientRequestId"`
	Task            map[string]any `json:"task"`
}

type SendAttachmentInput struct {
	Channel         Address `json:"channel"`
	ClientRequestID string  `json:"clientRequestId"`
	Kind            string  `json:"kind"`
	Quote           any     `json:"quote,omitempty"`
	Source          struct {
		Kind     string `json:"kind"`
		Name     string `json:"name"`
		MIMEType string `json:"mimeType,omitempty"`
		URI      string `json:"uri"`
	} `json:"source"`
}

type SearchInput struct {
	Channel *Address `json:"channel,omitempty"`
	Cursor  string   `json:"cursor,omitempty"`
	Limit   int      `json:"limit,omitempty"`
	Query   string   `json:"query"`
}

type SearchPage struct {
	Completed  bool      `json:"completed"`
	Messages   []Message `json:"messages"`
	NextCursor string    `json:"nextCursor,omitempty"`
	TotalCount int       `json:"totalCount"`
}

type ConversationSummary struct {
	ConversationID     string `json:"conversationId"`
	Kind               string `json:"kind"`
	LastMessagePreview string `json:"lastMessagePreview"`
	PeerUserID         string `json:"peerUserId,omitempty"`
	Title              string `json:"title"`
	UnreadCount        int    `json:"unreadCount"`
}

type ConversationSnapshot struct {
	IsSyncCompleted bool                  `json:"isSyncCompleted"`
	Items           []ConversationSummary `json:"items"`
}

type ScopeInput struct {
	Generation             uint64    `json:"generation"`
	AllowedConversations   []Address `json:"allowedConversations"`
	AllowedMemberIMUserIDs []string  `json:"allowedMemberImUserIds"`
}

type EmitFunc func(any) error

type Adapter struct {
	config Config

	mu                   sync.Mutex
	transport            im.Transport
	selfUserID           string
	launchID             string
	ready                bool
	terminalErr          error
	references           map[string]im.MessageRef
	scopeSet             bool
	scopeGeneration      uint64
	allowedConversations map[string]struct{}
	allowedAddresses     []Address
	subscribers          map[string]map[uint64]EmitFunc
	nextSubID            atomic.Uint64
	pumpDone             chan struct{}
}

func NewAdapter(config Config) *Adapter {
	return &Adapter{
		config:               config,
		references:           make(map[string]im.MessageRef),
		allowedConversations: make(map[string]struct{}),
		subscribers: map[string]map[uint64]EmitFunc{
			"messages": {}, "lifecycle": {}, "conversations": {},
		},
	}
}

func (a *Adapter) Connect(ctx context.Context, launchID string) error {
	if a.config.Issuer == nil || a.config.NewTransport == nil || strings.TrimSpace(launchID) == "" {
		return ErrInvalidConfig
	}
	a.mu.Lock()
	if a.transport != nil {
		a.mu.Unlock()
		return ErrAlreadyStarted
	}
	a.mu.Unlock()
	session, err := a.config.Issuer.IssueIMSession(ctx)
	if err != nil {
		return err
	}
	transport, err := a.config.NewTransport()
	if err != nil {
		return err
	}
	if err := transport.Start(ctx, im.Session{
		SDKAppID: session.SDKAppID, UserID: session.UserID,
		UserSig: session.UserSig, LaunchID: launchID,
	}); err != nil {
		return err
	}
	a.mu.Lock()
	a.transport = transport
	a.selfUserID = session.UserID
	a.launchID = launchID
	a.ready = true
	a.terminalErr = nil
	a.pumpDone = make(chan struct{})
	a.mu.Unlock()
	a.publish("lifecycle", map[string]any{"type": "ready"})
	go a.pump(transport)
	return nil
}

func (a *Adapter) WaitUntilReady(context.Context) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.terminalErr != nil {
		return a.terminalErr
	}
	if !a.ready {
		return codedError{cause: ErrNotConnected, code: "IM_NOT_READY"}
	}
	return nil
}

func (a *Adapter) SetScope(_ context.Context, input ScopeInput) error {
	if input.Generation == 0 {
		return codedError{cause: ErrInvalidScope, code: "USAGE"}
	}
	allowed := make(map[string]struct{}, len(input.AllowedConversations)+len(input.AllowedMemberIMUserIDs))
	addresses := make([]Address, 0, len(input.AllowedConversations))
	for _, address := range input.AllowedConversations {
		conversation, err := conversationFromAddress(address)
		if err != nil || address.ConversationID != conversationID(conversation) {
			return codedError{cause: ErrInvalidScope, code: "USAGE"}
		}
		id := conversationID(conversation)
		allowed[id] = struct{}{}
		addresses = append(addresses, address)
	}
	for _, userID := range input.AllowedMemberIMUserIDs {
		conversation, err := im.NewC2CConversation(userID)
		if err != nil {
			return codedError{cause: ErrInvalidScope, code: "USAGE"}
		}
		allowed[conversationID(conversation)] = struct{}{}
	}

	a.mu.Lock()
	defer a.mu.Unlock()
	if input.Generation < a.scopeGeneration {
		return nil
	}
	a.scopeSet = true
	a.scopeGeneration = input.Generation
	a.allowedConversations = allowed
	a.allowedAddresses = addresses
	for messageID, reference := range a.references {
		if _, ok := allowed[conversationID(reference.Conversation())]; !ok {
			delete(a.references, messageID)
		}
	}
	return nil
}

func (a *Adapter) Close(ctx context.Context) error {
	a.mu.Lock()
	transport := a.transport
	pumpDone := a.pumpDone
	a.transport = nil
	a.ready = false
	a.mu.Unlock()
	if transport == nil {
		return nil
	}
	err := transport.Close(ctx)
	if pumpDone != nil {
		select {
		case <-pumpDone:
		case <-ctx.Done():
			return errors.Join(err, ctx.Err())
		}
	}
	a.publish("lifecycle", map[string]any{"type": "not_ready", "reason": "closed"})
	return err
}

func (a *Adapter) LoadHistory(ctx context.Context, input HistoryInput) (MessagePage, error) {
	transport, self, err := a.current()
	if err != nil {
		return MessagePage{}, err
	}
	history, ok := transport.(im.HistoryTransport)
	if !ok {
		return MessagePage{}, ErrUnsupported
	}
	conversation, err := a.authorizeAddress(input.Channel)
	if err != nil {
		return MessagePage{}, err
	}
	page, err := history.History(ctx, im.HistoryRequest{Conversation: conversation, Cursor: input.Cursor})
	if err != nil {
		return MessagePage{}, a.normalizeTransportError(err)
	}
	messages := make([]Message, 0, len(page.Messages))
	for _, incoming := range page.Messages {
		messages = append(messages, a.project(incoming, self))
	}
	return MessagePage{Completed: page.Completed, Messages: messages, NextCursor: page.NextCursor}, nil
}

func (a *Adapter) LoadMessagesByReferences(ctx context.Context, input ReferencesInput) ([]Message, error) {
	result := make([]Message, 0, len(input.References))
	for _, reference := range input.References {
		messages, err := a.loadContext(ctx, input.Channel, reference)
		if err != nil {
			return nil, err
		}
		for _, message := range messages {
			if message.ID == reference.MessageID {
				result = append(result, message)
				break
			}
		}
	}
	return result, nil
}

func (a *Adapter) LoadMessageContext(ctx context.Context, input ContextInput) ([]Message, error) {
	return a.loadContext(ctx, input.Channel, input.Reference)
}

func (a *Adapter) loadContext(ctx context.Context, address Address, reference MessageReference) ([]Message, error) {
	transport, self, err := a.current()
	if err != nil {
		return nil, err
	}
	history, ok := transport.(im.HistoryTransport)
	if !ok {
		return nil, ErrUnsupported
	}
	conversation, err := a.authorizeAddress(address)
	if err != nil {
		return nil, err
	}
	request := im.HistoryRequest{Conversation: conversation}
	if reference.Sequence > 0 {
		request.AroundSequence = reference.Sequence
	} else if reference.Timestamp > 0 {
		request.AroundTimestampMS = reference.Timestamp
	} else {
		return nil, im.ErrInvalidMessageRef
	}
	page, err := history.History(ctx, request)
	if err != nil {
		return nil, a.normalizeTransportError(err)
	}
	messages := make([]Message, 0, len(page.Messages))
	for _, incoming := range page.Messages {
		messages = append(messages, a.project(incoming, self))
	}
	return messages, nil
}

func (a *Adapter) MarkRead(ctx context.Context, address Address) error {
	transport, _, err := a.current()
	if err != nil {
		return err
	}
	history, ok := transport.(im.HistoryTransport)
	if !ok {
		return ErrUnsupported
	}
	conversation, err := a.authorizeAddress(address)
	if err != nil {
		return err
	}
	return a.normalizeTransportError(history.MarkRead(ctx, conversation))
}

func (a *Adapter) SendText(ctx context.Context, input SendTextInput) (Message, error) {
	transport, self, err := a.current()
	if err != nil {
		return Message{}, err
	}
	conversation, err := a.authorizeAddress(input.Channel)
	if err != nil {
		return Message{}, err
	}
	mentions := make([]string, 0, len(input.Mentions))
	for _, mention := range input.Mentions {
		mentions = append(mentions, mention.IMUserID)
	}
	metadata := map[string]any{"schema": "vela.client-message/v2", "clientRequestId": input.ClientRequestID}
	if input.Quote != nil {
		metadata["quote"] = input.Quote
	}
	cloud, err := common.Marshal(metadata)
	if err != nil {
		return Message{}, err
	}
	receipt, err := transport.SendText(ctx, im.SendTextRequest{
		Conversation: conversation, Text: input.Text,
		MentionUserIDs: mentions, CloudCustomData: string(cloud),
	})
	if err != nil {
		return Message{}, a.normalizeTransportError(err)
	}
	return a.outgoingMessage(conversation, receipt, self, input.ClientRequestID, input.Text, mentions, input.Quote), nil
}

func (a *Adapter) SendTask(ctx context.Context, input SendTaskInput) (Message, error) {
	transport, self, err := a.current()
	if err != nil {
		return Message{}, err
	}
	conversation, err := a.authorizeAddress(input.Channel)
	if err != nil {
		return Message{}, err
	}
	data, err := common.Marshal(input.Task)
	if err != nil {
		return Message{}, err
	}
	receipt, err := transport.SendCustom(ctx, im.SendCustomRequest{Conversation: conversation, CustomType: "Task", Data: data})
	if err != nil {
		return Message{}, a.normalizeTransportError(err)
	}
	message := a.outgoingMessage(conversation, receipt, self, input.ClientRequestID, fmt.Sprint(input.Task["title"]), nil, nil)
	message.Kind = "task"
	message.RawType = "TIMCustomElem"
	message.Content = map[string]any{
		"kind": "task", "taskId": fmt.Sprint(input.Task["taskId"]),
		"title": fmt.Sprint(input.Task["title"]), "status": fmt.Sprint(input.Task["status"]),
	}
	return message, nil
}

func (a *Adapter) SendAttachment(ctx context.Context, input SendAttachmentInput) (Message, error) {
	transport, self, err := a.current()
	if err != nil {
		return Message{}, err
	}
	attachments, ok := transport.(im.AttachmentTransport)
	if !ok {
		return Message{}, ErrUnsupported
	}
	filename, err := localPath(input.Source.URI)
	if err != nil {
		return Message{}, err
	}
	data, err := readAttachment(filename)
	if err != nil {
		return Message{}, err
	}
	conversation, err := a.authorizeAddress(input.Channel)
	if err != nil {
		return Message{}, err
	}
	receipt, err := attachments.SendAttachment(ctx, im.SendAttachmentRequest{
		Conversation: conversation, Filename: input.Source.Name,
		MIMEType: input.Source.MIMEType, Data: data,
	})
	if err != nil {
		return Message{}, a.normalizeTransportError(err)
	}
	message := a.outgoingMessage(conversation, receipt.SendReceipt, self, input.ClientRequestID, input.Source.Name, nil, input.Quote)
	message.Kind = input.Kind
	message.RawType = "TIMFileElem"
	message.Content = map[string]any{
		"kind": input.Kind, "name": receipt.Attachment.Filename,
		"mimeType": receipt.Attachment.MIMEType, "size": receipt.Attachment.SizeBytes,
		"url": receipt.Attachment.URL,
	}
	return message, nil
}

func (a *Adapter) Search(ctx context.Context, input SearchInput) (SearchPage, error) {
	transport, self, err := a.current()
	if err != nil {
		return SearchPage{}, err
	}
	search, ok := transport.(im.SearchTransport)
	if !ok {
		return SearchPage{}, ErrUnsupported
	}
	request := im.SearchRequest{Query: input.Query, Cursor: input.Cursor, Limit: input.Limit}
	if request.Limit == 0 {
		request.Limit = 50
	}
	if input.Channel != nil {
		conversation, err := a.authorizeAddress(*input.Channel)
		if err != nil {
			return SearchPage{}, err
		}
		request.Conversation = &conversation
	}
	page, err := search.Search(ctx, request)
	if err != nil {
		return SearchPage{}, a.normalizeTransportError(err)
	}
	messages := make([]Message, 0, len(page.Messages))
	for _, incoming := range page.Messages {
		if a.conversationAllowed(incoming.Ref.Conversation()) {
			messages = append(messages, a.project(incoming, self))
		}
	}
	return SearchPage{Completed: page.Completed, Messages: messages, NextCursor: page.NextCursor, TotalCount: page.TotalCount}, nil
}

func (a *Adapter) SetReaction(ctx context.Context, messageID, reactionID string, active bool) error {
	transport, _, err := a.current()
	if err != nil {
		return err
	}
	reactions, ok := transport.(im.ReactionTransport)
	if !ok {
		return ErrUnsupported
	}
	a.mu.Lock()
	reference, ok := a.references[messageID]
	a.mu.Unlock()
	if !ok {
		return ErrMessageNotFound
	}
	if !a.conversationAllowed(reference.Conversation()) {
		return codedError{cause: ErrOutsideScope, code: "AUTH_FORBIDDEN"}
	}
	return a.normalizeTransportError(reactions.SetReaction(ctx, reference, reactionID, active))
}

func (a *Adapter) Revoke(ctx context.Context, messageID string) (Message, error) {
	transport, self, err := a.current()
	if err != nil {
		return Message{}, err
	}
	recaller, ok := transport.(im.RecallTransport)
	if !ok {
		return Message{}, ErrUnsupported
	}
	a.mu.Lock()
	reference, found := a.references[messageID]
	a.mu.Unlock()
	if !found {
		return Message{}, ErrMessageNotFound
	}
	if !a.conversationAllowed(reference.Conversation()) {
		return Message{}, codedError{cause: ErrOutsideScope, code: "AUTH_FORBIDDEN"}
	}
	if err := recaller.Recall(ctx, reference); err != nil {
		return Message{}, a.normalizeTransportError(err)
	}
	projected := referenceFrom(reference, self)
	return Message{
		Content:        map[string]any{"kind": "system", "text": "[消息已撤回]"},
		ConversationID: conversationID(reference.Conversation()),
		CreatedAt:      time.UnixMilli(reference.TimestampMS()).UTC().Format(time.RFC3339Nano),
		Delivery:       map[string]any{"state": "sent"},
		Direction:      "outgoing",
		ID:             reference.MessageID(),
		Kind:           "system",
		Mentions:       []string{},
		RawType:        "TIMRevokedElem",
		Reactions:      []any{},
		Read:           map[string]any{"state": "unknown"},
		Reference:      &projected,
		SenderID:       self,
		SenderName:     self,
		Text:           "[消息已撤回]",
	}, nil
}

func (a *Adapter) ListConversations(ctx context.Context, _ []string) (ConversationSnapshot, error) {
	transport, _, err := a.current()
	if err != nil {
		return ConversationSnapshot{}, err
	}
	allowed, addresses, err := a.scopeSnapshot()
	if err != nil {
		return ConversationSnapshot{}, err
	}
	projected := make([]ConversationSummary, 0, len(allowed))
	seen := make(map[string]struct{}, len(allowed))
	syncCompleted := true
	if conversations, ok := transport.(im.ConversationTransport); ok {
		snapshot, snapshotErr := conversations.Conversations(ctx)
		if snapshotErr != nil {
			return ConversationSnapshot{}, a.normalizeTransportError(snapshotErr)
		}
		syncCompleted = snapshot.IsSyncCompleted
		for _, item := range snapshot.Items {
			id := conversationID(item.Conversation)
			if _, permitted := allowed[id]; !permitted {
				continue
			}
			projected = append(projected, projectConversationSummary(item))
			seen[id] = struct{}{}
		}
	} else if history, ok := transport.(im.HistoryTransport); ok {
		unread, unreadErr := history.UnreadConversations(ctx)
		if unreadErr != nil {
			return ConversationSnapshot{}, a.normalizeTransportError(unreadErr)
		}
		for _, item := range unread {
			id := conversationID(item.Conversation)
			if _, permitted := allowed[id]; !permitted {
				continue
			}
			projected = append(projected, ConversationSummary{
				ConversationID: id,
				Kind:           conversationKind(item.Conversation),
				Title:          conversationFallbackTitle(item.Conversation),
				UnreadCount:    item.UnreadCount,
			})
			seen[id] = struct{}{}
		}
	}
	for _, address := range addresses {
		if _, exists := seen[address.ConversationID]; exists {
			continue
		}
		projected = append(projected, ConversationSummary{
			ConversationID: address.ConversationID,
			Kind:           "group",
			Title:          address.TargetID,
		})
	}
	return ConversationSnapshot{IsSyncCompleted: syncCompleted, Items: projected}, nil
}

func (a *Adapter) MessagesTopic(ctx context.Context, _ any, emit EmitFunc) error {
	return a.topic(ctx, "messages", emit)
}

func (a *Adapter) LifecycleTopic(ctx context.Context, _ any, emit EmitFunc) error {
	return a.topic(ctx, "lifecycle", emit)
}

func (a *Adapter) ConversationsTopic(ctx context.Context, _ any, emit EmitFunc) error {
	return a.topic(ctx, "conversations", emit)
}

func (a *Adapter) topic(ctx context.Context, topic string, emit EmitFunc) error {
	if emit == nil {
		return ErrInvalidConfig
	}
	id := a.nextSubID.Add(1)
	a.mu.Lock()
	a.subscribers[topic][id] = emit
	a.mu.Unlock()
	defer func() {
		a.mu.Lock()
		delete(a.subscribers[topic], id)
		a.mu.Unlock()
	}()
	<-ctx.Done()
	return ctx.Err()
}

func (a *Adapter) pump(transport im.Transport) {
	a.mu.Lock()
	done := a.pumpDone
	a.mu.Unlock()
	defer close(done)
	for event := range transport.Events() {
		a.mu.Lock()
		self := a.selfUserID
		a.mu.Unlock()
		switch event.Type {
		case im.EventMessage:
			if event.Message != nil && a.conversationAllowed(event.Message.Ref.Conversation()) {
				a.publish("messages", []Message{a.project(*event.Message, self)})
			}
		case im.EventConversationUpdated:
			updates := make([]ConversationSummary, 0, len(event.Conversations))
			for _, item := range event.Conversations {
				if a.conversationAllowed(item.Conversation) {
					updates = append(updates, projectConversationSummary(item))
				}
			}
			if len(updates) > 0 {
				a.publish("conversations", updates)
			}
		case im.EventReady:
			a.publish("lifecycle", map[string]any{"type": "ready"})
		case im.EventNetworkChanged:
			a.publish("lifecycle", map[string]any{"type": "network", "state": "connecting"})
		case im.EventUserSigExpiring:
			a.publish("lifecycle", map[string]any{"type": "not_ready", "reason": "user_sig_expired"})
		case im.EventKickedOut:
			reason := friendlyKickedOutReason(event.Reason)
			a.mu.Lock()
			a.ready = false
			a.terminalErr = codedError{
				cause: errors.New(reason),
				code:  "IM_KICKED_OUT",
			}
			a.mu.Unlock()
			a.publish("lifecycle", map[string]any{"type": "kicked_out", "reason": reason})
		case im.EventSDKError:
			a.publish("lifecycle", map[string]any{"type": "error", "message": event.Code})
		}
	}
}

func projectConversationSummary(item im.ConversationSummary) ConversationSummary {
	id := conversationID(item.Conversation)
	peerUserID := ""
	if item.Conversation.Kind() == im.ConversationC2C {
		peerUserID = item.Conversation.PeerUserID()
	}
	return ConversationSummary{
		ConversationID: id,
		Kind:           conversationKind(item.Conversation),
		PeerUserID:     peerUserID,
		Title:          item.Title,
		UnreadCount:    item.UnreadCount,
	}
}

func conversationKind(conversation im.Conversation) string {
	if conversation.Kind() == im.ConversationC2C {
		return "direct"
	}
	return "group"
}

func conversationFallbackTitle(conversation im.Conversation) string {
	if conversation.Kind() == im.ConversationC2C {
		return conversation.PeerUserID()
	}
	if conversation.Kind() == im.ConversationTopic {
		return conversation.TopicID()
	}
	return conversation.GroupID()
}

func (a *Adapter) authorizeAddress(address Address) (im.Conversation, error) {
	conversation, err := conversationFromAddress(address)
	if err != nil {
		return im.Conversation{}, err
	}
	if address.ConversationID != conversationID(conversation) || !a.conversationAllowed(conversation) {
		return im.Conversation{}, codedError{cause: ErrOutsideScope, code: "AUTH_FORBIDDEN"}
	}
	return conversation, nil
}

func (a *Adapter) conversationAllowed(conversation im.Conversation) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.scopeSet {
		return false
	}
	_, ok := a.allowedConversations[conversationID(conversation)]
	return ok
}

func (a *Adapter) scopeSnapshot() (map[string]struct{}, []Address, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.scopeSet {
		return nil, nil, codedError{cause: ErrOutsideScope, code: "AUTH_FORBIDDEN"}
	}
	allowed := make(map[string]struct{}, len(a.allowedConversations))
	for id := range a.allowedConversations {
		allowed[id] = struct{}{}
	}
	return allowed, append([]Address(nil), a.allowedAddresses...), nil
}

func (a *Adapter) publish(topic string, value any) {
	a.mu.Lock()
	callbacks := make(map[uint64]EmitFunc, len(a.subscribers[topic]))
	for id, callback := range a.subscribers[topic] {
		callbacks[id] = callback
	}
	a.mu.Unlock()
	for id, callback := range callbacks {
		if err := callback(value); err != nil {
			a.mu.Lock()
			delete(a.subscribers[topic], id)
			a.mu.Unlock()
		}
	}
}

func (a *Adapter) current() (im.Transport, string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.terminalErr != nil {
		return nil, "", a.terminalErr
	}
	if a.transport == nil || !a.ready {
		return nil, "", codedError{cause: ErrNotConnected, code: "IM_NOT_READY"}
	}
	return a.transport, a.selfUserID, nil
}

func (a *Adapter) normalizeTransportError(err error) error {
	if err == nil {
		return nil
	}
	var safe interface{ SafeCode() string }
	if !errors.As(err, &safe) || safe.SafeCode() != "sdk_2024" {
		return err
	}
	var normalized error = codedError{
		cause: fmt.Errorf("%w：腾讯云 IM 登录态已失效，请重新连接", ErrNotConnected),
		code:  "IM_NOT_READY",
	}
	a.mu.Lock()
	a.ready = false
	if a.terminalErr == nil {
		a.terminalErr = normalized
	} else {
		normalized = a.terminalErr
	}
	a.mu.Unlock()
	return normalized
}

func friendlyKickedOutReason(reason string) string {
	switch strings.TrimSpace(reason) {
	case "kicked_out_mult_account":
		return "腾讯云 IM 登录已被其他客户端挤下线"
	case "kicked_out_mult_device":
		return "腾讯云 IM 已在其他设备登录"
	case "kicked_out_rest_api":
		return "腾讯云 IM 会话已被后台结束"
	default:
		return "腾讯云 IM 登录已失效"
	}
}

func (a *Adapter) project(incoming im.IncomingMessage, self string) Message {
	text := ""
	kind := "unsupported"
	rawType := "TIMUnknownElem"
	var content any = map[string]any{"kind": "unsupported", "rawType": rawType}
	mentions := make([]string, 0)
	for _, element := range incoming.Elements {
		switch element.Type {
		case im.ElementText:
			text += element.Text
			kind, rawType = "text", "TIMTextElem"
			content = map[string]any{"kind": "text", "text": text}
		case im.ElementMention:
			mentions = append(mentions, element.UserIDs...)
			if element.Text != "" {
				text += element.Text
			}
			kind, rawType = "text", "TIMTextElem"
			content = map[string]any{"kind": "text", "text": text}
		case im.ElementAttachment:
			kind, rawType = "file", "TIMFileElem"
			if element.Attachment != nil {
				text = element.Attachment.Filename
				content = map[string]any{
					"kind": "file", "name": element.Attachment.Filename,
					"mimeType": element.Attachment.MIMEType, "size": element.Attachment.SizeBytes,
					"url": element.Attachment.URL,
				}
			}
		case im.ElementCustom:
			kind, rawType = "custom", "TIMCustomElem"
			text = element.CustomType
			content = map[string]any{"kind": "custom", "description": element.CustomType, "data": string(element.Data)}
		}
	}
	reference := referenceFrom(incoming.Ref, incoming.SenderUserID)
	a.mu.Lock()
	a.references[incoming.Ref.MessageID()] = incoming.Ref
	a.mu.Unlock()
	metadata := decodeMetadata(incoming.CloudCustomData)
	message := Message{
		ClientRequestID: stringValue(metadata["clientRequestId"]),
		Content:         content, ConversationID: conversationID(incoming.Ref.Conversation()),
		CreatedAt: time.UnixMilli(incoming.Ref.TimestampMS()).UTC().Format(time.RFC3339Nano),
		Delivery:  map[string]any{"state": "sent"},
		Direction: direction(incoming.SenderUserID, self), ID: incoming.Ref.MessageID(),
		Kind: kind, Mentions: mentions, RawType: rawType, Reactions: []any{},
		Read: map[string]any{"state": "unknown"}, Reference: &reference,
		SenderID: incoming.SenderUserID, SenderName: incoming.SenderUserID, Text: text,
	}
	if quote, exists := metadata["quote"]; exists {
		message.Quote = quote
	}
	return message
}

func (a *Adapter) outgoingMessage(conversation im.Conversation, receipt im.SendReceipt, self, clientRequestID, text string, mentions []string, quote any) Message {
	reference, _ := im.NewMessageRef(conversation, receipt.MessageID, receipt.Sequence, receipt.TimestampMS)
	a.mu.Lock()
	a.references[receipt.MessageID] = reference
	a.mu.Unlock()
	projected := referenceFrom(reference, self)
	message := Message{
		ClientRequestID: clientRequestID,
		Content:         map[string]any{"kind": "text", "text": text},
		ConversationID:  conversationID(conversation),
		CreatedAt:       time.UnixMilli(receipt.TimestampMS).UTC().Format(time.RFC3339Nano),
		Delivery:        map[string]any{"state": "sent"}, Direction: "outgoing",
		ID: receipt.MessageID, Kind: "text", Mentions: mentions, RawType: "TIMTextElem",
		Reactions: []any{}, Read: map[string]any{"state": "unknown"}, Reference: &projected,
		SenderID: self, SenderName: self, Text: text,
	}
	if quote != nil {
		message.Quote = quote
	}
	return message
}

func conversationFromAddress(address Address) (im.Conversation, error) {
	if address.DirectUserID != "" {
		return im.NewC2CConversation(address.DirectUserID)
	}
	if address.IMTopicID != nil && *address.IMTopicID != "" {
		return im.NewTopicConversation(address.IMGroupID, *address.IMTopicID)
	}
	if address.IMGroupID != "" {
		return im.NewGroupConversation(address.IMGroupID)
	}
	return im.Conversation{}, im.ErrInvalidConversation
}

func conversationID(conversation im.Conversation) string {
	switch conversation.Kind() {
	case im.ConversationC2C:
		return "C2C" + conversation.PeerUserID()
	case im.ConversationTopic:
		return "GROUP" + conversation.TopicID()
	case im.ConversationGroup:
		return "GROUP" + conversation.GroupID()
	default:
		return ""
	}
}

func referenceFrom(reference im.MessageRef, sender string) MessageReference {
	conversation := reference.Conversation()
	result := MessageReference{
		Kind: string(conversation.Kind()), MessageID: reference.MessageID(),
		Sequence: reference.Sequence(), Timestamp: reference.TimestampMS(), SenderUserID: &sender,
	}
	if conversation.Kind() != im.ConversationC2C {
		groupID := conversation.GroupID()
		result.Kind = "group"
		result.GroupID = &groupID
		if conversation.Kind() == im.ConversationTopic {
			topicID := conversation.TopicID()
			result.TopicID = &topicID
		}
	}
	return result
}

func direction(sender, self string) string {
	if sender == self {
		return "outgoing"
	}
	return "incoming"
}

func decodeMetadata(raw string) map[string]any {
	var value map[string]any
	if strings.TrimSpace(raw) == "" || common.Unmarshal([]byte(raw), &value) != nil {
		return map[string]any{}
	}
	return value
}

func stringValue(value any) string {
	result, _ := value.(string)
	return result
}

func localPath(raw string) (string, error) {
	if strings.HasPrefix(raw, "file://") {
		parsed, err := url.Parse(raw)
		if err != nil || parsed.Scheme != "file" || (parsed.Host != "" && parsed.Host != "localhost") || !filepath.IsAbs(parsed.Path) {
			return "", im.ErrInvalidAttachment
		}
		return filepath.Clean(parsed.Path), nil
	}
	if !filepath.IsAbs(strings.TrimSpace(raw)) {
		return "", im.ErrInvalidAttachment
	}
	return filepath.Clean(raw), nil
}

func readAttachment(filename string) ([]byte, error) {
	file, err := os.Open(filename)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > maxAttachmentBytes {
		return nil, im.ErrInvalidAttachment
	}
	contents, err := io.ReadAll(io.LimitReader(file, maxAttachmentBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(contents)) > maxAttachmentBytes {
		return nil, im.ErrInvalidAttachment
	}
	return contents, nil
}
