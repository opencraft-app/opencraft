package devroute

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/openclaw/openclaw/mono/shared/cloudladdertransport"
)

const registrationPath = "/v1/dev-environments/registration"

type Config struct {
	GatewayBaseURL string
	RouteID        string
	Caller         string
	Secret         string
	Timeout        time.Duration
	HTTPClient     *http.Client
	Now            func() time.Time
}

type Registration struct {
	Uin         int64     `json:"uin"`
	Status      string    `json:"status"`
	TargetIP    string    `json:"targetIp,omitempty"`
	Port        int       `json:"port,omitempty"`
	TunnelHost  string    `json:"tunnelHost,omitempty"`
	TunnelToken string    `json:"tunnelToken,omitempty"`
	ExpiresAt   time.Time `json:"expiresAt,omitempty"`
	UpdatedAt   time.Time `json:"updatedAt,omitempty"`
}

type RegisterInput struct {
	Uin        int64  `json:"uin"`
	TargetIP   string `json:"targetIp"`
	Port       int    `json:"port"`
	TTLSeconds int    `json:"ttlSeconds"`
}

type registerRequest struct {
	UIN        string `json:"uin"`
	TargetIP   string `json:"targetIp"`
	Port       int    `json:"port"`
	TTLSeconds int    `json:"ttlSeconds"`
}

type registrationResponse struct {
	UIN         string    `json:"uin"`
	Status      string    `json:"status"`
	TargetIP    string    `json:"targetIp,omitempty"`
	Port        int       `json:"port,omitempty"`
	TunnelHost  string    `json:"tunnelHost,omitempty"`
	TunnelToken string    `json:"tunnelToken,omitempty"`
	ExpiresAt   time.Time `json:"expiresAt,omitempty"`
	UpdatedAt   time.Time `json:"updatedAt,omitempty"`
}

type Error struct {
	Status  int
	Code    string
	Message string
}

func (e *Error) Error() string {
	if e == nil {
		return ""
	}
	if e.Code == "" {
		return e.Message
	}
	return e.Code + ": " + e.Message
}

type Client struct {
	baseURL *url.URL
	routeID string
	caller  string
	secret  string
	client  *http.Client
	now     func() time.Time
}

func New(cfg Config) (*Client, error) {
	baseURL, err := url.Parse(strings.TrimRight(strings.TrimSpace(cfg.GatewayBaseURL), "/"))
	if err != nil || baseURL.Scheme == "" || baseURL.Host == "" || baseURL.User != nil || baseURL.RawQuery != "" || baseURL.Fragment != "" {
		return nil, errors.New("developer route gateway base URL must be an absolute URL without credentials, query, or fragment")
	}
	if baseURL.Scheme != "http" && baseURL.Scheme != "https" {
		return nil, errors.New("developer route gateway base URL must use http or https")
	}
	if strings.TrimSpace(cfg.RouteID) == "" {
		return nil, errors.New("developer route route id is required")
	}
	if strings.TrimSpace(cfg.Caller) == "" {
		return nil, errors.New("developer route caller is required")
	}
	if cfg.Secret == "" {
		return nil, errors.New("developer route HMAC secret is required")
	}
	client := cfg.HTTPClient
	if client == nil {
		timeout := cfg.Timeout
		if timeout <= 0 {
			timeout = 10 * time.Second
		}
		client = &http.Client{Timeout: timeout}
	}
	now := cfg.Now
	if now == nil {
		now = time.Now
	}
	return &Client{
		baseURL: baseURL,
		routeID: strings.TrimSpace(cfg.RouteID),
		caller:  strings.TrimSpace(cfg.Caller),
		secret:  cfg.Secret,
		client:  client,
		now:     now,
	}, nil
}

func (c *Client) Register(ctx context.Context, input RegisterInput) (Registration, error) {
	if input.Uin <= 0 || strings.TrimSpace(input.TargetIP) == "" || input.Port <= 0 || input.Port > 65535 || input.TTLSeconds <= 0 {
		return Registration{}, errors.New("invalid developer route registration input")
	}
	body, err := json.Marshal(registerRequest{
		UIN:        strconv.FormatInt(input.Uin, 10),
		TargetIP:   input.TargetIP,
		Port:       input.Port,
		TTLSeconds: input.TTLSeconds,
	})
	if err != nil {
		return Registration{}, fmt.Errorf("encode developer route registration: %w", err)
	}
	return c.do(ctx, http.MethodPost, nil, body)
}

func (c *Client) Get(ctx context.Context, uin int64) (Registration, error) {
	if uin <= 0 {
		return Registration{}, errors.New("invalid developer route uin")
	}
	query := url.Values{"uin": []string{strconv.FormatInt(uin, 10)}}
	return c.do(ctx, http.MethodGet, query, nil)
}

func (c *Client) Disable(ctx context.Context, uin int64) (Registration, error) {
	if uin <= 0 {
		return Registration{}, errors.New("invalid developer route uin")
	}
	query := url.Values{"uin": []string{strconv.FormatInt(uin, 10)}}
	return c.do(ctx, http.MethodDelete, query, nil)
}

func (c *Client) do(ctx context.Context, method string, query url.Values, body []byte) (Registration, error) {
	endpoint := *c.baseURL
	endpoint.Path = strings.TrimRight(endpoint.Path, "/") + registrationPath
	endpoint.RawQuery = query.Encode()
	req, err := http.NewRequestWithContext(ctx, method, endpoint.String(), bytes.NewReader(body))
	if err != nil {
		return Registration{}, fmt.Errorf("create developer route request: %w", err)
	}
	if len(body) > 0 {
		req.Header.Set("Content-Type", "application/json")
	}
	cloudladdertransport.SignHTTPHeaders(c.secret, req.Header, cloudladdertransport.Request{
		Caller:  c.caller,
		RouteID: c.routeID,
		Method:  method,
		Path:    registrationPath,
		Query:   endpoint.RawQuery,
		Body:    body,
	}, c.now())
	response, err := c.client.Do(req)
	if err != nil {
		return Registration{}, fmt.Errorf("call developer route gateway: %w", err)
	}
	defer response.Body.Close()
	payload, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return Registration{}, fmt.Errorf("read developer route response: %w", err)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		var failure struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		}
		_ = json.Unmarshal(payload, &failure)
		if strings.TrimSpace(failure.Message) == "" {
			failure.Message = http.StatusText(response.StatusCode)
		}
		return Registration{}, &Error{Status: response.StatusCode, Code: strings.TrimSpace(failure.Code), Message: strings.TrimSpace(failure.Message)}
	}
	var wire registrationResponse
	if err := json.Unmarshal(payload, &wire); err != nil {
		return Registration{}, fmt.Errorf("decode developer route response: %w", err)
	}
	uin, err := strconv.ParseInt(strings.TrimSpace(wire.UIN), 10, 64)
	if err != nil || uin <= 0 || strconv.FormatInt(uin, 10) != wire.UIN || strings.TrimSpace(wire.Status) == "" {
		return Registration{}, errors.New("developer route response is incomplete")
	}
	return Registration{
		Uin:         uin,
		Status:      wire.Status,
		TargetIP:    wire.TargetIP,
		Port:        wire.Port,
		TunnelHost:  wire.TunnelHost,
		TunnelToken: wire.TunnelToken,
		ExpiresAt:   wire.ExpiresAt,
		UpdatedAt:   wire.UpdatedAt,
	}, nil
}
