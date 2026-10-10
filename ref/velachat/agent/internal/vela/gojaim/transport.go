package gojaim

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"path"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"velachat/agent/internal/common"
	"velachat/agent/internal/vela/im"
)

var (
	ErrInvalidTransportConfig = errors.New("Goja IM Transport 配置无效")
	ErrTransportStarted       = errors.New("Goja IM Transport 已启动")
	ErrTransportNotStarted    = errors.New("Goja IM Transport 尚未启动")
	ErrInvalidSDKResult       = errors.New("LiteChat 返回结构无效")
	ErrInvalidMention         = errors.New("LiteChat mention 参数无效")
)

const topicMarker = "@TOPIC#_"

const readinessProbeInterval = 250 * time.Millisecond

type commandEngine interface {
	Command(context.Context, map[string]any) (any, error)
	DrainEvents(context.Context) ([]RuntimeEvent, error)
	Close(context.Context) error
}

type asynchronousCommandEngine interface {
	BeginCommand(map[string]any) (<-chan commandResult, error)
}

type TransportConfig struct {
	Host           Host
	StartTimeout   time.Duration
	RequestTimeout time.Duration
	PollInterval   time.Duration

	newEngine func(int, Host) (commandEngine, error)
}

type Transport struct {
	config TransportConfig
	events chan im.Event

	mu       sync.Mutex
	engine   commandEngine
	session  im.Session
	cancel   context.CancelFunc
	closed   bool
	pumpDone chan struct{}
	eventID  atomic.Uint64
}

var _ im.Transport = (*Transport)(nil)
var _ im.HistoryTransport = (*Transport)(nil)
var _ im.ConversationTransport = (*Transport)(nil)
var _ im.SearchTransport = (*Transport)(nil)
var _ im.ReactionTransport = (*Transport)(nil)
var _ im.RecallTransport = (*Transport)(nil)
var _ im.AttachmentTransport = (*Transport)(nil)

func NewTransport(config TransportConfig) (*Transport, error) {
	if config.StartTimeout <= 0 {
		config.StartTimeout = 20 * time.Second
	}
	if config.RequestTimeout <= 0 {
		config.RequestTimeout = 20 * time.Second
	}
	if config.PollInterval <= 0 {
		config.PollInterval = 50 * time.Millisecond
	}
	if config.Host == nil {
		config.Host = NewNetworkHost(NetworkHostConfig{})
	}
	if config.newEngine == nil {
		config.newEngine = func(
			sdkAppID int,
			host Host,
		) (commandEngine, error) {
			return NewEngine(Config{
				SDKAppID: sdkAppID,
				Host:     host,
				Timeout:  config.StartTimeout,
			})
		}
	}
	if config.Host == nil || config.newEngine == nil {
		return nil, ErrInvalidTransportConfig
	}
	return &Transport{
		config:   config,
		events:   make(chan im.Event, 64),
		pumpDone: make(chan struct{}),
	}, nil
}

func (t *Transport) Start(
	parent context.Context,
	session im.Session,
) error {
	if session.SDKAppID <= 0 ||
		strings.TrimSpace(session.UserID) == "" ||
		strings.TrimSpace(session.UserSig.Reveal()) == "" ||
		strings.TrimSpace(session.LaunchID) == "" {
		return ErrInvalidTransportConfig
	}
	t.mu.Lock()
	if t.engine != nil || t.closed {
		t.mu.Unlock()
		return ErrTransportStarted
	}
	t.mu.Unlock()

	startContext, startCancel := context.WithTimeout(
		parent,
		t.config.StartTimeout,
	)
	defer startCancel()
	engine, err := t.config.newEngine(
		session.SDKAppID,
		t.config.Host,
	)
	if err != nil {
		return err
	}
	loginResult, err := beginCommand(engine, startContext, map[string]any{
		"op":      "login",
		"userID":  session.UserID,
		"userSig": session.UserSig.Reveal(),
	})
	if err != nil {
		_ = engine.Close(startContext)
		return err
	}
	if err := t.waitReady(startContext, engine, session, loginResult); err != nil {
		_ = engine.Close(startContext)
		return err
	}

	pumpContext, cancel := context.WithCancel(context.Background())
	t.mu.Lock()
	if t.closed {
		t.mu.Unlock()
		cancel()
		_ = engine.Close(startContext)
		return ErrEngineClosed
	}
	t.engine = engine
	t.session = session
	t.cancel = cancel
	t.mu.Unlock()
	go t.pump(pumpContext)
	return nil
}

