package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"connectrpc.com/connect"

	"cvm-mock-e2b/internal/envd/process"
	"cvm-mock-e2b/internal/envd/process/processconnect"
	"cvm-mock-e2b/internal/logging"
)

type sandboxCreateRequest struct {
	TemplateID string `json:"templateID"`
	Timeout    int    `json:"timeout"`
}

type sandboxResponse struct {
	SandboxID string `json:"sandboxID"`
	ClientID  string `json:"clientID"`
}

type headerInterceptor struct {
	envdPort  int
	sandboxID string
	user      string
}

func (i *headerInterceptor) WrapUnary(next connect.UnaryFunc) connect.UnaryFunc {
	return func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
		applyHeaders(req.Header(), i.envdPort, i.sandboxID, i.user)
		return next(ctx, req)
	}
}

func (i *headerInterceptor) WrapStreamingClient(next connect.StreamingClientFunc) connect.StreamingClientFunc {
	return func(ctx context.Context, spec connect.Spec) connect.StreamingClientConn {
		conn := next(ctx, spec)
		applyHeaders(conn.RequestHeader(), i.envdPort, i.sandboxID, i.user)
		return conn
	}
}

func (i *headerInterceptor) WrapStreamingHandler(next connect.StreamingHandlerFunc) connect.StreamingHandlerFunc {
	return next
}

func applyHeaders(h http.Header, envdPort int, sandboxID, user string) {
	host := fmt.Sprintf("%d-%s-00000000.e2b.app", envdPort, sandboxID)
	h.Set("Host", host)
	token := base64.StdEncoding.EncodeToString([]byte(user + ":"))
	h.Set("Authorization", "Basic "+token)
}

func main() {
	cleanup, err := logging.Init("sandboxcli")
	if err != nil {
		log.Fatalf("init logging: %v", err)
	}
	defer cleanup()

	if err := run(); err != nil {
		// Logs are typically written to file; also print to stderr so callers (e.g. run.sh) see details.
		log.Printf("sandboxcli failed: %v", err)
		fmt.Fprintf(os.Stderr, "sandboxcli failed: %v\n", err)
		os.Exit(1)
	}
}

func run() (retErr error) {
	var (
		apiBaseURL     = flag.String("api-base-url", getenv("E2B_API_BASE_URL", "http://127.0.0.1:8081"), "sandbox API base URL")
		apiKey         = flag.String("api-key", os.Getenv("E2B_API_KEY"), "sandbox API key")
		templateID     = flag.String("template-id", "", "template ID (required)")
		sandboxTimeout = flag.Int("sandbox-timeout", 3600, "sandbox timeout seconds")
		processBaseURL = flag.String("process-base-url", "http://127.0.0.1:8082", "process Connect base URL")
		envdPort       = flag.Int("envd-port", 49983, "envd port in Host header")
		user           = flag.String("user", "root", "user in Authorization header")
		cmd            = flag.String("cmd", "echo hello", "shell command executed by /bin/bash -l -c")
		requestTimeout = flag.Duration("request-timeout", 30*time.Second, "HTTP timeout for create/delete sandbox")
		processTimeout = flag.Duration("process-timeout", 30*time.Minute, "timeout for process stream")
		idleTimeout    = flag.Duration("idle-timeout", time.Minute, "cancel process stream if no events for this duration (0 to disable)")
		keepSandbox    = flag.Bool("keep-sandbox", false, "always keep sandbox after process exits")
		keepOnError    = flag.Bool("keep-on-error", false, "keep sandbox only when command execution fails")
		loop           = flag.Bool("loop", false, "run forever until an iteration fails (exits non-zero on failure)")
		loopInterval   = flag.Duration("loop-interval", 0, "sleep between successful iterations (0 for no sleep)")
		loopMax        = flag.Int("loop-max", 0, "max iterations before exiting successfully (0 for infinite)")
	)
	flag.Parse()

	if *templateID == "" {
		return fmt.Errorf("-template-id is required")
	}
	//if *apiKey == "" {
	//	log.Fatal("-api-key or E2B_API_KEY is required")
	//}

	cfg := sandboxCLICfg{
		apiBaseURL:     strings.TrimRight(*apiBaseURL, "/"),
		apiKey:         *apiKey,
		templateID:     *templateID,
		sandboxTimeout: *sandboxTimeout,
		processBaseURL: strings.TrimRight(*processBaseURL, "/"),
		envdPort:       *envdPort,
		user:           *user,
		cmd:            *cmd,
		requestTimeout: *requestTimeout,
		processTimeout: *processTimeout,
		idleTimeout:    *idleTimeout,
		keepSandbox:    *keepSandbox,
		keepOnError:    *keepOnError,
	}

	sigCtx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if !*loop {
		return runOnce(sigCtx, cfg)
	}

	iter := 0
	for {
		iter++
		log.Printf("loop iteration=%d starting", iter)
		if err := runOnce(sigCtx, cfg); err != nil {
			log.Printf("loop iteration=%d failed: %v", iter, err)
			fmt.Fprintf(os.Stderr, "loop iteration=%d failed: %v\n", iter, err)
			return err
		}
		log.Printf("loop iteration=%d ok", iter)

		if *loopMax > 0 && iter >= *loopMax {
			return nil
		}
		if *loopInterval > 0 {
			select {
			case <-time.After(*loopInterval):
			case <-sigCtx.Done():
				return sigCtx.Err()
			}
		}
	}
}

