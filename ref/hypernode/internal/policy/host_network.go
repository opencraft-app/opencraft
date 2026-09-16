package policy

import (
	"bytes"
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	goja "hypernode/internal/policy/jsvm"
	"hypernode/internal/telemetry"
)

const (
	hostHTTPBodyLimit       = 8 * 1024 * 1024
	hostWebSocketQueueLimit = 32 * 1024 * 1024
	hostTCPQueueLimit       = 32 * 1024 * 1024
)

type hostNetwork struct {
	client     *http.Client
	mu         sync.Mutex
	sockets    map[string]*hostWebSocket
	tcpSockets map[string]*hostTCPSocket
	notify     func()
	telemetry  *telemetry.Manager
}

type hostTCPSocket struct {
	connMu            sync.RWMutex
	conn              net.Conn
	mu                sync.Mutex
	writeMu           sync.Mutex
	data              []byte
	err               string
	closed            bool
	hostname          string
	secureTransport   string
	allowHalfOpen     bool
	upgrading         bool
	readDone          chan struct{}
	pendingWrite      []byte
	pendingCloseWrite bool
	notify            func()
	telemetry         *telemetry.Manager
	telemetryHandle   string
	readCount         int64
	totalReadBytes    int64
	drainCount        int64
	lastReadAt        time.Time
	lastDrainAt       time.Time
	telemetryEnded    bool
}

type hostWebSocket struct {
	conn   *websocket.Conn
	mu     sync.Mutex
	frames []string
	bytes  int
	err    string
	closed bool
	notify func()
}

func newHostNetwork(notifiers ...func()) *hostNetwork {
	return newHostNetworkWithTelemetry(nil, notifiers...)
}

func newHostNetworkWithTelemetry(manager *telemetry.Manager, notifiers ...func()) *hostNetwork {
	notify := func() {}
	if len(notifiers) > 0 && notifiers[0] != nil {
		notify = notifiers[0]
	}
	return &hostNetwork{
		client:     &http.Client{Timeout: 30 * time.Second},
		sockets:    make(map[string]*hostWebSocket),
		tcpSockets: make(map[string]*hostTCPSocket),
		notify:     notify,
		telemetry:  manager,
	}
}

func (h *hostRuntime) installNetwork(vm *goja.Runtime) error {
	object := vm.NewObject()
	if err := object.Set("request", h.network.request); err != nil {
		return err
	}
	if err := object.Set("openWebSocket", h.network.openWebSocket); err != nil {
		return err
	}
	if err := object.Set("sendWebSocket", h.network.sendWebSocket); err != nil {
		return err
	}
	if err := object.Set("drainWebSocket", h.network.drainWebSocket); err != nil {
		return err
	}
	if err := object.Set("closeWebSocket", h.network.closeWebSocket); err != nil {
		return err
	}
	if err := vm.Set("hostNetwork", object); err != nil {
		return err
	}

	// Private JavaScript-host ABI. The public Worker-compatible Socket object lives in JS;
	// this driver only owns outbound TCP bytes and OS resources.
	sockets := vm.NewObject()
	if err := sockets.Set("open", h.network.connectTCP); err != nil {
		return err
	}
	if err := sockets.Set("write", h.network.writeTCP); err != nil {
		return err
	}
	if err := sockets.Set("drain", h.network.drainTCP); err != nil {
		return err
	}
	if err := sockets.Set("shutdownWrite", h.network.closeTCPWrite); err != nil {
		return err
	}
	if err := sockets.Set("startTls", h.network.startTLS); err != nil {
		return err
	}
	if err := sockets.Set("close", h.network.closeTCP); err != nil {
		return err
	}
	return vm.Set("hostTcpOutboundDriver", sockets)
}