func (t *Transport) SendText(
	ctx context.Context,
	request im.SendTextRequest,
) (im.SendReceipt, error) {
	if !request.Conversation.Valid() ||
		strings.TrimSpace(request.Text) == "" ||
		len(request.CloudCustomData) > 8*1024 {
		return im.SendReceipt{}, im.ErrInvalidConversation
	}
	if err := validateMentionUserIDs(
		request.Conversation,
		request.MentionUserIDs,
	); err != nil {
		return im.SendReceipt{}, err
	}
	result, err := t.command(ctx, map[string]any{
		"op":                "sendText",
		"conversation":      conversationValue(request.Conversation),
		"text":              request.Text,
		"mention_user_ids":  append([]string(nil), request.MentionUserIDs...),
		"cloud_custom_data": request.CloudCustomData,
	})
	if err != nil {
		return im.SendReceipt{}, err
	}
	return parseReceipt(result)
}

func (t *Transport) SendCustom(
	ctx context.Context,
	request im.SendCustomRequest,
) (im.SendReceipt, error) {
	if !request.Conversation.Valid() ||
		strings.TrimSpace(request.CustomType) == "" {
		return im.SendReceipt{}, im.ErrInvalidConversation
	}
	var data any
	if err := common.Unmarshal(request.Data, &data); err != nil {
		return im.SendReceipt{}, err
	}
	result, err := t.command(ctx, map[string]any{
		"op":           "sendCustom",
		"conversation": conversationValue(request.Conversation),
		"custom_type":  request.CustomType,
		"data":         data,
	})
	if err != nil {
		return im.SendReceipt{}, err
	}
	return parseReceipt(result)
}

func (t *Transport) SendAttachment(
	ctx context.Context,
	request im.SendAttachmentRequest,
) (im.SendAttachmentReceipt, error) {
	filename := strings.TrimSpace(request.Filename)
	mimeType := strings.TrimSpace(request.MIMEType)
	if !request.Conversation.Valid() || filename == "" || mimeType == "" ||
		len(request.Data) == 0 || len(request.Data) > 50<<20 ||
		len(request.CloudCustomData) > 8*1024 {
		return im.SendAttachmentReceipt{}, im.ErrInvalidAttachment
	}
	result, err := t.command(ctx, map[string]any{
		"op":                "sendAttachment",
		"conversation":      conversationValue(request.Conversation),
		"filename":          filename,
		"mime_type":         mimeType,
		"data":              append([]byte(nil), request.Data...),
		"cloud_custom_data": request.CloudCustomData,
	})
	if err != nil {
		return im.SendAttachmentReceipt{}, err
	}
	return parseAttachmentReceipt(result)
}

func (t *Transport) UnreadConversations(
	ctx context.Context,
) ([]im.UnreadConversation, error) {
	result, err := t.command(ctx, map[string]any{
		"op": "listUnread",
	})
	if err != nil {
		return nil, err
	}
	value, ok := asMap(result)
	if !ok {
		return nil, ErrInvalidSDKResult
	}
	// LiteChat can keep isSyncCompleted false for a newly provisioned identity
	// until its first conversation arrives. Treat the current list as a
	// best-effort recovery snapshot so realtime delivery is never blocked by
	// an empty-account synchronization deadlock. A later reconnect or session
	// refresh takes another snapshot and continues backlog recovery.
	values, ok := asSlice(value["conversationList"])
	if !ok {
		return nil, ErrInvalidSDKResult
	}
	unread := make([]im.UnreadConversation, 0, len(values))
	for _, candidate := range values {
		conversationValue, ok := asMap(candidate)
		if !ok {
			continue
		}
		count, ok := numberInt(conversationValue["unreadCount"])
		if !ok || count <= 0 {
			continue
		}
		conversation, err := parseConversationID(
			stringValue(conversationValue["conversationID"]),
		)
		if err != nil {
			continue
		}
		unread = append(unread, im.UnreadConversation{
			Conversation: conversation,
			UnreadCount:  count,
		})
	}
	return unread, nil
}

