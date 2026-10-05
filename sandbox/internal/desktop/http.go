package desktop

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// HTTP mutations require product authentication. Browser WebSockets authenticate
// with a scoped one-use ticket in their first frame, not a general bearer token
// in the URL. No desktop bytes are exposed before that proof is verified.
type Handler struct {
	Broker       *Broker
	Authenticate func(*http.Request) (string, error)
	// Optional additional trusted cookie/gateway identity. When configured,
	// mismatches or errors reject rather than fall back to ticket-only access.
	SocketPrincipal func(*http.Request) (string, error)
	Origin          string
}

func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if h.Broker == nil || h.Authenticate == nil || h.Origin == "" {
		http.Error(w, "Unavailable", 503)
		return
	}
	if origin := r.Header.Get("Origin"); origin != "" && origin != h.Origin {
		http.Error(w, "Forbidden", 403)
		return
	}
	principal := ""
	connecting := r.URL.Path == "/desktop/connect" && r.Method == http.MethodGet
	authenticate := h.Authenticate
	if connecting {
		authenticate = h.SocketPrincipal
	}
	if authenticate != nil {
		var err error
		principal, err = authenticate(r)
		if err != nil || principal == "" {
			http.Error(w, "Unauthorized", 401)
			return
		}
	}
	switch {
	case r.URL.Path == "/desktop/attachments" && r.Method == http.MethodPost:
		var req Request
		if decode(http.MaxBytesReader(w, r.Body, 8192), &req) != nil {
			http.Error(w, "Invalid request", 400)
			return
		}
		credential, err := h.Broker.Issue(r.Context(), principal, req)
		if err != nil {
			http.Error(w, "Unavailable", 403)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"code": "OK", "message": "success", "data": credential})
	case strings.HasPrefix(r.URL.Path, "/desktop/attachments/") && r.Method == http.MethodDelete:
		h.Broker.Release(principal, strings.TrimPrefix(r.URL.Path, "/desktop/attachments/"))
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"code": "OK", "message": "success", "data": nil})
	case r.URL.Path == "/desktop/connect" && r.Method == http.MethodGet:
		// Require Origin even if HTTP server-to-server clients may omit it.
		if r.Header.Get("Origin") != h.Origin || r.URL.RawQuery != "" {
			http.Error(w, "Forbidden", 403)
			return
		}
		releaseSlot, allowed := h.Broker.reserveSocket(principal)
		if !allowed {
			http.Error(w, "Unavailable", http.StatusTooManyRequests)
			return
		}
		defer releaseSlot()
		upgrader := websocket.Upgrader{HandshakeTimeout: 5 * time.Second, CheckOrigin: func(*http.Request) bool { return true }}
		ws, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		h.Broker.serve(r.Context(), principal, ws)
	default:
		http.NotFound(w, r)
	}
}
func decode(reader io.Reader, result any) error {
	decoder := json.NewDecoder(reader)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(result); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return errUnavailable
	}
	return nil
}

type wireMessage struct {
	Event            string `json:"event"`
	Version          int    `json:"version,omitempty"`
	AttachmentID     string `json:"attachmentId,omitempty"`
	Ticket           string `json:"ticket,omitempty"`
	RequestID        string `json:"requestId,omitempty"`
	ControlAvailable *bool  `json:"controlAvailable,omitempty"`
}
type viewer struct {
	broker        *Broker
	attachment    *attachment
	stream        VerifiedStream
	ws            *websocket.Conn
	writeMu       sync.Mutex
	mu            sync.Mutex
	pending       string
	requestCancel context.CancelFunc
	grant         Grant
	grantID       string
	lastRequest   uint64
}