func (n *hostNetwork) connectTCP(id string, address map[string]any, options map[string]any) (map[string]any, error) {
	if id == "" {
		return nil, fmt.Errorf("tcp socket id is required")
	}
	hostname, _ := address["hostname"].(string)
	port, ok := numericPort(address["port"])
	if hostname == "" || !ok {
		return nil, fmt.Errorf("tcp hostname and port are required")
	}
	secure, _ := options["secureTransport"].(string)
	if secure == "" {
		secure = "off"
	}
	if secure != "off" && secure != "on" && secure != "starttls" {
		return nil, fmt.Errorf("tcp secureTransport %q is invalid", secure)
	}
	addressText := net.JoinHostPort(hostname, fmt.Sprint(port))
	parentTraceparent, _ := options["_hypernodeTraceparent"].(string)
	correlationID, _ := options["_hypernodeCorrelationId"].(string)
	requestID, _ := options["_hypernodeRequestId"].(string)
	telemetryHandle := ""
	if n.telemetry != nil {
		telemetryHandle, _ = n.telemetry.StartSpan("hypernode.tcp.client", map[string]any{
			"network.transport":         "tcp",
			"server.address":            hostname,
			"server.port":               port,
			"network.secure_transport":  secure,
			"hypernode.correlation_id":  correlationID,
			"hypernode.http.request_id": requestID,
		}, parentTraceparent)
	}
	readDone := make(chan struct{})
	allowHalfOpen, _ := options["allowHalfOpen"].(bool)
	socket := &hostTCPSocket{
		hostname: hostname, secureTransport: secure,
		allowHalfOpen: allowHalfOpen, readDone: readDone, notify: n.notify,
		telemetry: n.telemetry, telemetryHandle: telemetryHandle,
	}
	n.mu.Lock()
	if n.tcpSockets[id] != nil {
		n.mu.Unlock()
		if n.telemetry != nil {
			n.telemetry.AddEvent(telemetryHandle, "network.socket.duplicate", nil)
			n.telemetry.EndSpan(telemetryHandle, "error", nil)
		}
		return nil, fmt.Errorf("duplicate tcp socket id %q", id)
	}
	n.tcpSockets[id] = socket
	n.mu.Unlock()
	go n.dialTCP(socket, addressText, secure, telemetryHandle)
	return socketInfo(nil), nil
}

func (n *hostNetwork) dialTCP(socket *hostTCPSocket, addressText, secure, telemetryHandle string) {
	var connection net.Conn
	var err error
	if secure == "on" {
		dialer := &net.Dialer{Timeout: 10 * time.Second}
		connection, err = tls.DialWithDialer(dialer, "tcp", addressText, &tls.Config{
			MinVersion: tls.VersionTLS12,
			ServerName: socket.hostname,
		})
	} else {
		connection, err = net.DialTimeout("tcp", addressText, 10*time.Second)
	}
	if err != nil {
		socket.mu.Lock()
		socket.err = err.Error()
		socket.closed = true
		socket.mu.Unlock()
		if n.telemetry != nil {
			n.telemetry.AddEvent(telemetryHandle, "network.connect.error", map[string]any{
				"error.type": fmt.Sprintf("%T", err),
			})
		}
		socket.notify()
		socket.finishTelemetry()
		return
	}
	socket.writeMu.Lock()
	socket.mu.Lock()
	closed := socket.closed
	queued := append([]byte(nil), socket.pendingWrite...)
	socket.pendingWrite = nil
	socket.mu.Unlock()
	if closed {
		socket.writeMu.Unlock()
		_ = connection.Close()
		return
	}
	socket.connMu.Lock()
	socket.conn = connection
	socket.connMu.Unlock()
	written := 0
	for written < len(queued) {
		count, writeErr := connection.Write(queued[written:])
		written += count
		if writeErr != nil || count == 0 {
			if writeErr == nil {
				writeErr = io.ErrShortWrite
			}
			socket.mu.Lock()
			socket.err = writeErr.Error()
			socket.closed = true
			socket.mu.Unlock()
			socket.writeMu.Unlock()
			_ = connection.Close()
			socket.notify()
			socket.finishTelemetry()
			return
		}
	}
	if socket.pendingCloseWrite {
		if halfCloser, ok := connection.(interface{ CloseWrite() error }); ok {
			if closeErr := halfCloser.CloseWrite(); closeErr != nil {
				socket.mu.Lock()
				socket.err = closeErr.Error()
				socket.closed = true
				socket.mu.Unlock()
			}
		}
	}
	socket.writeMu.Unlock()
	if n.telemetry != nil {
		n.telemetry.AddEvent(telemetryHandle, "network.connect.completed", nil)
	}
	socket.notify()
	socket.readLoop(connection, socket.readDone)
}

