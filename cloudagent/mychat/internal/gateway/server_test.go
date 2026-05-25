package gateway

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"
)

func TestAppWebSocketInitializesFakeACP(t *testing.T) {
	if os.Getenv("MYCHAT_FAKE_ACP") == "1" {
		runFakeACPAgent()
		return
	}

	command := []string{os.Args[0], "-test.run=TestAppWebSocketInitializesFakeACP"}
	t.Setenv("MYCHAT_FAKE_ACP", "1")
	server := &Server{cfg: Config{Addr: "127.0.0.1:0", Command: command}}
	mux := http.NewServeMux()
	server.routes(mux)
	ts := httptest.NewServer(withCORS(mux))
	defer ts.Close()

	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws"
	client := dialTestWS(t, wsURL)
	defer client.close()

	client.writeJSON(t, map[string]any{
		"type": "acp",
		"message": map[string]any{
			"jsonrpc": "2.0",
			"id":      1,
			"method":  "initialize",
			"params": map[string]any{
				"protocolVersion":    1,
				"clientInfo":         map[string]any{"name": "test", "version": "0.1.0"},
				"clientCapabilities": map[string]any{},
			},
		},
	})
	waitForACPResult(t, client, float64(1))

	client.writeJSON(t, map[string]any{
		"type": "acp",
		"message": map[string]any{
			"jsonrpc": "2.0",
			"id":      2,
			"method":  "session/new",
			"params":  map[string]any{"cwd": "/tmp", "mcpServers": []any{}},
		},
	})
	result := waitForACPResult(t, client, float64(2))
	payload := result["message"].(map[string]any)
	body := payload["result"].(map[string]any)
	if body["sessionId"] != "fake-session-1" {
		t.Fatalf("unexpected session id: %#v", body["sessionId"])
	}
}

func TestRawACPDoesNotEnvelopeStderr(t *testing.T) {
	if os.Getenv("MYCHAT_FAKE_ACP_STDERR") == "1" {
		runFakeACPStderrAgent()
		return
	}
	command := []string{os.Args[0], "-test.run=TestRawACPDoesNotEnvelopeStderr"}
	t.Setenv("MYCHAT_FAKE_ACP_STDERR", "1")
	server := &Server{cfg: Config{Addr: "127.0.0.1:0", Command: command}}
	mux := http.NewServeMux()
	server.routes(mux)
	ts := httptest.NewServer(withCORS(mux))
	defer ts.Close()

	client := dialTestWS(t, "ws"+strings.TrimPrefix(ts.URL, "http")+"/acp")
	defer client.close()
	client.writeMasked(t, []byte(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`))
	_, payload, err := client.readFrame()
	if err != nil {
		t.Fatal(err)
	}
	var response map[string]any
	if err := json.Unmarshal(payload, &response); err != nil {
		t.Fatal(err)
	}
	if response["jsonrpc"] != "2.0" || response["id"] != float64(1) {
		t.Fatalf("raw /acp returned non-JSON-RPC payload: %s", string(payload))
	}
}

func TestFileAPIProxyForwardsV1Requests(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/files" {
			t.Fatalf("unexpected upstream path: %s", r.URL.Path)
		}
		if r.Header.Get("X-Tenant-ID") != "tenant-a" || r.Header.Get("X-Project-ID") != "project-a" {
			t.Fatalf("missing scoped headers: %#v", r.Header)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"file_1"}`))
	}))
	defer upstream.Close()

	server := &Server{cfg: Config{
		Addr:           "127.0.0.1:0",
		Command:        []string{"fake", "acp"},
		FileAPIBaseURL: upstream.URL,
	}}
	mux := http.NewServeMux()
	server.routes(mux)
	ts := httptest.NewServer(withCORS(mux))
	defer ts.Close()

	req, err := http.NewRequest(http.MethodPost, ts.URL+"/v1/files", strings.NewReader("body"))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("X-Tenant-ID", "tenant-a")
	req.Header.Set("X-Project-ID", "project-a")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK || !strings.Contains(string(body), "file_1") {
		t.Fatalf("unexpected proxy response status=%d body=%s", resp.StatusCode, string(body))
	}
}

