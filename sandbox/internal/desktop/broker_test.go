package desktop

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// These are explicit external authority/executor substitutes, not proof of
// native input security, production authorization or distributed exclusivity.
type testAuthority struct {
	mu      sync.Mutex
	binding Binding
	stream  *testStream
	control Controller
	opens   int
	open    func(context.Context, context.Context, Binding) (VerifiedStream, error)
}

func (a *testAuthority) Resolve(_ context.Context, principal string, target Target) (Binding, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.binding.Target != target || principal != target.PrincipalID {
		return Binding{}, errUnavailable
	}
	return a.binding, nil
}
func (a *testAuthority) OpenVerified(opening, lifetime context.Context, binding Binding) (VerifiedStream, error) {
	a.mu.Lock()
	a.opens++
	callback := a.open
	a.mu.Unlock()
	if callback != nil {
		return callback(opening, lifetime, binding)
	}
	return VerifiedStream{Binding: binding, Stream: a.stream, Control: a.control}, nil
}

type testStream struct {
	reader *io.PipeReader
	writer *io.PipeWriter
	mu     sync.Mutex
	bytes  []byte
	closed chan struct{}
	once   sync.Once
}

func newStream() *testStream {
	r, w := io.Pipe()
	return &testStream{reader: r, writer: w, closed: make(chan struct{})}
}
func (s *testStream) Read(data []byte) (int, error) { return s.reader.Read(data) }
func (s *testStream) Write(data []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.bytes = append(s.bytes, data...)
	return len(data), nil
}
func (s *testStream) Close() error {
	s.once.Do(func() { close(s.closed); _ = s.reader.Close(); _ = s.writer.Close() })
	return nil
}
func fixture(t *testing.T) (*Broker, *testAuthority, Request) {
	t.Helper()
	req := Request{Target: Target{ConversationID: "conversation", ServerID: "server", EnvironmentID: "environment", PrincipalID: "principal"},
		InstanceID: "instance", ResourceID: "instance", PreparationGenerationID: "preparation", BindingRevision: "binding"}
	authority := &testAuthority{binding: Binding{Request: req, Incarnation: "physical"}, stream: newStream()}
	broker, err := NewBroker(authority)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(broker.Close)
	t.Cleanup(func() { _ = authority.stream.Close() })
	return broker, authority, req
}
func waitFor(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("condition not reached")
}
func TestIssueAuthorityAndQuota(t *testing.T) {
	b, a, req := fixture(t)
	for _, mutate := range []func(*Request){func(r *Request) { r.Target.PrincipalID = "other" }, func(r *Request) { r.InstanceID = "other" },
		func(r *Request) { r.PreparationGenerationID = "physical" }, func(r *Request) { r.BindingRevision = "old" }} {
		wrong := req
		mutate(&wrong)
		if _, err := b.Issue(context.Background(), "principal", wrong); err == nil {
			t.Fatal("wrong authority accepted")
		}
	}
	for range 4 {
		if _, err := b.Issue(context.Background(), "principal", req); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := b.Issue(context.Background(), "principal", req); err == nil {
		t.Fatal("quota not enforced")
	}
	if a.opens != 0 {
		t.Fatal("issuing credential must not open media")
	}
}
func TestClaimIdentityReplayAndBindingChange(t *testing.T) {
	b, a, req := fixture(t)
	credential, _ := b.Issue(context.Background(), "principal", req)
	if _, _, err := b.claim(context.Background(), "other", credential.AttachmentID, credential.Ticket); err == nil {
		t.Fatal("wrong principal accepted")
	}
	if _, _, err := b.claim(context.Background(), "principal", credential.AttachmentID, "wrong"); err == nil {
		t.Fatal("wrong ticket accepted")
	}
	attachment, stream, err := b.claim(context.Background(), "principal", credential.AttachmentID, credential.Ticket)
	if err != nil || stream.Stream != a.stream {
		t.Fatal("valid claim failed", err)
	}
	if attachment.ctx.Err() != nil {
		t.Fatal("opening cancellation leaked into attachment")
	}
	if _, _, err := b.claim(context.Background(), "principal", credential.AttachmentID, credential.Ticket); err == nil {
		t.Fatal("ticket replay accepted")
	}
	_ = stream.Stream.Close()
	b.retire(attachment)
	credential, _ = b.Issue(context.Background(), "principal", req)
	a.mu.Lock()
	a.binding.Incarnation = "successor"
	a.mu.Unlock()
	if _, _, err := b.claim(context.Background(), "principal", credential.AttachmentID, credential.Ticket); err == nil {
		t.Fatal("physical replacement accepted")
	}
}
func TestLateOpeningAndWrongIncarnationAreClosed(t *testing.T) {
	for _, cancelled := range []bool{false, true} {
		t.Run(map[bool]string{false: "wrong", true: "cancelled"}[cancelled], func(t *testing.T) {
			b, a, req := fixture(t)
			credential, _ := b.Issue(context.Background(), "principal", req)
			a.open = func(_ context.Context, _ context.Context, binding Binding) (VerifiedStream, error) {
				if cancelled {
					b.Release("principal", credential.AttachmentID)
				} else {
					binding.Incarnation = "wrong"
				}
				return VerifiedStream{Binding: binding, Stream: a.stream}, nil
			}
			if _, _, err := b.claim(context.Background(), "principal", credential.AttachmentID, credential.Ticket); err == nil {
				t.Fatal("late/wrong stream accepted")
			}
			select {
			case <-a.stream.closed:
			default:
				t.Fatal("stream leaked")
			}
		})
	}
}
func TestTicketExpiryReleasesQuotaAndOldTimerCannotRetireClaim(t *testing.T) {
	b, _, req := fixture(t)
	b.ticketTTL = 10 * time.Millisecond
	first, _ := b.Issue(context.Background(), "principal", req)
	waitFor(t, func() bool { b.mu.Lock(); defer b.mu.Unlock(); return b.attachments[first.AttachmentID] == nil })
	second, _ := b.Issue(context.Background(), "principal", req)
	a, _, err := b.claim(context.Background(), "principal", second.AttachmentID, second.Ticket)
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(15 * time.Millisecond)
	b.expire(a)
	if a.ctx.Err() != nil {
		t.Fatal("old ticket expiry retired a claimed viewer")
	}
}
func server(t *testing.T, b *Broker) *httptest.Server {
	t.Helper()
	s := httptest.NewServer(Handler{Broker: b, Origin: "https://workbench.test", Authenticate: func(r *http.Request) (string, error) {
		if r.Header.Get("Authorization") != "Synthetic principal" {
			return "", errors.New("unauthenticated")
		}
		return "principal", nil
	}})
	t.Cleanup(s.Close)
	return s
}
func connect(t *testing.T, s *httptest.Server, c Credential) *websocket.Conn {
	t.Helper()
	headers := http.Header{"Origin": []string{"https://workbench.test"}, "Authorization": []string{"Synthetic principal"}}
	ws, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(s.URL, "http")+"/desktop/connect", headers)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ws.Close() })
	_ = ws.SetReadDeadline(time.Now().Add(2 * time.Second))
	if err := ws.WriteJSON(wireMessage{Event: "desktop/attach", Version: 1, AttachmentID: c.AttachmentID, Ticket: c.Ticket}); err != nil {
		t.Fatal(err)
	}
	return ws
}
func readEvent(t *testing.T, ws *websocket.Conn, event string) wireMessage {
	t.Helper()
	var msg wireMessage
	if err := ws.ReadJSON(&msg); err != nil {
		t.Fatal(err)
	}
	if msg.Event != event {
		t.Fatalf("event %q, wanted %q", msg.Event, event)
	}
	return msg
}
func TestHTTPIdentityOriginBodyAndNoStore(t *testing.T) {
	b, _, req := fixture(t)
	s := server(t, b)
	for _, tc := range []struct {
		auth, origin, body string
		status             int
	}{
		{"", "", "{}", 401}, {"Synthetic principal", "https://evil.test", "{}", 403},
		{"Synthetic principal", "", "{\"unknown\":1}", 400}, {"Synthetic principal", "", strings.Repeat("x", 9000), 400},
	} {
		r, _ := http.NewRequest(http.MethodPost, s.URL+"/desktop/attachments", strings.NewReader(tc.body))
		r.Header.Set("Authorization", tc.auth)
		r.Header.Set("Origin", tc.origin)
		response, err := http.DefaultClient.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		_ = response.Body.Close()
		if response.StatusCode != tc.status || response.Header.Get("Cache-Control") != "no-store" {
			t.Fatal("unexpected response", response.StatusCode)
		}
	}
	data, _ := json.Marshal(req)
	r, _ := http.NewRequest(http.MethodPost, s.URL+"/desktop/attachments", bytes.NewReader(data))
	r.Header.Set("Authorization", "Synthetic principal")
	response, err := http.DefaultClient.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var envelope struct {
		Code string     `json:"code"`
		Data Credential `json:"data"`
	}
	if err := json.NewDecoder(response.Body).Decode(&envelope); err != nil || envelope.Data.Version != 1 || envelope.Code != "OK" {
		t.Fatal("credential DTO", err)
	}
	headers := http.Header{"Origin": []string{"https://workbench.test"}, "Authorization": []string{"Synthetic principal"}}
	_, denied, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(s.URL, "http")+"/desktop/connect?ticket=forbidden", headers)
	if err == nil || denied.StatusCode != 403 {
		t.Fatal("URL credential accepted")
	}
	_ = denied.Body.Close()
}
func TestBinaryMediaObserveOnlyAndRevocation(t *testing.T) {
	b, a, req := fixture(t)
	s := server(t, b)
	c, _ := b.Issue(context.Background(), "principal", req)
	ws := connect(t, s, c)
	ready := readEvent(t, ws, "desktop/ready")
	if ready.ControlAvailable == nil || *ready.ControlAvailable {
		t.Fatal("observer advertised control")
	}
	_ = ws.WriteJSON(wireMessage{Event: "control/request", RequestID: "1"})
	readEvent(t, ws, "control/denied")
	data := bytes.Repeat([]byte{0, 1, 255, 9}, 1<<16)
	go func() { _, _ = a.stream.writer.Write(data) }()
	var received []byte
	for len(received) < len(data) {
		kind, chunk, err := ws.ReadMessage()
		if err != nil || kind != websocket.BinaryMessage {
			t.Fatal("media", err)
		}
		received = append(received, chunk...)
	}
	if !bytes.Equal(received, data) {
		t.Fatal("binary bytes changed")
	}
	b.Revoke(req.Target)
	if _, _, err := ws.ReadMessage(); err == nil {
		t.Fatal("revocation did not close viewer")
	}
	select {
	case <-a.stream.closed:
	default:
		t.Fatal("physical stream leaked")
	}
}