func socketInfo(connection net.Conn) map[string]any {
	localAddress := any(nil)
	remoteAddress := any(nil)
	if connection != nil && connection.LocalAddr() != nil {
		localAddress = connection.LocalAddr().String()
	}
	if connection != nil && connection.RemoteAddr() != nil {
		remoteAddress = connection.RemoteAddr().String()
	}
	return map[string]any{"localAddress": localAddress, "remoteAddress": remoteAddress}
}

func numericPort(value any) (int, bool) {
	var port int
	switch typed := value.(type) {
	case int:
		port = typed
	case int64:
		port = int(typed)
	case float64:
		port = int(typed)
	default:
		return 0, false
	}
	return port, port > 0 && port <= 65535
}

func (n *hostNetwork) tcpSocket(id string) (*hostTCPSocket, error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	socket := n.tcpSockets[id]
	if socket == nil {
		return nil, fmt.Errorf("unknown tcp socket %q", id)
	}
	return socket, nil
}

func (n *hostNetwork) writeTCP(id string, data []byte) (int, error) {
	if len(data) > hostTCPQueueLimit {
		return 0, fmt.Errorf("tcp write exceeds limit")
	}
	socket, err := n.tcpSocket(id)
	if err != nil {
		return 0, err
	}
	socket.writeMu.Lock()
	defer socket.writeMu.Unlock()
	socket.connMu.RLock()
	connection := socket.conn
	socket.connMu.RUnlock()
	if connection == nil {
		socket.mu.Lock()
		defer socket.mu.Unlock()
		if socket.closed {
			return 0, fmt.Errorf("tcp socket is closed: %s", socket.err)
		}
		if len(socket.pendingWrite)+len(data) > hostTCPQueueLimit {
			return 0, fmt.Errorf("tcp pending write queue exceeds limit")
		}
		socket.pendingWrite = append(socket.pendingWrite, data...)
		return len(data), nil
	}
	written := 0
	for written < len(data) {
		count, writeErr := connection.Write(data[written:])
		written += count
		if writeErr != nil {
			return written, writeErr
		}
		if count == 0 {
			return written, io.ErrShortWrite
		}
	}
	return written, nil
}

func (n *hostNetwork) drainTCP(id string) (map[string]any, error) {
	socket, err := n.tcpSocket(id)
	if err != nil {
		return nil, err
	}
	socket.mu.Lock()
	data := append([]byte(nil), socket.data...)
	socket.data = socket.data[:0]
	closed := socket.closed
	errorText := socket.err
	now := time.Now()
	firstDrain := len(data) > 0 && socket.drainCount == 0
	drainGap := time.Duration(0)
	if len(data) > 0 {
		if !socket.lastDrainAt.IsZero() {
			drainGap = now.Sub(socket.lastDrainAt)
		}
		socket.lastDrainAt = now
		socket.drainCount++
	}
	drainCount := socket.drainCount
	handle := socket.telemetryHandle
	manager := socket.telemetry
	socket.mu.Unlock()
	if manager != nil && firstDrain {
		manager.AddEvent(handle, "network.drain.first", map[string]any{
			"network.io.bytes": len(data),
		})
	} else if manager != nil && drainGap >= time.Second {
		manager.AddEvent(handle, "network.drain.gap", map[string]any{
			"network.io.bytes":       len(data),
			"network.io.gap_ms":      drainGap.Milliseconds(),
			"network.io.drain_count": drainCount,
		})
	}
	return map[string]any{"dataBytes": data, "closed": closed, "error": errorText}, nil
}

