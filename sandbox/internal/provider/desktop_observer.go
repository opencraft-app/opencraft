package provider

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"go.mongodb.org/mongo-driver/v2/bson"
)

const (
	desktopObserverTCPPort      = "5901" // Must match CTL's native view-only unit.
	desktopObserverMaxFrame     = 1 << 20
	desktopObserverWriteTimeout = 10 * time.Second
)

type desktopProxyFrame struct {
	Type string `json:"Type" bson:"Type"`
	Data struct {
		SessionID string `json:"SessionId" bson:"SessionId"`
		ChannelID string `json:"ChannelId" bson:"ChannelId"`
		Data      struct {
			ProxyID string `json:"ProxyId" bson:"ProxyId"`
			Data    []byte `json:"Data" bson:"Data"`
			Error   string `json:"Error" bson:"Error"`
		} `json:"Data" bson:"Data"`
	} `json:"Data" bson:"Data"`
}

// OpenDesktopObserver is a backend-only transport primitive, NOT an authorized
// public viewer API. Its caller must resolve/revalidate the owned instance and
// desktop incarnation, enforce attachment expiry, and close it on revocation.
// Only the fixed native view-only endpoint is reachable. No arbitrary host/port,
// shell, or TAT credentials cross this port. Control requires another executor.
func (p *TencentCloudProvider) OpenDesktopObserver(ctx context.Context, region, instanceID string) (io.ReadWriteCloser, error) {
	return p.openDesktopObserver(ctx, ctx, region, instanceID, desktopObserverTCPPort)
}

// Opening and lifetime are separate: retiring a completed handshake must not
// retire the viewer. The caller may only use the two fixed internal endpoints.
func (p *TencentCloudProvider) openDesktopObserver(openingParent, lifetime context.Context, region, instanceID, port string) (io.ReadWriteCloser, error) {
	if openingParent == nil || lifetime == nil {
		return nil, errors.New("desktop observer context required")
	}
	if port != desktopObserverTCPPort && port != "5902" {
		return nil, errors.New("invalid desktop observer endpoint")
	}
	if err := openingParent.Err(); err != nil {
		return nil, err
	}
	if err := lifetime.Err(); err != nil {
		return nil, err
	}
	region = p.resolveRegion(region)
	instanceID = strings.TrimSpace(instanceID)
	if !tencentRegionPattern.MatchString(region) || instanceID == "" {
		return nil, errors.New("invalid desktop observer target")
	}
	// The bound covers StartSession, WS authentication and proxy readiness, but
	// not the viewer lifetime. Do not blindly retry an unknown StartSession result.
	opening, cancel := context.WithTimeout(openingParent, tatStreamHandshakeTimeout)
	stopLifetime := context.AfterFunc(lifetime, cancel)
	defer stopLifetime()
	defer cancel()
	start := p.startTerminalSessionFunc
	if start == nil {
		start = p.StartTerminalSession
	}
	session, err := start(opening, region, instanceID)
	if err != nil {
		return nil, errors.New("desktop observer session unavailable")
	}
	if err := opening.Err(); err != nil {
		return nil, err
	}
	if session.SessionID == "" || session.OwnerUin == "" || session.AppID <= 0 || session.InstanceID != instanceID || session.Region != region {
		return nil, errors.New("desktop observer session target mismatch")
	}
	url := fmt.Sprintf("wss://%s.forward.tat-tc.tencent.cn/ws", region)
	if p.tatForwardURLFunc != nil {
		url = p.tatForwardURLFunc(region)
	}
	dialer := websocket.Dialer{HandshakeTimeout: tatStreamHandshakeTimeout}
	conn, resp, err := dialer.DialContext(opening, url, http.Header{})
	if resp != nil && resp.Body != nil {
		_ = resp.Body.Close()
	}
	if err != nil {
		return nil, errors.New("desktop observer transport unavailable")
	}
	conn.SetReadLimit(desktopObserverMaxFrame + 4096)
	reader, writer := io.Pipe() // Backpressure: no growing receive queue.
	deadline, _ := opening.Deadline()
	s := &desktopObserverStream{conn: conn, sessionID: session.SessionID,
		channelID: "desktop-" + uuid.NewString(), reader: reader, writer: writer, done: make(chan struct{}), openingDeadline: deadline}
	stopOpening := context.AfterFunc(opening, func() { s.finish(opening.Err()) })
	defer stopOpening()
	// A watcher uses the caller lifetime, including while opening. The opening
	// deadline also interrupts blocked reads/writes, without cancelling the
	// successful viewer when the opening context is retired below.
	go func() {
		select {
		case <-lifetime.Done():
			s.finish(lifetime.Err())
		case <-s.done:
		}
	}()
	_ = conn.SetReadDeadline(deadline)
	_ = conn.SetWriteDeadline(deadline)
	if err := s.writeJSON(map[string]any{"Type": "SessionAuth", "Data": map[string]any{
		"Uin": session.OwnerUin, "AppId": session.AppID, "InstanceId": instanceID, "SessionId": session.SessionID,
		"MaxIdleTime": 60,
	}}); err != nil {
		s.finish(err)
		return nil, errors.New("desktop observer authentication unavailable")
	}
	if err := s.send("PtyProxyNew", map[string]any{"ProxyId": s.channelID, "Ip": "127.0.0.1", "Port": port}); err != nil {
		s.finish(err)
		return nil, errors.New("desktop observer opening failed")
	}
	frame, err := s.readFrame()
	if err != nil || frame.Type != "PtyProxyReady" || !s.matches(frame) || frame.Data.Data.Error != "" {
		s.finish(errors.New("desktop observer not ready"))
		return nil, errors.New("desktop observer not ready")
	}
	if err := opening.Err(); err != nil {
		s.finish(err)
		return nil, err
	}
	_ = conn.SetReadDeadline(time.Time{})
	s.writeMu.Lock()
	s.openingDeadline = time.Time{}
	s.writeMu.Unlock()
	if err := lifetime.Err(); err != nil {
		s.finish(err)
		return nil, err
	}
	if !stopOpening() || opening.Err() != nil {
		s.finish(errors.New("desktop observer opening cancelled"))
		return nil, errors.New("desktop observer opening cancelled")
	}
	// A cancelled watcher may already have retired the channel.
	select {
	case <-s.done:
		return nil, errors.New("desktop observer cancelled")
	default:
	}
	go s.receive()
	return s, nil
}