func TestWebSocketAuthorizationAndOriginMatrix(t *testing.T) {
	t.Setenv("MYCHAT_FAKE_ACP", "1")
	command := []string{os.Args[0], "-test.run=TestAppWebSocketInitializesFakeACP"}
	server := &Server{cfg: Config{Addr: "127.0.0.1:0", Command: command, Token: "secret"}}
	mux := http.NewServeMux()
	server.routes(mux)
	ts := httptest.NewServer(withCORS(mux))
	defer ts.Close()

	for _, path := range []string{"/ws", "/acp"} {
		if got := requestWSHandshakeStatus(t, ts.URL, path, "", ""); got != http.StatusUnauthorized {
			t.Fatalf("%s missing token status = %d, want %d", path, got, http.StatusUnauthorized)
		}
		if got := requestWSHandshakeStatus(t, ts.URL, path+"?token=secret", "", ""); got != http.StatusSwitchingProtocols {
			t.Fatalf("%s query token status = %d, want %d", path, got, http.StatusSwitchingProtocols)
		}
		if got := requestWSHandshakeStatus(t, ts.URL, path, "X-MyChat-Token", "secret"); got != http.StatusSwitchingProtocols {
			t.Fatalf("%s header token status = %d, want %d", path, got, http.StatusSwitchingProtocols)
		}
	}
}

func TestLoopbackWebSocketRejectsForeignBrowserOrigin(t *testing.T) {
	t.Setenv("MYCHAT_FAKE_ACP", "1")
	command := []string{os.Args[0], "-test.run=TestAppWebSocketInitializesFakeACP"}
	server := &Server{cfg: Config{Addr: "127.0.0.1:0", Command: command}}
	mux := http.NewServeMux()
	server.routes(mux)
	ts := httptest.NewServer(withCORS(mux))
	defer ts.Close()

	if got := requestWSHandshakeStatus(t, ts.URL, "/ws", "Origin", "https://evil.example"); got != http.StatusForbidden {
		t.Fatalf("foreign origin status = %d, want %d", got, http.StatusForbidden)
	}
	if got := requestWSHandshakeStatus(t, ts.URL, "/ws", "Origin", "http://127.0.0.1:5173"); got != http.StatusSwitchingProtocols {
		t.Fatalf("loopback origin status = %d, want %d", got, http.StatusSwitchingProtocols)
	}
}

func TestAppWebSocketRejectsInvalidFrameAndStaysOpen(t *testing.T) {
	if os.Getenv("MYCHAT_FAKE_ACP") == "1" {
		runFakeACPAgent()
		return
	}

	command := []string{os.Args[0], "-test.run=TestAppWebSocketRejectsInvalidFrameAndStaysOpen"}
	t.Setenv("MYCHAT_FAKE_ACP", "1")
	server := &Server{cfg: Config{Addr: "127.0.0.1:0", Command: command}}
	mux := http.NewServeMux()
	server.routes(mux)
	ts := httptest.NewServer(withCORS(mux))
	defer ts.Close()

	client := dialTestWS(t, "ws"+strings.TrimPrefix(ts.URL, "http")+"/ws")
	defer client.close()

	client.writeMasked(t, []byte(`{"method":"initialize","params":{}}`))
	envelope := waitForEnvelopeType(t, client, "error")
	errBody := envelope["error"].(map[string]any)
	if errBody["code"] != "bad_request" || errBody["kind"] != "invalid_jsonrpc" {
		t.Fatalf("unexpected error envelope: %#v", envelope)
	}

	client.writeJSON(t, map[string]any{
		"type": "acp",
		"message": map[string]any{
			"jsonrpc": "2.0",
			"id":      1,
			"method":  "initialize",
			"params":  map[string]any{},
		},
	})
	waitForACPResult(t, client, float64(1))
}

func TestAppWebSocketForwardsStderrEnvelope(t *testing.T) {
	if os.Getenv("MYCHAT_FAKE_ACP_STDERR") == "1" {
		runFakeACPStderrAgent()
		return
	}
	command := []string{os.Args[0], "-test.run=TestAppWebSocketForwardsStderrEnvelope"}
	t.Setenv("MYCHAT_FAKE_ACP_STDERR", "1")
	server := &Server{cfg: Config{Addr: "127.0.0.1:0", Command: command}}
	mux := http.NewServeMux()
	server.routes(mux)
	ts := httptest.NewServer(withCORS(mux))
	defer ts.Close()

	client := dialTestWS(t, "ws"+strings.TrimPrefix(ts.URL, "http")+"/ws")
	defer client.close()
	envelope := waitForEnvelopeType(t, client, "stderr")
	if envelope["line"] != "stderr noise" {
		t.Fatalf("unexpected stderr envelope: %#v", envelope)
	}
}