type sandboxCLICfg struct {
	apiBaseURL     string
	apiKey         string
	templateID     string
	sandboxTimeout int
	processBaseURL string
	envdPort       int
	user           string
	cmd            string

	requestTimeout time.Duration
	processTimeout time.Duration
	idleTimeout    time.Duration
	keepSandbox    bool
	keepOnError    bool
}

func runOnce(ctx context.Context, cfg sandboxCLICfg) (retErr error) {
	httpClient := &http.Client{Timeout: cfg.requestTimeout}

	sb, err := createSandbox(ctx, httpClient, cfg.apiBaseURL, cfg.apiKey, cfg.templateID, cfg.sandboxTimeout)
	if err != nil {
		return fmt.Errorf("create sandbox: %w", err)
	}
	log.Printf("sandbox created id=%s client_id=%s", sb.SandboxID, sb.ClientID)

	defer func() {
		if cfg.keepSandbox {
			log.Printf("keeping sandbox id=%s due to -keep-sandbox", sb.SandboxID)
			return
		}
		if cfg.keepOnError && retErr != nil {
			log.Printf("keeping sandbox id=%s due to command error and -keep-on-error", sb.SandboxID)
			return
		}
		delCtx, cancel := context.WithTimeout(context.Background(), cfg.requestTimeout)
		defer cancel()
		log.Printf("deleting sandbox id=%s", sb.SandboxID)
		if err := deleteSandbox(delCtx, httpClient, cfg.apiBaseURL, cfg.apiKey, sb.SandboxID); err != nil {
			log.Printf("delete sandbox failed id=%s err=%v", sb.SandboxID, err)
			return
		}
		log.Printf("sandbox deleted id=%s", sb.SandboxID)
	}()

	procCtx, cancel := context.WithTimeout(ctx, cfg.processTimeout)
	defer cancel()

	procClient := processconnect.NewProcessClient(
		newSniffingHTTPClient(cfg.processTimeout),
		cfg.processBaseURL,
		connect.WithInterceptors(&headerInterceptor{envdPort: cfg.envdPort, sandboxID: sb.SandboxID, user: cfg.user}),
	)

	req := connect.NewRequest(&process.StartRequest{
		Process: &process.ProcessConfig{
			Cmd:  "/bin/bash",
			Args: []string{"-l", "-c", cfg.cmd},
		},
	})
	log.Printf("debug process start curl:\n%s", buildProcessStartCurl(cfg.processBaseURL, cfg.envdPort, sb.SandboxID, cfg.user, cfg.cmd))

	stream, err := procClient.Start(procCtx, req)
	if err != nil {
		return fmt.Errorf("start process: %w", err)
	}
	if err := handleProcessStream(procCtx, cancel, stream, cfg.idleTimeout); err != nil && !errors.Is(err, context.Canceled) {
		return fmt.Errorf("process stream: %w", err)
	}
	return nil
}