type desktopObserverStream struct {
	conn                 *websocket.Conn
	sessionID, channelID string
	reader               *io.PipeReader
	writer               *io.PipeWriter
	writeMu              sync.Mutex
	closeOnce            sync.Once
	done                 chan struct{}
	openingDeadline      time.Time // guarded by writeMu; retired after readiness.
}

func (s *desktopObserverStream) Read(data []byte) (int, error) { return s.reader.Read(data) }
func (s *desktopObserverStream) Write(data []byte) (int, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	written := 0
	for len(data) > 0 {
		select {
		case <-s.done:
			return written, io.ErrClosedPipe
		default:
		}
		n := len(data)
		if n > 64*1024 {
			n = 64 * 1024
		}
		if err := s.sendLocked("PtyProxyData", map[string]any{"ProxyId": s.channelID, "Data": data[:n]}); err != nil {
			// finish never acquires writeMu: retirement fences further writes now.
			s.finish(errors.New("desktop observer write failed"))
			return written, errors.New("desktop observer write failed")
		}
		written += n
		data = data[n:]
	}
	return written, nil
}
func (s *desktopObserverStream) Close() error { s.finish(io.EOF); return nil }
func (s *desktopObserverStream) finish(err error) {
	s.closeOnce.Do(func() {
		close(s.done)
		// Close first: never wait for a blocked writer to relinquish writeMu.
		// This dedicated physical socket has no Chat/PTY/other viewer consumers.
		_ = s.conn.Close()
		_ = s.writer.CloseWithError(err)
	})
}
func (s *desktopObserverStream) writeJSON(frame any) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	return s.conn.WriteJSON(frame)
}
func (s *desktopObserverStream) send(kind string, data any) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	return s.sendLocked(kind, data)
}
func (s *desktopObserverStream) sendLocked(kind string, data any) error {
	deadline := time.Now().Add(desktopObserverWriteTimeout)
	if !s.openingDeadline.IsZero() && s.openingDeadline.Before(deadline) {
		deadline = s.openingDeadline
	}
	_ = s.conn.SetWriteDeadline(deadline)
	payload, err := bson.Marshal(map[string]any{"Type": kind, "Data": map[string]any{
		"SessionId": s.sessionID, "ChannelId": s.channelID, "Data": data,
	}})
	if err != nil {
		return err
	}
	return s.conn.WriteMessage(websocket.BinaryMessage, payload)
}
func (s *desktopObserverStream) readFrame() (desktopProxyFrame, error) {
	kind, bytes, err := s.conn.ReadMessage()
	if err != nil {
		return desktopProxyFrame{}, errors.New("desktop observer disconnected")
	}
	var frame desktopProxyFrame
	switch kind {
	case websocket.BinaryMessage:
		err = bson.Unmarshal(bytes, &frame)
	case websocket.TextMessage:
		err = json.Unmarshal(bytes, &frame)
	default:
		err = errors.New("unsupported desktop observer frame")
	}
	if err != nil {
		return desktopProxyFrame{}, errors.New("invalid desktop observer frame")
	}
	return frame, nil
}
func (s *desktopObserverStream) matches(frame desktopProxyFrame) bool {
	return frame.Data.ChannelID == s.channelID && frame.Data.Data.ProxyID == s.channelID &&
		(frame.Data.SessionID == "" || frame.Data.SessionID == s.sessionID)
}
func (s *desktopObserverStream) receive() {
	for {
		frame, err := s.readFrame()
		if err != nil {
			s.finish(err)
			return
		}
		if !s.matches(frame) || frame.Data.Data.Error != "" {
			s.finish(errors.New("desktop observer channel rejected"))
			return
		}
		switch frame.Type {
		case "PtyProxyData":
			if len(frame.Data.Data.Data) > desktopObserverMaxFrame {
				s.finish(errors.New("desktop observer frame too large"))
				return
			}
			if _, err := s.writer.Write(frame.Data.Data.Data); err != nil {
				s.finish(err)
				return
			}
		case "PtyProxyClose":
			s.finish(io.EOF)
			return
		default:
			s.finish(errors.New("unexpected desktop observer frame"))
			return
		}
	}
}
