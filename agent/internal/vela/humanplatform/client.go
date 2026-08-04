package humanplatform

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/vela/im"
)

const platformPrefix = "/v1"

var (
	ErrNotAuthenticated error = codedError{code: "AUTH_REQUIRED", message: "Human 尚未登录"}
	ErrUnsafeRequest          = errors.New("Human Platform 请求不在允许范围")
	ErrUnsafeBaseURL          = errors.New("Human Platform 远端地址必须使用 HTTPS")
)

type codedError struct {
	code    string
	message string
}

func (e codedError) Error() string      { return e.message }
func (e codedError) NativeCode() string { return e.code }

type Config struct {
	BaseURL           string
	StatePath         string
	AllowInsecureHTTP bool
	HTTP              *http.Client
	Now               func() time.Time
}

type Request struct {
	Method  string            `json:"method"`
	Path    string            `json:"path"`
	Body    any               `json:"body,omitempty"`
	Headers map[string]string `json:"headers,omitempty"`
}

type IMSession struct {
	SDKAppID int
	UserID   string
	UserSig  im.UserSig
	Expires  time.Time
}

type HTTPError struct {
	Status    int
	RequestID string
	Body      []byte
}

func (e *HTTPError) Error() string {
	if e.RequestID == "" {
		return fmt.Sprintf("Platform HTTP %d", e.Status)
	}
	return fmt.Sprintf("Platform HTTP %d (request %s)", e.Status, e.RequestID)
}

func (e *HTTPError) NativeCode() string {
	switch e.Status {
	case http.StatusBadRequest, http.StatusUnprocessableEntity:
		return "USAGE"
	case http.StatusUnauthorized:
		return "AUTH_REQUIRED"
	case http.StatusForbidden:
		return "AUTH_FORBIDDEN"
	case http.StatusNotFound:
		return "RESOURCE_NOT_FOUND"
	case http.StatusConflict, http.StatusPreconditionFailed:
		return "CONFLICT"
	case http.StatusTooManyRequests:
		return "RATE_LIMITED"
	default:
		if e.Status >= 500 {
			return "REMOTE_UNAVAILABLE"
		}
		return "PROTOCOL"
	}
}

type Client struct {
	baseURL   string
	statePath string
	http      *http.Client
	now       func() time.Time

	mu            sync.Mutex
	accessToken   string
	accessExpires time.Time
	refreshToken  string
}

type authResult struct {
	AccessToken  string         `json:"accessToken"`
	RefreshToken string         `json:"refreshToken"`
	ExpiresAt    string         `json:"expiresAt"`
	Account      map[string]any `json:"account"`
}

type sessionFile struct {
	RefreshToken string `json:"refreshToken"`
}

type imSessionWire struct {
	SDKAppID int    `json:"sdkAppId"`
	UserID   string `json:"userId"`
	UserSig  string `json:"userSig"`
	Expires  string `json:"expiresAt"`
}

func NewClient(config Config) (*Client, error) {
	baseURL := strings.TrimRight(strings.TrimSpace(config.BaseURL), "/")
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return nil, errors.New("Human Platform BaseURL 无效")
	}
	if parsed.Scheme != "https" &&
		(parsed.Scheme != "http" ||
			(!isLoopbackHost(parsed.Hostname()) && !config.AllowInsecureHTTP)) {
		return nil, ErrUnsafeBaseURL
	}
	if !strings.HasSuffix(parsed.Path, platformPrefix) {
		parsed.Path = strings.TrimRight(parsed.Path, "/") + platformPrefix
	}
	if config.StatePath == "" {
		return nil, errors.New("Human session 状态路径不能为空")
	}
	httpClient := config.HTTP
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 20 * time.Second}
	}
	now := config.Now
	if now == nil {
		now = time.Now
	}
	client := &Client{
		baseURL: parsed.String(), statePath: config.StatePath,
		http: httpClient, now: now,
	}
	if err := client.loadState(); err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	return client, nil
}

func isLoopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	address := net.ParseIP(host)
	return address != nil && address.IsLoopback()
}

func (c *Client) Login(ctx context.Context, email, password string) (map[string]any, error) {
	return c.authenticate(ctx, "/auth/login", map[string]any{"email": email, "password": password})
}

