package sandbox

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"connectrpc.com/connect"
	"ctl/pkg/adapter/client"
	"ctl/pkg/adapter/sandbox/envdprocess"
	"ctl/pkg/adapter/sandbox/envdprocessconnect"
	"ctl/pkg/config"
	"ctl/pkg/errcode"
	"ctl/pkg/metric"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
	"go.uber.org/zap"
)

const (
	defaultTimeoutSeconds  = 30
	defaultMaxRetries      = 3
	defaultRetryIntervalMS = 1000
	defaultUserAgent       = "ctl/1.0"

	defaultExecTimeoutSec = 30
	maxExecTimeoutSec     = 300
	initialPollInterval   = 500 * time.Millisecond
	maxPollInterval       = 8 * time.Second
)

// Adapter defines sandbox lifecycle operations exposed to the business layer.
type Adapter interface {
	CreateSandbox(ctx context.Context, req *CreateSandboxRequest) (*Sandbox, error)
	GetSandbox(ctx context.Context, sandboxID string) (*SandboxDetail, error)
	ListSandboxes(ctx context.Context, req *ListSandboxesRequest) ([]ListedSandbox, error)
	ListPools(ctx context.Context) ([]Pool, error)
	ListPoolInstances(ctx context.Context, poolID string) ([]PoolInstance, error)
	DeleteSandbox(ctx context.Context, sandboxID string) error
	PauseSandbox(ctx context.Context, sandboxID string) error
	ResumeSandbox(ctx context.Context, sandboxID string, req *ResumeSandboxRequest) (*Sandbox, error)
	SetTimeout(ctx context.Context, sandboxID string, timeoutSec int32) error
	Refresh(ctx context.Context, sandboxID string, durationSec int32) error
	GetLogs(ctx context.Context, sandboxID string, req *GetLogsRequest) (*SandboxLogs, error)
	StartTerminalSession(ctx context.Context, sandboxID string) (*TerminalSession, error)
	ExecCommand(ctx context.Context, sandboxID string, bash string, timeoutSec int) (*ExecCommandResult, error)
	GetCommandResult(ctx context.Context, sandboxID string, invocationID string) (*ExecCommandResult, error)
	StartProcessStream(ctx context.Context, sandboxID string, req *ProcessStartRequest, onEvent func(ProcessStreamEvent) error) error
	RunProcessWithStdin(ctx context.Context, sandboxID string, req *ProcessStartRequest, stdin []byte) (*ExecCommandResult, error)
	SendProcessSignal(ctx context.Context, sandboxID string, pid uint32, signal string) error
}

// RetryConfig defines retry behavior for the sandbox adapter.
type RetryConfig struct {
	MaxRetries    int
	RetryInterval time.Duration
}

// SandboxAdapter wraps sandbox HTTP API access.
type SandboxAdapter struct {
	baseURL        string
	processBaseURL string
	apiKey         string
	httpClient     *http.Client
	retryConfig    RetryConfig
	logger         *zap.Logger
	envdTokenCache sync.Map
}

type requestLogger interface {
	Logger() *zap.Logger
}

type requestIDProvider interface {
	GetRequestId() string
}

// NewSandboxAdapter creates a sandbox API adapter.
func NewSandboxAdapter(conf *config.SandboxConfig, logger *zap.Logger) *SandboxAdapter {
	if conf == nil {
		panic("sandbox config is nil")
	}
	if logger == nil {
		logger = zap.NewNop()
	}

	timeout := time.Duration(conf.Timeout) * time.Second
	if conf.Timeout <= 0 {
		timeout = defaultTimeoutSeconds * time.Second
	}

	maxRetries := conf.MaxRetries
	if conf.MaxRetries < 0 {
		maxRetries = defaultMaxRetries
	}

	retryInterval := time.Duration(conf.RetryInterval) * time.Millisecond
	if conf.RetryInterval <= 0 {
		retryInterval = defaultRetryIntervalMS * time.Millisecond
	}

	clientConf := client.NewConfig()
	clientConf.Timeout = timeout
	clientConf.MaxIdleConns = 10
	clientConf.MaxIdleConnsPerHost = 10
	clientConf.IdleConnTimeout = 30 * time.Second

	transport := &http.Transport{
		DialContext: (&net.Dialer{
			Timeout:   clientConf.Timeout,
			KeepAlive: clientConf.KeepAliveTime,
		}).DialContext,
		DisableKeepAlives:   clientConf.DisableKeepAlives,
		MaxIdleConns:        clientConf.MaxIdleConns,
		MaxIdleConnsPerHost: clientConf.MaxIdleConnsPerHost,
		MaxConnsPerHost:     100,
		IdleConnTimeout:     clientConf.IdleConnTimeout,
	}

	apiKey := strings.TrimSpace(os.Getenv("SANDBOX_API_KEY"))
	if apiKey == "" {
		apiKey = strings.TrimSpace(conf.APIKey)
	}
	if apiKey == "" {
		logger.Warn("sandbox API key not configured")
	}

	baseURL := strings.TrimRight(conf.BaseURL, "/")
	if baseURL == "" {
		baseURL = "https://api.e2b.app"
	}

	return &SandboxAdapter{
		baseURL:        baseURL,
		processBaseURL: strings.TrimRight(conf.ProcessBaseURL, "/"),
		apiKey:         apiKey,
		httpClient: &http.Client{
			Timeout:   timeout,
			Transport: transport,
		},
		retryConfig: RetryConfig{
			MaxRetries:    maxRetries,
			RetryInterval: retryInterval,
		},
		logger: logger.With(zap.String("component", "sandbox-adapter")),
	}
}