func (n *hostNetwork) closeTCPWrite(id string) error {
	socket, err := n.tcpSocket(id)
	if err != nil {
		return err
	}
	socket.writeMu.Lock()
	defer socket.writeMu.Unlock()
	socket.connMu.RLock()
	connection := socket.conn
	socket.connMu.RUnlock()
	if connection == nil {
		socket.mu.Lock()
		defer socket.mu.Unlock()
		if socket.closed {
			return fmt.Errorf("tcp socket is closed: %s", socket.err)
		}
		socket.pendingCloseWrite = true
		return nil
	}
	if halfCloser, ok := connection.(interface{ CloseWrite() error }); ok {
		return halfCloser.CloseWrite()
	}
	return fmt.Errorf("tcp socket does not support half-close")
}

func (n *hostNetwork) startTLS(id string) (map[string]any, error) {
	socket, err := n.tcpSocket(id)
	if err != nil {
		return nil, err
	}
	socket.mu.Lock()
	if socket.closed || socket.upgrading || socket.secureTransport != "starttls" {
		socket.mu.Unlock()
		return nil, fmt.Errorf("tcp socket is not eligible for startTls")
	}
	socket.upgrading = true
	readDone := socket.readDone
	socket.mu.Unlock()
	socket.writeMu.Lock()
	defer socket.writeMu.Unlock()
	resetUpgrade := func(upgradeErr error, closeSocket bool) {
		socket.mu.Lock()
		socket.upgrading = false
		if upgradeErr != nil {
			socket.err = upgradeErr.Error()
		}
		if closeSocket {
			socket.closed = true
		}
		socket.mu.Unlock()
		if closeSocket {
			socket.connMu.RLock()
			connection := socket.conn
			socket.connMu.RUnlock()
			_ = connection.Close()
			socket.notify()
		}
	}

	socket.connMu.RLock()
	plain := socket.conn
	socket.connMu.RUnlock()
	if plain == nil {
		resetUpgrade(fmt.Errorf("tcp socket is still connecting"), false)
		return nil, fmt.Errorf("tcp socket is still connecting")
	}
	if err := plain.SetReadDeadline(time.Now()); err != nil {
		resetUpgrade(err, false)
		return nil, err
	}
	<-readDone
	if err := plain.SetReadDeadline(time.Time{}); err != nil {
		resetUpgrade(err, true)
		return nil, err
	}
	secure := tls.Client(plain, &tls.Config{MinVersion: tls.VersionTLS12, ServerName: socket.hostname})
	if err := secure.Handshake(); err != nil {
		resetUpgrade(err, true)
		return nil, err
	}
	newReadDone := make(chan struct{})
	socket.connMu.Lock()
	socket.conn = secure
	socket.connMu.Unlock()
	socket.mu.Lock()
	socket.secureTransport = "on"
	socket.upgrading = false
	socket.readDone = newReadDone
	socket.mu.Unlock()
	go socket.readLoop(secure, newReadDone)
	return socketInfo(secure), nil
}

func (n *hostNetwork) closeTCP(id string) error {
	n.mu.Lock()
	socket := n.tcpSockets[id]
	delete(n.tcpSockets, id)
	n.mu.Unlock()
	if socket == nil {
		return nil
	}
	socket.connMu.RLock()
	connection := socket.conn
	socket.connMu.RUnlock()
	socket.mu.Lock()
	socket.closed = true
	socket.mu.Unlock()
	if connection == nil {
		socket.notify()
		socket.finishTelemetry()
		return nil
	}
	return connection.Close()
}

