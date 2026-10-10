package tat

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"

	tencenttatport "chatserver/internal/ports/tencenttat"
)

const maximumSessionIssuerResponse = 64 << 10

// SessionIssuerConfig 配置平台内部 TAT Session Issuer Gateway。
type SessionIssuerConfig struct {
	BaseURL      string
	ServiceToken string
	HTTPClient   *http.Client
}

// HTTPSessionIssuer 调用内部控制面签发一次性 TAT PTY 数据通道。
type HTTPSessionIssuer struct {
	endpoint string
	token    string
	client   *http.Client
}

// NewHTTPSessionIssuer 创建不会跟随重定向的内部 Gateway Client。
func NewHTTPSessionIssuer(config SessionIssuerConfig) (*HTTPSessionIssuer, error) {
	endpoint, err := url.Parse(strings.TrimSpace(config.BaseURL))
	token := strings.TrimSpace(config.ServiceToken)
	if err != nil || endpoint.Host == "" ||
		endpoint.User != nil || endpoint.RawQuery != "" || endpoint.Fragment != "" ||
		!safeIssuerScheme(endpoint) ||
		len(token) < 16 || len(token) > 4096 ||
		strings.ContainsAny(token, "\r\n\x00") ||
		config.HTTPClient == nil {
		return nil, errors.New("TAT Session Issuer 配置无效")
	}
	endpoint.Path = path.Join(
		strings.TrimSuffix(endpoint.Path, "/"),
		"/v1/tat/terminal-sessions",
	)
	client := *config.HTTPClient
	client.CheckRedirect = func(
		_ *http.Request,
		_ []*http.Request,
	) error {
		return http.ErrUseLastResponse
	}
	return &HTTPSessionIssuer{
		endpoint: endpoint.String(),
		token:    token,
		client:   &client,
	}, nil
}

type terminalSessionRequest struct {
	ComputerID   string `json:"computerId"`
	Region       string `json:"region"`
	InstanceKind string `json:"instanceKind"`
	InstanceID   string `json:"instanceId"`
	OSType       string `json:"osType"`
}

type terminalSessionResponse struct {
	SessionID      string    `json:"sessionId"`
	WSURL          string    `json:"wsUrl"`
	ExpiresAt      time.Time `json:"expiresAt"`
	OwnerUIN       string    `json:"ownerUin"`
	AppID          int64     `json:"appId"`
	InstanceID     string    `json:"instanceId"`
	Cols           int       `json:"cols"`
	Rows           int       `json:"rows"`
	TimeoutSeconds int       `json:"timeoutSeconds"`
}

// Issue 只返回短期引导信息，不保存或代理终端内容。
func (issuer *HTTPSessionIssuer) Issue(
	ctx context.Context,
	target tencenttatport.TerminalTarget,
) (tencenttatport.TerminalSession, error) {
	if issuer == nil || issuer.client == nil || ctx == nil ||
		target.Validate() != nil {
		return tencenttatport.TerminalSession{},
			newError("terminal_invalid_request", false, false)
	}
	payload, err := json.Marshal(terminalSessionRequest{
		ComputerID:   target.ComputerID,
		Region:       target.Region,
		InstanceKind: target.InstanceKind,
		InstanceID:   target.InstanceID,
		OSType:       string(target.OS),
	})
	if err != nil {
		return tencenttatport.TerminalSession{},
			newError("terminal_request_encode_failed", false, false)
	}
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		issuer.endpoint,
		bytes.NewReader(payload),
	)
	if err != nil {
		return tencenttatport.TerminalSession{},
			newError("terminal_invalid_request", false, false)
	}
	request.Header.Set("Authorization", "Bearer "+issuer.token)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	response, err := issuer.client.Do(request)
	if err != nil {
		return tencenttatport.TerminalSession{},
			newError("terminal_session_unavailable", true, false)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusCreated &&
		response.StatusCode != http.StatusOK {
		return tencenttatport.TerminalSession{},
			sessionIssuerHTTPError(response.StatusCode)
	}
	limited := io.LimitReader(response.Body, maximumSessionIssuerResponse+1)
	data, err := io.ReadAll(limited)
	if err != nil || len(data) == 0 || len(data) > maximumSessionIssuerResponse {
		return tencenttatport.TerminalSession{},
			newError("terminal_response_invalid", false, false)
	}
	var decoded terminalSessionResponse
	if err := json.Unmarshal(data, &decoded); err != nil {
		return tencenttatport.TerminalSession{},
			newError("terminal_response_invalid", false, false)
	}
	return tencenttatport.TerminalSession{
		SessionID:      decoded.SessionID,
		WebSocketURL:   decoded.WSURL,
		ExpiresAt:      decoded.ExpiresAt.UTC(),
		OwnerUIN:       decoded.OwnerUIN,
		AppID:          decoded.AppID,
		InstanceID:     decoded.InstanceID,
		Cols:           decoded.Cols,
		Rows:           decoded.Rows,
		MaxIdleSeconds: decoded.TimeoutSeconds,
	}, nil
}

func safeIssuerScheme(endpoint *url.URL) bool {
	if endpoint.Scheme == "https" {
		return true
	}
	if endpoint.Scheme != "http" {
		return false
	}
	host := endpoint.Hostname()
	ip := net.ParseIP(host)
	return strings.EqualFold(host, "localhost") || ip != nil && ip.IsLoopback()
}

func sessionIssuerHTTPError(status int) error {
	switch status {
	case http.StatusNotFound:
		return newError("terminal_target_not_found", false, false)
	case http.StatusConflict:
		return newError("terminal_target_offline", true, false)
	case http.StatusTooManyRequests:
		return newError("terminal_rate_limited", true, false)
	case http.StatusUnauthorized, http.StatusForbidden:
		return newError("terminal_session_rejected", false, false)
	default:
		return newError("terminal_session_unavailable", status >= 500, false)
	}
}

// UnavailableSessionIssuer 保持未配置环境的其他平台能力可用。
type UnavailableSessionIssuer struct{}

func (UnavailableSessionIssuer) Issue(
	context.Context,
	tencenttatport.TerminalTarget,
) (tencenttatport.TerminalSession, error) {
	return tencenttatport.TerminalSession{},
		newError("terminal_session_unavailable", false, false)
}

var _ tencenttatport.TerminalSessionIssuer = (*HTTPSessionIssuer)(nil)
var _ tencenttatport.TerminalSessionIssuer = UnavailableSessionIssuer{}