type processHeaderInterceptor struct {
	sandboxID   string
	user        string
	accessToken string
}

func (i *processHeaderInterceptor) WrapUnary(next connect.UnaryFunc) connect.UnaryFunc {
	return func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
		applyProcessHeaders(req.Header(), i.sandboxID, i.user, i.accessToken)
		return next(ctx, req)
	}
}

func (i *processHeaderInterceptor) WrapStreamingClient(next connect.StreamingClientFunc) connect.StreamingClientFunc {
	return func(ctx context.Context, spec connect.Spec) connect.StreamingClientConn {
		conn := next(ctx, spec)
		applyProcessHeaders(conn.RequestHeader(), i.sandboxID, i.user, i.accessToken)
		return conn
	}
}

func (i *processHeaderInterceptor) WrapStreamingHandler(next connect.StreamingHandlerFunc) connect.StreamingHandlerFunc {
	return next
}

func applyProcessHeaders(h http.Header, sandboxID, user, accessToken string) {
	host := fmt.Sprintf("49983-%s-00000000.e2b.app", sandboxID)
	h.Set("Host", host)
	h.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(user+":")))
	if strings.TrimSpace(accessToken) != "" {
		h.Set("X-Access-Token", accessToken)
	}
	h.Set("Keepalive-Ping-Interval", "10")
}

func chunkBytes(input []byte, size int) [][]byte {
	if len(input) == 0 {
		return nil
	}
	if size <= 0 {
		size = len(input)
	}
	chunks := make([][]byte, 0, (len(input)+size-1)/size)
	for start := 0; start < len(input); start += size {
		end := start + size
		if end > len(input) {
			end = len(input)
		}
		chunks = append(chunks, input[start:end])
	}
	return chunks
}

func (a *SandboxAdapter) newProcessClient(ctx context.Context, sandboxID string, timeout time.Duration) (envdprocessconnect.ProcessClient, error) {
	if err := validateSandboxID(sandboxID); err != nil {
		return nil, err
	}

	baseURL := a.processBaseURL
	if baseURL == "" {
		baseURL = a.baseURL
	}
	accessToken, err := a.getEnvdAccessToken(ctx, sandboxID)
	if err != nil {
		return nil, err
	}
	client := &http.Client{
		Timeout: timeout,
		Transport: &http.Transport{
			DialContext: (&net.Dialer{
				Timeout:   30 * time.Second,
				KeepAlive: 30 * time.Second,
			}).DialContext,
			DisableKeepAlives: false,
			MaxIdleConns:      10,
			IdleConnTimeout:   30 * time.Second,
		},
	}

	return envdprocessconnect.NewProcessClient(
		client,
		baseURL,
		connect.WithGRPCWeb(),
		connect.WithInterceptors(&processHeaderInterceptor{sandboxID: sandboxID, user: "root", accessToken: accessToken}),
	), nil
}

