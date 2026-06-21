package wecom

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"cloudagent/channelgateway/internal/channel"
)

const maxMessageLength = 4096

type Config struct {
	AccountID    string
	BotID        string
	Secret       string
	WebSocketURL string
	DMPolicy     string
	GroupPolicy  string
}

type Adapter struct {
	cfg Config

	mu               sync.Mutex
	writeMu          sync.Mutex
	conn             *websocket.Conn
	pending          map[string]chan frame
	replyByMessageID map[string]string
	closed           bool
}

type inboundDispatchError struct {
	messageID string
	err       error
}

func (e inboundDispatchError) Error() string {
	return fmt.Sprintf("dispatch inbound message %s: %v", e.messageID, e.err)
}

func (e inboundDispatchError) Unwrap() error {
	return e.err
}

func NewAdapter(cfg Config) *Adapter {
	return &Adapter{
		cfg:              cfg,
		pending:          map[string]chan frame{},
		replyByMessageID: map[string]string{},
	}
}

func (a *Adapter) Start(ctx context.Context, handler channel.InboundHandler) error {
	if handler == nil {
		return errors.New("missing inbound handler")
	}
	if strings.TrimSpace(a.cfg.BotID) == "" || strings.TrimSpace(a.cfg.Secret) == "" {
		return errors.New("missing WeCom bot id or secret")
	}
	backoff := []time.Duration{2 * time.Second, 5 * time.Second, 10 * time.Second, 30 * time.Second, 60 * time.Second}
	attempt := 0
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		err := a.runOnce(ctx, handler)
		if err == nil || ctx.Err() != nil {
			return ctx.Err()
		}
		var dispatchErr inboundDispatchError
		if errors.As(err, &dispatchErr) {
			return err
		}
		wait := backoff[min(attempt, len(backoff)-1)]
		attempt++
		log.Printf("wecom account=%s disconnected: %v; reconnecting in %s", a.cfg.AccountID, err, wait)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(wait):
		}
	}
}

func (a *Adapter) Stop(ctx context.Context) error {
	a.mu.Lock()
	a.closed = true
	conn := a.conn
	a.conn = nil
	a.mu.Unlock()
	if conn == nil {
		return nil
	}
	done := make(chan error, 1)
	go func() { done <- conn.Close() }()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case err := <-done:
		return err
	}
}

func (a *Adapter) Send(ctx context.Context, reply channel.Reply) (channel.SendResult, error) {
	text := strings.TrimSpace(reply.Text)
	if text == "" {
		return channel.SendResult{}, errors.New("empty reply text")
	}
	if len([]rune(text)) > maxMessageLength {
		text = string([]rune(text)[:maxMessageLength])
	}
	reqID := a.replyReqID(reply.ExternalMessageID)
	mode := "proactive"
	var raw frame
	var err error
	startedAt := time.Now()
	if reqID != "" {
		mode = "callback"
		log.Printf("wecom account=%s action=send_start mode=%s external_conversation_id=%s external_message_id=%s req_id=%s text_bytes=%d",
			logValue(a.cfg.AccountID), mode, logValue(reply.ExternalConversationID), logValue(reply.ExternalMessageID), logValue(reqID), len([]byte(text)))
		raw, err = a.request(ctx, reqID, respondStreamFrame(reqID, text))
	} else {
		reqID = newReqID("send")
		log.Printf("wecom account=%s action=send_start mode=%s external_conversation_id=%s external_message_id=%s req_id=%s text_bytes=%d",
			logValue(a.cfg.AccountID), mode, logValue(reply.ExternalConversationID), logValue(reply.ExternalMessageID), logValue(reqID), len([]byte(text)))
		raw, err = a.request(ctx, reqID, sendMarkdownFrame(reqID, reply.ExternalConversationID, text))
	}
	if err != nil {
		log.Printf("wecom account=%s action=send_failed mode=%s external_conversation_id=%s external_message_id=%s req_id=%s duration_ms=%d error=%s",
			logValue(a.cfg.AccountID), mode, logValue(reply.ExternalConversationID), logValue(reply.ExternalMessageID), logValue(reqID), time.Since(startedAt).Milliseconds(), logValue(err.Error()))
		return channel.SendResult{}, err
	}
	if raw.ErrCode != 0 {
		log.Printf("wecom account=%s action=send_rejected mode=%s external_conversation_id=%s external_message_id=%s req_id=%s duration_ms=%d errcode=%d errmsg=%s",
			logValue(a.cfg.AccountID), mode, logValue(reply.ExternalConversationID), logValue(reply.ExternalMessageID), logValue(reqID), time.Since(startedAt).Milliseconds(), raw.ErrCode, logValue(raw.ErrMsg))
		return channel.SendResult{}, fmt.Errorf("wecom send failed errcode=%d errmsg=%s", raw.ErrCode, raw.ErrMsg)
	}
	log.Printf("wecom account=%s action=send_done mode=%s external_conversation_id=%s external_message_id=%s req_id=%s duration_ms=%d",
		logValue(a.cfg.AccountID), mode, logValue(reply.ExternalConversationID), logValue(reply.ExternalMessageID), logValue(reqID), time.Since(startedAt).Milliseconds())
	body, _ := json.Marshal(raw)
	return channel.SendResult{MessageID: reqID, Raw: body}, nil
}