func (v *viewer) write(kind int, data []byte) error {
	v.writeMu.Lock()
	defer v.writeMu.Unlock()
	_ = v.ws.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return v.ws.WriteMessage(kind, data)
}
func (v *viewer) message(message wireMessage) error {
	data, _ := json.Marshal(message)
	return v.write(websocket.TextMessage, data)
}
func release(grant Grant) error {
	if grant == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return grant.Release(ctx)
}
func (v *viewer) retire() { v.broker.retire(v.attachment) }
func (v *viewer) control(message wireMessage) error {
	if message.RequestID == "" || len(message.RequestID) > 64 || message.Version != 0 || message.AttachmentID != "" || message.Ticket != "" || message.ControlAvailable != nil {
		return errUnavailable
	}
	switch message.Event {
	case "control/request":
		sequence, err := strconv.ParseUint(message.RequestID, 10, 64)
		if err != nil || sequence == 0 || strconv.FormatUint(sequence, 10) != message.RequestID {
			return errUnavailable
		}
		v.mu.Lock()
		if sequence <= v.lastRequest {
			v.mu.Unlock()
			return errUnavailable
		}
		v.lastRequest = sequence
		if v.stream.Control == nil || v.pending != "" || v.grant != nil || v.attachment.ctx.Err() != nil {
			v.mu.Unlock()
			return v.message(wireMessage{Event: "control/denied", RequestID: message.RequestID})
		}
		id := message.RequestID
		ctx, cancel := context.WithTimeout(v.attachment.ctx, 10*time.Second)
		v.pending, v.requestCancel = id, cancel
		v.mu.Unlock()
		go func() {
			grant, err := v.stream.Control.Acquire(ctx)
			v.mu.Lock()
			current := v.pending == id && ctx.Err() == nil && v.attachment.ctx.Err() == nil
			if v.pending == id {
				v.pending = ""
				v.requestCancel = nil
			}
			if err == nil && grant != nil && current {
				if grant.Done() == nil {
					current = false
				}
				select {
				case <-grant.Done():
					current = false
				default:
				}
			}
			if err == nil && grant != nil && current {
				v.grant, v.grantID = grant, id
			}
			v.mu.Unlock()
			cancel()
			if err != nil || grant == nil || !current {
				if release(grant) != nil {
					v.retire()
					return
				}
				if current && v.message(wireMessage{Event: "control/denied", RequestID: id}) != nil {
					v.retire()
				}
				return
			}
			if v.message(wireMessage{Event: "control/locked", RequestID: id}) != nil {
				v.retire()
				return
			}
			go func() {
				select {
				case <-grant.Done():
				case <-v.attachment.ctx.Done():
					return
				}
				v.mu.Lock()
				if v.grantID != id || v.grant == nil {
					v.mu.Unlock()
					return
				}
				v.grant = nil
				v.grantID = ""
				v.mu.Unlock()
				if release(grant) != nil || v.message(wireMessage{Event: "control/release", RequestID: id}) != nil {
					v.retire()
				}
			}()
		}()
	case "control/release":
		v.mu.Lock()
		if v.pending == message.RequestID {
			v.pending = ""
			if v.requestCancel != nil {
				v.requestCancel()
			}
			v.requestCancel = nil
		}
		var grant Grant
		if v.grantID == message.RequestID {
			grant = v.grant
			v.grant = nil
			v.grantID = ""
		}
		v.mu.Unlock()
		if release(grant) != nil {
			return errUnavailable
		}
	default:
		return errUnavailable
	}
	return nil
}
func (b *Broker) serve(ctx context.Context, principal string, ws *websocket.Conn) {
	defer ws.Close()
	ws.SetReadLimit(4096)
	_ = ws.SetReadDeadline(time.Now().Add(5 * time.Second))
	kind, data, err := ws.ReadMessage()
	var auth wireMessage
	if err != nil || kind != websocket.TextMessage || len(data) > 4096 || decode(strings.NewReader(string(data)), &auth) != nil ||
		auth.Event != "desktop/attach" || auth.Version != 1 || auth.RequestID != "" || auth.ControlAvailable != nil {
		return
	}
	a, stream, err := b.claim(ctx, principal, auth.AttachmentID, auth.Ticket)
	if err != nil {
		return
	}
	principal = a.principal
	ws.SetReadLimit(1 << 20)
	v := &viewer{broker: b, attachment: a, stream: stream, ws: ws}
	closeTransport := func() {
		// Close sockets before waiting for executor release or blocked media writes.
		_ = ws.Close()
		_ = stream.Stream.Close()
		v.mu.Lock()
		cancel := v.requestCancel
		v.requestCancel = nil
		v.pending = ""
		grant := v.grant
		v.grant = nil
		v.grantID = ""
		v.mu.Unlock()
		if cancel != nil {
			cancel()
		}
		_ = release(grant)
	}
	b.mu.Lock()
	if b.attachments[a.id] != a || a.ctx.Err() != nil {
		b.mu.Unlock()
		closeTransport()
		return
	}
	a.closeTransport = closeTransport
	b.mu.Unlock()
	defer b.retire(a)
	_ = ws.SetReadDeadline(time.Now().Add(45 * time.Second))
	ws.SetPongHandler(func(string) error { return ws.SetReadDeadline(time.Now().Add(45 * time.Second)) })
	available := stream.Control != nil
	if v.message(wireMessage{Event: "desktop/ready", Version: 1, AttachmentID: a.id, ControlAvailable: &available}) != nil {
		return
	}
	go func() {
		buffer := make([]byte, 64*1024)
		for {
			n, err := stream.Stream.Read(buffer)
			if n > 0 && v.write(websocket.BinaryMessage, buffer[:n]) != nil {
				v.retire()
				return
			}
			if err != nil {
				v.retire()
				return
			}
		}
	}()
	go func() {
		ticker := time.NewTicker(b.checkInterval)
		defer ticker.Stop()
		for {
			select {
			case <-a.ctx.Done():
				return
			case <-ticker.C:
			}
			check, cancel := context.WithTimeout(a.ctx, 5*time.Second)
			current, err := b.authority.Resolve(check, principal, a.binding.Target)
			cancel()
			if err != nil || current != a.binding {
				v.retire()
				return
			}
			if ws.WriteControl(websocket.PingMessage, nil, time.Now().Add(5*time.Second)) != nil {
				v.retire()
				return
			}
		}
	}()
	for {
		kind, data, err = ws.ReadMessage()
		if err != nil {
			return
		}
		switch kind {
		case websocket.BinaryMessage:
			// Protocol bytes pass to a verified native observe/gated executor. Never
			// treat a local grant boolean as a security filter for unparsed RFB bytes.
			written, err := stream.Stream.Write(data)
			if err != nil || written != len(data) {
				return
			}
		case websocket.TextMessage:
			var message wireMessage
			if len(data) > 4096 || decode(strings.NewReader(string(data)), &message) != nil || v.control(message) != nil {
				return
			}
		default:
			return
		}
	}
}
