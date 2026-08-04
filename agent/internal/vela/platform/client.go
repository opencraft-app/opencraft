// Package platform implements the Vela Agent's typed platform HTTP client.
package platform

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
)

const maxSessionResponseBytes = 1024 * 1024

var (
	ErrInvalidConfig      = errors.New("Vela 平台客户端配置无效")
	ErrInvalidSession     = errors.New("平台返回的 Runtime Session 无效")
	ErrCredentialRejected = errors.New("Runtime Credential 已失效")
	ErrRequestFailed      = errors.New("平台请求失败")
	ErrSensitiveMarshal   = errors.New("短期凭据禁止通用 JSON 序列化")
)

type Config struct {
	BaseURL               string
	HTTPClient            *http.Client
	AllowInsecureLoopback bool
	AllowInsecureHTTP     bool
	Now                   func() time.Time
	MaxSessionTTL         time.Duration
}

type Client struct {
	baseURL       string
	httpClient    *http.Client
	now           func() time.Time
	maxSessionTTL time.Duration
}

type secret struct {
	value string
}

type AccessToken struct {
	secret
}

type UserSig struct {
	secret
}

type AgentIdentity struct {
	ID           string
	ServerID     string
	UserID       string
	ReplyPolicy  string
	RuntimeKind  string
	RuntimeModel string
	Capabilities []string
}

type IMSession struct {
	SDKAppID  int
	UserID    string
	UserSig   UserSig
	ExpiresAt time.Time
}

type RuntimeSession struct {
	AccessToken AccessToken
	ExpiresAt   time.Time
	Agent       AgentIdentity
	IM          IMSession
}

func NewClient(config Config) (*Client, error) {
	baseURL, valid := normalizeBaseURL(
		config.BaseURL,
		config.AllowInsecureLoopback,
		config.AllowInsecureHTTP,
	)
	if !valid || config.Now == nil || config.MaxSessionTTL <= 0 {
		return nil, ErrInvalidConfig
	}
	httpClient, err := defaultHTTPClient()
	if err != nil {
		return nil, err
	}
	if config.HTTPClient != nil {
		clone := *config.HTTPClient
		httpClient = &clone
		if httpClient.Timeout <= 0 {
			httpClient.Timeout = 30 * time.Second
		}
	}
	httpClient.CheckRedirect = func(
		_ *http.Request,
		_ []*http.Request,
	) error {
		return http.ErrUseLastResponse
	}
	return &Client{
		baseURL:       baseURL,
		httpClient:    httpClient,
		now:           config.Now,
		maxSessionTTL: config.MaxSessionTTL,
	}, nil
}

func defaultHTTPClient() (*http.Client, error) {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	if caFile := strings.TrimSpace(os.Getenv("SSL_CERT_FILE")); caFile != "" {
		certificates, err := os.ReadFile(caFile)
		if err != nil || len(certificates) == 0 {
			return nil, ErrInvalidConfig
		}
		roots, err := x509.SystemCertPool()
		if err != nil {
			roots = x509.NewCertPool()
		}
		if !roots.AppendCertsFromPEM(certificates) {
			return nil, ErrInvalidConfig
		}
		tlsConfig := &tls.Config{
			MinVersion: tls.VersionTLS12,
			RootCAs:    roots,
		}
		if transport.TLSClientConfig != nil {
			tlsConfig = transport.TLSClientConfig.Clone()
			tlsConfig.RootCAs = roots
			if tlsConfig.MinVersion == 0 {
				tlsConfig.MinVersion = tls.VersionTLS12
			}
		}
		transport.TLSClientConfig = tlsConfig
	}
	return &http.Client{
		Timeout:   30 * time.Second,
		Transport: transport,
	}, nil
}

type runtimeSessionPayload struct {
	AccessToken *string   `json:"accessToken"`
	ExpiresAt   time.Time `json:"expiresAt"`
	Agent       struct {
		ID           string   `json:"id"`
		ServerID     string   `json:"serverId"`
		UserID       string   `json:"userId"`
		ReplyPolicy  string   `json:"replyPolicy"`
		Capabilities []string `json:"capabilities"`
		Runtime      struct {
			Kind  string `json:"kind"`
			Model string `json:"model"`
		} `json:"runtime"`
	} `json:"agent"`
	IM struct {
		SDKAppID  int       `json:"sdkAppId"`
		UserID    string    `json:"userId"`
		UserSig   *string   `json:"userSig"`
		ExpiresAt time.Time `json:"expiresAt"`
	} `json:"im"`
}

