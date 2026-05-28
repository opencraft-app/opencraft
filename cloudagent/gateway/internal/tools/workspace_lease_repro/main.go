package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha1"
	"crypto/tls"
	"database/sql"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

const websocketGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

type rpcClient struct {
	conn net.Conn
	br   *bufio.Reader
	next int
}

func main() {
	log.SetFlags(0)
	mode := flag.String("mode", "", "create-session, list-session, prompt, close-session, load-disconnect, concurrent-ensure-ready, seed-lease, assert-held, assert-stealable")
	acpURL := flag.String("acp-url", "", "ACP websocket or HTTP URL")
	acpURLB := flag.String("acp-url-b", "", "second ACP websocket or HTTP URL")
	dataDir := flag.String("data-dir", "", "gateway data dir")
	sessionID := flag.String("session-id", "", "ACP session id")
	apiKey := flag.String("api-key", "workspace-lease-repro", "gateway API key")
	ttl := flag.Duration("ttl", 2*time.Second, "seed lease ttl")
	flag.Parse()

	var err error
	switch *mode {
	case "create-session":
		err = createSession(*acpURL, *apiKey)
	case "list-session":
		err = listSession(*acpURL, *apiKey, *sessionID)
	case "prompt":
		err = prompt(*acpURL, *apiKey, *sessionID)
	case "close-session":
		err = closeSession(*acpURL, *apiKey, *sessionID)
	case "load-disconnect":
		err = loadDisconnect(*acpURL, *apiKey, *sessionID)
	case "concurrent-ensure-ready":
		err = concurrentEnsureReady(*acpURL, *acpURLB, *apiKey, *sessionID)
	case "seed-lease":
		err = seedLease(*dataDir, *sessionID, *ttl)
	case "assert-held":
		err = assertHeld(*dataDir, *sessionID)
	case "assert-stealable":
		err = assertStealable(*dataDir, *sessionID)
	default:
		err = fmt.Errorf("unknown -mode %q", *mode)
	}
	if err != nil {
		log.Fatal(err)
	}
}

func createSession(rawURL, apiKey string) error {
	client, err := dial(rawURL, apiKey)
	if err != nil {
		return err
	}
	defer client.close()
	if _, err := client.call("initialize", map[string]any{"protocolVersion": 1, "clientCapabilities": map[string]any{}}); err != nil {
		return err
	}
	result, err := client.call("session/new", map[string]any{
		"cwd": "/workspace",
		"_meta": map[string]any{"cloudagent": map[string]any{
			"outer_runtime": "wisp",
		}},
	})
	if err != nil {
		return err
	}
	var out struct {
		SessionID string `json:"sessionId"`
	}
	if err := json.Unmarshal(result, &out); err != nil {
		return err
	}
	if strings.TrimSpace(out.SessionID) == "" {
		return errors.New("session/new returned empty sessionId")
	}
	fmt.Println(out.SessionID)
	return nil
}

func listSession(rawURL, apiKey, sessionID string) error {
	client, err := dial(rawURL, apiKey)
	if err != nil {
		return err
	}
	defer client.close()
	if _, err := client.call("initialize", map[string]any{"protocolVersion": 1, "clientCapabilities": map[string]any{}}); err != nil {
		return err
	}
	result, err := client.call("session/list", map[string]any{})
	if err != nil {
		return err
	}
	var out struct {
		Sessions []struct {
			SessionID string `json:"sessionId"`
		} `json:"sessions"`
	}
	if err := json.Unmarshal(result, &out); err != nil {
		return err
	}
	for _, session := range out.Sessions {
		if session.SessionID == sessionID {
			fmt.Println(sessionID)
			return nil
		}
	}
	return fmt.Errorf("session %s not visible in session/list", sessionID)
}

