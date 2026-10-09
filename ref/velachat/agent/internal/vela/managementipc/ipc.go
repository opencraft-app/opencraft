// Package managementipc implements the local Vela Computer management
// protocol. It is intentionally separate from the legacy Vela service IPC.
package managementipc

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"sync"

	"github.com/google/uuid"
	"velachat/agent/internal/common"
)

const (
	Protocol          = "vela.ipc.v1"
	MaximumFrameBytes = 1024 * 1024

	FrameResult = "result"
	FrameEvent  = "event"
	FrameError  = "error"
	FrameEnd    = "end"
)

var (
	ErrInvalidConfig = errors.New("Vela 管理 IPC 配置无效")
	ErrFrameTooLarge = errors.New("Vela 管理 IPC frame 超过 1 MiB")
	ErrInvalidFrame  = errors.New("Vela 管理 IPC frame 无效")
)

type Request struct {
	Protocol      string          `json:"protocol"`
	RequestID     string          `json:"requestId"`
	ClientVersion string          `json:"clientVersion"`
	Method        string          `json:"method"`
	Params        json.RawMessage `json:"params,omitempty"`
}

type Response struct {
	Protocol  string          `json:"protocol"`
	RequestID string          `json:"requestId"`
	Type      string          `json:"type"`
	Result    json.RawMessage `json:"result,omitempty"`
	Event     json.RawMessage `json:"event,omitempty"`
	Error     *ErrorDetail    `json:"error,omitempty"`
}

type ErrorDetail struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
}

type ProtocolError struct {
	Detail ErrorDetail
}

func (e *ProtocolError) Error() string {
	return fmt.Sprintf("%s: %s", e.Detail.Code, e.Detail.Message)
}

type Sender interface {
	Result(any) error
	Event(any) error
	Error(ErrorDetail) error
	End() error
}

type Handler interface {
	Handle(context.Context, Request, Sender) error
}

type HandlerFunc func(context.Context, Request, Sender) error

func (f HandlerFunc) Handle(
	ctx context.Context,
	request Request,
	sender Sender,
) error {
	return f(ctx, request, sender)
}

type Server struct {
	path      string
	listener  *net.UnixListener
	handler   Handler
	ctx       context.Context
	cancel    context.CancelFunc
	closeOnce sync.Once
	closeErr  error
}

