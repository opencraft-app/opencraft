package provider

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"go.mongodb.org/mongo-driver/v2/bson"
)

const (
	terminalCommandUsername         = "agentuser"
	terminalCommandWorkingDirectory = "/home/agentuser"
	maxTerminalCommandTimeout       = 300
	maxTerminalReorderBytes         = 1 << 20
	tatStreamHandshakeTimeout       = 10 * time.Second
	tatStreamCleanupTimeout         = time.Second
	tatHandshakeMaxAttempts         = 3
	tatHandshakeBackoffMin          = 200 * time.Millisecond
)

var tencentRegionPattern = regexp.MustCompile(`^[a-z][a-z0-9-]{1,31}$`)

type tatStreamFrame struct {
	Type string            `json:"Type" bson:"Type"`
	Data tatStreamEnvelope `json:"Data" bson:"Data"`
}

type tatStreamEnvelope struct {
	SessionID  string         `json:"SessionId,omitempty" bson:"SessionId,omitempty"`
	ChannelID  string         `json:"ChannelId,omitempty" bson:"ChannelId,omitempty"`
	CustomData string         `json:"CustomData,omitempty" bson:"CustomData,omitempty"`
	Message    string         `json:"Message,omitempty" bson:"Message,omitempty"`
	ErrMsg     string         `json:"ErrMsg,omitempty" bson:"ErrMsg,omitempty"`
	Error      string         `json:"Error,omitempty" bson:"Error,omitempty"`
	Data       tatStreamChunk `json:"Data,omitempty" bson:"Data,omitempty"`
}

type tatStreamChunk struct {
	Cmd      string `json:"Cmd,omitempty" bson:"Cmd,omitempty"`
	Timeout  int    `json:"Timeout,omitempty" bson:"Timeout,omitempty"`
	Index    int    `json:"Index,omitempty" bson:"Index,omitempty"`
	Data     []byte `json:"Data,omitempty" bson:"Data,omitempty"`
	IsLast   bool   `json:"IsLast,omitempty" bson:"IsLast,omitempty"`
	ExitCode int    `json:"ExitCode,omitempty" bson:"ExitCode,omitempty"`
	Error    string `json:"Error,omitempty" bson:"Error,omitempty"`
}

type tatStreamSocket struct {
	conn        *websocket.Conn
	writeMu     sync.Mutex
	cleanupOnce sync.Once
}

type tatTerminalHandshake struct {
	socket    *tatStreamSocket
	sessionID string
	channelID string
	watchDone chan struct{}
	closeOnce sync.Once
}

type tatTerminalHandshakeError struct {
	message string
	err     error
}

func (e *tatTerminalHandshakeError) Error() string {
	return fmt.Sprintf("%s: %v", e.message, e.err)
}

func (e *tatTerminalHandshakeError) Unwrap() error {
	return e.err
}

func (s *tatStreamSocket) writeJSON(frame any) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	return s.conn.WriteJSON(frame)
}