// newSniffingHTTPClient returns an HTTP client that prints a small response body snippet to stderr
// when upstream returns 502. This helps debug Bad Gateway errors with minimal overhead.
func newSniffingHTTPClient(timeout time.Duration) *http.Client {
	base := http.DefaultTransport
	return &http.Client{
		Timeout: timeout,
		Transport: &sniffingTransport{
			base:    base,
			maxBody: 2048,
		},
	}
}

type sniffingTransport struct {
	base    http.RoundTripper
	maxBody int64
}

func (t *sniffingTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	base := t.base
	if base == nil {
		base = http.DefaultTransport
	}
	resp, err := base.RoundTrip(req)
	if err != nil || resp == nil || resp.Body == nil {
		return resp, err
	}

	if resp.StatusCode == http.StatusBadGateway {
		// Read and print a bounded body snippet, then restore the stream for downstream readers.
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, t.maxBody))
		server := strings.TrimSpace(resp.Header.Get("Server"))
		via := strings.TrimSpace(resp.Header.Get("Via"))
		reqID := strings.TrimSpace(resp.Header.Get("X-Request-Id"))
		envoyReqID := strings.TrimSpace(resp.Header.Get("X-Envoy-Request-Id"))
		envoyFlags := strings.TrimSpace(resp.Header.Get("X-Envoy-Response-Flags"))
		upstreamTime := strings.TrimSpace(resp.Header.Get("X-Upstream-Service-Time"))
		host := strings.TrimSpace(req.Host)
		if host == "" {
			host = req.URL.Host
		}
		if len(snippet) > 0 {
			trim := strings.TrimSpace(string(snippet))
			fmt.Fprintf(os.Stderr,
				"process http 502 method=%s url=%s host=%s server=%q via=%q x_request_id=%q x_envoy_request_id=%q x_envoy_response_flags=%q x_upstream_service_time=%q body_snippet=%q\n",
				req.Method, req.URL.String(), host, server, via, reqID, envoyReqID, envoyFlags, upstreamTime, trim,
			)
			resp.Body = io.NopCloser(io.MultiReader(bytes.NewReader(snippet), resp.Body))
		} else {
			fmt.Fprintf(os.Stderr,
				"process http 502 method=%s url=%s host=%s server=%q via=%q x_request_id=%q x_envoy_request_id=%q x_envoy_response_flags=%q x_upstream_service_time=%q body_snippet=%q\n",
				req.Method, req.URL.String(), host, server, via, reqID, envoyReqID, envoyFlags, upstreamTime, "",
			)
			// Put the empty snippet back as well, in case downstream expects to read it.
			resp.Body = io.NopCloser(io.MultiReader(bytes.NewReader(snippet), resp.Body))
		}
	}
	return resp, err
}

func createSandbox(ctx context.Context, hc *http.Client, apiBaseURL, apiKey, templateID string, timeout int) (sandboxResponse, error) {
	body, err := json.Marshal(sandboxCreateRequest{TemplateID: templateID, Timeout: timeout})
	if err != nil {
		return sandboxResponse{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, apiBaseURL+"/sandboxes", bytes.NewReader(body))
	if err != nil {
		return sandboxResponse{}, err
	}
	req.Header.Set("X-API-Key", apiKey)
	req.Header.Set("Content-Type", "application/json")

	resp, err := hc.Do(req)
	if err != nil {
		return sandboxResponse{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return sandboxResponse{}, fmt.Errorf("status=%d body=%s", resp.StatusCode, string(msg))
	}
	var sb sandboxResponse
	if err := json.NewDecoder(resp.Body).Decode(&sb); err != nil {
		return sandboxResponse{}, err
	}
	if sb.SandboxID == "" {
		return sandboxResponse{}, fmt.Errorf("empty sandboxID in response")
	}
	return sb, nil
}

func deleteSandbox(ctx context.Context, hc *http.Client, apiBaseURL, apiKey, sandboxID string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, apiBaseURL+"/sandboxes/"+sandboxID, nil)
	if err != nil {
		return err
	}
	req.Header.Set("X-API-Key", apiKey)
	resp, err := hc.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent && resp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return fmt.Errorf("status=%d body=%s", resp.StatusCode, string(msg))
	}
	return nil
}

