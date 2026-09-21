package gojaim

import (
	"bytes"
	"context"
	"crypto/tls"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

var (
	ErrUnknownResource = errors.New("Goja IM 网络资源不存在")
	ErrPayloadTooLarge = errors.New("Goja IM 网络载荷超过限制")
)

type NetworkHostConfig struct {
	Policy         NetworkPolicy
	DialTimeout    time.Duration
	RequestTimeout time.Duration
	MaxFrameBytes  int64
	MaxHTTPBytes   int64
}

type NetworkHost struct {
	config NetworkHostConfig
	nextID atomic.Uint64

	mu      sync.Mutex
	sockets map[uint64]*networkSocket
	fetches map[uint64]context.CancelFunc
}

type networkSocket struct {
	cancel context.CancelFunc

	mu   sync.Mutex
	conn *websocket.Conn
}

func NewNetworkHost(config NetworkHostConfig) *NetworkHost {
	if len(config.Policy.webSocketSuffixes) == 0 ||
		len(config.Policy.httpSuffixes) == 0 {
		config.Policy = DefaultNetworkPolicy()
	}
	if config.DialTimeout <= 0 {
		config.DialTimeout = 10 * time.Second
	}
	if config.RequestTimeout <= 0 {
		config.RequestTimeout = 10 * time.Second
	}
	if config.MaxFrameBytes <= 0 {
		config.MaxFrameBytes = 8 << 20
	}
	if config.MaxHTTPBytes <= 0 {
		config.MaxHTTPBytes = 4 << 20
	}
	return &NetworkHost{
		config:  config,
		sockets: make(map[uint64]*networkSocket),
		fetches: make(map[uint64]context.CancelFunc),
	}
}

func (h *NetworkHost) OpenWebSocket(
	parent context.Context,
	rawURL string,
	emit func(SocketEvent),
) (uint64, error) {
	if err := h.config.Policy.Validate(
		rawURL,
		EndpointWebSocket,
	); err != nil {
		return 0, err
	}
	ctx, cancel := context.WithCancel(parent)
	id := h.nextID.Add(1)
	socket := &networkSocket{cancel: cancel}
	h.mu.Lock()
	h.sockets[id] = socket
	h.mu.Unlock()

	go h.runWebSocket(ctx, id, rawURL, socket, emit)
	return id, nil
}

func (h *NetworkHost) runWebSocket(
	ctx context.Context,
	id uint64,
	rawURL string,
	socket *networkSocket,
	emit func(SocketEvent),
) {
	dialer := websocket.Dialer{
		HandshakeTimeout: h.config.DialTimeout,
		Proxy:            nil,
		NetDialContext:   h.secureDialContext,
		TLSClientConfig: &tls.Config{
			MinVersion: tls.VersionTLS12,
		},
	}
	conn, _, err := dialer.DialContext(ctx, rawURL, nil)
	if err != nil {
		emit(SocketEvent{Type: "error", Reason: "dial_failed"})
		emit(SocketEvent{
			Type:   "close",
			Code:   websocket.CloseAbnormalClosure,
			Reason: "dial_failed",
		})
		h.removeSocket(id, socket)
		return
	}
	socket.mu.Lock()
	socket.conn = conn
	socket.mu.Unlock()
	conn.SetReadLimit(h.config.MaxFrameBytes)
	emit(SocketEvent{Type: "open"})

	closeOnContext := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			_ = conn.Close()
		case <-closeOnContext:
		}
	}()
	defer close(closeOnContext)
	defer conn.Close()
	defer h.removeSocket(id, socket)

	for {
		_, payload, err := conn.ReadMessage()
		if err != nil {
			if ctx.Err() == nil {
				code := websocket.CloseAbnormalClosure
				reason := "read_failed"
				var closeError *websocket.CloseError
				if errors.As(err, &closeError) {
					code = closeError.Code
					reason = closeError.Text
				}
				emit(SocketEvent{
					Type:   "close",
					Code:   code,
					Reason: reason,
				})
			}
			return
		}
		if int64(len(payload)) > h.config.MaxFrameBytes {
			emit(SocketEvent{
				Type:   "error",
				Reason: "frame_too_large",
			})
			return
		}
		emit(SocketEvent{
			Type: "message",
			Data: append([]byte(nil), payload...),
		})
	}
}

func (h *NetworkHost) SendWebSocket(
	_ context.Context,
	id uint64,
	payload []byte,
) error {
	if int64(len(payload)) > h.config.MaxFrameBytes {
		return ErrPayloadTooLarge
	}
	socket, err := h.socket(id)
	if err != nil {
		return err
	}
	socket.mu.Lock()
	defer socket.mu.Unlock()
	if socket.conn == nil {
		return ErrUnknownResource
	}
	return socket.conn.WriteMessage(websocket.BinaryMessage, payload)
}

