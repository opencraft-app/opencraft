package hermesgateway

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"

	"velachat/agent/internal/common"
)

const (
	defaultMaximumFrameBytes = 16 * 1024 * 1024
	defaultEventBuffer       = 256
)

var errTransportClosed = errors.New("Hermes Gateway transport is closed")

type transportOptions struct {
	MaximumFrameBytes int
	EventBuffer       int
}

type gatewayEvent struct {
	Type      string
	SessionID string
	Payload   json.RawMessage
}

type rpcRemoteError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (err *rpcRemoteError) Error() string {
	if err == nil {
		return ""
	}
	return fmt.Sprintf("Hermes Gateway RPC failed with code %d: %s", err.Code, err.Message)
}

type rpcResponse struct {
	Result json.RawMessage
	Error  *rpcRemoteError
}

type rpcEnvelope struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      *int64          `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *rpcRemoteError `json:"error,omitempty"`
}

type rpcRequest struct {
	JSONRPC string `json:"jsonrpc"`
	ID      int64  `json:"id"`
	Method  string `json:"method"`
	Params  any    `json:"params,omitempty"`
}

type gatewayEventParams struct {
	Type      string          `json:"type"`
	SessionID string          `json:"session_id,omitempty"`
	Payload   json.RawMessage `json:"payload,omitempty"`
}

type transport struct {
	reader       io.Reader
	readerCloser io.Closer
	writer       io.Writer

	maximumFrameBytes int
	events            chan gatewayEvent
	done              chan struct{}

	writeMu sync.Mutex
	mu      sync.Mutex
	nextID  int64
	pending map[int64]chan rpcResponse
	// abandoned contains cancelled request IDs whose single late response is
	// expected and must not poison an otherwise healthy connection.
	abandoned map[int64]struct{}
	closed    bool
	err       error

	finishOnce sync.Once
}

func newTransport(
	reader io.Reader,
	writer io.Writer,
	options transportOptions,
) *transport {
	maximumFrameBytes := options.MaximumFrameBytes
	if maximumFrameBytes <= 0 {
		maximumFrameBytes = defaultMaximumFrameBytes
	}
	eventBuffer := options.EventBuffer
	if eventBuffer <= 0 {
		eventBuffer = defaultEventBuffer
	}
	value := &transport{
		reader:            reader,
		writer:            writer,
		maximumFrameBytes: maximumFrameBytes,
		events:            make(chan gatewayEvent, eventBuffer),
		done:              make(chan struct{}),
		pending:           make(map[int64]chan rpcResponse),
		abandoned:         make(map[int64]struct{}),
	}
	if closer, ok := reader.(io.Closer); ok {
		value.readerCloser = closer
	}
	go value.readLoop()
	return value
}

func (transport *transport) Events() <-chan gatewayEvent {
	return transport.events
}

func (transport *transport) Done() <-chan struct{} {
	return transport.done
}

func (transport *transport) Err() error {
	transport.mu.Lock()
	defer transport.mu.Unlock()
	return transport.err
}

func (transport *transport) Close() {
	transport.finish(nil)
}

func (transport *transport) Call(
	ctx context.Context,
	method string,
	params any,
	result any,
) error {
	method = strings.TrimSpace(method)
	if method == "" {
		return errors.New("Hermes Gateway RPC method is required")
	}
	responseChannel := make(chan rpcResponse, 1)
	transport.mu.Lock()
	if transport.closed {
		err := transport.err
		transport.mu.Unlock()
		if err != nil {
			return err
		}
		return errTransportClosed
	}
	transport.nextID++
	requestID := transport.nextID
	transport.pending[requestID] = responseChannel
	transport.mu.Unlock()

	request := rpcRequest{
		JSONRPC: "2.0",
		ID:      requestID,
		Method:  method,
		Params:  params,
	}
	if err := transport.write(request); err != nil {
		transport.mu.Lock()
		delete(transport.pending, requestID)
		transport.mu.Unlock()
		transport.finish(fmt.Errorf("write Hermes Gateway RPC: %w", err))
		return err
	}

	select {
	case response := <-responseChannel:
		if response.Error != nil {
			return response.Error
		}
		if result == nil || len(bytes.TrimSpace(response.Result)) == 0 {
			return nil
		}
		if err := common.Unmarshal(response.Result, result); err != nil {
			return fmt.Errorf("decode Hermes Gateway RPC result: %w", err)
		}
		return nil
	case <-ctx.Done():
		transport.mu.Lock()
		if _, pending := transport.pending[requestID]; pending {
			delete(transport.pending, requestID)
			transport.abandoned[requestID] = struct{}{}
		}
		transport.mu.Unlock()
		return ctx.Err()
	case <-transport.done:
		transport.mu.Lock()
		delete(transport.pending, requestID)
		err := transport.err
		transport.mu.Unlock()
		if err != nil {
			return err
		}
		return errTransportClosed
	}
}

func (transport *transport) write(value any) error {
	data, err := common.Marshal(value)
	if err != nil {
		return err
	}
	data = append(data, '\n')
	transport.writeMu.Lock()
	defer transport.writeMu.Unlock()
	for len(data) > 0 {
		written, writeErr := transport.writer.Write(data)
		if written > 0 {
			data = data[written:]
		}
		if writeErr != nil {
			return writeErr
		}
		if written == 0 {
			return io.ErrShortWrite
		}
	}
	return nil
}

func (transport *transport) readLoop() {
	initialBufferSize := 64 * 1024
	if transport.maximumFrameBytes < initialBufferSize {
		initialBufferSize = transport.maximumFrameBytes
	}
	if initialBufferSize < 1 {
		initialBufferSize = 1
	}
	scanner := bufio.NewScanner(transport.reader)
	scanner.Buffer(make([]byte, initialBufferSize), transport.maximumFrameBytes)
	for scanner.Scan() {
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 {
			continue
		}
		if line[0] != '{' {
			// Some Hermes/Python environments print startup diagnostics to
			// stdout. They are intentionally ignored as bounded line text.
			continue
		}
		var envelope rpcEnvelope
		if err := common.Unmarshal(line, &envelope); err != nil {
			transport.finish(fmt.Errorf("decode Hermes Gateway frame: %w", err))
			return
		}
		if envelope.JSONRPC != "2.0" {
			transport.finish(errors.New("invalid Hermes Gateway JSON-RPC version"))
			return
		}
		if envelope.Method != "" {
			if envelope.Method == "event" {
				if err := transport.publishEvent(envelope.Params); err != nil {
					transport.finish(err)
					return
				}
			}
			continue
		}
		if envelope.ID == nil {
			transport.finish(errors.New("Hermes Gateway response is missing an ID"))
			return
		}
		if err := transport.resolve(*envelope.ID, rpcResponse{
			Result: envelope.Result,
			Error:  envelope.Error,
		}); err != nil {
			transport.finish(err)
			return
		}
	}
	if err := scanner.Err(); err != nil {
		transport.finish(fmt.Errorf("read Hermes Gateway frame: %w", err))
		return
	}
	transport.finish(io.EOF)
}

func (transport *transport) publishEvent(raw json.RawMessage) error {
	var params gatewayEventParams
	if err := common.Unmarshal(raw, &params); err != nil {
		return fmt.Errorf("decode Hermes Gateway event: %w", err)
	}
	params.Type = strings.TrimSpace(params.Type)
	if params.Type == "" {
		return errors.New("Hermes Gateway event is missing a type")
	}
	event := gatewayEvent{
		Type:      params.Type,
		SessionID: strings.TrimSpace(params.SessionID),
		Payload:   append(json.RawMessage(nil), params.Payload...),
	}
	select {
	case transport.events <- event:
		return nil
	case <-transport.done:
		return errTransportClosed
	default:
		return errors.New("Hermes Gateway event buffer is full")
	}
}

func (transport *transport) resolve(
	requestID int64,
	response rpcResponse,
) error {
	transport.mu.Lock()
	responseChannel, pending := transport.pending[requestID]
	if pending {
		delete(transport.pending, requestID)
		transport.mu.Unlock()
		responseChannel <- response
		return nil
	}
	if _, abandoned := transport.abandoned[requestID]; abandoned {
		delete(transport.abandoned, requestID)
		transport.mu.Unlock()
		return nil
	}
	transport.mu.Unlock()
	return fmt.Errorf(
		"unexpected or duplicate Hermes Gateway response ID %d",
		requestID,
	)
}

func (transport *transport) finish(err error) {
	transport.finishOnce.Do(func() {
		transport.mu.Lock()
		transport.closed = true
		transport.err = err
		transport.mu.Unlock()
		if transport.readerCloser != nil {
			_ = transport.readerCloser.Close()
		}
		close(transport.done)
	})
}