func (s *hostTCPSocket) readLoop(connection net.Conn, done chan struct{}) {
	defer func() {
		close(done)
		s.connMu.RLock()
		currentConnection := s.conn
		s.connMu.RUnlock()
		s.mu.Lock()
		if s.upgrading && currentConnection == connection {
			s.mu.Unlock()
			return
		}
		s.closed = true
		s.mu.Unlock()
		s.notify()
		s.finishTelemetry()
	}()
	buffer := make([]byte, 32*1024)
	for {
		count, err := connection.Read(buffer)
		if count > 0 {
			now := time.Now()
			s.mu.Lock()
			if len(s.data)+count > hostTCPQueueLimit {
				s.err = "tcp receive queue exceeds limit"
				s.closed = true
				s.mu.Unlock()
				_ = connection.Close()
				s.notify()
				return
			}
			firstRead := s.readCount == 0
			readGap := time.Duration(0)
			if !s.lastReadAt.IsZero() {
				readGap = now.Sub(s.lastReadAt)
			}
			s.lastReadAt = now
			s.readCount++
			s.totalReadBytes += int64(count)
			readCount := s.readCount
			handle := s.telemetryHandle
			manager := s.telemetry
			s.data = append(s.data, buffer[:count]...)
			s.mu.Unlock()
			if manager != nil && firstRead {
				manager.AddEvent(handle, "network.read.first", map[string]any{
					"network.io.bytes": count,
				})
			} else if manager != nil && readGap >= time.Second {
				manager.AddEvent(handle, "network.read.gap", map[string]any{
					"network.io.bytes":      count,
					"network.io.gap_ms":     readGap.Milliseconds(),
					"network.io.read_count": readCount,
				})
			}
			s.notify()
		}
		if err != nil {
			s.mu.Lock()
			upgrading := s.upgrading
			s.mu.Unlock()
			if !errors.Is(err, net.ErrClosed) && !errors.Is(err, io.EOF) {
				if !upgrading {
					s.mu.Lock()
					s.err = err.Error()
					s.mu.Unlock()
				}
			}
			if errors.Is(err, io.EOF) && !s.allowHalfOpen {
				s.writeMu.Lock()
				if halfCloser, ok := connection.(interface{ CloseWrite() error }); ok {
					_ = halfCloser.CloseWrite()
				}
				s.writeMu.Unlock()
			}
			return
		}
	}
}

func (s *hostTCPSocket) finishTelemetry() {
	s.mu.Lock()
	if s.telemetryEnded {
		s.mu.Unlock()
		return
	}
	s.telemetryEnded = true
	manager := s.telemetry
	handle := s.telemetryHandle
	errorText := s.err
	attributes := map[string]any{
		"network.io.read_count":  s.readCount,
		"network.io.read_bytes":  s.totalReadBytes,
		"network.io.drain_count": s.drainCount,
	}
	s.mu.Unlock()
	if manager == nil {
		return
	}
	status := "ok"
	if errorText != "" {
		status = "error"
		manager.AddEvent(handle, "network.read.error", map[string]any{
			"error.type": "network_read",
		})
	}
	manager.EndSpan(handle, status, attributes)
}

func (n *hostNetwork) request(options map[string]any) (map[string]any, error) {
	method, _ := options["method"].(string)
	url, _ := options["url"].(string)
	body, _ := options["body"].(string)
	if method == "" || url == "" {
		return nil, fmt.Errorf("network request method and url are required")
	}
	request, err := http.NewRequest(method, url, bytes.NewBufferString(body))
	if err != nil {
		return nil, err
	}
	if headers, ok := options["headers"].(map[string]any); ok {
		for name, raw := range headers {
			value, ok := raw.(string)
			if !ok {
				return nil, fmt.Errorf("network header %q must be a string", name)
			}
			request.Header.Set(name, value)
		}
	}
	response, err := n.client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	payload, err := io.ReadAll(io.LimitReader(response.Body, hostHTTPBodyLimit+1))
	if err != nil {
		return nil, err
	}
	if len(payload) > hostHTTPBodyLimit {
		return nil, fmt.Errorf("network response body exceeds limit")
	}
	headers := make(map[string]string, len(response.Header))
	for name, values := range response.Header {
		if len(values) > 0 {
			headers[name] = values[0]
		}
	}
	return map[string]any{
		"status":  response.StatusCode,
		"headers": headers,
		"body":    string(payload),
	}, nil
}