func prompt(rawURL, apiKey, sessionID string) error {
	client, err := dial(rawURL, apiKey)
	if err != nil {
		return err
	}
	defer client.close()
	if _, err := client.call("initialize", map[string]any{"protocolVersion": 1, "clientCapabilities": map[string]any{}}); err != nil {
		return err
	}
	result, err := client.call("session/prompt", map[string]any{
		"sessionId": sessionID,
		"prompt": []map[string]any{{
			"type": "text",
			"text": "refresh should renew workspace lease",
		}},
	})
	if err != nil {
		return err
	}
	var out struct {
		StopReason string `json:"stopReason"`
	}
	if err := json.Unmarshal(result, &out); err != nil {
		return err
	}
	if out.StopReason != "end_turn" {
		return fmt.Errorf("unexpected stopReason %q", out.StopReason)
	}
	fmt.Println(out.StopReason)
	return nil
}

func closeSession(rawURL, apiKey, sessionID string) error {
	client, err := dial(rawURL, apiKey)
	if err != nil {
		return err
	}
	defer client.close()
	if _, err := client.call("initialize", map[string]any{"protocolVersion": 1, "clientCapabilities": map[string]any{}}); err != nil {
		return err
	}
	if _, err := client.call("session/close", map[string]any{"sessionId": sessionID}); err != nil {
		return err
	}
	fmt.Println("closed")
	return nil
}

func loadDisconnect(rawURL, apiKey, sessionID string) error {
	client, err := dial(rawURL, apiKey)
	if err != nil {
		return err
	}
	defer client.close()
	if _, err := client.call("initialize", map[string]any{"protocolVersion": 1, "clientCapabilities": map[string]any{}}); err != nil {
		return err
	}
	if _, err := client.call("session/load", map[string]any{"sessionId": sessionID}); err != nil {
		return err
	}
	fmt.Println("loaded_then_disconnected")
	return nil
}

func concurrentEnsureReady(rawURLA, rawURLB, apiKey, sessionID string) error {
	if strings.TrimSpace(rawURLA) == "" || strings.TrimSpace(rawURLB) == "" {
		return errors.New("acp-url and acp-url-b are required")
	}
	type result struct {
		name string
		err  error
	}
	results := make(chan result, 2)
	for _, item := range []struct {
		name string
		url  string
	}{{name: "a", url: rawURLA}, {name: "b", url: rawURLB}} {
		item := item
		go func() {
			results <- result{name: item.name, err: ensureReady(item.url, apiKey, sessionID)}
		}()
	}
	var successes int
	var ownershipFailures int
	var errorsText []string
	for i := 0; i < 2; i++ {
		res := <-results
		if res.err == nil {
			successes++
			continue
		}
		text := res.err.Error()
		errorsText = append(errorsText, res.name+": "+text)
		if strings.Contains(text, "runtime ownership") || strings.Contains(text, "ownership") || strings.Contains(text, "held") {
			ownershipFailures++
		}
	}
	if successes != 1 || ownershipFailures != 1 {
		return fmt.Errorf("expected one ensure_ready success and one ownership failure, successes=%d ownership_failures=%d errors=%s", successes, ownershipFailures, strings.Join(errorsText, " | "))
	}
	fmt.Println("concurrent_ensure_ready_single_owner")
	return nil
}

func ensureReady(rawURL, apiKey, sessionID string) error {
	client, err := dial(rawURL, apiKey)
	if err != nil {
		return err
	}
	defer client.close()
	if _, err := client.call("initialize", map[string]any{"protocolVersion": 1, "clientCapabilities": map[string]any{}}); err != nil {
		return err
	}
	_, err = client.call("_cloudagent.runtime.ensure_ready", map[string]any{"session_id": sessionID, "cwd": "/workspace"})
	return err
}