func (a *Adapter) runOnce(ctx context.Context, handler channel.InboundHandler) error {
	url := strings.TrimSpace(a.cfg.WebSocketURL)
	if url == "" {
		url = "wss://openws.work.weixin.qq.com"
	}
	dialCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	dialStartedAt := time.Now()
	log.Printf("wecom account=%s action=dial_start websocket_url=%s", logValue(a.cfg.AccountID), logValue(url))
	conn, _, err := websocket.DefaultDialer.DialContext(dialCtx, url, http.Header{})
	if err != nil {
		log.Printf("wecom account=%s action=dial_failed websocket_url=%s duration_ms=%d error=%s",
			logValue(a.cfg.AccountID), logValue(url), time.Since(dialStartedAt).Milliseconds(), logValue(err.Error()))
		return err
	}
	log.Printf("wecom account=%s action=dial_done websocket_url=%s duration_ms=%d remote_addr=%s",
		logValue(a.cfg.AccountID), logValue(url), time.Since(dialStartedAt).Milliseconds(), logValue(conn.RemoteAddr().String()))
	a.mu.Lock()
	a.conn = conn
	a.closed = false
	a.mu.Unlock()
	defer func() {
		_ = conn.Close()
		a.mu.Lock()
		if a.conn == conn {
			a.conn = nil
		}
		a.mu.Unlock()
	}()
	reqID := newReqID(cmdSubscribe)
	subscribeStartedAt := time.Now()
	log.Printf("wecom account=%s action=subscribe_start req_id=%s", logValue(a.cfg.AccountID), logValue(reqID))
	if err := a.writeJSON(conn, subscribeFrame(reqID, a.cfg.BotID, a.cfg.Secret)); err != nil {
		log.Printf("wecom account=%s action=subscribe_write_failed req_id=%s duration_ms=%d error=%s",
			logValue(a.cfg.AccountID), logValue(reqID), time.Since(subscribeStartedAt).Milliseconds(), logValue(err.Error()))
		return err
	}
	if err := a.waitHandshake(ctx, reqID); err != nil {
		log.Printf("wecom account=%s action=subscribe_failed req_id=%s duration_ms=%d error=%s",
			logValue(a.cfg.AccountID), logValue(reqID), time.Since(subscribeStartedAt).Milliseconds(), logValue(err.Error()))
		return err
	}
	log.Printf("wecom account=%s action=subscribe_done req_id=%s duration_ms=%d dispatch_mode=sync",
		logValue(a.cfg.AccountID), logValue(reqID), time.Since(subscribeStartedAt).Milliseconds())
	errCh := make(chan error, 1)
	go a.heartbeat(ctx, errCh)
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case err := <-errCh:
			return err
		default:
		}
		_, raw, err := conn.ReadMessage()
		if err != nil {
			return err
		}
		if a.dispatchPending(raw) {
			continue
		}
		msg, ok, err := parseInbound(raw, a.cfg.AccountID)
		if err != nil {
			log.Printf("wecom account=%s parse callback failed: %v", a.cfg.AccountID, err)
			continue
		}
		if !ok {
			continue
		}
		if !a.allowMessage(msg) {
			log.Printf("wecom account=%s action=inbound_denied external_message_id=%s external_conversation_id=%s chat_type=%s",
				logValue(a.cfg.AccountID), logValue(msg.ExternalMessageID), logValue(msg.ExternalConversationID), logValue(string(msg.ChatType)))
			continue
		}
		log.Printf("wecom account=%s action=inbound_received external_message_id=%s external_conversation_id=%s external_user_id=%s thread_id=%s chat_type=%s kind=%s raw_bytes=%d",
			logValue(a.cfg.AccountID), logValue(msg.ExternalMessageID), logValue(msg.ExternalConversationID), logValue(msg.ExternalUserID),
			logValue(msg.ThreadID), logValue(string(msg.ChatType)), logValue(string(msg.Kind)), len(raw))
		a.rememberReplyReqID(msg.ExternalMessageID, raw)
		if err := handler.HandleInbound(ctx, msg); err != nil {
			log.Printf("wecom account=%s action=inbound_dispatch_failed external_message_id=%s external_conversation_id=%s error=%s",
				logValue(a.cfg.AccountID), logValue(msg.ExternalMessageID), logValue(msg.ExternalConversationID), logValue(err.Error()))
			return inboundDispatchError{messageID: msg.ExternalMessageID, err: err}
		}
		log.Printf("wecom account=%s action=inbound_dispatched external_message_id=%s external_conversation_id=%s",
			logValue(a.cfg.AccountID), logValue(msg.ExternalMessageID), logValue(msg.ExternalConversationID))
	}
}