func (n *hostNetwork) openWebSocket(id, url string, headers map[string]any) error {
	if id == "" || url == "" {
		return fmt.Errorf("websocket id and url are required")
	}
	header := make(http.Header, len(headers))
	for name, raw := range headers {
		value, ok := raw.(string)
		if !ok {
			return fmt.Errorf("websocket header %q must be a string", name)
		}
		header.Set(name, value)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	conn, response, err := websocket.DefaultDialer.DialContext(ctx, url, header)
	if err != nil {
		if response != nil {
			return fmt.Errorf("websocket handshake failed: HTTP %d: %w", response.StatusCode, err)
		}
		return err
	}
	socket := &hostWebSocket{conn: conn, notify: n.notify}
	n.mu.Lock()
	if previous := n.sockets[id]; previous != nil {
		n.mu.Unlock()
		_ = conn.Close()
		return fmt.Errorf("duplicate websocket id %q", id)
	}
	n.sockets[id] = socket
	n.mu.Unlock()
	go socket.readLoop()
	return nil
}

func (n *hostNetwork) socket(id string) (*hostWebSocket, error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	socket := n.sockets[id]
	if socket == nil {
		return nil, fmt.Errorf("unknown websocket %q", id)
	}
	return socket, nil
}

func (n *hostNetwork) sendWebSocket(id, text string) error {
	if len(text) > hostWebSocketQueueLimit {
		return fmt.Errorf("websocket message exceeds limit")
	}
	socket, err := n.socket(id)
	if err != nil {
		return err
	}
	return socket.conn.WriteMessage(websocket.TextMessage, []byte(text))
}

func (n *hostNetwork) drainWebSocket(id string) (map[string]any, error) {
	socket, err := n.socket(id)
	if err != nil {
		return nil, err
	}
	socket.mu.Lock()
	defer socket.mu.Unlock()
	frames := append([]string(nil), socket.frames...)
	socket.frames = socket.frames[:0]
	socket.bytes = 0
	return map[string]any{"messages": frames, "closed": socket.closed, "error": socket.err}, nil
}

func (n *hostNetwork) closeWebSocket(id string) error {
	n.mu.Lock()
	socket := n.sockets[id]
	delete(n.sockets, id)
	n.mu.Unlock()
	if socket == nil {
		return nil
	}
	return socket.conn.Close()
}

func (n *hostNetwork) closeAll() {
	n.mu.Lock()
	sockets := n.sockets
	n.sockets = make(map[string]*hostWebSocket)
	tcpSockets := n.tcpSockets
	n.tcpSockets = make(map[string]*hostTCPSocket)
	n.mu.Unlock()
	for _, socket := range sockets {
		_ = socket.conn.Close()
	}
	for _, socket := range tcpSockets {
		socket.mu.Lock()
		socket.closed = true
		socket.mu.Unlock()
		socket.connMu.RLock()
		connection := socket.conn
		socket.connMu.RUnlock()
		if connection != nil {
			_ = connection.Close()
		}
	}
}

func (s *hostWebSocket) readLoop() {
	defer func() {
		s.mu.Lock()
		s.closed = true
		s.mu.Unlock()
		s.notify()
	}()
	for {
		kind, payload, err := s.conn.ReadMessage()
		if err != nil {
			s.mu.Lock()
			s.err = err.Error()
			s.mu.Unlock()
			return
		}
		if kind != websocket.TextMessage {
			continue
		}
		s.mu.Lock()
		if s.bytes+len(payload) > hostWebSocketQueueLimit {
			s.err = "websocket receive queue exceeds limit"
			s.closed = true
			s.mu.Unlock()
			_ = s.conn.Close()
			s.notify()
			return
		}
		s.frames = append(s.frames, string(payload))
		s.bytes += len(payload)
		s.mu.Unlock()
		s.notify()
	}
}