func TestAppWebSocketReportsAgentStdoutClosed(t *testing.T) {
	if os.Getenv("MYCHAT_FAKE_ACP_EXIT") == "1" {
		return
	}
	command := []string{os.Args[0], "-test.run=TestAppWebSocketReportsAgentStdoutClosed"}
	t.Setenv("MYCHAT_FAKE_ACP_EXIT", "1")
	server := &Server{cfg: Config{Addr: "127.0.0.1:0", Command: command}}
	mux := http.NewServeMux()
	server.routes(mux)
	ts := httptest.NewServer(withCORS(mux))
	defer ts.Close()

	client := dialTestWS(t, "ws"+strings.TrimPrefix(ts.URL, "http")+"/ws")
	defer client.close()
	envelope := waitForEnvelopeType(t, client, "error")
	errBody := envelope["error"].(map[string]any)
	if errBody["code"] != "agent" || errBody["kind"] != "stdout_closed" {
		t.Fatalf("unexpected agent exit envelope: %#v", envelope)
	}
}

func TestMain(m *testing.M) {
	if os.Getenv("MYCHAT_FAKE_ACP") == "1" {
		runFakeACPAgent()
		return
	}
	if os.Getenv("MYCHAT_FAKE_ACP_EXIT") == "1" {
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func runFakeACPAgent() {
	scanner := bufio.NewScanner(os.Stdin)
	encoder := json.NewEncoder(os.Stdout)
	for scanner.Scan() {
		var request struct {
			ID     any    `json:"id"`
			Method string `json:"method"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &request); err != nil {
			continue
		}
		switch request.Method {
		case "initialize":
			_ = encoder.Encode(map[string]any{
				"jsonrpc": "2.0",
				"id":      request.ID,
				"result": map[string]any{
					"protocolVersion": 1,
					"agentCapabilities": map[string]any{
						"loadSession": false,
					},
				},
			})
		case "session/new":
			_ = encoder.Encode(map[string]any{
				"jsonrpc": "2.0",
				"id":      request.ID,
				"result": map[string]any{
					"sessionId":     "fake-session-1",
					"configOptions": []any{},
				},
			})
		default:
			_ = encoder.Encode(map[string]any{
				"jsonrpc": "2.0",
				"id":      request.ID,
				"error":   map[string]any{"code": -32601, "message": "method not found"},
			})
		}
	}
}

func runFakeACPStderrAgent() {
	fmt.Fprintln(os.Stderr, "stderr noise")
	encoder := json.NewEncoder(os.Stdout)
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		var request struct {
			ID any `json:"id"`
		}
		_ = json.Unmarshal(scanner.Bytes(), &request)
		_ = encoder.Encode(map[string]any{"jsonrpc": "2.0", "id": request.ID, "result": map[string]any{"ok": true}})
	}
}

type testWSClient struct {
	conn net.Conn
	br   *bufio.Reader
}

func dialTestWS(t *testing.T, rawURL string) *testWSClient {
	t.Helper()
	parsed, err := url.Parse(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var d net.Dialer
	conn, err := d.DialContext(ctx, "tcp", parsed.Host)
	if err != nil {
		t.Fatal(err)
	}
	keyBytes := make([]byte, 16)
	if _, err := rand.Read(keyBytes); err != nil {
		t.Fatal(err)
	}
	key := base64.StdEncoding.EncodeToString(keyBytes)
	path := parsed.RequestURI()
	if path == "" {
		path = "/"
	}
	request := fmt.Sprintf("GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: %s\r\n\r\n", path, parsed.Host, key)
	if _, err := conn.Write([]byte(request)); err != nil {
		t.Fatal(err)
	}
	br := bufio.NewReader(conn)
	response, err := http.ReadResponse(br, &http.Request{Method: http.MethodGet})
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("unexpected status: %s", response.Status)
	}
	if got, want := response.Header.Get("Sec-WebSocket-Accept"), testAccept(key); got != want {
		t.Fatalf("bad accept: got %q want %q", got, want)
	}
	return &testWSClient{conn: conn, br: br}
}

func requestWSHandshakeStatus(t *testing.T, baseURL string, path string, headerKey string, headerValue string) int {
	t.Helper()
	parsed, err := url.Parse(baseURL)
	if err != nil {
		t.Fatal(err)
	}
	conn, err := net.Dial("tcp", parsed.Host)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	keyBytes := make([]byte, 16)
	if _, err := rand.Read(keyBytes); err != nil {
		t.Fatal(err)
	}
	key := base64.StdEncoding.EncodeToString(keyBytes)
	extraHeader := ""
	if headerKey != "" {
		extraHeader = fmt.Sprintf("%s: %s\r\n", headerKey, headerValue)
	}
	request := fmt.Sprintf("GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: %s\r\n%s\r\n", path, parsed.Host, key, extraHeader)
	if _, err := conn.Write([]byte(request)); err != nil {
		t.Fatal(err)
	}
	br := bufio.NewReader(conn)
	response, err := http.ReadResponse(br, &http.Request{Method: http.MethodGet})
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	return response.StatusCode
}

func (c *testWSClient) close() {
	_ = c.conn.Close()
}

func (c *testWSClient) writeJSON(t *testing.T, value any) {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	c.writeMasked(t, data)
}

func (c *testWSClient) writeMasked(t *testing.T, payload []byte) {
	t.Helper()
	mask := make([]byte, 4)
	if _, err := rand.Read(mask); err != nil {
		t.Fatal(err)
	}
	header := []byte{0x81}
	length := len(payload)
	switch {
	case length < 126:
		header = append(header, 0x80|byte(length))
	case length <= 65535:
		header = append(header, 0x80|126, byte(length>>8), byte(length))
	default:
		t.Fatalf("payload too large")
	}
	frame := append(header, mask...)
	for i, b := range payload {
		frame = append(frame, b^mask[i%4])
	}
	if _, err := c.conn.Write(frame); err != nil {
		t.Fatal(err)
	}
}

func (c *testWSClient) readJSON(t *testing.T) map[string]any {
	t.Helper()
	opcode, payload, err := c.readFrame()
	if err != nil {
		t.Fatal(err)
	}
	if opcode != 0x1 {
		t.Fatalf("expected text frame, got opcode %d", opcode)
	}
	var value map[string]any
	if err := json.Unmarshal(payload, &value); err != nil {
		t.Fatalf("bad json %s: %v", string(payload), err)
	}
	return value
}

func (c *testWSClient) readFrame() (byte, []byte, error) {
	header := make([]byte, 2)
	if _, err := io.ReadFull(c.br, header); err != nil {
		return 0, nil, err
	}
	opcode := header[0] & 0x0F
	length := uint64(header[1] & 0x7F)
	switch length {
	case 126:
		var ext [2]byte
		if _, err := io.ReadFull(c.br, ext[:]); err != nil {
			return 0, nil, err
		}
		length = uint64(binary.BigEndian.Uint16(ext[:]))
	case 127:
		return 0, nil, fmt.Errorf("test frame too large")
	}
	payload := make([]byte, length)
	if _, err := io.ReadFull(c.br, payload); err != nil {
		return 0, nil, err
	}
	return opcode, payload, nil
}

func waitForACPResult(t *testing.T, client *testWSClient, id float64) map[string]any {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		envelope := client.readJSON(t)
		if envelope["type"] != "acp" || envelope["direction"] != "recv" {
			continue
		}
		message, ok := envelope["message"].(map[string]any)
		if !ok {
			continue
		}
		if message["id"] == id {
			return envelope
		}
	}
	t.Fatalf("timed out waiting for ACP result id %v", id)
	return nil
}

func waitForEnvelopeType(t *testing.T, client *testWSClient, envelopeType string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		envelope := client.readJSON(t)
		if envelope["type"] == envelopeType {
			return envelope
		}
	}
	t.Fatalf("timed out waiting for envelope type %q", envelopeType)
	return nil
}

func testAccept(key string) string {
	sum := sha1.Sum([]byte(key + websocketGUID))
	return base64.StdEncoding.EncodeToString(sum[:])
}