func logValue(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return "-"
	}
	if len(value) > 160 {
		return value[:160] + "...[truncated]"
	}
	return value
}

func (a *Adapter) allowMessage(msg channel.Message) bool {
	policy := a.cfg.DMPolicy
	if msg.ChatType == channel.ChatGroup {
		policy = a.cfg.GroupPolicy
	}
	switch strings.ToLower(strings.TrimSpace(policy)) {
	case "", "open", "allow", "enabled":
		return true
	case "closed", "deny", "disabled", "off":
		return false
	default:
		return true
	}
}

func (a *Adapter) waitHandshake(ctx context.Context, reqID string) error {
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		a.mu.Lock()
		conn := a.conn
		a.mu.Unlock()
		if conn == nil {
			return errors.New("wecom websocket is closed")
		}
		_, raw, err := conn.ReadMessage()
		if err != nil {
			return err
		}
		var payload frame
		if err := json.Unmarshal(raw, &payload); err != nil {
			continue
		}
		if payload.Headers.ReqID != reqID {
			continue
		}
		if payload.ErrCode != 0 {
			return fmt.Errorf("wecom subscribe failed errcode=%d errmsg=%s", payload.ErrCode, payload.ErrMsg)
		}
		return nil
	}
	return errors.New("wecom subscribe timed out")
}

func (a *Adapter) heartbeat(ctx context.Context, errCh chan<- error) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			a.mu.Lock()
			conn := a.conn
			a.mu.Unlock()
			if conn == nil {
				return
			}
			if err := a.writeJSON(conn, pingFrame(newReqID("ping"))); err != nil {
				select {
				case errCh <- err:
				default:
				}
				return
			}
		}
	}
}

func (a *Adapter) request(ctx context.Context, reqID string, payload any) (frame, error) {
	ch := make(chan frame, 1)
	a.mu.Lock()
	conn := a.conn
	if conn == nil {
		a.mu.Unlock()
		return frame{}, errors.New("wecom websocket is not connected")
	}
	a.pending[reqID] = ch
	a.mu.Unlock()
	err := a.writeJSON(conn, payload)
	if err != nil {
		a.mu.Lock()
		delete(a.pending, reqID)
		a.mu.Unlock()
		return frame{}, err
	}
	select {
	case <-ctx.Done():
		a.mu.Lock()
		delete(a.pending, reqID)
		a.mu.Unlock()
		return frame{}, ctx.Err()
	case resp := <-ch:
		return resp, nil
	case <-time.After(30 * time.Second):
		a.mu.Lock()
		delete(a.pending, reqID)
		a.mu.Unlock()
		return frame{}, errors.New("wecom request timed out")
	}
}

func (a *Adapter) writeJSON(conn *websocket.Conn, payload any) error {
	a.writeMu.Lock()
	defer a.writeMu.Unlock()
	return conn.WriteJSON(payload)
}

func (a *Adapter) dispatchPending(raw []byte) bool {
	var payload frame
	if err := json.Unmarshal(raw, &payload); err != nil {
		return false
	}
	reqID := payload.Headers.ReqID
	if reqID == "" {
		return false
	}
	a.mu.Lock()
	ch := a.pending[reqID]
	if ch != nil {
		delete(a.pending, reqID)
	}
	a.mu.Unlock()
	if ch == nil {
		return false
	}
	ch <- payload
	return true
}

func (a *Adapter) rememberReplyReqID(messageID string, raw []byte) {
	if messageID == "" {
		return
	}
	var payload frame
	if err := json.Unmarshal(raw, &payload); err != nil || payload.Headers.ReqID == "" {
		return
	}
	a.mu.Lock()
	a.replyByMessageID[messageID] = payload.Headers.ReqID
	a.mu.Unlock()
}

func (a *Adapter) replyReqID(messageID string) string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.replyByMessageID[messageID]
}

func newReqID(prefix string) string {
	return fmt.Sprintf("%s-%d", prefix, time.Now().UnixNano())
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