func (t *Transport) Conversations(ctx context.Context) (im.ConversationSnapshot, error) {
	result, err := t.command(ctx, map[string]any{"op": "listConversations"})
	if err != nil {
		return im.ConversationSnapshot{}, err
	}
	value, ok := asMap(result)
	if !ok {
		return im.ConversationSnapshot{}, ErrInvalidSDKResult
	}
	values, ok := asSlice(value["conversationList"])
	if !ok {
		return im.ConversationSnapshot{}, ErrInvalidSDKResult
	}
	completed, ok := value["isSyncCompleted"].(bool)
	if !ok {
		return im.ConversationSnapshot{}, ErrInvalidSDKResult
	}
	items := make([]im.ConversationSummary, 0, len(values))
	for _, candidate := range values {
		item, ok := projectSDKConversation(candidate)
		if ok {
			items = append(items, item)
		}
	}
	return im.ConversationSnapshot{Items: items, IsSyncCompleted: completed}, nil
}

func (t *Transport) History(
	ctx context.Context,
	request im.HistoryRequest,
) (im.HistoryPage, error) {
	if !request.Conversation.Valid() {
		return im.HistoryPage{}, im.ErrInvalidConversation
	}
	result, err := t.command(ctx, map[string]any{
		"op":              "history",
		"conversation":    conversationValue(request.Conversation),
		"cursor":          request.Cursor,
		"after_sequence":  request.AfterSequence,
		"around_sequence": request.AroundSequence,
		"around_time_ms":  request.AroundTimestampMS,
	})
	if err != nil {
		return im.HistoryPage{}, err
	}
	response, ok := asMap(result)
	if !ok {
		return im.HistoryPage{}, ErrInvalidSDKResult
	}
	data, ok := asMap(response["data"])
	if !ok {
		return im.HistoryPage{}, ErrInvalidSDKResult
	}
	values, ok := asSlice(data["messageList"])
	if !ok {
		return im.HistoryPage{}, ErrInvalidSDKResult
	}
	completed, ok := data["isCompleted"].(bool)
	if !ok {
		return im.HistoryPage{}, ErrInvalidSDKResult
	}
	messages := make([]im.IncomingMessage, 0, len(values))
	for _, value := range values {
		message, err := projectSDKMessage(value, t.session.UserID)
		if err == nil {
			messages = append(messages, message)
		}
	}
	return im.HistoryPage{
		Messages:   messages,
		NextCursor: stringValue(data["nextReqMessageID"]),
		Completed:  completed,
	}, nil
}

func (t *Transport) MarkRead(
	ctx context.Context,
	conversation im.Conversation,
) error {
	if !conversation.Valid() {
		return im.ErrInvalidConversation
	}
	_, err := t.command(ctx, map[string]any{
		"op":           "markRead",
		"conversation": conversationValue(conversation),
	})
	return err
}

func (t *Transport) Search(
	ctx context.Context,
	request im.SearchRequest,
) (im.SearchPage, error) {
	query := strings.TrimSpace(request.Query)
	if query == "" || request.Limit <= 0 || request.Limit > 100 {
		return im.SearchPage{}, ErrInvalidSDKResult
	}
	command := map[string]any{
		"op":     "search",
		"query":  query,
		"cursor": strings.TrimSpace(request.Cursor),
		"limit":  request.Limit,
	}
	if request.Conversation != nil {
		if !request.Conversation.Valid() {
			return im.SearchPage{}, im.ErrInvalidConversation
		}
		command["conversation"] = conversationValue(*request.Conversation)
	}
	result, err := t.command(ctx, command)
	if err != nil {
		return im.SearchPage{}, err
	}
	response, ok := asMap(result)
	if !ok {
		return im.SearchPage{}, ErrInvalidSDKResult
	}
	data, ok := asMap(response["data"])
	if !ok {
		return im.SearchPage{}, ErrInvalidSDKResult
	}
	values := searchMessageValues(data)
	messages := make([]im.IncomingMessage, 0, len(values))
	for _, value := range values {
		message, projectErr := projectSDKMessage(value, t.session.UserID)
		if projectErr == nil {
			messages = append(messages, message)
		}
	}
	cursor := stringValue(data["nextCursor"])
	if cursor == "" {
		cursor = stringValue(data["cursor"])
	}
	totalCount, totalOK := numberInt(data["totalCount"])
	if !totalOK {
		totalCount = len(messages)
	}
	completed, completedOK := data["isCompleted"].(bool)
	if !completedOK {
		completed = cursor == ""
	}
	return im.SearchPage{
		Messages: messages, NextCursor: cursor,
		Completed: completed, TotalCount: totalCount,
	}, nil
}