func (c *Client) Register(ctx context.Context, input map[string]any) (map[string]any, error) {
	return c.authenticate(ctx, "/auth/register", input)
}

func (c *Client) Restore(ctx context.Context) (map[string]any, error) {
	if err := c.refresh(ctx, false); err != nil {
		return nil, err
	}
	value, err := c.Request(ctx, Request{Method: http.MethodGet, Path: "/me"})
	if err != nil {
		return nil, err
	}
	account, ok := value.(map[string]any)
	if !ok {
		return nil, errors.New("Platform Account 响应无效")
	}
	return account, nil
}

func (c *Client) Logout(ctx context.Context) error {
	_, requestErr := c.Request(ctx, Request{Method: http.MethodPost, Path: "/auth/logout"})
	c.mu.Lock()
	c.accessToken = ""
	c.accessExpires = time.Time{}
	c.refreshToken = ""
	c.mu.Unlock()
	removeErr := os.Remove(c.statePath)
	if removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
		return removeErr
	}
	return requestErr
}

func (c *Client) authenticate(ctx context.Context, endpoint string, input any) (map[string]any, error) {
	body, err := common.Marshal(input)
	if err != nil {
		return nil, err
	}
	response, err := c.do(ctx, http.MethodPost, endpoint, body, nil, "")
	if err != nil {
		return nil, err
	}
	var result authResult
	if err := common.Unmarshal(response, &result); err != nil {
		return nil, errors.New("Platform AuthResult 响应无效")
	}
	if err := c.adopt(result); err != nil {
		return nil, err
	}
	return result.Account, nil
}

func (c *Client) Request(ctx context.Context, request Request) (any, error) {
	if err := validateRequest(request); err != nil {
		return nil, err
	}
	if err := c.refresh(ctx, false); err != nil {
		return nil, err
	}
	body, err := marshalOptional(request.Body)
	if err != nil {
		return nil, err
	}
	token := c.currentAccessToken()
	response, err := c.do(ctx, request.Method, request.Path, body, request.Headers, token)
	var httpError *HTTPError
	if errors.As(err, &httpError) && httpError.Status == http.StatusUnauthorized {
		if refreshErr := c.refresh(ctx, true); refreshErr != nil {
			return nil, refreshErr
		}
		response, err = c.do(ctx, request.Method, request.Path, body, request.Headers, c.currentAccessToken())
	}
	if err != nil {
		return nil, err
	}
	if len(bytes.TrimSpace(response)) == 0 {
		return nil, nil
	}
	var value any
	if err := common.Unmarshal(response, &value); err != nil {
		return nil, errors.New("Platform JSON 响应无效")
	}
	return value, nil
}

// IssueIMSession is deliberately not reachable through Request. Only the Go
// Human IM adapter receives the resulting UserSig value.
func (c *Client) IssueIMSession(ctx context.Context) (IMSession, error) {
	if err := c.refresh(ctx, false); err != nil {
		return IMSession{}, err
	}
	response, err := c.do(ctx, http.MethodPost, "/me/im/session", nil, nil, c.currentAccessToken())
	if err != nil {
		return IMSession{}, err
	}
	var wire imSessionWire
	if err := common.Unmarshal(response, &wire); err != nil {
		return IMSession{}, errors.New("Platform ImSession 响应无效")
	}
	userSig, err := im.NewUserSig(wire.UserSig)
	if err != nil {
		return IMSession{}, err
	}
	expires, err := time.Parse(time.RFC3339, wire.Expires)
	if err != nil {
		return IMSession{}, errors.New("Platform ImSession expiresAt 无效")
	}
	return IMSession{SDKAppID: wire.SDKAppID, UserID: wire.UserID, UserSig: userSig, Expires: expires}, nil
}