func Listen(socketPath string, handler Handler) (*Server, error) {
	if !filepath.IsAbs(socketPath) || handler == nil {
		return nil, ErrInvalidConfig
	}
	parent := filepath.Dir(socketPath)
	if err := os.MkdirAll(parent, 0o700); err != nil {
		return nil, err
	}
	if err := os.Chmod(parent, 0o700); err != nil {
		return nil, err
	}
	if err := os.Remove(socketPath); err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	address, err := net.ResolveUnixAddr("unix", socketPath)
	if err != nil {
		return nil, err
	}
	listener, err := net.ListenUnix("unix", address)
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(socketPath, 0o600); err != nil {
		_ = listener.Close()
		_ = os.Remove(socketPath)
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	server := &Server{
		path:     socketPath,
		listener: listener,
		handler:  handler,
		ctx:      ctx,
		cancel:   cancel,
	}
	go server.serve()
	return server, nil
}

func (s *Server) serve() {
	for {
		connection, err := s.listener.AcceptUnix()
		if err != nil {
			return
		}
		go s.handle(connection)
	}
}

func (s *Server) handle(connection *net.UnixConn) {
	defer connection.Close()
	if err := verifySameUser(connection); err != nil {
		return
	}
	seen := make(map[string]struct{})
	for {
		var request Request
		if err := readFrame(connection, &request); err != nil {
			return
		}
		sender := &connectionSender{
			connection: connection,
			requestID:  request.RequestID,
		}
		if _, duplicate := seen[request.RequestID]; duplicate {
			_ = sender.Error(ErrorDetail{
				Code:    "duplicate_request_id",
				Message: "同一连接内不能重复使用 requestId",
			})
			continue
		}
		seen[request.RequestID] = struct{}{}
		if request.Protocol != Protocol {
			_ = sender.Error(ErrorDetail{
				Code:    "protocol_unsupported",
				Message: "本地管理协议版本不受支持",
			})
			continue
		}
		if !validRequest(request) {
			_ = sender.Error(ErrorDetail{
				Code:    "invalid_request",
				Message: "本地管理请求无效",
			})
			continue
		}
		if err := s.handler.Handle(s.ctx, request, sender); err != nil {
			_ = sender.Error(ErrorDetail{
				Code:      "handler_failed",
				Message:   "daemon 无法完成本地管理请求",
				Retryable: true,
			})
		}
	}
}

func (s *Server) Close() error {
	if s == nil {
		return nil
	}
	s.closeOnce.Do(func() {
		s.cancel()
		s.closeErr = s.listener.Close()
		if err := os.Remove(s.path); s.closeErr == nil &&
			err != nil && !os.IsNotExist(err) {
			s.closeErr = err
		}
	})
	return s.closeErr
}

type connectionSender struct {
	mu         sync.Mutex
	connection net.Conn
	requestID  string
}

func (s *connectionSender) Result(value any) error {
	return s.send(FrameResult, value, nil)
}

func (s *connectionSender) Event(value any) error {
	return s.send(FrameEvent, value, nil)
}

func (s *connectionSender) Error(detail ErrorDetail) error {
	return s.send(FrameError, nil, &detail)
}

func (s *connectionSender) End() error {
	return s.send(FrameEnd, nil, nil)
}

func (s *connectionSender) send(
	frameType string,
	value any,
	detail *ErrorDetail,
) error {
	var payload json.RawMessage
	if value != nil {
		encoded, err := common.Marshal(value)
		if err != nil {
			return err
		}
		payload = encoded
	}
	response := Response{
		Protocol:  Protocol,
		RequestID: s.requestID,
		Type:      frameType,
		Error:     detail,
	}
	if frameType == FrameEvent {
		response.Event = payload
	} else if frameType == FrameResult {
		response.Result = payload
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return writeFrame(s.connection, response)
}

type Client struct {
	socketPath    string
	clientVersion string
}

func NewClient(socketPath, clientVersion string) *Client {
	return &Client{
		socketPath:    socketPath,
		clientVersion: clientVersion,
	}
}

func (c *Client) Call(
	ctx context.Context,
	requestID string,
	method string,
	params any,
	destination any,
) error {
	connection, err := c.openRequest(
		ctx,
		requestID,
		method,
		params,
	)
	if err != nil {
		return err
	}
	defer connection.Close()
	var response Response
	if err := readFrame(connection, &response); err != nil {
		return err
	}
	if err := validateResponse(response, requestID); err != nil {
		return err
	}
	switch response.Type {
	case FrameError:
		return responseError(response)
	case FrameResult:
		if destination == nil {
			return nil
		}
		if len(response.Result) == 0 {
			return ErrInvalidFrame
		}
		return common.Unmarshal(response.Result, destination)
	default:
		return ErrInvalidFrame
	}
}

func (c *Client) Stream(
	ctx context.Context,
	requestID string,
	method string,
	params any,
	onEvent func(Response) error,
) error {
	if onEvent == nil {
		return ErrInvalidConfig
	}
	connection, err := c.openRequest(
		ctx,
		requestID,
		method,
		params,
	)
	if err != nil {
		return err
	}
	defer connection.Close()
	for {
		var response Response
		if err := readFrame(connection, &response); err != nil {
			return err
		}
		if err := validateResponse(response, requestID); err != nil {
			return err
		}
		switch response.Type {
		case FrameEvent:
			if len(response.Event) == 0 {
				return ErrInvalidFrame
			}
			if err := onEvent(response); err != nil {
				return err
			}
		case FrameError:
			return responseError(response)
		case FrameEnd:
			return nil
		default:
			return ErrInvalidFrame
		}
	}
}

func (c *Client) openRequest(
	ctx context.Context,
	requestID string,
	method string,
	params any,
) (net.Conn, error) {
	if c == nil || ctx == nil ||
		!filepath.IsAbs(c.socketPath) ||
		c.clientVersion == "" {
		return nil, ErrInvalidConfig
	}
	var rawParams json.RawMessage
	if params != nil {
		encoded, err := common.Marshal(params)
		if err != nil {
			return nil, err
		}
		rawParams = encoded
	}
	var dialer net.Dialer
	connection, err := dialer.DialContext(ctx, "unix", c.socketPath)
	if err != nil {
		return nil, err
	}
	if deadline, ok := ctx.Deadline(); ok {
		_ = connection.SetDeadline(deadline)
	}
	if err := writeFrame(connection, Request{
		Protocol:      Protocol,
		RequestID:     requestID,
		ClientVersion: c.clientVersion,
		Method:        method,
		Params:        rawParams,
	}); err != nil {
		_ = connection.Close()
		return nil, err
	}
	return connection, nil
}

func validateResponse(response Response, requestID string) error {
	if response.Protocol != Protocol ||
		response.RequestID != requestID {
		return ErrInvalidFrame
	}
	return nil
}

func responseError(response Response) error {
	if response.Error == nil {
		return ErrInvalidFrame
	}
	return &ProtocolError{Detail: *response.Error}
}

func readFrame(reader io.Reader, destination any) error {
	var prefix [4]byte
	if _, err := io.ReadFull(reader, prefix[:]); err != nil {
		return err
	}
	size := binary.BigEndian.Uint32(prefix[:])
	if size == 0 {
		return ErrInvalidFrame
	}
	if size > MaximumFrameBytes {
		return ErrFrameTooLarge
	}
	payload := make([]byte, int(size))
	if _, err := io.ReadFull(reader, payload); err != nil {
		return err
	}
	if err := common.Unmarshal(payload, destination); err != nil {
		return ErrInvalidFrame
	}
	return nil
}

func writeFrame(writer io.Writer, value any) error {
	payload, err := common.Marshal(value)
	if err != nil {
		return err
	}
	if len(payload) == 0 {
		return ErrInvalidFrame
	}
	if len(payload) > MaximumFrameBytes {
		return ErrFrameTooLarge
	}
	var prefix [4]byte
	binary.BigEndian.PutUint32(prefix[:], uint32(len(payload)))
	if err := writeFull(writer, prefix[:]); err != nil {
		return err
	}
	return writeFull(writer, payload)
}

func writeFull(writer io.Writer, data []byte) error {
	for len(data) > 0 {
		written, err := writer.Write(data)
		if err != nil {
			return err
		}
		if written <= 0 {
			return io.ErrShortWrite
		}
		data = data[written:]
	}
	return nil
}

func validRequest(request Request) bool {
	parsed, err := uuid.Parse(request.RequestID)
	return err == nil &&
		parsed.Version() == 7 &&
		request.ClientVersion != "" &&
		request.Method != ""
}
