package selfupdate

import (
	"context"
	"crypto/ed25519"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

var ErrChannelRequest = errors.New("Computer Update channel 请求失败")

type ChannelClientConfig struct {
	BaseURL               string
	HTTPClient            *http.Client
	AllowInsecureLoopback bool
	AllowInsecureHTTP     bool
	Channel               string
	Target                string
	KeyID                 string
	PublicKey             ed25519.PublicKey
	Now                   func() time.Time
}

type ChannelClient struct {
	baseURL   string
	http      *http.Client
	channel   string
	target    string
	keyID     string
	publicKey ed25519.PublicKey
	now       func() time.Time
}

func NewChannelClient(config ChannelClientConfig) (*ChannelClient, error) {
	baseURL, ok := normalizeChannelBaseURL(
		config.BaseURL,
		config.AllowInsecureLoopback,
		config.AllowInsecureHTTP,
	)
	if !ok || config.Now == nil ||
		(config.Channel != "stable" && config.Channel != "canary") ||
		(config.Target != "darwin-arm64" && config.Target != "linux-amd64") ||
		!keyIDPattern.MatchString(config.KeyID) || len(config.PublicKey) != ed25519.PublicKeySize {
		return nil, ErrChannelInvalid
	}
	client := &http.Client{Timeout: 20 * time.Second}
	if config.HTTPClient != nil {
		clone := *config.HTTPClient
		client = &clone
		if client.Timeout <= 0 {
			client.Timeout = 20 * time.Second
		}
	}
	client.CheckRedirect = func(_ *http.Request, _ []*http.Request) error {
		return http.ErrUseLastResponse
	}
	return &ChannelClient{
		baseURL: baseURL, http: client, channel: config.Channel, target: config.Target,
		keyID: config.KeyID, publicKey: append(ed25519.PublicKey(nil), config.PublicKey...),
		now: config.Now,
	}, nil
}

func (client *ChannelClient) Get(ctx context.Context) (VerifiedChannel, error) {
	if client == nil || ctx == nil {
		return VerifiedChannel{}, ErrChannelRequest
	}
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodGet,
		client.baseURL+"/computer-releases/"+client.channel+"/"+client.target,
		nil,
	)
	if err != nil {
		return VerifiedChannel{}, ErrChannelRequest
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Cache-Control", "no-store")
	response, err := client.http.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return VerifiedChannel{}, ctx.Err()
		}
		return VerifiedChannel{}, ErrChannelRequest
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK ||
		!strings.HasPrefix(strings.ToLower(response.Header.Get("Content-Type")), "application/json") ||
		!strings.EqualFold(strings.TrimSpace(response.Header.Get("Cache-Control")), "no-store") {
		return VerifiedChannel{}, ErrChannelRequest
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, maximumChannelEnvelopeBytes+1))
	if err != nil || len(raw) == 0 || len(raw) > maximumChannelEnvelopeBytes {
		return VerifiedChannel{}, ErrChannelRequest
	}
	return VerifyChannelEnvelope(raw, VerifyChannelConfig{
		Channel: client.channel, Target: client.target,
		KeyID: client.keyID, PublicKey: client.publicKey, Now: client.now().UTC(),
	})
}

func normalizeChannelBaseURL(
	raw string,
	allowInsecureLoopback bool,
	allowInsecureHTTP bool,
) (string, bool) {
	raw = strings.TrimSpace(raw)
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" ||
		parsed.Fragment != "" || (parsed.Path != "" && parsed.Path != "/") {
		return "", false
	}
	if parsed.Scheme != "https" {
		loopbackAllowed := allowInsecureLoopback && loopbackHost(parsed.Hostname())
		pinnedHTTPAllowed := allowInsecureHTTP && parsed.Scheme == "http"
		if parsed.Scheme != "http" || (!loopbackAllowed && !pinnedHTTPAllowed) {
			return "", false
		}
	} else if allowInsecureHTTP {
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
