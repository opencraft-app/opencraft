package openclaw

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"runtime"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

const (
	gatewayProtocolVersion  = 4
	gatewayHandshakeTimeout = 15 * time.Second
)

type gatewayClient struct {
	connection *websocket.Conn
	writeMu    sync.Mutex
	mu         sync.Mutex
	pending    map[string]chan gatewayFrame
	events     chan gatewayFrame
	done       chan struct{}
	closeOnce  sync.Once
}

type gatewayFrame struct {
	Type    string          `json:"type"`
	ID      string          `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Event   string          `json:"event,omitempty"`
	OK      bool            `json:"ok,omitempty"`
	Payload json.RawMessage `json:"payload,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Error   *gatewayError   `json:"error,omitempty"`
}

type gatewayError struct {
	Code         string `json:"code,omitempty"`
	Message      string `json:"message,omitempty"`
	Retryable    bool   `json:"retryable,omitempty"`
	RetryAfterMS int64  `json:"retryAfterMs,omitempty"`
}

func dialGateway(
	ctx context.Context,
	url string,
	token string,
	version string,
) (*gatewayClient, error) {
	handshakeCtx, cancel := context.WithTimeout(ctx, gatewayHandshakeTimeout)
	defer cancel()
	connection, _, err := websocket.DefaultDialer.DialContext(
		handshakeCtx,
		url,
		nil,
	)
	if err != nil {
		return nil, fmt.Errorf("connect OpenClaw Gateway: %w", err)
	}
	failed := true
	defer func() {
		if failed {
			_ = connection.Close()
		}
	}()
	if deadline, ok := handshakeCtx.Deadline(); ok {
		_ = connection.SetReadDeadline(deadline)
		_ = connection.SetWriteDeadline(deadline)
	}
	var challenge gatewayFrame
	if err := connection.ReadJSON(&challenge); err != nil {
		return nil, fmt.Errorf("read OpenClaw Gateway challenge: %w", err)
	}
	if challenge.Type != "event" || challenge.Event != "connect.challenge" {
		return nil, errors.New("OpenClaw Gateway did not send connect.challenge")
	}
	requestID := uuid.NewString()
	request := map[string]any{
		"type":   "req",
		"id":     requestID,
		"method": "connect",
		"params": map[string]any{
			"minProtocol": gatewayProtocolVersion,
			"maxProtocol": gatewayProtocolVersion,
			"client": map[string]any{
				"id":       "gateway-client",
				"version":  version,
				"platform": runtime.GOOS,
				"mode":     "backend",
			},
			"role":        "operator",
			"scopes":      []string{"operator.read", "operator.write"},
			"caps":        []string{},
			"commands":    []string{},
			"permissions": map[string]bool{},
			"auth":        map[string]string{"token": token},
			"locale":      "en-US",
			"userAgent":   "vela-computer/" + version,
		},
	}
	if err := connection.WriteJSON(request); err != nil {
		return nil, fmt.Errorf("write OpenClaw Gateway connect: %w", err)
	}
	var response gatewayFrame
	if err := connection.ReadJSON(&response); err != nil {
		return nil, fmt.Errorf("read OpenClaw Gateway connect: %w", err)
	}
	if response.Type != "res" || response.ID != requestID || !response.OK {
		if response.Error != nil && response.Error.Message != "" {
			return nil, fmt.Errorf(
				"OpenClaw Gateway connect failed: %s",
				response.Error.Message,
			)
		}
		return nil, errors.New("OpenClaw Gateway rejected connect")
	}
	var hello struct {
		Type     string `json:"type"`
		Protocol int    `json:"protocol"`
	}
	if err := json.Unmarshal(response.Payload, &hello); err != nil ||
		hello.Type != "hello-ok" || hello.Protocol != gatewayProtocolVersion {
		return nil, errors.New("OpenClaw Gateway returned incompatible hello")
	}
	_ = connection.SetReadDeadline(time.Time{})
	_ = connection.SetWriteDeadline(time.Time{})
	failed = false
	client := &gatewayClient{
		connection: connection,
		pending:    make(map[string]chan gatewayFrame),
		events:     make(chan gatewayFrame, 64),
		done:       make(chan struct{}),
	}
	go client.readLoop()
	return client, nil
}

func (client *gatewayClient) Close() error {
	if client == nil || client.connection == nil {
		return nil
	}
	err := client.connection.Close()
	client.finish()
	return err
}

func (client *gatewayClient) request(
	ctx context.Context,
	method string,
	params any,
) (gatewayFrame, error) {
	id := uuid.NewString()
	response := make(chan gatewayFrame, 1)
	client.mu.Lock()
	client.pending[id] = response
	client.mu.Unlock()
	defer func() {
		client.mu.Lock()
		delete(client.pending, id)
		client.mu.Unlock()
	}()
	client.writeMu.Lock()
	err := client.connection.WriteJSON(map[string]any{
		"type": "req", "id": id, "method": method, "params": params,
	})
	client.writeMu.Unlock()
	if err != nil {
		return gatewayFrame{}, err
	}
	select {
	case frame := <-response:
		if !frame.OK {
			if frame.Error != nil && frame.Error.Message != "" {
				return gatewayFrame{}, errors.New(frame.Error.Message)
			}
			return gatewayFrame{}, errors.New("OpenClaw Gateway request failed")
		}
		return frame, nil
	case <-client.done:
		return gatewayFrame{}, errors.New("OpenClaw Gateway connection closed")
	case <-ctx.Done():
		return gatewayFrame{}, ctx.Err()
	}
}

func (client *gatewayClient) readLoop() {
	defer client.finish()
	for {
		var frame gatewayFrame
		if err := client.connection.ReadJSON(&frame); err != nil {
			return
		}
		if frame.Type == "res" {
			client.mu.Lock()
			response := client.pending[frame.ID]
			client.mu.Unlock()
			if response != nil {
				select {
				case response <- frame:
				default:
				}
			}
			continue
		}
		if frame.Type == "event" {
			select {
			case client.events <- frame:
			case <-client.done:
				return
			}
		}
	}
}

func (client *gatewayClient) finish() {
	client.closeOnce.Do(func() { close(client.done) })
}