func TestBrowserSocketUsesScopedTicketWithoutHTTPBearer(t *testing.T) {
	b, _, req := fixture(t)
	b.checkInterval = 5 * time.Millisecond
	s := server(t, b)
	credential, _ := b.Issue(context.Background(), "principal", req)
	ws, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(s.URL, "http")+"/desktop/connect",
		http.Header{"Origin": []string{"https://workbench.test"}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ws.Close() })
	_ = ws.SetReadDeadline(time.Now().Add(time.Second))
	_ = ws.WriteJSON(wireMessage{Event: "desktop/attach", Version: 1, AttachmentID: credential.AttachmentID, Ticket: credential.Ticket})
	readEvent(t, ws, "desktop/ready")
	// Revalidation must use the ticket's bound principal, not an empty header.
	time.Sleep(15 * time.Millisecond)
	_ = ws.WriteJSON(wireMessage{Event: "control/request", RequestID: "1"})
	readEvent(t, ws, "control/denied")
}

func TestWSSAndAdditionalSocketIdentity(t *testing.T) {
	for _, mismatch := range []bool{false, true} {
		t.Run(map[bool]string{false: "trusted-wss", true: "identity-mismatch"}[mismatch], func(t *testing.T) {
			b, a, req := fixture(t)
			handler := Handler{Broker: b, Origin: "https://workbench.test", Authenticate: func(*http.Request) (string, error) { return "principal", nil }}
			if mismatch {
				handler.SocketPrincipal = func(*http.Request) (string, error) { return "other", nil }
			}
			s := httptest.NewTLSServer(handler)
			t.Cleanup(s.Close)
			credential, _ := b.Issue(context.Background(), "principal", req)
			dialer := websocket.Dialer{TLSClientConfig: s.Client().Transport.(*http.Transport).TLSClientConfig}
			ws, _, err := dialer.Dial("wss"+strings.TrimPrefix(s.URL, "https")+"/desktop/connect", http.Header{"Origin": []string{"https://workbench.test"}})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = ws.Close() })
			_ = ws.SetReadDeadline(time.Now().Add(time.Second))
			_ = ws.WriteJSON(wireMessage{Event: "desktop/attach", Version: 1, AttachmentID: credential.AttachmentID, Ticket: credential.Ticket})
			if mismatch {
				if _, _, err := ws.ReadMessage(); err == nil {
					t.Fatal("identity mismatch accepted")
				}
				if a.opens != 0 {
					t.Fatal("wrong principal opened media")
				}
				return
			}
			readEvent(t, ws, "desktop/ready")
			data := []byte{0, 255, 1, 10}
			go func() { _, _ = a.stream.writer.Write(data) }()
			kind, got, err := ws.ReadMessage()
			if err != nil || kind != websocket.BinaryMessage || !bytes.Equal(data, got) {
				t.Fatal("WSS media mismatch", err)
			}
		})
	}
}