func dial(rawURL, apiKey string) (*rpcClient, error) {
	wsURL, err := normalizeACPURL(rawURL)
	if err != nil {
		return nil, err
	}
	parsed, err := url.Parse(wsURL)
	if err != nil {
		return nil, err
	}
	host := parsed.Host
	if !strings.Contains(host, ":") {
		if parsed.Scheme == "wss" {
			host += ":443"
		} else {
			host += ":80"
		}
	}
	var conn net.Conn
	if parsed.Scheme == "wss" {
		conn, err = tls.Dial("tcp", host, &tls.Config{ServerName: parsed.Hostname()})
	} else {
		conn, err = net.Dial("tcp", host)
	}
	if err != nil {
		return nil, err
	}
	key, err := websocketKey()
	if err != nil {
		_ = conn.Close()
		return nil, err
	}
	path := parsed.RequestURI()
	if path == "" {
		path = "/"
	}
	var builder strings.Builder
	builder.WriteString(fmt.Sprintf("GET %s HTTP/1.1\r\n", path))
	builder.WriteString(fmt.Sprintf("Host: %s\r\n", parsed.Host))
	builder.WriteString("Upgrade: websocket\r\n")
	builder.WriteString("Connection: Upgrade\r\n")
	builder.WriteString("Sec-WebSocket-Version: 13\r\n")
	builder.WriteString(fmt.Sprintf("Sec-WebSocket-Key: %s\r\n", key))
	if apiKey != "" {
		builder.WriteString(fmt.Sprintf("Authorization: Bearer %s\r\n", apiKey))
	}
	builder.WriteString("\r\n")
	if _, err := conn.Write([]byte(builder.String())); err != nil {
		_ = conn.Close()
		return nil, err
	}
	br := bufio.NewReader(conn)
	resp, err := http.ReadResponse(br, &http.Request{Method: http.MethodGet})
	if err != nil {
		_ = conn.Close()
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusSwitchingProtocols {
		_ = conn.Close()
		return nil, fmt.Errorf("websocket upgrade failed: %s", resp.Status)
	}
	if got, want := resp.Header.Get("Sec-WebSocket-Accept"), websocketAccept(key); got != want {
		_ = conn.Close()
		return nil, fmt.Errorf("websocket upgrade accept mismatch")
	}
	return &rpcClient{conn: conn, br: br}, nil
}

func normalizeACPURL(raw string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return "", err
	}
	switch parsed.Scheme {
	case "http":
		parsed.Scheme = "ws"
	case "https":
		parsed.Scheme = "wss"
	case "ws", "wss":
	default:
		return "", fmt.Errorf("unsupported ACP URL scheme %q", parsed.Scheme)
	}
	if parsed.Path == "" || parsed.Path == "/" {
		parsed.Path = "/acp"
	}
	return parsed.String(), nil
}

func (c *rpcClient) call(method string, params any) (json.RawMessage, error) {
	c.next++
	id := c.next
	req := map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params}
	if err := c.writeJSON(req); err != nil {
		return nil, err
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		if err := c.conn.SetReadDeadline(deadline); err != nil {
			return nil, err
		}
		var env struct {
			ID     int             `json:"id"`
			Result json.RawMessage `json:"result"`
			Error  *struct {
				Code    int             `json:"code"`
				Message string          `json:"message"`
				Data    json.RawMessage `json:"data"`
			} `json:"error"`
		}
		if err := c.readJSON(&env); err != nil {
			return nil, err
		}
		if env.ID != id {
			continue
		}
		if env.Error != nil {
			return nil, fmt.Errorf("rpc %s failed code=%d message=%s data=%s", method, env.Error.Code, env.Error.Message, string(env.Error.Data))
		}
		return env.Result, nil
	}
}

func (c *rpcClient) close() {
	_ = c.conn.Close()
}

func (c *rpcClient) writeJSON(value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	var header []byte
	header = append(header, 0x81)
	length := len(data)
	switch {
	case length < 126:
		header = append(header, 0x80|byte(length))
	case length <= 65535:
		header = append(header, 0x80|126, byte(length>>8), byte(length))
	default:
		header = append(header, 0x80|127)
		var ext [8]byte
		binary.BigEndian.PutUint64(ext[:], uint64(length))
		header = append(header, ext[:]...)
	}
	var mask [4]byte
	if _, err := rand.Read(mask[:]); err != nil {
		return err
	}
	masked := append([]byte(nil), data...)
	for i := range masked {
		masked[i] ^= mask[i%4]
	}
	frame := append(header, mask[:]...)
	frame = append(frame, masked...)
	_, err = c.conn.Write(frame)
	return err
}

func (c *rpcClient) readJSON(out any) error {
	for {
		opcode, payload, err := c.readFrame()
		if err != nil {
			return err
		}
		switch opcode {
		case 0x1:
			return json.Unmarshal(payload, out)
		case 0x8:
			return io.EOF
		case 0x9:
			if err := c.writePong(payload); err != nil {
				return err
			}
		}
	}
}