func (a *SandboxAdapter) StartProcessStream(ctx context.Context, sandboxID string, req *ProcessStartRequest, onEvent func(ProcessStreamEvent) error) error {
	if err := validateSandboxID(sandboxID); err != nil {
		return err
	}
	if req == nil || strings.TrimSpace(req.Cmd) == "" {
		return errcode.ErrSandboxInvalidParam
	}
	if onEvent == nil {
		return errors.New("onEvent callback is required")
	}
	procClient, err := a.newProcessClient(ctx, sandboxID, 0)
	if err != nil {
		return err
	}

	startReq := &envdprocess.StartRequest{
		Process: &envdprocess.ProcessConfig{
			Cmd:  req.Cmd,
			Args: append([]string(nil), req.Args...),
			Envs: cloneProcessEnv(req.Env),
		},
	}
	if req.Pty {
		startReq.Pty = &envdprocess.PTY{Size: &envdprocess.PTY_Size{Cols: req.Cols, Rows: req.Rows}}
	}
	stream, err := procClient.Start(ctx, connect.NewRequest(startReq))
	if err != nil {
		return fmt.Errorf("start envd process: %w", err)
	}
	defer stream.Close()

	for stream.Receive() {
		msg := stream.Msg()
		if msg == nil || msg.Event == nil {
			continue
		}
		ev := ProcessStreamEvent{}
		switch event := msg.Event.Event.(type) {
		case *envdprocess.ProcessEvent_Start:
			ev.PID = event.Start.GetPid()
		case *envdprocess.ProcessEvent_Data:
			if event.Data == nil {
				continue
			}
			if out := event.Data.GetStdout(); len(out) > 0 {
				ev.Stdout = string(out)
			}
			if out := event.Data.GetStderr(); len(out) > 0 {
				ev.Stderr = string(out)
			}
			if out := event.Data.GetPty(); len(out) > 0 {
				ev.Stdout = string(out)
			}
		case *envdprocess.ProcessEvent_End:
			ev.Ended = true
			ev.ExitCode = event.End.GetExitCode()
			ev.Status = event.End.GetStatus()
			ev.Error = event.End.GetError()
		case *envdprocess.ProcessEvent_Keepalive:
			continue
		default:
			continue
		}
		if err := onEvent(ev); err != nil {
			return err
		}
	}
	if err := stream.Err(); err != nil && !errors.Is(err, context.Canceled) {
		return fmt.Errorf("envd process stream error: %w", err)
	}
	return nil
}

func (a *SandboxAdapter) RunProcessWithStdin(ctx context.Context, sandboxID string, req *ProcessStartRequest, stdin []byte) (*ExecCommandResult, error) {
	if req == nil || strings.TrimSpace(req.Cmd) == "" {
		return nil, errcode.ErrSandboxInvalidParam
	}

	procClient, err := a.newProcessClient(ctx, sandboxID, 0)
	if err != nil {
		return nil, err
	}

	startReq := &envdprocess.StartRequest{
		Process: &envdprocess.ProcessConfig{
			Cmd:  req.Cmd,
			Args: append([]string(nil), req.Args...),
			Envs: cloneProcessEnv(req.Env),
		},
	}
	if req.Pty {
		startReq.Pty = &envdprocess.PTY{Size: &envdprocess.PTY_Size{Cols: req.Cols, Rows: req.Rows}}
	}

	stream, err := procClient.Start(ctx, connect.NewRequest(startReq))
	if err != nil {
		return nil, fmt.Errorf("start envd process: %w", err)
	}
	defer stream.Close()

	result := &ExecCommandResult{Status: "RUNNING"}
	var outputBuf strings.Builder
	var pid uint32
	started := false
	ended := false

	for stream.Receive() {
		msg := stream.Msg()
		if msg == nil || msg.Event == nil {
			continue
		}

		switch event := msg.Event.Event.(type) {
		case *envdprocess.ProcessEvent_Start:
			pid = event.Start.GetPid()
			result.InvocationID = fmt.Sprintf("pid:%d", pid)
			result.CommandID = result.InvocationID
			started = true

			chunks := chunkBytes(stdin, 32*1024)
			for _, chunk := range chunks {
				_, err := procClient.SendInput(ctx, connect.NewRequest(&envdprocess.SendInputRequest{
					Process: &envdprocess.ProcessSelector{
						Selector: &envdprocess.ProcessSelector_Pid{Pid: pid},
					},
					Input: &envdprocess.ProcessInput{
						Input: &envdprocess.ProcessInput_Stdin{Stdin: chunk},
					},
				}))
				if err != nil {
					return result, fmt.Errorf("send envd stdin: %w", err)
				}
			}
		case *envdprocess.ProcessEvent_Data:
			if event.Data != nil {
				if out := event.Data.GetStdout(); len(out) > 0 {
					outputBuf.Write(out)
				}
				if out := event.Data.GetStderr(); len(out) > 0 {
					outputBuf.Write(out)
				}
				if out := event.Data.GetPty(); len(out) > 0 {
					outputBuf.Write(out)
				}
			}
		case *envdprocess.ProcessEvent_End:
			ended = true
			result.ExitCode = int64(event.End.GetExitCode())
			result.Status = event.End.GetStatus()
			result.ErrorInfo = event.End.GetError()
			result.Output = outputBuf.String()
			return result, nil
		case *envdprocess.ProcessEvent_Keepalive:
			continue
		}
	}

	if err := stream.Err(); err != nil && !errors.Is(err, context.Canceled) {
		result.Output = outputBuf.String()
		return result, fmt.Errorf("envd process stream error: %w", err)
	}
	result.Output = outputBuf.String()
	if !started {
		return result, errors.New("process stream ended before start event")
	}
	if !ended {
		return result, errors.New("process stream ended without exit event")
	}
	return result, nil
}

