package federation

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

var (
	ErrTATUnauthorized = errors.New("TAT source session unauthorized")
	ErrTATNotFound     = errors.New("TAT bot not found")
	ErrTATConflict     = errors.New("TAT bot is not connectable")
	ErrTATTimeout      = errors.New("TAT upstream timeout")
	ErrTATUpstream     = errors.New("TAT upstream failure")
)

type TATClientConfig struct {
	BaseURL       string
	InternalToken string
	Timeout       time.Duration
	HTTPClient    *http.Client
}

type TATClient struct {
	baseURL       string
	internalToken string
	timeout       time.Duration
	httpClient    *http.Client
}

type TATBootstrap struct {
	SessionID        string `json:"sessionId"`
	Region           string `json:"region"`
	InstanceID       string `json:"instanceId"`
	OwnerUin         string `json:"ownerUin"`
	LoginUin         string `json:"loginUin"`
	AppID            int64  `json:"appId"`
	WsURL            string `json:"wsUrl"`
	Cols             int64  `json:"cols"`
	Rows             int64  `json:"rows"`
	TimeoutSeconds   int64  `json:"timeoutSeconds"`
	Username         string `json:"username,omitempty"`
	WorkingDirectory string `json:"workingDirectory,omitempty"`
}

func NewTATClient(config TATClientConfig) (*TATClient, error) {
	baseURL := strings.TrimRight(strings.TrimSpace(config.BaseURL), "/")
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, fmt.Errorf("invalid service-gateway base URL")
	}
	if config.Timeout <= 0 {
		return nil, fmt.Errorf("invalid TAT timeout")
	}
	internalToken := strings.TrimSpace(config.InternalToken)
	if internalToken == "" {
		return nil, fmt.Errorf("missing CTL internal token")
	}
	client := config.HTTPClient
	if client == nil {
		client = http.DefaultClient
	}
	return &TATClient{baseURL: baseURL, internalToken: internalToken, timeout: config.Timeout, httpClient: client}, nil
}

func (c *TATClient) CreateSession(ctx context.Context, botID, userID, requestID string) (TATBootstrap, string, error) {
	botID = strings.TrimSpace(botID)
	userID = strings.TrimSpace(userID)
	if botID == "" || strings.Contains(botID, "/") || userID == "" {
		return TATBootstrap{}, "", ErrTATUnauthorized
	}
	requestCtx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(requestCtx, http.MethodPost, c.baseURL+"/internal/bots/"+url.PathEscape(botID)+"/tat/session", nil)
	if err != nil {
		return TATBootstrap{}, "", fmt.Errorf("create TAT request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.internalToken)
	req.Header.Set("X-User-Id", userID)
	if strings.TrimSpace(requestID) != "" {
		req.Header.Set("X-Request-ID", strings.TrimSpace(requestID))
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(requestCtx.Err(), context.DeadlineExceeded) {
			return TATBootstrap{}, "", ErrTATTimeout
		}
		return TATBootstrap{}, "", fmt.Errorf("%w: %v", ErrTATUpstream, err)
	}
	defer resp.Body.Close()
	upstreamRequestID := strings.TrimSpace(resp.Header.Get("X-Request-ID"))
	switch resp.StatusCode {
	case http.StatusOK:
	case http.StatusUnauthorized:
		return TATBootstrap{}, upstreamRequestID, ErrTATUnauthorized
	case http.StatusForbidden:
		return TATBootstrap{}, upstreamRequestID, ErrTATConflict
	case http.StatusNotFound:
		return TATBootstrap{}, upstreamRequestID, ErrTATNotFound
	case http.StatusConflict, http.StatusUnprocessableEntity:
		return TATBootstrap{}, upstreamRequestID, ErrTATConflict
	case http.StatusGatewayTimeout:
		return TATBootstrap{}, upstreamRequestID, ErrTATTimeout
	default:
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		return TATBootstrap{}, upstreamRequestID, fmt.Errorf("%w: status %d", ErrTATUpstream, resp.StatusCode)
	}
	var envelope struct {
		Data TATBootstrap `json:"data"`
	}
	decoder := json.NewDecoder(io.LimitReader(resp.Body, 1<<20))
	if err := decoder.Decode(&envelope); err != nil {
		return TATBootstrap{}, upstreamRequestID, fmt.Errorf("%w: decode response", ErrTATUpstream)
	}
	if envelope.Data.SessionID == "" || envelope.Data.WsURL == "" || envelope.Data.Region == "" || envelope.Data.InstanceID == "" {
		return TATBootstrap{}, upstreamRequestID, fmt.Errorf("%w: incomplete response", ErrTATUpstream)
	}
	return envelope.Data, upstreamRequestID, nil
}
