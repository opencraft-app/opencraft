package acp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	acpconn "acp-client/pkg/acp"
)

type Client struct {
	url     string
	headers http.Header

	mu       sync.Mutex
	promptMu sync.Mutex
	conn     *acpconn.Conn
	current  *promptCapture
}

type PromptResult struct {
	StopReason string
	Text       string
	Raw        json.RawMessage
}

type promptCapture struct {
	sessionID string
	text      strings.Builder
}

func NewClient(url string, headers http.Header) *Client {
	return &Client{url: strings.TrimSpace(url), headers: headers}
}

func (c *Client) Close() error {
	c.mu.Lock()
	conn := c.conn
	c.conn = nil
	c.mu.Unlock()
	if conn == nil {
		return nil
	}
	return conn.Close()
}

func (c *Client) Initialize(ctx context.Context) error {
	conn, err := c.ensureConn(ctx)
	if err != nil {
		return err
	}
	_, err = conn.Call(ctx, "initialize", map[string]any{
		"protocolVersion":    1,
		"clientCapabilities": map[string]any{},
		"clientInfo": map[string]any{
			"name":    "cloudagent-channelgateway",
			"version": "0.1.0",
		},
	})
	return err
}

func (c *Client) NewSession(ctx context.Context, cwd string) (string, error) {
	conn, err := c.ensureConn(ctx)
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(cwd) == "" {
		cwd = "/workspace"
	}
	raw, err := conn.Call(ctx, "session/new", map[string]any{"cwd": cwd, "mcpServers": []any{}})
	if err != nil {
		c.resetConn(conn)
		return "", err
	}
	var result struct {
		SessionID string `json:"sessionId"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return "", fmt.Errorf("decode session/new result: %w", err)
	}
	if result.SessionID == "" {
		return "", errors.New("session/new result missing sessionId")
	}
	conn.SetLogSID(result.SessionID)
	return result.SessionID, nil
}

func (c *Client) LoadSession(ctx context.Context, sessionID, cwd string) error {
	if strings.TrimSpace(sessionID) == "" {
		return errors.New("missing session id")
	}
	conn, err := c.ensureConn(ctx)
	if err != nil {
		return err
	}
	if strings.TrimSpace(cwd) == "" {
		cwd = "/workspace"
	}
	_, err = conn.Call(ctx, "session/load", map[string]any{"sessionId": sessionID, "cwd": cwd})
	if err == nil {
		conn.SetLogSID(sessionID)
	} else {
		c.resetConn(conn)
	}
	return err
}

func (c *Client) Prompt(ctx context.Context, sessionID, text string) (PromptResult, error) {
	if strings.TrimSpace(sessionID) == "" {
		return PromptResult{}, errors.New("missing session id")
	}
	conn, err := c.ensureConn(ctx)
	if err != nil {
		return PromptResult{}, err
	}
	c.promptMu.Lock()
	defer c.promptMu.Unlock()
	capture := &promptCapture{sessionID: sessionID}
	c.mu.Lock()
	if c.current != nil {
		c.mu.Unlock()
		return PromptResult{}, errors.New("acp prompt already in flight on this client")
	}
	c.current = capture
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		if c.current == capture {
			c.current = nil
		}
		c.mu.Unlock()
	}()
	raw, err := conn.Call(ctx, "session/prompt", map[string]any{
		"sessionId": sessionID,
		"prompt": []map[string]any{{
			"type": "text",
			"text": text,
		}},
	})
	if err != nil {
		c.resetConn(conn)
		return PromptResult{}, err
	}
	var result struct {
		StopReason string `json:"stopReason"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return PromptResult{}, fmt.Errorf("decode session/prompt result: %w", err)
	}
	return PromptResult{StopReason: result.StopReason, Text: capture.text.String(), Raw: raw}, nil
}

func (c *Client) ensureConn(ctx context.Context) (*acpconn.Conn, error) {
	c.mu.Lock()
	conn := c.conn
	c.mu.Unlock()
	if conn != nil {
		return conn, nil
	}
	if c.url == "" {
		return nil, errors.New("missing ACP url")
	}
	dialCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	conn, err := acpconn.ConnectWSWithHeaders(dialCtx, c.url, c.headers)
	if err != nil {
		return nil, err
	}
	conn.SetNotificationHandler(c.handleNotification)
	c.mu.Lock()
	if c.conn == nil {
		c.conn = conn
		c.mu.Unlock()
		return conn, nil
	}
	existing := c.conn
	c.mu.Unlock()
	_ = conn.Close()
	return existing, nil
}

func (c *Client) resetConn(conn *acpconn.Conn) {
	c.mu.Lock()
	if c.conn == conn {
		c.conn = nil
	}
	c.mu.Unlock()
	if conn != nil {
		_ = conn.Close()
	}
}

func (c *Client) handleNotification(raw json.RawMessage) error {
	var env struct {
		Method string          `json:"method"`
		Params json.RawMessage `json:"params"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return err
	}
	if env.Method != "session/update" {
		return nil
	}
	var params struct {
		SessionID string `json:"sessionId"`
		Update    struct {
			SessionUpdate string          `json:"sessionUpdate"`
			Content       json.RawMessage `json:"content"`
		} `json:"update"`
	}
	if err := json.Unmarshal(env.Params, &params); err != nil {
		return err
	}
	text := acpContentText(params.Update.Content)
	if params.Update.SessionUpdate != "agent_message_chunk" || text == "" {
		return nil
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.current != nil && c.current.sessionID == params.SessionID {
		_, _ = c.current.text.WriteString(text)
	}
	return nil
}

func acpContentText(raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	var text string
	if err := json.Unmarshal(raw, &text); err == nil {
		return text
	}
	var part struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal(raw, &part); err == nil {
		return part.Text
	}
	var parts []struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal(raw, &parts); err == nil {
		var b strings.Builder
		for _, p := range parts {
			b.WriteString(p.Text)
		}
		return b.String()
	}
	return ""
}