func (a *SandboxAdapter) SendProcessSignal(ctx context.Context, sandboxID string, pid uint32, signal string) error {
	if err := validateSandboxID(sandboxID); err != nil {
		return err
	}
	if pid == 0 {
		return errcode.ErrSandboxInvalidParam
	}
	procClient, err := a.newProcessClient(ctx, sandboxID, 15*time.Second)
	if err != nil {
		return err
	}
	sig := envdprocess.Signal_SIGNAL_SIGTERM
	if strings.EqualFold(signal, "SIGKILL") {
		sig = envdprocess.Signal_SIGNAL_SIGKILL
	}
	_, err = procClient.SendSignal(ctx, connect.NewRequest(&envdprocess.SendSignalRequest{
		Process: &envdprocess.ProcessSelector{
			Selector: &envdprocess.ProcessSelector_Pid{Pid: pid},
		},
		Signal: sig,
	}))
	if err != nil {
		return fmt.Errorf("send envd signal: %w", err)
	}
	return nil
}

func cloneProcessEnv(env map[string]string) map[string]string {
	if len(env) == 0 {
		return nil
	}
	cloned := make(map[string]string, len(env))
	for k, v := range env {
		cloned[k] = v
	}
	return cloned
}

// CreateSandbox creates a new sandbox.
func (a *SandboxAdapter) CreateSandbox(ctx context.Context, req *CreateSandboxRequest) (resp *Sandbox, err error) {
	ctx, span := otel.Tracer("ctl/pkg/adapter/sandbox").Start(ctx, "SandboxAdapter.CreateSandbox")
	defer func() { endSpanWithError(span, err) }()

	resp = new(Sandbox)
	if err = a.doRequest(ctx, "create", http.MethodPost, "/sandboxes", nil, req, http.StatusCreated, resp); err != nil {
		return nil, err
	}
	a.cacheEnvdAccessToken(resp.SandboxID, resp.EnvdAccessToken)
	return resp, nil
}

// GetSandbox fetches sandbox details.
func (a *SandboxAdapter) GetSandbox(ctx context.Context, sandboxID string) (resp *SandboxDetail, err error) {
	ctx, span := otel.Tracer("ctl/pkg/adapter/sandbox").Start(ctx, "SandboxAdapter.GetSandbox")
	defer func() { endSpanWithError(span, err) }()

	if err = validateSandboxID(sandboxID); err != nil {
		return nil, err
	}
	resp = new(SandboxDetail)
	if err = a.doRequest(ctx, "get", http.MethodGet, "/sandboxes/"+url.PathEscape(sandboxID), nil, nil, http.StatusOK, resp); err != nil {
		return nil, err
	}
	a.cacheEnvdAccessToken(resp.SandboxID, resp.EnvdAccessToken)
	return resp, nil
}

// ListSandboxes fetches sandbox list.
func (a *SandboxAdapter) ListSandboxes(ctx context.Context, req *ListSandboxesRequest) (resp []ListedSandbox, err error) {
	ctx, span := otel.Tracer("ctl/pkg/adapter/sandbox").Start(ctx, "SandboxAdapter.ListSandboxes")
	defer func() { endSpanWithError(span, err) }()

	query := url.Values{}
	if req != nil {
		if req.Metadata != "" {
			query.Set("metadata", req.Metadata)
		}
		if len(req.State) > 0 {
			query.Set("state", strings.Join(req.State, ","))
		}
		if req.NextToken != "" {
			query.Set("nextToken", req.NextToken)
		}
		if req.Limit != nil {
			query.Set("limit", fmt.Sprintf("%d", *req.Limit))
		}
	}

	if err = a.doRequest(ctx, "list", http.MethodGet, "/v2/sandboxes", query, nil, http.StatusOK, &resp); err != nil {
		return nil, err
	}
	return resp, nil
}

func (a *SandboxAdapter) ListPools(ctx context.Context) (resp []Pool, err error) {
	ctx, span := otel.Tracer("ctl/pkg/adapter/sandbox").Start(ctx, "SandboxAdapter.ListPools")
	defer func() { endSpanWithError(span, err) }()

	if err = a.doRequest(ctx, "listpools", http.MethodGet, "/internal/pools", nil, nil, http.StatusOK, &resp); err != nil {
		return nil, err
	}
	return resp, nil
}