func searchMessageValues(data map[string]any) []any {
	if values, ok := asSlice(data["messageList"]); ok {
		return values
	}
	groups, ok := asSlice(data["searchResultList"])
	if !ok {
		return nil
	}
	result := make([]any, 0)
	for _, value := range groups {
		group, ok := asMap(value)
		if !ok {
			continue
		}
		if messages, ok := asSlice(group["messageList"]); ok {
			result = append(result, messages...)
		}
	}
	return result
}

func (t *Transport) SetReaction(
	ctx context.Context,
	reference im.MessageRef,
	reactionID string,
	active bool,
) error {
	reactionID = strings.TrimSpace(reactionID)
	if !reference.Conversation().Valid() ||
		strings.TrimSpace(reference.MessageID()) == "" ||
		reactionID == "" || len([]rune(reactionID)) > 32 {
		return ErrInvalidSDKResult
	}
	_, err := t.command(ctx, map[string]any{
		"op":           "setReaction",
		"conversation": conversationValue(reference.Conversation()),
		"message_id":   reference.MessageID(),
		"sequence":     reference.Sequence(),
		"timestamp_ms": reference.TimestampMS(),
		"reaction_id":  reactionID,
		"active":       active,
	})
	return err
}

func (t *Transport) Recall(ctx context.Context, reference im.MessageRef) error {
	if !reference.Valid() {
		return im.ErrInvalidMessageRef
	}
	_, err := t.command(ctx, map[string]any{
		"op":           "revoke",
		"conversation": conversationValue(reference.Conversation()),
		"message_id":   reference.MessageID(),
		"sequence":     reference.Sequence(),
		"timestamp_ms": reference.TimestampMS(),
	})
	return err
}

func (t *Transport) Events() <-chan im.Event {
	return t.events
}

func (t *Transport) Close(ctx context.Context) error {
	t.mu.Lock()
	if t.closed {
		t.mu.Unlock()
		return nil
	}
	t.closed = true
	engine := t.engine
	cancel := t.cancel
	t.mu.Unlock()
	if engine == nil {
		close(t.events)
		return nil
	}
	if cancel != nil {
		cancel()
	}
	select {
	case <-t.pumpDone:
	case <-ctx.Done():
		return ctx.Err()
	}
	_, logoutErr := engine.Command(ctx, map[string]any{"op": "logout"})
	closeErr := engine.Close(ctx)
	close(t.events)
	return errors.Join(logoutErr, closeErr)
}

func (t *Transport) command(
	ctx context.Context,
	request map[string]any,
) (any, error) {
	t.mu.Lock()
	engine := t.engine
	closed := t.closed
	t.mu.Unlock()
	if engine == nil || closed {
		return nil, ErrTransportNotStarted
	}
	requestContext, cancel := context.WithTimeout(
		ctx,
		t.config.RequestTimeout,
	)
	defer cancel()
	return engine.Command(requestContext, request)
}