func (c *Client) refresh(ctx context.Context, force bool) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !force && c.accessToken != "" && c.now().Add(30*time.Second).Before(c.accessExpires) {
		return nil
	}
	if c.refreshToken == "" {
		return ErrNotAuthenticated
	}
	body, err := common.Marshal(map[string]any{"refreshToken": c.refreshToken})
	if err != nil {
		return err
	}
	response, err := c.do(ctx, http.MethodPost, "/auth/refresh", body, nil, "")
	if err != nil {
		return err
	}
	var result authResult
	if err := common.Unmarshal(response, &result); err != nil {
		return errors.New("Platform Refresh AuthResult 响应无效")
	}
	return c.adoptLocked(result)
}

func (c *Client) adopt(result authResult) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.adoptLocked(result)
}

func (c *Client) adoptLocked(result authResult) error {
	expires, err := time.Parse(time.RFC3339, result.ExpiresAt)
	if err != nil || result.AccessToken == "" || result.RefreshToken == "" {
		return errors.New("Platform AuthResult 缺少有效令牌")
	}
	if err := writeState(c.statePath, sessionFile{RefreshToken: result.RefreshToken}); err != nil {
		return err
	}
	c.accessToken = result.AccessToken
	c.accessExpires = expires
	c.refreshToken = result.RefreshToken
	return nil
}

func (c *Client) currentAccessToken() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.accessToken
}

func (c *Client) do(ctx context.Context, method, requestPath string, body []byte, headers map[string]string, token string) ([]byte, error) {
	request, err := http.NewRequestWithContext(ctx, method, c.baseURL+requestPath, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", "application/json")
	if len(body) > 0 {
		request.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	response, err := c.http.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	contents, err := io.ReadAll(io.LimitReader(response.Body, 8<<20))
	if err != nil {
		return nil, err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, &HTTPError{Status: response.StatusCode, RequestID: response.Header.Get("X-Request-ID"), Body: contents}
	}
	return contents, nil
}

func validateRequest(request Request) error {
	method := strings.ToUpper(strings.TrimSpace(request.Method))
	if method != http.MethodGet && method != http.MethodPost && method != http.MethodPatch && method != http.MethodPut && method != http.MethodDelete {
		return ErrUnsafeRequest
	}
	parsed, err := url.Parse(request.Path)
	if err != nil || parsed.IsAbs() || parsed.Host != "" || !strings.HasPrefix(parsed.Path, "/") || path.Clean(parsed.Path) != parsed.Path {
		return ErrUnsafeRequest
	}
	if parsed.Path == "/me/im/session" || strings.HasPrefix(parsed.Path, "/runtime/") || strings.HasPrefix(parsed.Path, "/computer/") || strings.HasPrefix(parsed.Path, "/callbacks/") {
		return ErrUnsafeRequest
	}
	allowed := parsed.Path == "/me" || parsed.Path == "/auth/logout" || parsed.Path == "/invites/accept" || parsed.Path == "/computer-installation-options" ||
		strings.HasPrefix(parsed.Path, "/servers") || strings.HasPrefix(parsed.Path, "/server-slugs/")
	if !allowed {
		return ErrUnsafeRequest
	}
	for name := range request.Headers {
		if !strings.EqualFold(name, "Idempotency-Key") && !strings.EqualFold(name, "X-Resource-Revision") {
			return ErrUnsafeRequest
		}
	}
	return nil
}

func marshalOptional(value any) ([]byte, error) {
	if value == nil {
		return nil, nil
	}
	return common.Marshal(value)
}

func (c *Client) loadState() error {
	contents, err := os.ReadFile(c.statePath)
	if err != nil {
		return err
	}
	var state sessionFile
	if err := common.Unmarshal(contents, &state); err != nil {
		return errors.New("Human session 状态损坏")
	}
	c.refreshToken = strings.TrimSpace(state.RefreshToken)
	return nil
}

func writeState(filename string, state sessionFile) error {
	directory := filepath.Dir(filename)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return err
	}
	if err := os.Chmod(directory, 0o700); err != nil {
		return err
	}
	contents, err := common.Marshal(state)
	if err != nil {
		return err
	}
	temporary, err := os.CreateTemp(directory, ".session-*")
	if err != nil {
		return err
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.Write(contents); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Rename(temporaryName, filename); err != nil {
		return err
	}
	directoryHandle, err := os.Open(directory)
	if err == nil {
		_ = directoryHandle.Sync()
		_ = directoryHandle.Close()
	}
	return nil
}