func (a *SandboxAdapter) ListPoolInstances(ctx context.Context, poolID string) (resp []PoolInstance, err error) {
	ctx, span := otel.Tracer("ctl/pkg/adapter/sandbox").Start(ctx, "SandboxAdapter.ListPoolInstances")
	defer func() { endSpanWithError(span, err) }()

	poolID = strings.TrimSpace(poolID)
	if poolID == "" {
		return nil, errcode.ErrSandboxInvalidParam
	}
	if err = a.doRequest(ctx, "listpoolinstances", http.MethodGet, "/internal/pools/"+url.PathEscape(poolID)+"/instances", nil, nil, http.StatusOK, &resp); err != nil {
		return nil, err
	}
	return resp, nil
}

// DeleteSandbox deletes a sandbox.
func (a *SandboxAdapter) DeleteSandbox(ctx context.Context, sandboxID string) (err error) {
	ctx, span := otel.Tracer("ctl/pkg/adapter/sandbox").Start(ctx, "SandboxAdapter.DeleteSandbox")
	defer func() { endSpanWithError(span, err) }()

	if err = validateSandboxID(sandboxID); err != nil {
		return err
	}
	if err = a.doRequest(ctx, "delete", http.MethodDelete, "/sandboxes/"+url.PathEscape(sandboxID), nil, nil, http.StatusNoContent, nil); err != nil {
		return err
	}
	a.envdTokenCache.Delete(sandboxID)
	return nil
}

func (a *SandboxAdapter) cacheEnvdAccessToken(sandboxID, accessToken string) {
	sandboxID = strings.TrimSpace(sandboxID)
	accessToken = strings.TrimSpace(accessToken)
	if sandboxID == "" || accessToken == "" {
		return
	}
	a.envdTokenCache.Store(sandboxID, accessToken)
}

func (a *SandboxAdapter) getEnvdAccessToken(ctx context.Context, sandboxID string) (string, error) {
	if cached, ok := a.envdTokenCache.Load(sandboxID); ok {
		if token, ok := cached.(string); ok {
			return token, nil
		}
	}
	detail, err := a.GetSandbox(ctx, sandboxID)
	if err != nil {
		return "", fmt.Errorf("get sandbox envd access token: %w", err)
	}
	return strings.TrimSpace(detail.EnvdAccessToken), nil
}

// PauseSandbox pauses a sandbox.
func (a *SandboxAdapter) PauseSandbox(ctx context.Context, sandboxID string) (err error) {
	ctx, span := otel.Tracer("ctl/pkg/adapter/sandbox").Start(ctx, "SandboxAdapter.PauseSandbox")
	defer func() { endSpanWithError(span, err) }()

	if err = validateSandboxID(sandboxID); err != nil {
		return err
	}
	return a.doRequest(ctx, "pause", http.MethodPost, "/sandboxes/"+url.PathEscape(sandboxID)+"/pause", nil, nil, http.StatusNoContent, nil)
}

// ResumeSandbox resumes a sandbox.
func (a *SandboxAdapter) ResumeSandbox(ctx context.Context, sandboxID string, req *ResumeSandboxRequest) (resp *Sandbox, err error) {
	ctx, span := otel.Tracer("ctl/pkg/adapter/sandbox").Start(ctx, "SandboxAdapter.ResumeSandbox")
	defer func() { endSpanWithError(span, err) }()

	if err = validateSandboxID(sandboxID); err != nil {
		return nil, err
	}
	resp = new(Sandbox)
	if err = a.doRequest(ctx, "resume", http.MethodPost, "/sandboxes/"+url.PathEscape(sandboxID)+"/resume", nil, req, http.StatusCreated, resp); err != nil {
		return nil, err
	}
	return resp, nil
}

// SetTimeout overwrites the sandbox timeout.
func (a *SandboxAdapter) SetTimeout(ctx context.Context, sandboxID string, timeoutSec int32) (err error) {
	ctx, span := otel.Tracer("ctl/pkg/adapter/sandbox").Start(ctx, "SandboxAdapter.SetTimeout")
	defer func() { endSpanWithError(span, err) }()

	if err = validateSandboxID(sandboxID); err != nil {
		return err
	}
	if timeoutSec < 0 {
		return errcode.ErrSandboxInvalidParam
	}
	body := map[string]int32{"timeout": timeoutSec}
	return a.doRequest(ctx, "settimeout", http.MethodPost, "/sandboxes/"+url.PathEscape(sandboxID)+"/timeout", nil, body, http.StatusNoContent, nil)
}

// Refresh extends sandbox lifetime.
func (a *SandboxAdapter) Refresh(ctx context.Context, sandboxID string, durationSec int32) (err error) {
	ctx, span := otel.Tracer("ctl/pkg/adapter/sandbox").Start(ctx, "SandboxAdapter.Refresh")
	defer func() { endSpanWithError(span, err) }()

	if err = validateSandboxID(sandboxID); err != nil {
		return err
	}
	if durationSec < 0 {
		return errcode.ErrSandboxInvalidParam
	}
	body := map[string]int32{"duration": durationSec}
	return a.doRequest(ctx, "refresh", http.MethodPost, "/sandboxes/"+url.PathEscape(sandboxID)+"/refreshes", nil, body, http.StatusNoContent, nil)
}