func (s *tatStreamSocket) writeBSON(frame any) error {
	payload, err := bson.Marshal(frame)
	if err != nil {
		return err
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	return s.conn.WriteMessage(websocket.BinaryMessage, payload)
}

func (s *tatStreamSocket) cleanup(sessionID, channelID string) {
	s.cleanupOnce.Do(func() {
		s.writeMu.Lock()
		_ = s.conn.SetWriteDeadline(time.Now().Add(tatStreamCleanupTimeout))
		_ = s.conn.WriteJSON(map[string]any{
			"Type": "PtyStop",
			"Data": map[string]any{
				"SessionId": sessionID,
				"ChannelId": channelID,
			},
		})
		s.writeMu.Unlock()
		_ = s.conn.Close()
	})
}

func (h *tatTerminalHandshake) close() {
	h.closeOnce.Do(func() {
		close(h.watchDone)
		h.socket.cleanup(h.sessionID, h.channelID)
	})
}

func (p *TencentCloudProvider) StreamTerminalCommand(ctx context.Context, req TerminalCommandStreamRequest, emit func(TerminalCommandStreamEvent) error) (TerminalCommandResult, error) {
	if emit == nil {
		return TerminalCommandResult{}, protocolStreamError("event callback is required")
	}
	region := p.resolveRegion(req.Region)
	if !tencentRegionPattern.MatchString(region) {
		return TerminalCommandResult{}, protocolStreamError("invalid Tencent region")
	}
	instanceID := strings.TrimSpace(req.InstanceID)
	if instanceID == "" {
		return TerminalCommandResult{}, protocolStreamError("instance id is required")
	}
	if strings.TrimSpace(req.Command) == "" {
		return TerminalCommandResult{}, protocolStreamError("command is required")
	}
	if req.Username != terminalCommandUsername {
		return TerminalCommandResult{}, protocolStreamError("unsupported terminal username")
	}
	if req.WorkingDirectory != terminalCommandWorkingDirectory {
		return TerminalCommandResult{}, protocolStreamError("unsupported terminal working directory")
	}

	timeoutSeconds := clampTerminalCommandTimeout(req.TimeoutSeconds)
	timeoutSeconds = boundTimeoutByContext(ctx, timeoutSeconds)
	runCtx, cancel := context.WithTimeout(ctx, time.Duration(timeoutSeconds)*time.Second)
	defer cancel()

	var (
		handshake    *tatTerminalHandshake
		handshakeErr *tatTerminalHandshakeError
	)
	for attempt := 1; attempt <= tatHandshakeMaxAttempts; attempt++ {
		handshake, handshakeErr = p.openTerminalCommandHandshake(runCtx, region, instanceID, timeoutSeconds)
		if handshakeErr == nil {
			break
		}
		if runCtx.Err() != nil || attempt == tatHandshakeMaxAttempts {
			break
		}
		if err := waitForTerminalHandshakeRetry(runCtx, attempt); err != nil {
			break
		}
	}
	if handshakeErr != nil {
		return TerminalCommandResult{}, classifyStreamError(ctx, runCtx, handshakeErr.message, handshakeErr.err)
	}
	defer handshake.close()
	socket := handshake.socket
	conn := socket.conn
	channelID := handshake.channelID

	customData := uuid.NewString()
	executionID := "pty:" + strings.ReplaceAll(customData, "-", "")[:12]
	if err := emit(TerminalCommandStreamEvent{
		Type:        TerminalCommandEventStarted,
		ExecutionID: executionID,
	}); err != nil {
		return TerminalCommandResult{}, classifyStreamError(ctx, runCtx, "started event callback failed", err)
	}

	if err := socket.writeBSON(tatStreamFrame{
		Type: "PtyExecCmdStream",
		Data: tatStreamEnvelope{
			SessionID:  handshake.sessionID,
			ChannelID:  channelID,
			CustomData: customData,
			Data: tatStreamChunk{
				Cmd:     req.Command,
				Timeout: timeoutSeconds,
			},
		},
	}); err != nil {
		return TerminalCommandResult{}, classifyStreamError(ctx, runCtx, "command request failed", err)
	}

	result, err := readTerminalCommandChunks(runCtx, conn, channelID, customData, executionID, emit)
	if err != nil {
		return TerminalCommandResult{}, classifyStreamError(ctx, runCtx, "command stream failed", err)
	}
	return result, nil
}

func (p *TencentCloudProvider) openTerminalCommandHandshake(ctx context.Context, region, instanceID string, timeoutSeconds int) (*tatTerminalHandshake, *tatTerminalHandshakeError) {
	startSession := p.startTerminalSessionFunc
	if startSession == nil {
		startSession = p.StartTerminalSession
	}
	session, err := startSession(ctx, region, instanceID)
	if err != nil {
		return nil, &tatTerminalHandshakeError{message: "start session failed", err: err}
	}
	if strings.TrimSpace(session.SessionID) == "" ||
		strings.TrimSpace(session.OwnerUin) == "" ||
		session.AppID == 0 {
		return nil, &tatTerminalHandshakeError{
			message: "start session returned incomplete authentication data",
			err:     errors.New("incomplete authentication data"),
		}
	}

	forwardURL := fmt.Sprintf("wss://%s.forward.tat-tc.tencent.cn/ws", region)
	if p.tatForwardURLFunc != nil {
		forwardURL = p.tatForwardURLFunc(region)
	}
	dialer := websocket.Dialer{
		HandshakeTimeout: tatStreamHandshakeTimeout,
		ReadBufferSize:   4096,
		WriteBufferSize:  4096,
	}
	conn, resp, err := dialer.DialContext(ctx, forwardURL, http.Header{})
	if resp != nil && resp.Body != nil {
		_ = resp.Body.Close()
	}
	if err != nil {
		return nil, &tatTerminalHandshakeError{message: "websocket connection failed", err: err}
	}
	conn.SetReadLimit(maxTerminalReorderBytes + 64*1024)

	handshake := &tatTerminalHandshake{
		socket:    &tatStreamSocket{conn: conn},
		sessionID: session.SessionID,
		channelID: "exec-" + uuid.NewString(),
		watchDone: make(chan struct{}),
	}
	succeeded := false
	defer func() {
		if !succeeded {
			handshake.close()
		}
	}()
	go func() {
		select {
		case <-ctx.Done():
			handshake.socket.cleanup(handshake.sessionID, handshake.channelID)
		case <-handshake.watchDone:
		}
	}()

	if err := handshake.socket.writeJSON(map[string]any{
		"Type": "SessionAuth",
		"Data": map[string]any{
			"Uin":        session.OwnerUin,
			"AppId":      session.AppID,
			"InstanceId": instanceID,
			"SessionId":  session.SessionID,
		},
	}); err != nil {
		return nil, &tatTerminalHandshakeError{message: "session authentication failed", err: err}
	}
	if err := handshake.socket.writeJSON(map[string]any{
		"Type": "PtyStart",
		"Data": map[string]any{
			"SessionId":   session.SessionID,
			"ChannelId":   handshake.channelID,
			"Cols":        defaultTerminalCols,
			"Rows":        defaultTerminalRows,
			"UserName":    terminalCommandUsername,
			"NoShell":     true,
			"MaxIdleTime": timeoutSeconds,
		},
	}); err != nil {
		return nil, &tatTerminalHandshakeError{message: "pty start failed", err: err}
	}
	if err := waitForPtyReady(ctx, conn); err != nil {
		return nil, &tatTerminalHandshakeError{message: "pty did not become ready", err: err}
	}

	succeeded = true
	return handshake, nil
}

func waitForTerminalHandshakeRetry(ctx context.Context, failedAttempt int) error {
	delay := tatHandshakeBackoffMin
	for attempt := 1; attempt < failedAttempt; attempt++ {
		delay *= 2
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func waitForPtyReady(ctx context.Context, conn *websocket.Conn) error {
	for {
		frame, err := readTATStreamFrame(conn)
		if err != nil {
			return err
		}
		switch frame.Type {
		case "PtyReady":
			return nil
		case "PtyError", "Error":
			return errors.New("TAT rejected PTY startup")
		default:
			if err := ctx.Err(); err != nil {
				return err
			}
			return fmt.Errorf("unexpected frame before PtyReady: %s", frame.Type)
		}
	}
}

func readTerminalCommandChunks(ctx context.Context, conn *websocket.Conn, channelID, customData, executionID string, emit func(TerminalCommandStreamEvent) error) (TerminalCommandResult, error) {
	pending := make(map[int]tatStreamChunk)
	bufferedBytes := 0
	nextIndex := 0
	finalIndex := -1
	finalExitCode := 0
	var utf8Pending []byte
	utf8PendingIndex := 0

	for {
		frame, err := readTATStreamFrame(conn)
		if err != nil {
			if ctx.Err() != nil {
				return TerminalCommandResult{}, ctx.Err()
			}
			return TerminalCommandResult{}, err
		}
		if frame.Type == "PtyError" || frame.Type == "Error" {
			return TerminalCommandResult{}, errors.New("TAT command stream error")
		}
		if frame.Type != "PtyExecCmdStream" {
			return TerminalCommandResult{}, fmt.Errorf("unexpected command stream frame: %s", frame.Type)
		}
		if frame.Data.ChannelID != channelID {
			return TerminalCommandResult{}, errors.New("command stream channel mismatch")
		}
		if frame.Data.CustomData != customData {
			return TerminalCommandResult{}, errors.New("command stream correlation mismatch")
		}
		chunk := frame.Data.Data
		if chunk.Error != "" {
			return TerminalCommandResult{}, errors.New("TAT command execution failed")
		}
		if chunk.Index < nextIndex {
			return TerminalCommandResult{}, errors.New("duplicate command stream chunk")
		}
		if _, exists := pending[chunk.Index]; exists {
			return TerminalCommandResult{}, errors.New("duplicate command stream chunk")
		}
		if chunk.IsLast {
			if finalIndex >= 0 && finalIndex != chunk.Index {
				return TerminalCommandResult{}, errors.New("multiple final command stream chunks")
			}
			finalIndex = chunk.Index
			finalExitCode = chunk.ExitCode
		}
		pending[chunk.Index] = chunk
		bufferedBytes += len(chunk.Data)
		if bufferedBytes > maxTerminalReorderBytes {
			return TerminalCommandResult{}, errors.New("command stream reorder buffer exceeded")
		}

		for {
			ordered, ok := pending[nextIndex]
			if !ok {
				break
			}
			delete(pending, nextIndex)
			bufferedBytes -= len(ordered.Data)

			eventIndex := nextIndex
			if len(utf8Pending) > 0 {
				eventIndex = utf8PendingIndex
			}
			combined := append(append([]byte(nil), utf8Pending...), ordered.Data...)
			text, remainder, err := splitCompleteUTF8(combined)
			if err != nil {
				return TerminalCommandResult{}, err
			}
			utf8Pending = append(utf8Pending[:0], remainder...)
			if len(utf8Pending) > 0 && len(remainder) == len(combined) {
				utf8PendingIndex = eventIndex
			} else if len(utf8Pending) > 0 {
				utf8PendingIndex = nextIndex
			}
			if text != "" {
				if err := emit(TerminalCommandStreamEvent{
					Type:        TerminalCommandEventOutput,
					ExecutionID: executionID,
					Index:       eventIndex,
					Chunk:       text,
				}); err != nil {
					return TerminalCommandResult{}, err
				}
			}
			nextIndex++
		}

		if finalIndex >= 0 && nextIndex > finalIndex {
			if len(utf8Pending) != 0 {
				return TerminalCommandResult{}, errors.New("final command stream chunk ended with incomplete UTF-8")
			}
			return TerminalCommandResult{ExecutionID: executionID, ExitCode: finalExitCode}, nil
		}
	}
}

func readTATStreamFrame(conn *websocket.Conn) (tatStreamFrame, error) {
	messageType, payload, err := conn.ReadMessage()
	if err != nil {
		return tatStreamFrame{}, err
	}
	var frame tatStreamFrame
	switch messageType {
	case websocket.TextMessage:
		err = json.Unmarshal(payload, &frame)
	case websocket.BinaryMessage:
		err = bson.Unmarshal(payload, &frame)
	default:
		err = fmt.Errorf("unsupported websocket message type %d", messageType)
	}
	if err != nil {
		return tatStreamFrame{}, fmt.Errorf("decode TAT frame: %w", err)
	}
	if strings.TrimSpace(frame.Type) == "" {
		return tatStreamFrame{}, errors.New("TAT frame missing type")
	}
	return frame, nil
}

func splitCompleteUTF8(data []byte) (string, []byte, error) {
	index := 0
	for index < len(data) {
		if !utf8.FullRune(data[index:]) {
			break
		}
		r, size := utf8.DecodeRune(data[index:])
		if r == utf8.RuneError && size == 1 {
			return "", nil, errors.New("command stream contained invalid UTF-8")
		}
		index += size
	}
	return string(data[:index]), data[index:], nil
}

func clampTerminalCommandTimeout(timeoutSeconds int) int {
	if timeoutSeconds < 1 {
		return 1
	}
	if timeoutSeconds > maxTerminalCommandTimeout {
		return maxTerminalCommandTimeout
	}
	return timeoutSeconds
}

func boundTimeoutByContext(ctx context.Context, timeoutSeconds int) int {
	deadline, ok := ctx.Deadline()
	if !ok {
		return timeoutSeconds
	}
	remaining := int(time.Until(deadline) / time.Second)
	if remaining < 1 {
		return 1
	}
	if remaining < timeoutSeconds {
		return remaining
	}
	return timeoutSeconds
}

func classifyStreamError(parentCtx, runCtx context.Context, message string, err error) error {
	if parentCtx.Err() != nil {
		return &TerminalCommandStreamError{Code: TerminalCommandErrorCanceled, Message: "command canceled"}
	}
	if errors.Is(runCtx.Err(), context.DeadlineExceeded) {
		return &TerminalCommandStreamError{Code: TerminalCommandErrorTimeout, Message: "command timed out"}
	}
	if errors.Is(err, context.Canceled) {
		return &TerminalCommandStreamError{Code: TerminalCommandErrorCanceled, Message: "command canceled"}
	}
	return protocolStreamError(message)
}

func protocolStreamError(message string) error {
	return &TerminalCommandStreamError{Code: TerminalCommandErrorProtocol, Message: message}
}