func (h *NetworkHost) CloseWebSocket(
	_ context.Context,
	id uint64,
) error {
	socket, err := h.socket(id)
	if err != nil {
		if errors.Is(err, ErrUnknownResource) {
			return nil
		}
		return err
	}
	socket.cancel()
	socket.mu.Lock()
	defer socket.mu.Unlock()
	if socket.conn != nil {
		return socket.conn.Close()
	}
	return nil
}

func (h *NetworkHost) StartFetch(
	parent context.Context,
	request FetchRequest,
	complete func(FetchResult),
) (uint64, error) {
	if err := h.config.Policy.Validate(
		request.URL,
		EndpointHTTP,
	); err != nil {
		return 0, err
	}
	method := strings.ToUpper(request.Method)
	switch method {
	case http.MethodGet,
		http.MethodPost,
		http.MethodPut,
		http.MethodDelete:
	default:
		return 0, ErrEndpointDenied
	}
	ctx, cancel := context.WithTimeout(
		parent,
		h.config.RequestTimeout,
	)
	id := h.nextID.Add(1)
	h.mu.Lock()
	h.fetches[id] = cancel
	h.mu.Unlock()
	go h.runFetch(ctx, id, method, request, complete)
	return id, nil
}

func (h *NetworkHost) runFetch(
	ctx context.Context,
	id uint64,
	method string,
	request FetchRequest,
	complete func(FetchResult),
) {
	defer h.removeFetch(id)
	var body io.Reader
	switch value := request.Body.(type) {
	case nil:
	case string:
		body = strings.NewReader(value)
	case []byte:
		body = bytes.NewReader(value)
	default:
		complete(FetchResult{})
		return
	}
	httpRequest, err := http.NewRequestWithContext(
		ctx,
		method,
		request.URL,
		body,
	)
	if err != nil {
		complete(FetchResult{})
		return
	}
	for key, value := range request.Headers {
		httpRequest.Header.Set(key, value)
	}
	client := &http.Client{
		Timeout: h.config.RequestTimeout,
		Transport: &http.Transport{
			Proxy:       nil,
			DialContext: h.secureDialContext,
			TLSClientConfig: &tls.Config{
				MinVersion: tls.VersionTLS12,
			},
		},
		CheckRedirect: func(
			request *http.Request,
			via []*http.Request,
		) error {
			if len(via) >= 3 {
				return ErrEndpointDenied
			}
			return h.config.Policy.Validate(
				request.URL.String(),
				EndpointHTTP,
			)
		},
	}
	response, err := client.Do(httpRequest)
	if err != nil {
		complete(FetchResult{Error: "request_failed"})
		return
	}
	defer response.Body.Close()
	limited := io.LimitReader(
		response.Body,
		h.config.MaxHTTPBytes+1,
	)
	payload, err := io.ReadAll(limited)
	if err != nil || int64(len(payload)) > h.config.MaxHTTPBytes {
		complete(FetchResult{Error: "response_invalid"})
		return
	}
	headers := make(map[string]string, len(response.Header))
	for key, values := range response.Header {
		headers[strings.ToLower(key)] = strings.Join(values, ", ")
	}
	complete(FetchResult{
		Status:     response.StatusCode,
		StatusText: response.Status,
		Headers:    headers,
		Body:       string(payload),
	})
}

func (h *NetworkHost) AbortFetch(
	_ context.Context,
	id uint64,
) error {
	h.mu.Lock()
	cancel, ok := h.fetches[id]
	h.mu.Unlock()
	if !ok {
		return nil
	}
	cancel()
	return nil
}

func (h *NetworkHost) secureDialContext(
	ctx context.Context,
	network string,
	address string,
) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, ErrEndpointDenied
	}
	if parsed := net.ParseIP(host); parsed != nil {
		return nil, ErrEndpointDenied
	}
	addresses, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return nil, err
	}
	dialer := net.Dialer{Timeout: h.config.DialTimeout}
	var lastErr error
	for _, address := range addresses {
		if !isPublicIP(address.IP) {
			continue
		}
		connection, err := dialer.DialContext(
			ctx,
			network,
			net.JoinHostPort(address.IP.String(), port),
		)
		if err == nil {
			return connection, nil
		}
		lastErr = err
	}
	if lastErr != nil {
		return nil, lastErr
	}
	return nil, ErrEndpointDenied
}

func isPublicIP(ip net.IP) bool {
	return ip != nil &&
		ip.IsGlobalUnicast() &&
		!ip.IsPrivate() &&
		!ip.IsLoopback() &&
		!ip.IsLinkLocalUnicast() &&
		!ip.IsLinkLocalMulticast()
}

func (h *NetworkHost) socket(id uint64) (*networkSocket, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	socket, ok := h.sockets[id]
	if !ok {
		return nil, ErrUnknownResource
	}
	return socket, nil
}

func (h *NetworkHost) removeSocket(
	id uint64,
	expected *networkSocket,
) {
	h.mu.Lock()
	if h.sockets[id] == expected {
		delete(h.sockets, id)
	}
	h.mu.Unlock()
}

func (h *NetworkHost) removeFetch(id uint64) {
	h.mu.Lock()
	cancel := h.fetches[id]
	delete(h.fetches, id)
	h.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}