// GetLogs fetches sandbox logs.
func (a *SandboxAdapter) GetLogs(ctx context.Context, sandboxID string, req *GetLogsRequest) (resp *SandboxLogs, err error) {
	ctx, span := otel.Tracer("ctl/pkg/adapter/sandbox").Start(ctx, "SandboxAdapter.GetLogs")
	defer func() { endSpanWithError(span, err) }()

	if err = validateSandboxID(sandboxID); err != nil {
		return nil, err
	}
	query := url.Values{}
	if req != nil {
		if req.Start != nil {
			query.Set("start", fmt.Sprintf("%d", *req.Start))
		}
		if req.Limit != nil {
			query.Set("limit", fmt.Sprintf("%d", *req.Limit))
		}
	}

	resp = new(SandboxLogs)
	if err = a.doRequest(ctx, "getlogs", http.MethodGet, "/sandboxes/"+url.PathEscape(sandboxID)+"/logs", query, nil, http.StatusOK, resp); err != nil {
		return nil, err
	}
	return resp, nil
}

func (a *SandboxAdapter) StartTerminalSession(ctx context.Context, sandboxID string) (*TerminalSession, error) {
	if err := validateSandboxID(sandboxID); err != nil {
		return nil, err
	}
	resp := new(TerminalSession)
	if err := a.doRequest(ctx, "tat_session", http.MethodPost, "/sandboxes/"+url.PathEscape(sandboxID)+"/tat/session", nil, nil, http.StatusOK, resp); err != nil {
		return nil, err
	}
	return resp, nil
}

func (a *SandboxAdapter) doRequest(
	ctx context.Context,
	action string,
	method string,
	path string,
	query url.Values,
	reqBody interface{},
	expectedStatus int,
	respBody interface{},
) error {
	start := time.Now() // 记录请求开始时间

	logger := a.logger
	if ctxLogger, ok := ctx.(requestLogger); ok && ctxLogger.Logger() != nil {
		logger = ctxLogger.Logger().With(zap.String("component", "sandbox-adapter"))
	}

	traceID := ""
	if provider, ok := ctx.(requestIDProvider); ok {
		traceID = provider.GetRequestId()
	}

	bodyBytes, err := marshalBody(reqBody)
	if err != nil {
		metric.RecordSandboxAPICall(action, time.Since(start).Seconds(), errcode.ErrSandboxInvalidParam)
		return errcode.Wrap(errcode.ErrSandboxInvalidParam, "marshal request body")
	}

	requestURL := a.baseURL + path
	if len(query) > 0 {
		requestURL += "?" + query.Encode()
	}

	var lastErr error
	for attempt := 0; attempt <= a.retryConfig.MaxRetries; attempt++ {
		req, err := http.NewRequestWithContext(ctx, method, requestURL, bytes.NewReader(bodyBytes))
		if err != nil {
			metric.RecordSandboxAPICall(action, time.Since(start).Seconds(), errcode.ErrSandboxServiceError)
			return errcode.Wrap(errcode.ErrSandboxServiceError, "create request")
		}
		req.Header.Set("User-Agent", defaultUserAgent)
		req.Header.Set("Accept", "application/json")
		if reqBody != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		if traceID != "" {
			req.Header.Set("X-Trace-Id", traceID)
			req.Header.Set("X-Request-Id", traceID)
		}
		if a.apiKey != "" {
			req.Header.Set("X-API-Key", a.apiKey)
		}
		applySandboxSessionAuth(ctx, req, path)

		resp, reqErr := a.httpClient.Do(req)
		duration := time.Since(start)
		if reqErr != nil {
			lastErr = reqErr
			logger.Warn("sandbox request failed",
				zap.String("method", method),
				zap.String("path", path),
				zap.String("trace_id", traceID),
				zap.Duration("duration", duration),
				zap.Int("attempt", attempt+1),
				zap.Error(reqErr),
			)
			if shouldRetryNetwork(reqErr) && attempt < a.retryConfig.MaxRetries {
				if waitErr := sleepWithContext(ctx, backoff(a.retryConfig.RetryInterval, attempt)); waitErr != nil {
					metric.RecordSandboxAPICall(action, time.Since(start).Seconds(), waitErr)
					return waitErr
				}
				continue
			}
			if errorsIsContext(reqErr) {
				metric.RecordSandboxAPICall(action, time.Since(start).Seconds(), reqErr)
				return reqErr
			}
			if isTimeoutError(reqErr) {
				metric.RecordSandboxAPICall(action, time.Since(start).Seconds(), errcode.ErrSandboxTimeout)
				return errcode.Wrap(errcode.ErrSandboxTimeout, "sandbox request failed")
			}
			metric.RecordSandboxAPICall(action, time.Since(start).Seconds(), errcode.ErrSandboxServiceError)
			return errcode.Wrap(errcode.ErrSandboxServiceError, "sandbox request failed")
		}

		body, readErr := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		if readErr != nil {
			metric.RecordSandboxAPICall(action, time.Since(start).Seconds(), errcode.ErrSandboxServiceError)
			return errcode.Wrap(errcode.ErrSandboxServiceError, "read sandbox response")
		}

		logger.Info("sandbox request completed",
			zap.String("method", method),
			zap.String("path", path),
			zap.String("trace_id", traceID),
			zap.Int("status", resp.StatusCode),
			zap.Duration("duration", duration),
		)

		if resp.StatusCode >= 500 && attempt < a.retryConfig.MaxRetries {
			lastErr = errcode.Wrap(errcode.ErrSandboxServiceError, "sandbox returned status %d", resp.StatusCode)
			if waitErr := sleepWithContext(ctx, backoff(a.retryConfig.RetryInterval, attempt)); waitErr != nil {
				metric.RecordSandboxAPICall(action, time.Since(start).Seconds(), waitErr)
				return waitErr
			}
			continue
		}

		if resp.StatusCode != expectedStatus {
			apiErr := mapAPIError(resp.StatusCode, body)
			metric.RecordSandboxAPICall(action, time.Since(start).Seconds(), apiErr)
			return apiErr
		}

		if respBody != nil && len(body) > 0 {
			if err := json.Unmarshal(body, respBody); err != nil {
				metric.RecordSandboxAPICall(action, time.Since(start).Seconds(), errcode.ErrSandboxServiceError)
				return errcode.Wrap(errcode.ErrSandboxServiceError, "decode sandbox response")
			}
		}

		// 记录成功调用
		metric.RecordSandboxAPICall(action, time.Since(start).Seconds(), nil)
		return nil
	}

	if lastErr != nil {
		metric.RecordSandboxAPICall(action, time.Since(start).Seconds(), lastErr)
		return lastErr
	}
	metric.RecordSandboxAPICall(action, time.Since(start).Seconds(), errcode.ErrSandboxServiceError)
	return errcode.ErrSandboxServiceError
}