func (c *rpcClient) readFrame() (byte, []byte, error) {
	header := make([]byte, 2)
	if _, err := io.ReadFull(c.br, header); err != nil {
		return 0, nil, err
	}
	opcode := header[0] & 0x0F
	masked := header[1]&0x80 != 0
	length := uint64(header[1] & 0x7F)
	switch length {
	case 126:
		var ext [2]byte
		if _, err := io.ReadFull(c.br, ext[:]); err != nil {
			return 0, nil, err
		}
		length = uint64(binary.BigEndian.Uint16(ext[:]))
	case 127:
		var ext [8]byte
		if _, err := io.ReadFull(c.br, ext[:]); err != nil {
			return 0, nil, err
		}
		length = binary.BigEndian.Uint64(ext[:])
	}
	if length > 16*1024*1024 {
		return 0, nil, fmt.Errorf("websocket frame too large: %d", length)
	}
	var mask [4]byte
	if masked {
		if _, err := io.ReadFull(c.br, mask[:]); err != nil {
			return 0, nil, err
		}
	}
	payload := make([]byte, length)
	if _, err := io.ReadFull(c.br, payload); err != nil {
		return 0, nil, err
	}
	if masked {
		for i := range payload {
			payload[i] ^= mask[i%4]
		}
	}
	return opcode, payload, nil
}

func (c *rpcClient) writePong(payload []byte) error {
	header := []byte{0x8A, byte(len(payload))}
	_, err := c.conn.Write(append(header, payload...))
	return err
}

func websocketKey() (string, error) {
	var key [16]byte
	if _, err := rand.Read(key[:]); err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(key[:]), nil
}

func websocketAccept(key string) string {
	sum := sha1.Sum([]byte(key + websocketGUID))
	return base64.StdEncoding.EncodeToString(sum[:])
}

func seedLease(dataDir, sessionID string, ttl time.Duration) error {
	if strings.TrimSpace(dataDir) == "" || strings.TrimSpace(sessionID) == "" {
		return errors.New("data-dir and session-id are required")
	}
	db, err := openDB(dataDir)
	if err != nil {
		return err
	}
	defer db.Close()
	now := time.Now().UTC()
	expiresAt := now.Add(ttl)
	workspaceID := workspaceIDForSession(sessionID)
	runtimeID := "lease_owner_" + sessionID
	leaseID := "lease_seed_" + sessionID
	if _, err := db.Exec(`
INSERT INTO workspaces (
	workspace_id, backend, provider_workspace_id, state, fencing_token,
	owner_session_id, workspace_version, wisp_name, wisp_smh_space_id,
	wisp_owns_smh_space, cleanup_state, delete_state, created_at, updated_at
) VALUES (?, 'wisp', ?, 'active', 1, ?, 'builtin.v1', ?, ?, 1, 'active', '', ?, ?)
ON CONFLICT(workspace_id) DO UPDATE SET
	state = 'active',
	fencing_token = 1,
	owner_session_id = excluded.owner_session_id,
	wisp_name = excluded.wisp_name,
	wisp_smh_space_id = excluded.wisp_smh_space_id,
	updated_at = excluded.updated_at,
	deleted_at = NULL`,
		workspaceID, workspaceID, sessionID, "agent-"+sessionID, workspaceID, now.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano)); err != nil {
		return err
	}
	if _, err := db.Exec(`
INSERT INTO workspace_runtimes (runtime_id, workspace_id, provider, state, lease_id, fencing_token, created_at, updated_at)
VALUES (?, ?, 'ags', 'active', ?, 1, ?, ?)
ON CONFLICT(runtime_id) DO UPDATE SET
	workspace_id = excluded.workspace_id,
	provider = excluded.provider,
	state = 'active',
	lease_id = excluded.lease_id,
	fencing_token = excluded.fencing_token,
	updated_at = excluded.updated_at,
	released_at = NULL`,
		runtimeID, workspaceID, leaseID, now.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano)); err != nil {
		return err
	}
	if _, err := db.Exec(`
INSERT INTO workspace_leases (workspace_id, lease_id, runtime_id, fencing_token, state, expires_at, heartbeat_at, created_at, updated_at)
VALUES (?, ?, ?, 1, 'active', ?, ?, ?, ?)
ON CONFLICT(workspace_id) DO UPDATE SET
	lease_id = excluded.lease_id,
	runtime_id = excluded.runtime_id,
	fencing_token = excluded.fencing_token,
	state = 'active',
	expires_at = excluded.expires_at,
	heartbeat_at = excluded.heartbeat_at,
	created_at = excluded.created_at,
	updated_at = excluded.updated_at`,
		workspaceID, leaseID, runtimeID, expiresAt.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano)); err != nil {
		return err
	}
	if _, err := db.Exec(`
UPDATE session_runtimes
SET runtime_id = ?,
	outer_runtime = 'wisp',
	runtime_recovery = 'reattach_or_recreate',
	outer_sandbox_id = CASE WHEN outer_sandbox_id = '' THEN 'outer_seed' ELSE outer_sandbox_id END,
	wisp_name = ?,
	wisp_workspace_id = ?,
	wisp_smh_space_id = ?,
	wisp_owns_smh_space = 1,
	wisp_lease_id = ?,
	wisp_lease_fence = 1,
	wisp_lease_until = ?,
	workspace_id = ?,
	workspace_runtime_id = ?,
	workspace_wisp_name = ?,
	workspace_lease_id = ?,
	workspace_fence = 1,
	workspace_lease_until = ?,
	workspace_attach_state = 'attached',
	inner_sandbox_id = 'inner_seed'
WHERE session_id = ? AND generation = (SELECT runtime_generation FROM sessions WHERE session_id = ?)`,
		runtimeID,
		"agent-"+sessionID,
		workspaceID,
		workspaceID,
		leaseID,
		expiresAt.Format(time.RFC3339Nano),
		workspaceID,
		runtimeID,
		"agent-"+sessionID,
		leaseID,
		expiresAt.Format(time.RFC3339Nano),
		sessionID,
		sessionID); err != nil {
		return err
	}
	if err := insertOldUserMessage(db, sessionID, now.Add(-2*time.Second)); err != nil {
		return err
	}
	fmt.Printf("workspace_id=%s lease_id=%s expires_at=%s\n", workspaceID, leaseID, expiresAt.Format(time.RFC3339Nano))
	return nil
}