func (t *Transport) waitReady(
	ctx context.Context,
	engine commandEngine,
	session im.Session,
	loginResult <-chan commandResult,
) error {
	ticker := time.NewTicker(t.config.PollInterval)
	defer ticker.Stop()
	var nextProbe time.Time
	for {
		events, err := engine.DrainEvents(ctx)
		if err != nil {
			return err
		}
		for _, event := range events {
			if event.Type == "ready" {
				return nil
			}
			for _, projected := range t.projectRuntimeEvent(
				event,
				session,
			) {
				select {
				case t.events <- projected:
				case <-ctx.Done():
					return ctx.Err()
				}
			}
		}
		select {
		case completed := <-loginResult:
			if completed.err != nil {
				return completed.err
			}
			loginResult = nil
		default:
		}
		if !time.Now().Before(nextProbe) {
			result, probeErr := engine.Command(ctx, map[string]any{
				"op": "loginState",
			})
			if probeErr == nil && functionalReady(result, session.UserID) {
				return nil
			}
			nextProbe = time.Now().Add(readinessProbeInterval)
		}
		select {
		case <-ticker.C:
		case completed := <-loginResult:
			if completed.err != nil {
				return completed.err
			}
			loginResult = nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

func beginCommand(
	engine commandEngine,
	ctx context.Context,
	request map[string]any,
) (<-chan commandResult, error) {
	if asynchronous, ok := engine.(asynchronousCommandEngine); ok {
		return asynchronous.BeginCommand(request)
	}
	result := make(chan commandResult, 1)
	go func() {
		value, err := engine.Command(ctx, request)
		result <- commandResult{value: value, err: err}
	}()
	return result, nil
}

func functionalReady(result any, expectedUserID string) bool {
	value, ok := asMap(result)
	if !ok {
		return false
	}
	return strings.TrimSpace(expectedUserID) != "" &&
		stringValue(value["userID"]) == expectedUserID
}

func (t *Transport) pump(ctx context.Context) {
	defer close(t.pumpDone)
	ticker := time.NewTicker(t.config.PollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			t.mu.Lock()
			engine := t.engine
			session := t.session
			t.mu.Unlock()
			if engine == nil {
				continue
			}
			events, err := engine.DrainEvents(ctx)
			if err != nil {
				return
			}
			for _, event := range events {
				for _, projected := range t.projectRuntimeEvent(
					event,
					session,
				) {
					select {
					case t.events <- projected:
					case <-ctx.Done():
						return
					}
				}
			}
		case <-ctx.Done():
			return
		}
	}
}

func (t *Transport) projectRuntimeEvent(
	event RuntimeEvent,
	session im.Session,
) []im.Event {
	base := im.Event{
		ID:       t.nextEventID(),
		LaunchID: session.LaunchID,
	}
	switch event.Type {
	case "ready":
		base.Type = im.EventReady
		return []im.Event{base}
	case "not_ready", "network_changed":
		base.Type = im.EventNetworkChanged
		base.Retryable = true
		return []im.Event{base}
	case "usersig_expiring":
		base.Type = im.EventUserSigExpiring
		return []im.Event{base}
	case "kicked_out":
		base.Type = im.EventKickedOut
		base.Reason = safeKickedOutReason(event.Data)
		return []im.Event{base}
	case "sdk_error":
		base.Type = im.EventSDKError
		base.Retryable = true
		base.Code = "sdk_error"
		return []im.Event{base}
	case "message":
		values, ok := asSlice(event.Data)
		if !ok {
			return nil
		}
		result := make([]im.Event, 0, len(values))
		for _, value := range values {
			message, err := projectSDKMessage(value, session.UserID)
			if err != nil {
				continue
			}
			copy := base
			copy.ID = t.nextEventID()
			copy.Type = im.EventMessage
			copy.Message = &message
			result = append(result, copy)
		}
		return result
	case "conversation_updated":
		values, ok := asSlice(event.Data)
		if !ok {
			return nil
		}
		base.Type = im.EventConversationUpdated
		base.Conversations = make([]im.ConversationSummary, 0, len(values))
		for _, value := range values {
			conversation, valid := projectSDKConversation(value)
			if valid {
				base.Conversations = append(base.Conversations, conversation)
			}
		}
		if len(base.Conversations) == 0 {
			return nil
		}
		return []im.Event{base}
	default:
		return nil
	}
}

func projectSDKConversation(candidate any) (im.ConversationSummary, bool) {
	entry, ok := asMap(candidate)
	if !ok {
		return im.ConversationSummary{}, false
	}
	conversation, err := parseConversationID(stringValue(entry["conversationID"]))
	if err != nil {
		return im.ConversationSummary{}, false
	}
	unread, ok := numberInt(entry["unreadCount"])
	if !ok || unread < 0 {
		unread = 0
	}
	title := ""
	if conversation.Kind() == im.ConversationC2C {
		if profile, valid := asMap(entry["userProfile"]); valid {
			title = stringValue(profile["nick"])
			if title == "" {
				title = stringValue(profile["userID"])
			}
		}
		if title == "" {
			title = conversation.PeerUserID()
		}
	} else {
		if profile, valid := asMap(entry["groupProfile"]); valid {
			title = stringValue(profile["name"])
		}
		if title == "" {
			title = conversation.GroupID()
		}
	}
	return im.ConversationSummary{
		Conversation: conversation,
		UnreadCount:  unread,
		Title:        title,
	}, true
}

func safeKickedOutReason(value any) string {
	const unknown = "kicked_out_unknown"
	data, ok := asMap(value)
	if !ok {
		return unknown
	}
	raw := strings.ToLower(stringValue(data["type"]))
	normalized := strings.NewReplacer(
		"_", "",
		"-", "",
		" ", "",
	).Replace(raw)
	switch {
	case strings.Contains(normalized, "multaccount") ||
		strings.Contains(normalized, "multipleaccount"):
		return "kicked_out_mult_account"
	case strings.Contains(normalized, "multdevice") ||
		strings.Contains(normalized, "multipledevice"):
		return "kicked_out_mult_device"
	case strings.Contains(normalized, "usersigexpired"):
		return "kicked_out_usersig_expired"
	case strings.Contains(normalized, "restapi"):
		return "kicked_out_rest_api"
	default:
		return unknown
	}
}

func (t *Transport) nextEventID() string {
	return "goja-" + strconv.FormatUint(t.eventID.Add(1), 10)
}

func conversationValue(conversation im.Conversation) map[string]any {
	value := map[string]any{"type": string(conversation.Kind())}
	switch conversation.Kind() {
	case im.ConversationC2C:
		value["peer_user_id"] = conversation.PeerUserID()
	case im.ConversationGroup:
		value["group_id"] = conversation.GroupID()
	case im.ConversationTopic:
		value["group_id"] = conversation.GroupID()
		value["topic_id"] = conversation.TopicID()
	}
	return value
}

func parseReceipt(value any) (im.SendReceipt, error) {
	result, ok := asMap(value)
	if !ok {
		return im.SendReceipt{}, ErrInvalidSDKResult
	}
	timestamp, ok := numberInt64(result["timestamp_ms"])
	sequence, sequenceOK := numberInt64(result["sequence"])
	if !sequenceOK {
		sequence = 0
	}
	messageID := stringValue(result["message_id"])
	if !ok || timestamp <= 0 || messageID == "" || sequence < 0 {
		return im.SendReceipt{}, ErrInvalidSDKResult
	}
	return im.SendReceipt{
		MessageID:   messageID,
		TimestampMS: timestamp,
		Sequence:    sequence,
	}, nil
}

func parseAttachmentReceipt(value any) (im.SendAttachmentReceipt, error) {
	receipt, err := parseReceipt(value)
	if err != nil {
		return im.SendAttachmentReceipt{}, err
	}
	result, ok := asMap(value)
	if !ok {
		return im.SendAttachmentReceipt{}, ErrInvalidSDKResult
	}
	attachmentValue, ok := asMap(result["attachment"])
	if !ok {
		return im.SendAttachmentReceipt{}, ErrInvalidSDKResult
	}
	attachment, err := projectAttachment(attachmentValue)
	if err != nil {
		return im.SendAttachmentReceipt{}, err
	}
	return im.SendAttachmentReceipt{
		SendReceipt: receipt,
		Attachment:  attachment,
	}, nil
}

func parseConversationID(value string) (im.Conversation, error) {
	switch {
	case strings.HasPrefix(value, "C2C"):
		return im.NewC2CConversation(strings.TrimPrefix(value, "C2C"))
	case strings.HasPrefix(value, "GROUP"):
		target := strings.TrimPrefix(value, "GROUP")
		if marker := strings.Index(target, topicMarker); marker > 0 {
			return im.NewTopicConversation(target[:marker], target)
		}
		return im.NewGroupConversation(target)
	default:
		return im.Conversation{}, im.ErrInvalidConversation
	}
}

func projectSDKMessage(
	value any,
	selfUserID string,
) (im.IncomingMessage, error) {
	message, ok := asMap(value)
	if !ok {
		return im.IncomingMessage{}, ErrInvalidSDKResult
	}
	messageID := stringValue(message["ID"])
	sender := stringValue(message["from"])
	sequence, sequenceOK := numberInt64(message["sequence"])
	seconds, secondsOK := numberInt64(message["time"])
	if messageID == "" ||
		sender == "" ||
		!sequenceOK ||
		!secondsOK ||
		sequence < 0 ||
		seconds <= 0 {
		return im.IncomingMessage{}, ErrInvalidSDKResult
	}
	conversation, err := projectMessageConversation(
		message,
		selfUserID,
	)
	if err != nil {
		return im.IncomingMessage{}, err
	}
	reference, err := im.NewMessageRef(
		conversation,
		messageID,
		sequence,
		seconds*1000,
	)
	if err != nil {
		return im.IncomingMessage{}, err
	}
	elements := projectMessageElements(message)
	return im.IncomingMessage{
		Ref:             reference,
		SenderUserID:    sender,
		CloudCustomData: stringValue(message["cloudCustomData"]),
		Elements:        elements,
	}, nil
}

func projectMessageConversation(
	message map[string]any,
	selfUserID string,
) (im.Conversation, error) {
	switch stringValue(message["conversationType"]) {
	case "C2C":
		peer := stringValue(message["from"])
		if peer == selfUserID {
			peer = stringValue(message["to"])
		}
		return im.NewC2CConversation(peer)
	case "GROUP", "TOPIC":
		target := stringValue(message["to"])
		if target == "" {
			conversationID := stringValue(message["conversationID"])
			target = strings.TrimPrefix(conversationID, "GROUP")
		}
		if marker := strings.Index(target, topicMarker); marker > 0 {
			return im.NewTopicConversation(target[:marker], target)
		}
		return im.NewGroupConversation(target)
	default:
		return im.Conversation{}, im.ErrInvalidConversation
	}
}

func projectMessageElements(message map[string]any) []im.Element {
	payload, _ := asMap(message["payload"])
	elements := make([]im.Element, 0, 2)
	switch stringValue(message["type"]) {
	case "TIMTextElem":
		elements = append(elements, im.Element{
			Type: im.ElementText,
			Text: stringValue(payload["text"]),
		})
	case "TIMCustomElem":
		elements = append(elements, im.Element{
			Type:       im.ElementCustom,
			CustomType: stringValue(payload["description"]),
			Data:       rawJSONValue(payload["data"]),
		})
	case "TIMImageElem":
		element := im.Element{
			Type: im.ElementAttachment,
		}
		if attachment, err := projectImageAttachment(
			stringValue(message["ID"]),
			payload,
		); err == nil {
			element.Attachment = &attachment
		} else {
			element.Data = attachmentProjectionDiagnostic("TIMImageElem")
		}
		elements = append(elements, element)
	case "TIMSoundElem", "TIMVideoFileElem", "TIMFileElem":
		element := im.Element{Type: im.ElementAttachment}
		if attachment, err := projectAttachment(payload); err == nil {
			element.Attachment = &attachment
		} else {
			element.Data = attachmentProjectionDiagnostic(
				stringValue(message["type"]),
			)
		}
		elements = append(elements, element)
	default:
		elements = append(elements, im.Element{
			Type: im.ElementUnknown,
			Data: rawJSONValue(map[string]any{
				"sdk_type": stringValue(message["type"]),
				"payload":  payload,
			}),
		})
	}
	if mentions, ok := asSlice(message["atUserList"]); ok {
		userIDs := make([]string, 0, len(mentions))
		for _, value := range mentions {
			if userID := stringValue(value); userID != "" {
				userIDs = append(userIDs, userID)
			}
		}
		if len(userIDs) > 0 {
			elements = append(elements, im.Element{
				Type:    im.ElementMention,
				UserIDs: userIDs,
			})
		}
	}
	return elements
}

func projectImageAttachment(
	messageID string,
	value map[string]any,
) (im.Attachment, error) {
	images, ok := asSlice(value["imageInfoArray"])
	if !ok || len(images) == 0 {
		return im.Attachment{}, ErrInvalidSDKResult
	}
	selectedIndex := 0
	selected, selectedOK := asMap(images[0])
	for index, raw := range images {
		candidate, candidateOK := asMap(raw)
		if !candidateOK {
			continue
		}
		if imageType, imageTypeOK := numberInt64(candidate["imageType"]); imageTypeOK && imageType == 0 {
			selected = candidate
			selectedIndex = index
			selectedOK = true
			break
		}
	}
	if !selectedOK {
		return im.Attachment{}, ErrInvalidSDKResult
	}
	rawURL := stringValue(selected["url"])
	size, sizeOK := numberInt64(selected["size"])
	if strings.TrimSpace(messageID) == "" || rawURL == "" || !sizeOK || size < 0 {
		return im.Attachment{}, ErrInvalidSDKResult
	}
	imageType, imageTypeOK := numberInt64(selected["imageType"])
	if !imageTypeOK {
		imageType = int64(selectedIndex)
	}
	extension, mimeType := imageFileType(rawURL)
	return im.Attachment{
		ID:        messageID + ":image:" + strconv.FormatInt(imageType, 10),
		Filename:  "image-" + safeAttachmentNamePart(messageID) + extension,
		MIMEType:  mimeType,
		SizeBytes: size,
		URL:       rawURL,
	}, nil
}

func imageFileType(rawURL string) (string, string) {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return ".img", "application/octet-stream"
	}
	extension := strings.ToLower(path.Ext(parsed.Path))
	switch extension {
	case ".png":
		return extension, "image/png"
	case ".jpg", ".jpeg":
		return extension, "image/jpeg"
	case ".gif":
		return extension, "image/gif"
	case ".webp":
		return extension, "image/webp"
	default:
		return ".img", "application/octet-stream"
	}
}

func safeAttachmentNamePart(value string) string {
	value = strings.Map(func(character rune) rune {
		if (character >= 'a' && character <= 'z') ||
			(character >= 'A' && character <= 'Z') ||
			(character >= '0' && character <= '9') ||
			character == '-' || character == '_' {
			return character
		}
		return '_'
	}, strings.TrimSpace(value))
	if value == "" {
		return "attachment"
	}
	return value
}

func attachmentProjectionDiagnostic(messageType string) json.RawMessage {
	return rawJSONValue(map[string]any{
		"projection": "invalid_attachment",
		"sdk_type":   messageType,
	})
}

func projectAttachment(value map[string]any) (im.Attachment, error) {
	attachment := im.Attachment{
		ID:       stringValue(firstValue(value, "id", "uuid", "UUID")),
		Filename: stringValue(firstValue(value, "filename", "fileName", "name")),
		MIMEType: stringValue(firstValue(value, "mime_type", "mimeType", "type")),
		URL:      stringValue(firstValue(value, "url", "fileUrl", "downloadUrl")),
	}
	if size, ok := numberInt64(firstValue(value, "size_bytes", "fileSize", "size")); ok {
		attachment.SizeBytes = size
	}
	if attachment.ID == "" || attachment.Filename == "" ||
		attachment.SizeBytes < 0 || attachment.URL == "" {
		return im.Attachment{}, ErrInvalidSDKResult
	}
	return attachment, nil
}

func firstValue(value map[string]any, keys ...string) any {
	for _, key := range keys {
		if candidate, ok := value[key]; ok {
			return candidate
		}
	}
	return nil
}

func rawJSONValue(value any) json.RawMessage {
	if text, ok := value.(string); ok {
		var decoded any
		if common.Unmarshal([]byte(text), &decoded) == nil {
			value = decoded
		}
	}
	encoded, err := common.Marshal(value)
	if err != nil {
		return json.RawMessage("null")
	}
	return json.RawMessage(encoded)
}

func asMap(value any) (map[string]any, bool) {
	result, ok := value.(map[string]any)
	return result, ok
}

func asSlice(value any) ([]any, bool) {
	result, ok := value.([]any)
	return result, ok
}

func stringValue(value any) string {
	text, _ := value.(string)
	return text
}

func numberInt(value any) (int, bool) {
	number, ok := numberInt64(value)
	return int(number), ok
}

func numberInt64(value any) (int64, bool) {
	switch number := value.(type) {
	case int:
		return int64(number), true
	case int32:
		return int64(number), true
	case int64:
		return number, true
	case float64:
		converted := int64(number)
		return converted, float64(converted) == number
	default:
		return 0, false
	}
}

func validateMentionUserIDs(
	conversation im.Conversation,
	values []string,
) error {
	if len(values) > 0 && conversation.Kind() == im.ConversationC2C {
		return ErrInvalidMention
	}
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		if strings.TrimSpace(value) != value || value == "" {
			return ErrInvalidMention
		}
		if _, ok := seen[value]; ok {
			return ErrInvalidMention
		}
		seen[value] = struct{}{}
	}
	return nil
}