func marshalBody(body interface{}) ([]byte, error) {
	if body == nil {
		return nil, nil
	}
	content, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	return content, nil
}

func mapAPIError(status int, body []byte) error {
	var apiErr APIError
	_ = json.Unmarshal(body, &apiErr)
	message := strings.TrimSpace(apiErr.Message)

	var target *errcode.Error
	switch status {
	case http.StatusBadRequest:
		target = errcode.ErrSandboxInvalidParam
	case http.StatusUnauthorized:
		target = errcode.ErrSandboxAuthFailed
	case http.StatusNotFound:
		target = errcode.ErrSandboxNotFound
	case http.StatusConflict:
		target = errcode.ErrSandboxStatusConflict
	case http.StatusGatewayTimeout:
		target = errcode.ErrSandboxTimeout
	default:
		target = errcode.ErrSandboxServiceError
	}

	if message == "" {
		return target
	}
	return errcode.Wrap(target, "%s", message)
}

func backoff(base time.Duration, attempt int) time.Duration {
	if base <= 0 {
		base = defaultRetryIntervalMS * time.Millisecond
	}
	if attempt <= 0 {
		return base
	}
	if attempt >= 30 {
		attempt = 30
	}
	multiplier := time.Duration(math.Pow(2, float64(attempt)))
	return base * multiplier
}

func sleepWithContext(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()

	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func shouldRetryNetwork(err error) bool {
	if err == nil {
		return false
	}
	var netErr net.Error
	return errors.As(err, &netErr)
}

func isTimeoutError(err error) bool {
	if errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	var netErr net.Error
	return errors.As(err, &netErr) && netErr.Timeout()
}

func errorsIsContext(err error) bool {
	return errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded)
}

func validateSandboxID(sandboxID string) error {
	if strings.TrimSpace(sandboxID) == "" {
		return errcode.ErrSandboxInvalidParam
	}
	return nil
}

type sandboxSessionAuthProvider interface {
	GetSessionAuthorization() string
	GetSessionCookie() string
}

func applySandboxSessionAuth(ctx context.Context, req *http.Request, path string) {
	if req == nil || !strings.Contains(path, "/tat/") {
		return
	}
	provider, ok := ctx.(sandboxSessionAuthProvider)
	if !ok {
		return
	}
	if auth := strings.TrimSpace(provider.GetSessionAuthorization()); auth != "" {
		req.Header.Set("Authorization", auth)
	}
	if cookie := strings.TrimSpace(provider.GetSessionCookie()); cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
}