func assertHeld(dataDir, sessionID string) error {
	db, err := openDB(dataDir)
	if err != nil {
		return err
	}
	defer db.Close()
	workspaceID := workspaceIDForSession(sessionID)
	stolen, err := tryStealLease(db, workspaceID)
	if err != nil {
		return err
	}
	if stolen {
		return fmt.Errorf("workspace lease was stealable after runtime refresh; refresh did not renew workspace_id=%s", workspaceID)
	}
	fmt.Printf("workspace lease remains held workspace_id=%s\n", workspaceID)
	return nil
}

func assertStealable(dataDir, sessionID string) error {
	db, err := openDB(dataDir)
	if err != nil {
		return err
	}
	defer db.Close()
	workspaceID := workspaceIDForSession(sessionID)
	stolen, err := tryStealLease(db, workspaceID)
	if err != nil {
		return err
	}
	if !stolen {
		return fmt.Errorf("workspace lease was still held; expected it to be stealable after close workspace_id=%s", workspaceID)
	}
	fmt.Printf("workspace lease is stealable workspace_id=%s\n", workspaceID)
	return nil
}

func openDB(dataDir string) (*sql.DB, error) {
	db, err := sql.Open("sqlite", filepath.Join(dataDir, "wrapper.db"))
	if err != nil {
		return nil, err
	}
	if _, err := db.Exec("PRAGMA busy_timeout = 5000"); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

func insertOldUserMessage(db *sql.DB, sessionID string, at time.Time) error {
	var turnIndex int
	_ = db.QueryRow(`SELECT COALESCE(MAX(turn_index), -1) + 1 FROM turns WHERE session_id = ?`, sessionID).Scan(&turnIndex)
	suffix := fmt.Sprintf("%d", time.Now().UnixNano())
	turnID := "turn_seed_" + suffix
	messageID := "msg_seed_" + suffix
	blockID := "block_seed_" + suffix
	atText := at.Format(time.RFC3339Nano)
	payload := `{"sessionUpdate":"user_message_chunk","messageId":"` + messageID + `","blockId":"` + blockID + `","content":{"text":"old prompt"}}`
	if _, err := db.Exec(`INSERT INTO turns (id, session_id, turn_index, status, created_at, updated_at) VALUES (?, ?, ?, 'completed', ?, ?)`,
		turnID, sessionID, turnIndex, atText, atText); err != nil {
		return err
	}
	if _, err := db.Exec(`INSERT INTO messages (id, turn_id, session_id, role, status, message_index, created_at, updated_at) VALUES (?, ?, ?, 'user', 'completed', 0, ?, ?)`,
		messageID, turnID, sessionID, atText, atText); err != nil {
		return err
	}
	_, err := db.Exec(`INSERT INTO message_blocks (id, message_id, turn_id, session_id, block_index, type, status, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 'text', 'completed', ?, ?, ?)`,
		blockID, messageID, turnID, sessionID, payload, atText, atText)
	return err
}

func tryStealLease(db *sql.DB, workspaceID string) (bool, error) {
	now := time.Now().UTC()
	var state string
	var expiresText string
	var currentRuntime string
	err := db.QueryRow(`SELECT state, expires_at, runtime_id FROM workspace_leases WHERE workspace_id = ?`, workspaceID).Scan(&state, &expiresText, &currentRuntime)
	if err != nil {
		return false, err
	}
	expiresAt, err := time.Parse(time.RFC3339Nano, expiresText)
	if err != nil {
		return false, err
	}
	if state == "active" && expiresAt.After(now) {
		fmt.Fprintf(os.Stderr, "workspace lease still held by %s until %s\n", currentRuntime, expiresAt.Format(time.RFC3339Nano))
		return false, nil
	}
	tx, err := db.BeginTx(context.Background(), nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	if state == "active" {
		if _, err := tx.Exec(`UPDATE workspace_leases SET state = 'expired', updated_at = ? WHERE workspace_id = ?`, now.Format(time.RFC3339Nano), workspaceID); err != nil {
			return false, err
		}
	}
	if _, err := tx.Exec(`UPDATE workspaces SET fencing_token = fencing_token + 1, updated_at = ? WHERE workspace_id = ?`, now.Format(time.RFC3339Nano), workspaceID); err != nil {
		return false, err
	}
	var token int64
	if err := tx.QueryRow(`SELECT fencing_token FROM workspaces WHERE workspace_id = ?`, workspaceID).Scan(&token); err != nil {
		return false, err
	}
	runtimeID := "lease_thief_runtime"
	leaseID := "lease_thief_" + fmt.Sprintf("%d", now.UnixNano())
	expiresAt = now.Add(time.Minute)
	if _, err := tx.Exec(`
INSERT INTO workspace_runtimes (runtime_id, workspace_id, provider, state, lease_id, fencing_token, created_at, updated_at)
VALUES (?, ?, 'ags', 'active', ?, ?, ?, ?)`,
		runtimeID, workspaceID, leaseID, token, now.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano)); err != nil {
		return false, err
	}
	if _, err := tx.Exec(`
INSERT INTO workspace_leases (workspace_id, lease_id, runtime_id, fencing_token, state, expires_at, heartbeat_at, created_at, updated_at)
VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)
ON CONFLICT(workspace_id) DO UPDATE SET
	lease_id = excluded.lease_id,
	runtime_id = excluded.runtime_id,
	fencing_token = excluded.fencing_token,
	state = 'active',
	expires_at = excluded.expires_at,
	heartbeat_at = excluded.heartbeat_at,
	created_at = excluded.created_at,
	updated_at = excluded.updated_at`,
		workspaceID, leaseID, runtimeID, token, expiresAt.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano)); err != nil {
		return false, err
	}
	if err := tx.Commit(); err != nil {
		return false, err
	}
	fmt.Fprintf(os.Stderr, "stole workspace lease workspace_id=%s previous_runtime=%s new_runtime=%s fence=%d\n", workspaceID, currentRuntime, runtimeID, token)
	return true, nil
}

func workspaceIDForSession(sessionID string) string {
	return "lease_bug_" + sessionID
}
