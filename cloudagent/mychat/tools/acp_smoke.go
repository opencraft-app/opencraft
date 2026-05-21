package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

type rpcMessage struct {
	JSONRPC string          `json:"jsonrpc,omitempty"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type acpClient struct {
	stdin       io.Writer
	lines       <-chan string
	verbose     bool
	nextID      int
	loadCapture *loadCapture
}

type listedSession struct {
	SessionID             string   `json:"sessionId"`
	Cwd                   string   `json:"cwd"`
	Title                 string   `json:"title"`
	UpdatedAt             string   `json:"updatedAt"`
	AdditionalDirectories []string `json:"additionalDirectories"`
}

type listSessionsResult struct {
	Sessions   []listedSession `json:"sessions"`
	NextCursor string          `json:"nextCursor"`
}

type loadCapture struct {
	Updates    int
	TextChunks []string
}

func main() {
	gateway := flag.String("gateway", "http://127.0.0.1:8642", "Hermes HTTP gateway base URL")
	agent := flag.String("agent", "/Users/skipzhang/.local/bin/hermes", "ACP agent executable")
	agentArgs := flag.String("agent-args", "acp", "ACP agent args, shell-like whitespace split")
	cwd := flag.String("cwd", ".", "working directory passed to session/new")
	prompt := flag.String("prompt", "", "optional prompt to send after session/new; omitted by default")
	listSessions := flag.Bool("list", false, "call ACP session/list after initialize")
	loadSession := flag.String("load-session", "", "call ACP session/load for a session id; use 'first' to load the first listed session")
	postLoadWait := flag.Duration("post-load-wait", 2*time.Second, "additional time to read session/update notifications after session/load response")
	requireLoadReplay := flag.Bool("require-load-replay", false, "fail if session/load does not replay at least one session/update during the response plus post-load wait window")
	skipNew := flag.Bool("skip-new", false, "skip ACP session/new")
	timeout := flag.Duration("timeout", 20*time.Second, "overall timeout")
	skipGateway := flag.Bool("skip-gateway", false, "skip HTTP gateway probe")
	skipACP := flag.Bool("skip-acp", false, "skip ACP stdio probe")
	verbose := flag.Bool("v", false, "print raw ACP notifications")
	flag.Parse()

	ctx, cancel := context.WithTimeout(context.Background(), *timeout)
	defer cancel()

	if !*skipGateway {
		if err := probeGateway(ctx, *gateway); err != nil {
			fmt.Fprintf(os.Stderr, "[http] failed: %v\n", err)
		}
	}

	if !*skipACP {
		absCwd, err := filepath.Abs(*cwd)
		if err != nil {
			die("resolve cwd: %v", err)
		}
		options := acpProbeOptions{
			prompt:            *prompt,
			listSessions:      *listSessions,
			loadSession:       *loadSession,
			postLoadWait:      *postLoadWait,
			requireLoadReplay: *requireLoadReplay,
			skipNew:           *skipNew,
		}
		if err := probeACP(ctx, *agent, strings.Fields(*agentArgs), absCwd, options, *verbose); err != nil {
			die("acp failed: %v", err)
		}
	}
}

type acpProbeOptions struct {
	prompt            string
	listSessions      bool
	loadSession       string
	postLoadWait      time.Duration
	requireLoadReplay bool
	skipNew           bool
}

func probeGateway(ctx context.Context, base string) error {
	base = strings.TrimRight(base, "/")
	fmt.Printf("[http] probing %s\n", base)

	for _, path := range []string{"/health", "/v1/models"} {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+path, nil)
		if err != nil {
			return err
		}

		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return fmt.Errorf("GET %s: %w", path, err)
		}
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		_ = resp.Body.Close()

		summary := compactJSON(body)
		if summary == "" {
			summary = strings.TrimSpace(string(body))
		}
		fmt.Printf("[http] GET %s -> %s %s\n", path, resp.Status, summary)
	}

	return nil
}

func probeACP(ctx context.Context, agent string, args []string, cwd string, options acpProbeOptions, verbose bool) error {
	fmt.Printf("[acp] starting %s %s\n", agent, strings.Join(args, " "))

	cmd := exec.CommandContext(ctx, agent, args...)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return err
	}

	lines := make(chan string, 64)
	stderrLines := make(chan string, 256)
	go scanLines(stdout, lines)
	go scanLines(stderr, stderrLines)

	if err := cmd.Start(); err != nil {
		return err
	}
	defer func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	}()

	client := &acpClient{stdin: stdin, lines: lines, verbose: verbose}

	initResp, err := client.request(ctx, "initialize", map[string]any{
		"protocolVersion":    1,
		"clientCapabilities": map[string]any{},
		"clientInfo": map[string]any{
			"name":    "mychat-acp-smoke",
			"title":   "mychat ACP smoke client",
			"version": "0.1.0",
		},
	})
	if err != nil {
		return withStderrTail(err, stderrLines)
	}
	fmt.Printf("[acp] initialize ok: %s\n", compactJSON(initResp.Result))

	var listed []listedSession
	if options.listSessions || options.loadSession != "" {
		listResp, err := client.request(ctx, "session/list", map[string]any{"cwd": cwd})
		if err != nil {
			return withStderrTail(err, stderrLines)
		}
		var result listSessionsResult
		if err := json.Unmarshal(listResp.Result, &result); err != nil {
			return fmt.Errorf("decode session/list result %s: %w", string(listResp.Result), err)
		}
		listed = result.Sessions
		fmt.Printf("[acp] session/list ok: sessions=%d nextCursor=%q\n", len(listed), result.NextCursor)
		for i, session := range listed {
			fmt.Printf("[acp] session[%d]: id=%s title=%q cwd=%q updatedAt=%q additionalDirectories=%d\n",
				i, session.SessionID, session.Title, session.Cwd, session.UpdatedAt, len(session.AdditionalDirectories))
		}
	}

	if options.loadSession != "" {
		target, err := chooseLoadSession(options.loadSession, listed)
		if err != nil {
			return err
		}
		loadCwd := target.Cwd
		if loadCwd == "" {
			loadCwd = cwd
		}
		capture := &loadCapture{}
		client.loadCapture = capture
		loadResp, err := client.request(ctx, "session/load", map[string]any{
			"sessionId":             target.SessionID,
			"cwd":                   loadCwd,
			"mcpServers":            []any{},
			"additionalDirectories": target.AdditionalDirectories,
		})
		if err != nil {
			client.loadCapture = nil
			return withStderrTail(err, stderrLines)
		}
		updatesBeforeResponse := capture.Updates
		if options.postLoadWait > 0 {
			client.drainNotifications(ctx, "session/load", options.postLoadWait)
		}
		client.loadCapture = nil
		fmt.Printf("[acp] session/load ok: sessionId=%s updatesBeforeResponse=%d updatesAfterWait=%d result=%s\n",
			target.SessionID, updatesBeforeResponse, capture.Updates, compactJSON(loadResp.Result))
		for i, chunk := range capture.TextChunks {
			fmt.Printf("[acp] load text[%d]: %s\n", i, strings.TrimSpace(chunk))
		}
		if options.requireLoadReplay && capture.Updates == 0 {
			return fmt.Errorf("session/load completed without replaying session/update notifications during the load wait window")
		}
	}

	if options.skipNew {
		return nil
	}

	newResp, err := client.request(ctx, "session/new", map[string]any{
		"cwd":        cwd,
		"mcpServers": []any{},
	})
	if err != nil {
		return withStderrTail(err, stderrLines)
	}

	var session struct {
		SessionID string `json:"sessionId"`
	}
	if err := json.Unmarshal(newResp.Result, &session); err != nil {
		return fmt.Errorf("decode session/new result %s: %w", string(newResp.Result), err)
	}
	if session.SessionID == "" {
		return fmt.Errorf("session/new result did not contain sessionId: %s", string(newResp.Result))
	}
	fmt.Printf("[acp] session/new ok: sessionId=%s\n", session.SessionID)

	if options.prompt != "" {
		promptResp, err := client.request(ctx, "session/prompt", map[string]any{
			"sessionId": session.SessionID,
			"prompt": []any{
				map[string]any{"type": "text", "text": options.prompt},
			},
		})
		if err != nil {
			return withStderrTail(err, stderrLines)
		}
		fmt.Printf("[acp] session/prompt ok: %s\n", compactJSON(promptResp.Result))
	}

	return nil
}

func (c *acpClient) drainNotifications(ctx context.Context, waitingMethod string, duration time.Duration) {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			return
		case line, ok := <-c.lines:
			if !ok {
				return
			}
			var msg rpcMessage
			if err := json.Unmarshal([]byte(line), &msg); err != nil {
				if c.verbose {
					fmt.Printf("[acp] invalid post-response JSON: %q\n", line)
				}
				continue
			}
			if msg.Method != "" {
				_ = c.handleServerMessage(waitingMethod, msg)
				continue
			}
			if c.verbose {
				fmt.Printf("[acp] post-response rpc: %s\n", compactJSON([]byte(line)))
			}
		}
	}
}

func chooseLoadSession(requested string, listed []listedSession) (listedSession, error) {
	if requested == "first" {
		if len(listed) == 0 {
			return listedSession{}, fmt.Errorf("cannot load first listed session: session/list returned no sessions")
		}
		return listed[0], nil
	}
	for _, session := range listed {
		if session.SessionID == requested {
			return session, nil
		}
	}
	return listedSession{SessionID: requested}, nil
}

func (c *acpClient) request(ctx context.Context, method string, params any) (*rpcMessage, error) {
	c.nextID++
	id := c.nextID
	req := map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"method":  method,
		"params":  params,
	}
	if err := writeJSONLine(c.stdin, req); err != nil {
		return nil, err
	}

	for {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case line, ok := <-c.lines:
			if !ok {
				return nil, fmt.Errorf("agent stdout closed while waiting for %s response", method)
			}

			var msg rpcMessage
			if err := json.Unmarshal([]byte(line), &msg); err != nil {
				return nil, fmt.Errorf("invalid JSON from agent: %q: %w", line, err)
			}

			if msg.Method != "" {
				if err := c.handleServerMessage(method, msg); err != nil {
					return nil, err
				}
				continue
			}

			if string(msg.ID) != fmt.Sprintf("%d", id) {
				if c.verbose {
					fmt.Printf("[acp] non-matching response id=%s: %s\n", msg.ID, compactJSON([]byte(line)))
				}
				continue
			}
			if msg.Error != nil {
				return nil, fmt.Errorf("%s error %d: %s", method, msg.Error.Code, msg.Error.Message)
			}
			return &msg, nil
		}
	}
}

func (c *acpClient) handleServerMessage(waitingMethod string, msg rpcMessage) error {
	if len(msg.ID) == 0 {
		if msg.Method == "session/update" {
			if waitingMethod == "session/load" && c.loadCapture != nil {
				c.loadCapture.Updates++
				if text := extractUpdateText(msg.Params); text != "" {
					c.loadCapture.TextChunks = append(c.loadCapture.TextChunks, text)
				}
			}
			fmt.Printf("[acp] session/update: %s\n", summarizeJSON(msg.Params, c.verbose))
			return nil
		}
		if c.verbose {
			fmt.Printf("[acp] notification %s: %s\n", msg.Method, compactJSON(msg.Params))
		}
		return nil
	}

	switch msg.Method {
	case "session/request_permission":
		fmt.Printf("[acp] permission requested; smoke client answers cancelled\n")
		return writeJSONLine(c.stdin, map[string]any{
			"jsonrpc": "2.0",
			"id":      json.RawMessage(msg.ID),
			"result": map[string]any{
				"outcome": map[string]any{"outcome": "cancelled"},
			},
		})
	default:
		return writeJSONLine(c.stdin, map[string]any{
			"jsonrpc": "2.0",
			"id":      json.RawMessage(msg.ID),
			"error": map[string]any{
				"code":    -32601,
				"message": "method not implemented by smoke client",
			},
		})
	}
}

func extractUpdateText(raw json.RawMessage) string {
	var params struct {
		Update struct {
			Content struct {
				Text string `json:"text"`
			} `json:"content"`
		} `json:"update"`
	}
	if err := json.Unmarshal(raw, &params); err != nil {
		return ""
	}
	return params.Update.Content.Text
}

func writeJSONLine(w io.Writer, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	b = append(b, '\n')
	_, err = w.Write(b)
	return err
}

func scanLines(r io.Reader, out chan<- string) {
	defer close(out)
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)
	for scanner.Scan() {
		out <- scanner.Text()
	}
}

func compactJSON(b []byte) string {
	b = bytes.TrimSpace(b)
	if len(b) == 0 {
		return ""
	}
	var dst bytes.Buffer
	if err := json.Compact(&dst, b); err != nil {
		return ""
	}
	return dst.String()
}

func summarizeJSON(b []byte, verbose bool) string {
	if verbose {
		return compactJSON(b)
	}
	var payload map[string]any
	if err := json.Unmarshal(b, &payload); err != nil {
		return compactJSON(b)
	}
	for _, key := range []string{"sessionUpdate", "update", "type"} {
		if v, ok := payload[key]; ok {
			j, _ := json.Marshal(v)
			return compactJSON(j)
		}
	}
	return compactJSON(b)
}

func withStderrTail(err error, stderrLines <-chan string) error {
	var tail []string
	for {
		select {
		case line, ok := <-stderrLines:
			if !ok {
				return err
			}
			tail = append(tail, line)
			if len(tail) > 12 {
				tail = tail[1:]
			}
		default:
			if len(tail) == 0 {
				return err
			}
			return fmt.Errorf("%w\nstderr tail:\n%s", err, strings.Join(tail, "\n"))
		}
	}
}

func die(format string, args ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", args...)
	os.Exit(1)
}