func handleProcessStream(ctx context.Context, cancel context.CancelFunc, stream *connect.ServerStreamForClient[process.StartResponse], idle time.Duration) error {
	defer stream.Close()
	const maxStderrBytes = 8 << 10
	var stderrTail []byte
	var gotEnd bool
	var endExitCode int32
	var endStatus string
	var endErr string

	var timer *time.Timer
	resetTimer := func() {}
	if idle > 0 {
		timer = time.NewTimer(idle)
		resetTimer = func() {
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			timer.Reset(idle)
		}
		go func() {
			if timer == nil {
				return
			}
			select {
			case <-timer.C:
				log.Printf("process stream idle for %s; canceling", idle)
				cancel()
			case <-ctx.Done():
			}
		}()
		resetTimer()
	}
	for stream.Receive() {
		if timer != nil {
			resetTimer()
		}
		msg := stream.Msg()
		if msg.Event == nil {
			continue
		}
		switch event := msg.Event.Event.(type) {
		case *process.ProcessEvent_Start:
			log.Printf("process started pid=%d", event.Start.Pid)
		case *process.ProcessEvent_Data:
			if event.Data == nil {
				continue
			}
			switch out := event.Data.Output.(type) {
			case *process.ProcessEvent_DataEvent_Stdout:
				fmt.Print(string(out.Stdout))
			case *process.ProcessEvent_DataEvent_Stderr:
				// Keep a tail to report on failures.
				if len(out.Stderr) > 0 {
					stderrTail = append(stderrTail, out.Stderr...)
					if len(stderrTail) > maxStderrBytes {
						stderrTail = stderrTail[len(stderrTail)-maxStderrBytes:]
					}
				}
				fmt.Fprint(os.Stderr, string(out.Stderr))
			}
		case *process.ProcessEvent_End:
			gotEnd = true
			endExitCode = event.End.ExitCode
			endStatus = event.End.Status
			log.Printf("process ended exit_code=%d status=%s", endExitCode, endStatus)
			if event.End.Error != nil {
				endErr = *event.End.Error
				log.Printf("process error=%s", endErr)
			}
		}
	}
	if timer != nil {
		resetTimer()
	}
	streamErr := stream.Err()
	if gotEnd {
		if endExitCode != 0 {
			if len(stderrTail) > 0 {
				return fmt.Errorf("remote process failed exit_code=%d status=%s error=%s stderr_tail=%q", endExitCode, endStatus, endErr, string(stderrTail))
			}
			return fmt.Errorf("remote process failed exit_code=%d status=%s error=%s", endExitCode, endStatus, endErr)
		}
		// If the process ended successfully, tolerate transport errors that may arrive after the End event.
		// This avoids false negatives from flaky stream termination.
		if streamErr != nil {
			log.Printf("process stream transport error after successful end: %v", streamErr)
			return nil
		}
	}
	return streamErr
}

func waitForHealth(ctx context.Context, baseURL string, envdPort int, sandboxID string) error {
	target := strings.TrimRight(baseURL, "/") + "/health"
	host := fmt.Sprintf("%d-%s-00000000.e2b.app", envdPort, sandboxID)
	client := &http.Client{Timeout: 100 * time.Millisecond}
	for {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
		if err != nil {
			return err
		}
		req.Host = host
		resp, err := client.Do(req)
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK || resp.StatusCode == http.StatusNoContent {
				return nil
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
			time.Sleep(50 * time.Millisecond)
		}
	}
}

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func buildProcessStartCurl(processBaseURL string, envdPort int, sandboxID, user, cmd string) string {
	payload := map[string]any{
		"process": map[string]any{
			"cmd":  "/bin/bash",
			"args": []string{"-l", "-c", cmd},
		},
	}
	body, _ := json.Marshal(payload)
	host := fmt.Sprintf("%d-%s-00000000.e2b.app", envdPort, sandboxID)
	token := base64.StdEncoding.EncodeToString([]byte(user + ":"))
	return fmt.Sprintf(
		"curl -N -sS %s/process.Process/Start \\\n  -H 'Host: %s' \\\n  -H 'Authorization: Basic %s' \\\n  -H 'Content-Type: application/connect+json' \\\n  -H 'Connect-Protocol-Version: 1' \\\n  --data-raw %s",
		shellQuote(processBaseURL),
		host,
		token,
		shellQuote(string(body)),
	)
}

func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}
