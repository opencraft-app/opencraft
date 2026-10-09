package hermes

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"velachat/agent/internal/common"
	"velachat/agent/internal/runtimeapi"
)

type rpcError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

type rpcMessage struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`

	hasID     bool
	hasMethod bool
	hasResult bool
	hasError  bool
}

type rpcRequestError struct {
	Method  string
	Code    int
	Message string
}

func (err *rpcRequestError) Error() string {
	return fmt.Sprintf(
		"Hermes ACP RPC %s failed (%d): %s",
		err.Method,
		err.Code,
		err.Message,
	)
}

func decodeRPCMessage(raw []byte) (rpcMessage, error) {
	var fields map[string]json.RawMessage
	if err := common.Unmarshal(raw, &fields); err != nil || fields == nil {
		return rpcMessage{}, errors.New("invalid JSON-RPC object")
	}
	var message rpcMessage
	if value, ok := fields["jsonrpc"]; ok {
		_ = common.Unmarshal(value, &message.JSONRPC)
	}
	if value, ok := fields["id"]; ok {
		message.ID = append(json.RawMessage(nil), value...)
		message.hasID = true
	}
	if value, ok := fields["method"]; ok {
		message.hasMethod = common.Unmarshal(value, &message.Method) == nil
	}
	if value, ok := fields["params"]; ok {
		message.Params = append(json.RawMessage(nil), value...)
	}
	if value, ok := fields["result"]; ok {
		message.Result = append(json.RawMessage(nil), value...)
		message.hasResult = true
	}
	if value, ok := fields["error"]; ok {
		message.hasError = true
		message.Error = &rpcError{}
		if err := common.Unmarshal(value, message.Error); err != nil {
			return rpcMessage{}, err
		}
	}
	return message, nil
}

func (message rpcMessage) numericID() (int64, bool) {
	if !message.hasID {
		return 0, false
	}
	id, err := strconv.ParseInt(
		strings.TrimSpace(string(message.ID)),
		10,
		64,
	)
	return id, err == nil && id > 0
}

func (session *session) request(
	ctx context.Context,
	method string,
	params any,
) (rpcMessage, error) {
	id, response, err := session.sendRequest(ctx, method, params)
	if err != nil {
		return rpcMessage{}, err
	}
	return session.awaitResponse(ctx, id, method, response)
}

func (session *session) awaitResponse(
	ctx context.Context,
	id int64,
	method string,
	response <-chan rpcMessage,
) (rpcMessage, error) {
	if response == nil {
		return rpcMessage{}, errors.New("Hermes ACP request registration was lost")
	}
	select {
	case message := <-response:
		if message.Error != nil {
			detail := strings.TrimSpace(message.Error.Message)
			if detail == "" {
				detail = "request failed"
			}
			return rpcMessage{}, &rpcRequestError{
				Method:  method,
				Code:    message.Error.Code,
				Message: detail,
			}
		}
		return message, nil
	case <-ctx.Done():
		session.removePending(id)
		return rpcMessage{}, ctx.Err()
	case <-session.done:
		session.removePending(id)
		return rpcMessage{}, ErrSessionStopped
	}
}

func (session *session) sendRequest(
	ctx context.Context,
	method string,
	params any,
) (int64, chan rpcMessage, error) {
	if err := session.wire.Acquire(ctx); err != nil {
		return 0, nil, err
	}
	defer session.wire.Release()
	select {
	case <-session.done:
		return 0, nil, ErrSessionStopped
	default:
	}
	session.mu.Lock()
	if session.stopping {
		session.mu.Unlock()
		return 0, nil, ErrSessionStopped
	}
	session.nextID++
	id := session.nextID
	call := pendingCall{
		method:   method,
		response: make(chan rpcMessage, 1),
	}
	session.pending[id] = call
	session.mu.Unlock()

	payload := map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"method":  method,
		"params":  params,
	}
	result, err := session.writeLocked(ctx, payload)
	if errors.Is(err, ErrTerminalFrameWrite) {
		return 0, nil, err
	}
	if result.Status == frameWriteUnsent {
		session.removePending(id)
		return 0, nil, err
	}
	if result.Status == frameWriteAmbiguous {
		session.failTransport("Hermes ACP request write was ambiguous")
		return 0, nil, &ambiguousFrameWriteError{cause: err}
	}
	if err != nil {
		session.failTransport("Hermes ACP request write failed after commit")
	}
	return id, call.response, nil
}

func (session *session) sendPrompt(ctx context.Context, params any, busy bool) error {
	if err := session.wire.Acquire(ctx); err != nil {
		return err
	}
	defer session.wire.Release()
	select {
	case <-session.done:
		return ErrSessionStopped
	default:
	}

	session.mu.Lock()
	if session.stopping {
		session.mu.Unlock()
		return ErrSessionStopped
	}
	session.nextID++
	id := session.nextID
	var err error
	if busy {
		_, err = session.promptFamily.Append(id)
	} else {
		_, err = session.promptFamily.Start(id)
	}
	if err != nil {
		session.mu.Unlock()
		return err
	}
	session.pending[id] = pendingCall{
		method:     "session/prompt",
		prompt:     true,
		promptRoot: !busy,
	}
	session.mu.Unlock()

	payload := map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"method":  "session/prompt",
		"params":  params,
	}
	result, writeErr := session.writeLocked(ctx, payload)
	if errors.Is(writeErr, ErrTerminalFrameWrite) {
		return writeErr
	}
	switch result.Status {
	case frameWriteUnsent:
		session.removePending(id)
		return &unsentPromptWriteError{cause: writeErr}
	case frameWriteAmbiguous:
		session.failTransport("Hermes ACP prompt write was ambiguous")
		return &ambiguousFrameWriteError{cause: writeErr}
	case frameWriteCommitted:
		session.commitPrompt(id)
		if writeErr != nil {
			session.failTransport("Hermes ACP prompt write failed after commit")
		}
		return nil
	default:
		session.removePending(id)
		return &unsentPromptWriteError{cause: writeErr}
	}
}

func (session *session) notify(
	ctx context.Context,
	method string,
	params any,
) error {
	return session.write(ctx, map[string]any{
		"jsonrpc": "2.0",
		"method":  method,
		"params":  params,
	})
}

func (session *session) write(ctx context.Context, value any) error {
	if err := session.wire.Acquire(ctx); err != nil {
		return err
	}
	defer session.wire.Release()
	result, err := session.writeLocked(ctx, value)
	if result.Status != frameWriteCommitted || err != nil {
		session.mu.Lock()
		stopping := session.stopping
		session.mu.Unlock()
		if !stopping {
			session.failTransport("Hermes ACP wire write failed")
		}
	}
	return err
}

func (session *session) writeLocked(
	ctx context.Context,
	value any,
) (frameWriteResult, error) {
	data, err := common.Marshal(value)
	if err != nil {
		return frameWriteResult{Status: frameWriteUnsent, Err: err}, err
	}
	data = append(data, '\n')
	select {
	case <-session.done:
		result := frameWriteResult{Status: frameWriteUnsent, Err: ErrSessionStopped}
		return result, ErrSessionStopped
	default:
	}
	written := writeFrameContext(ctx, session.stdin, data, session.abortWire)
	if written.CancellationWon {
		cause := ctx.Err()
		if cause == nil {
			cause = written.Err
		}
		session.mu.Lock()
		stopping := session.stopping
		session.mu.Unlock()
		if !stopping {
			session.failTransport("Hermes ACP wire write was cancelled")
		}
		return written.frameWriteResult, &terminalFrameWriteError{cause: cause}
	}
	return written.frameWriteResult, written.Err
}

func (session *session) removePending(id int64) {
	session.mu.Lock()
	pending, exists := session.pending[id]
	delete(session.pending, id)
	if exists && pending.prompt {
		session.promptFamily.Rollback(id)
	}
	session.mu.Unlock()
}

func (session *session) commitPrompt(id int64) {
	session.mu.Lock()
	pending, exists := session.pending[id]
	if !exists || !pending.prompt {
		session.mu.Unlock()
		return
	}
	pending.committed = true
	events := make([]runtimeapi.Event, 0, 3)
	if pending.promptRoot {
		events = append(events, runtimeapi.Event{
			Kind:         runtimeapi.EventActivity,
			ActivityKind: "thinking",
			Text:         "Hermes is working",
			LaunchID:     session.launchID,
		})
	}
	if pending.deferredResponse == nil {
		session.pending[id] = pending
		session.enqueueEventsLocked(events)
		session.mu.Unlock()
		session.wakeActionDispatcher()
		return
	}
	message := *pending.deferredResponse
	delete(session.pending, id)
	resolution, resolved := session.promptFamily.Resolve(id)
	if resolved && !session.completionFenced {
		events = append(
			events,
			session.promptResponseEvents(
				pending.method,
				message,
				resolution.Complete,
			)...,
		)
	}
	session.enqueueEventsLocked(events)
	session.mu.Unlock()
	session.wakeActionDispatcher()
}

func (session *session) dispatch(message rpcMessage) {
	if message.hasMethod {
		if message.hasID {
			session.handleServerRequest(message)
			return
		}
		session.handleNotification(message)
		return
	}
	id, ok := message.numericID()
	if !ok {
		session.mu.Lock()
		active := session.promptFamily.Active()
		session.mu.Unlock()
		if active && (message.hasResult || message.hasError) {
			session.failTransport("Hermes ACP emitted an invalid response ID")
		}
		return
	}
	session.mu.Lock()
	highestIssuedID := session.nextID
	pending, exists := session.pending[id]
	if exists && pending.prompt && !pending.committed {
		deferred := message
		pending.deferredResponse = &deferred
		session.pending[id] = pending
		session.mu.Unlock()
		return
	}
	if exists {
		delete(session.pending, id)
	}
	var resolution promptResolution
	var resolved bool
	if exists && pending.prompt {
		resolution, resolved = session.promptFamily.Resolve(id)
	}
	active := session.promptFamily.Active()
	events := []runtimeapi.Event(nil)
	if exists && pending.prompt && resolved && !session.completionFenced {
		events = session.promptResponseEvents(
			pending.method,
			message,
			resolution.Complete,
		)
		session.enqueueEventsLocked(events)
	}
	session.mu.Unlock()
	if !exists {
		if active && id > highestIssuedID {
			session.failTransport("Hermes ACP emitted an unknown response ID")
		}
		return
	}
	if pending.prompt {
		if len(events) > 0 {
			session.wakeActionDispatcher()
		}
		return
	}
	pending.response <- message
}

func (session *session) promptResponseEvents(
	method string,
	message rpcMessage,
	complete bool,
) []runtimeapi.Event {
	events := make([]runtimeapi.Event, 0, 2)
	if message.Error != nil {
		detail := strings.TrimSpace(message.Error.Message)
		if detail == "" {
			detail = "request failed"
		}
		events = append(events, runtimeapi.Event{
			Kind: runtimeapi.EventError,
			Text: (&rpcRequestError{
				Method:  method,
				Code:    message.Error.Code,
				Message: detail,
			}).Error(),
			LaunchID: session.launchID,
		})
		if complete {
			events = append(events, runtimeapi.Event{
				Kind:     runtimeapi.EventTurnCompletion,
				Detail:   "error",
				LaunchID: session.launchID,
			})
		}
		return events
	}
	var result struct {
		StopReason string          `json:"stopReason"`
		Usage      json.RawMessage `json:"usage,omitempty"`
	}
	if len(message.Result) > 0 {
		_ = common.Unmarshal(message.Result, &result)
	}
	if len(result.Usage) > 0 && !rawJSONNull(result.Usage) {
		events = append(events, runtimeapi.Event{
			Kind:     runtimeapi.EventUsage,
			Raw:      append(json.RawMessage(nil), result.Usage...),
			LaunchID: session.launchID,
		})
	}
	if complete {
		events = append(events, runtimeapi.Event{
			Kind:     runtimeapi.EventTurnCompletion,
			Detail:   strings.TrimSpace(result.StopReason),
			LaunchID: session.launchID,
		})
	}
	return events
}

func (session *session) failPending(err error) bool {
	session.mu.Lock()
	pending := session.pending
	session.pending = make(map[int64]pendingCall)
	wasActive := session.promptFamily.Active()
	session.promptFamily.Detach()
	session.mu.Unlock()
	for _, call := range pending {
		if call.prompt {
			continue
		}
		message := rpcMessage{
			Error: &rpcError{
				Code:    -32000,
				Message: err.Error(),
			},
			hasError: true,
		}
		call.response <- message
	}
	return wasActive
}

func (session *session) handleServerRequest(message rpcMessage) {
	if message.Method == "session/request_permission" {
		session.handlePermissionRequest(message)
		return
	}
	session.writeBestEffort(map[string]any{
		"jsonrpc": "2.0",
		"id":      message.ID,
		"error": map[string]any{
			"code":    -32601,
			"message": "method not supported by vela-computer ACP client",
		},
	})
}

func (session *session) handlePermissionRequest(message rpcMessage) {
	var request struct {
		Options []struct {
			OptionID string `json:"optionId"`
			Kind     string `json:"kind"`
		} `json:"options"`
	}
	if err := common.Unmarshal(message.Params, &request); err != nil {
		session.writeBestEffort(map[string]any{
			"jsonrpc": "2.0",
			"id":      message.ID,
			"error": map[string]any{
				"code":    -32602,
				"message": "invalid permission request",
			},
		})
		return
	}
	optionID := selectPermissionOption(session.permissionPolicy, request.Options)
	outcome := map[string]any{"outcome": "cancelled"}
	if optionID != "" {
		outcome = map[string]any{
			"outcome":  "selected",
			"optionId": optionID,
		}
	}
	session.writeBestEffort(map[string]any{
		"jsonrpc": "2.0",
		"id":      message.ID,
		"result": map[string]any{
			"outcome": outcome,
		},
	})
}

func (session *session) writeBestEffort(value any) {
	ctx, cancel := context.WithTimeout(context.Background(), cancelGrace)
	defer cancel()
	_ = session.write(ctx, value)
}

func selectPermissionOption(
	policy string,
	options []struct {
		OptionID string `json:"optionId"`
		Kind     string `json:"kind"`
	},
) string {
	if policy == "deny" {
		return ""
	}
	preferred := []string{"allow_session", "allow_once"}
	if policy == "once" {
		preferred = []string{"allow_once"}
	}
	for _, candidate := range preferred {
		for _, option := range options {
			if option.OptionID == candidate {
				return candidate
			}
		}
	}
	for _, option := range options {
		if strings.HasPrefix(option.Kind, "allow_") {
			return option.OptionID
		}
	}
	return ""
}

func (session *session) handleNotification(message rpcMessage) {
	if message.Method == "session/update" {
		session.handleSessionUpdate(message.Params)
	}
}