// tatShellPrefix 在 TAT 命令前注入环境初始化，确保 nvm/pnpm 安装的工具可用。
// TAT agent 以非登录 shell 执行脚本，不会 source ~/.bashrc，因此需要手动加载。
const tatShellPrefix = `export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; export PNPM_HOME="$HOME/.local/share/pnpm"; export PATH="$PNPM_HOME:$HOME/.local/bin:$PATH"; `

// ExecCommand executes a TAT command in the sandbox and polls until completion.
func (a *SandboxAdapter) ExecCommand(ctx context.Context, sandboxID string, bash string, timeoutSec int) (*ExecCommandResult, error) {
	if err := validateSandboxID(sandboxID); err != nil {
		return nil, err
	}
	if strings.TrimSpace(bash) == "" {
		return nil, errcode.ErrSandboxInvalidParam
	}
	if timeoutSec <= 0 {
		timeoutSec = defaultExecTimeoutSec
	}
	if timeoutSec > maxExecTimeoutSec {
		timeoutSec = maxExecTimeoutSec
	}

	// 统一注入环境初始化前缀，保证 nvm/pnpm 工具链可用
	bash = tatShellPrefix + bash

	// Step 1: Submit the command.
	invResp := new(TATCommandResponse)
	if err := a.doRequest(
		ctx, "tat_exec", http.MethodPost,
		"/sandboxes/"+url.PathEscape(sandboxID)+"/tat/commands",
		nil, &ExecCommandRequest{Bash: bash},
		http.StatusAccepted, invResp,
	); err != nil {
		return nil, err
	}

	invocationID := strings.TrimSpace(invResp.InvocationID)
	if invocationID == "" {
		return nil, errcode.Wrap(errcode.ErrSandboxServiceError, "empty invocation id from TAT")
	}

	// Step 2: Poll for the result with exponential backoff.
	deadline := time.Now().Add(time.Duration(timeoutSec) * time.Second)
	pollInterval := initialPollInterval

	for {
		if err := sleepWithContext(ctx, pollInterval); err != nil {
			return nil, err
		}

		if time.Now().After(deadline) {
			return &ExecCommandResult{
				InvocationID: invocationID,
				CommandID:    invResp.CommandID,
				Status:       "TIMEOUT",
			}, errcode.ErrSandboxTimeout
		}

		result := new(TATCommandResult)
		if err := a.doRequest(
			ctx, "tat_query", http.MethodGet,
			"/sandboxes/"+url.PathEscape(sandboxID)+"/tat/commands/"+url.PathEscape(invocationID),
			nil, nil, http.StatusOK, result,
		); err != nil {
			return nil, err
		}

		switch result.Status {
		case "SUCCESS", "FAILED":
			return &ExecCommandResult{
				InvocationID: result.InvocationID,
				CommandID:    result.CommandID,
				Status:       result.Status,
				ExitCode:     result.ExitCode,
				Output:       result.Output,
				ErrorInfo:    result.ErrorInfo,
				StartTime:    result.StartTime,
				EndTime:      result.EndTime,
			}, nil
		}

		// Exponential backoff, capped at maxPollInterval.
		if pollInterval < maxPollInterval {
			pollInterval *= 2
			if pollInterval > maxPollInterval {
				pollInterval = maxPollInterval
			}
		}
	}
}

// GetCommandResult queries the result of a previously submitted TAT command.
func (a *SandboxAdapter) GetCommandResult(ctx context.Context, sandboxID string, invocationID string) (*ExecCommandResult, error) {
	if err := validateSandboxID(sandboxID); err != nil {
		return nil, err
	}
	if strings.TrimSpace(invocationID) == "" {
		return nil, errcode.ErrSandboxInvalidParam
	}

	result := new(TATCommandResult)
	if err := a.doRequest(
		ctx, "tat_query", http.MethodGet,
		"/sandboxes/"+url.PathEscape(sandboxID)+"/tat/commands/"+url.PathEscape(invocationID),
		nil, nil, http.StatusOK, result,
	); err != nil {
		return nil, err
	}

	return &ExecCommandResult{
		InvocationID: result.InvocationID,
		CommandID:    result.CommandID,
		Status:       result.Status,
		ExitCode:     result.ExitCode,
		Output:       result.Output,
		ErrorInfo:    result.ErrorInfo,
		StartTime:    result.StartTime,
		EndTime:      result.EndTime,
	}, nil
}

// endSpanWithError 记录 Span 结束状态
func endSpanWithError(span trace.Span, err error) {
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
	}
	span.End()
}

var _ Adapter = (*SandboxAdapter)(nil)