func TestCloseOneViewerDoesNotCloseSiblingOrResource(t *testing.T) {
	b, a, req := fixture(t)
	first, second := newStream(), newStream()
	t.Cleanup(func() { _ = first.Close(); _ = second.Close() })
	opened := 0
	a.open = func(_ context.Context, _ context.Context, binding Binding) (VerifiedStream, error) {
		opened++
		stream := first
		if opened == 2 {
			stream = second
		}
		return VerifiedStream{Binding: binding, Stream: stream}, nil
	}
	s := server(t, b)
	credential, _ := b.Issue(context.Background(), "principal", req)
	one := connect(t, s, credential)
	readEvent(t, one, "desktop/ready")
	credential, _ = b.Issue(context.Background(), "principal", req)
	two := connect(t, s, credential)
	readEvent(t, two, "desktop/ready")
	_ = one.Close()
	waitFor(t, func() bool {
		select {
		case <-first.closed:
			return true
		default:
			return false
		}
	})
	select {
	case <-second.closed:
		t.Fatal("sibling closed")
	default:
	}
	_ = two.WriteJSON(wireMessage{Event: "control/request", RequestID: "1"})
	readEvent(t, two, "control/denied")
	// Resource teardown is deliberately absent from the broker's authority port.
}

func TestSocketAdmissionBoundAndRelease(t *testing.T) {
	b, _, _ := fixture(t)
	var releases []func()
	for range 4 {
		release, ok := b.reserveSocket("principal")
		if !ok {
			t.Fatal("premature quota")
		}
		releases = append(releases, release)
	}
	if _, ok := b.reserveSocket("principal"); ok {
		t.Fatal("socket quota not enforced")
	}
	for _, release := range releases {
		release()
	}
	for range 128 {
		release, ok := b.reserveSocket("")
		if !ok {
			t.Fatal("premature unclaimed quota")
		}
		defer release()
	}
	if _, ok := b.reserveSocket(""); ok {
		t.Fatal("unclaimed handshake quota not enforced")
	}
}