func newAccessToken(value string) (AccessToken, error) {
	if strings.TrimSpace(value) == "" {
		return AccessToken{}, ErrInvalidSession
	}
	return AccessToken{secret{value: value}}, nil
}

// NewAccessToken constructs a redacted short-lived Runtime token for typed
// integration boundaries and tests.
func NewAccessToken(value string) (AccessToken, error) {
	return newAccessToken(value)
}

func newUserSig(value string) (UserSig, error) {
	if strings.TrimSpace(value) == "" {
		return UserSig{}, ErrInvalidSession
	}
	return UserSig{secret{value: value}}, nil
}

// NewUserSig constructs a redacted short-lived UserSig for typed integration
// boundaries and tests. Long-lived Tencent credentials are never accepted.
func NewUserSig(value string) (UserSig, error) {
	return newUserSig(value)
}

func (s secret) Reveal() string {
	return s.value
}

func (secret) String() string {
	return "[REDACTED]"
}

func (secret) GoString() string {
	return "[REDACTED]"
}

func (secret) MarshalJSON() ([]byte, error) {
	return nil, ErrSensitiveMarshal
}

func (token AccessToken) Reveal() string {
	return token.secret.Reveal()
}

func (AccessToken) String() string {
	return "[REDACTED]"
}

func (AccessToken) GoString() string {
	return "[REDACTED]"
}

func (AccessToken) MarshalJSON() ([]byte, error) {
	return nil, ErrSensitiveMarshal
}

func (userSig UserSig) Reveal() string {
	return userSig.secret.Reveal()
}

func (UserSig) String() string {
	return "[REDACTED]"
}

func (UserSig) GoString() string {
	return "[REDACTED]"
}

func (UserSig) MarshalJSON() ([]byte, error) {
	return nil, ErrSensitiveMarshal
}

func normalizeBaseURL(
	raw string,
	allowLoopback bool,
	allowInsecureHTTP bool,
) (string, bool) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil ||
		parsed.Host == "" ||
		parsed.User != nil ||
		parsed.RawQuery != "" ||
		parsed.Fragment != "" {
		return "", false
	}
	switch parsed.Scheme {
	case "https":
	case "http":
		if !allowInsecureHTTP &&
			(!allowLoopback || !loopbackHost(parsed.Hostname())) {
			return "", false
		}
	default:
		return "", false
	}
	switch strings.TrimSuffix(parsed.Path, "/") {
	case "":
		parsed.Path = "/v1"
	case "/v1":
		parsed.Path = "/v1"
	default:
		return "", false
	}
	return strings.TrimSuffix(parsed.String(), "/"), true
}

func loopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	address := net.ParseIP(host)
	return address != nil && address.IsLoopback()
}

func validUUIDv7(value string) bool {
	parsed, err := uuid.Parse(value)
	return err == nil &&
		parsed.Version() == 7 &&
		parsed.String() == value
}

func validExpiry(value, now time.Time, maxTTL time.Duration) bool {
	value = value.UTC()
	return value.After(now) && !value.After(now.Add(maxTTL))
}

func validReplyPolicy(value string) bool {
	switch value {
	case "mention_and_dm", "all_channel_messages", "dm_only":
		return true
	default:
		return false
	}
}

func validRuntimeKind(value string) bool {
	switch value {
	case "codex", "hermes-acp", "hermes-gateway":
		return true
	default:
		return false
	}
}

type requestError struct {
	retryable  bool
	retryAfter time.Duration
}

func (*requestError) Error() string {
	return ErrRequestFailed.Error()
}

func (*requestError) Is(target error) bool {
	return target == ErrRequestFailed
}

func newRequestError(
	retryable bool,
	retryAfter time.Duration,
) *requestError {
	return &requestError{
		retryable:  retryable,
		retryAfter: retryAfter,
	}
}

func IsRetryable(err error) bool {
	var request *requestError
	return errors.As(err, &request) && request.retryable
}

func RetryAfter(err error) time.Duration {
	var request *requestError
	if !errors.As(err, &request) {
		return 0
	}
	return request.retryAfter
}

func parseRetryAfter(value string, now time.Time) time.Duration {
	value = strings.TrimSpace(value)
	if seconds, err := strconv.ParseUint(value, 10, 32); err == nil {
		return time.Duration(seconds) * time.Second
	}
	if when, err := http.ParseTime(value); err == nil && when.After(now) {
		return when.Sub(now)
	}
	return 0
}

func (c *Client) String() string {
	if c == nil {
		return "VelaPlatformClient<nil>"
	}
	return fmt.Sprintf("VelaPlatformClient<%s>", c.baseURL)
}