type testGrant struct {
	done     chan struct{}
	once     sync.Once
	released chan struct{}
}

func newGrant() *testGrant {
	return &testGrant{done: make(chan struct{}), released: make(chan struct{})}
}
func (g *testGrant) Done() <-chan struct{} { return g.done }
func (g *testGrant) Release(context.Context) error {
	g.once.Do(func() { close(g.released) })
	return nil
}

type testController struct {
	entered chan struct{}
	result  chan *testGrant
}

func (c *testController) Acquire(context.Context) (Grant, error) {
	c.entered <- struct{}{}
	return <-c.result, nil
}
func TestControlCancelledLateGrantAndRemoteRevoke(t *testing.T) {
	b, a, req := fixture(t)
	controller := &testController{entered: make(chan struct{}, 2), result: make(chan *testGrant)}
	a.control = controller
	s := server(t, b)
	credential, _ := b.Issue(context.Background(), "principal", req)
	ws := connect(t, s, credential)
	ready := readEvent(t, ws, "desktop/ready")
	if ready.ControlAvailable == nil || !*ready.ControlAvailable {
		t.Fatal("executor not advertised")
	}
	_ = ws.WriteJSON(wireMessage{Event: "control/request", RequestID: "1"})
	<-controller.entered
	_ = ws.WriteJSON(wireMessage{Event: "control/release", RequestID: "1"})
	// Use a distinct request as an ordering barrier for the received release.
	_ = ws.WriteJSON(wireMessage{Event: "control/request", RequestID: "2"})
	<-controller.entered
	late := newGrant()
	controller.result <- late
	// Either acquisition goroutine may receive the first result. Return two
	// independent grants, then assert exactly one confirmation for request 2.
	current := newGrant()
	controller.result <- current
	locked := readEvent(t, ws, "control/locked")
	if locked.RequestID != "2" {
		t.Fatal("cancelled grant confirmed")
	}
	waitFor(t, func() bool {
		select {
		case <-late.released:
			return true
		case <-current.released:
			return true
		default:
			return false
		}
	})
	var active *testGrant
	select {
	case <-late.released:
		active = current
	default:
		active = late
	}
	close(active.done)
	revoked := readEvent(t, ws, "control/release")
	if revoked.RequestID != "2" {
		t.Fatal("wrong revocation")
	}
	waitFor(t, func() bool {
		select {
		case <-active.released:
			return true
		default:
			return false
		}
	})
}
func TestAuthorityChangeAndAttachmentExpiryRetireTransport(t *testing.T) {
	for _, expiry := range []bool{false, true} {
		t.Run(map[bool]string{false: "binding", true: "expiry"}[expiry], func(t *testing.T) {
			b, a, req := fixture(t)
			b.checkInterval = 5 * time.Millisecond
			if expiry {
				b.lifetime = 30 * time.Millisecond
			}
			s := server(t, b)
			credential, _ := b.Issue(context.Background(), "principal", req)
			ws := connect(t, s, credential)
			readEvent(t, ws, "desktop/ready")
			if !expiry {
				a.mu.Lock()
				a.binding.BindingRevision = "changed"
				a.mu.Unlock()
			}
			if _, _, err := ws.ReadMessage(); err == nil {
				t.Fatal("invalidated viewer stayed connected")
			}
			waitFor(t, func() bool {
				select {
				case <-a.stream.closed:
					return true
				default:
					return false
				}
			})
		})
	}
}
