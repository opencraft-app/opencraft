package tatproxy

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"
)

const (
	headerClientID  = "X-LightVela-Client-Id"
	headerKeyID     = "X-LightVela-Key-Id"
	headerTimestamp = "X-LightVela-Timestamp"
	headerRequestID = "X-LightVela-Request-Id"
	headerSignature = "X-LightVela-Signature"
	maxResponseBody = 1 << 20
	loginStateScope = "site-gateway/dsh-federation-state/v1"
)

var (
	ErrFederationUnauthorized = errors.New("federation session unauthorized")
	ErrFederationNotFound     = errors.New("federation bot not found")
	ErrFederationConflict     = errors.New("federation bot not connectable")
	ErrFederationTimeout      = errors.New("federation TAT request timed out")
	ErrFederationUpstream     = errors.New("federation TAT request failed")
)

// Target contains only the opaque authorization context supplied by the trusted
// access proxy. Physical instance information comes from Auth after ownership
// validation and is never accepted from the browser-facing request.
type Target struct {
	BotID            string
	DelegatedSession string
}

func (t Target) Key() string {
	sum := sha256.Sum256([]byte(t.BotID + "\x00" + t.DelegatedSession))
	return hex.EncodeToString(sum[:])
}

func (t Target) Validate() error {
	if !validBotID(t.BotID) {
		return errors.New("invalid DSH bot identifier")
	}
	if t.DelegatedSession == "" || len(t.DelegatedSession) > 16<<10 {
		return errors.New("invalid delegated session")
	}
	return nil
}

func validBotID(botID string) bool {
	if len(botID) == 0 || len(botID) > 59 || !isBotAlphaNumeric(botID[0]) || !isBotAlphaNumeric(botID[len(botID)-1]) {
		return false
	}
	for index := range len(botID) {
		value := botID[index]
		if !isBotAlphaNumeric(value) && value != '-' {
			return false
		}
	}
	return true
}

func isBotAlphaNumeric(value byte) bool {
	return value >= 'a' && value <= 'z' || value >= '0' && value <= '9'
}

type Bootstrap struct {
	SessionID      string `json:"sessionId"`
	Region         string `json:"region"`
	InstanceID     string `json:"instanceId"`
	OwnerUIN       string `json:"ownerUin"`
	LoginUIN       string `json:"loginUin"`
	AppID          int64  `json:"appId"`
	WSURL          string `json:"wsUrl"`
	Cols           int64  `json:"cols"`
	Rows           int64  `json:"rows"`
	TimeoutSeconds int64  `json:"timeoutSeconds"`
}

type Starter interface {
	Start(context.Context, Target) (Bootstrap, error)
}

type FederationStarterOptions struct {
	BaseURL    string
	ClientID   string
	KeyID      string
	HMACKey    []byte
	HTTPClient *http.Client
	Clock      func() time.Time
	RequestID  func() string
}

type FederationStarter struct {
	baseURL    *url.URL
	clientID   string
	keyID      string
	hmacKey    []byte
	httpClient *http.Client
	clock      func() time.Time
	requestID  func() string
}

// LoginState is kept in the DSH host's short-lived HttpOnly state cookie.
// The federation signer authenticates it so a browser cannot substitute a
// callback host or return path before the handoff ticket is exchanged.
type LoginState struct {
	Host      string `json:"host"`
	ReturnTo  string `json:"return_to"`
	State     string `json:"state"`
	ExpiresAt int64  `json:"expires_at"`
}

type DelegatedSession struct {
	Value     string
	ExpiresAt time.Time
}

func NewFederationStarter(opts FederationStarterOptions) (*FederationStarter, error) {
	baseURL, err := url.Parse(strings.TrimSpace(opts.BaseURL))
	if err != nil || (baseURL.Scheme != "http" && baseURL.Scheme != "https") || baseURL.Host == "" ||
		baseURL.User != nil || baseURL.RawQuery != "" || baseURL.Fragment != "" {
		return nil, errors.New("invalid federation base URL")
	}
	clientID := strings.TrimSpace(opts.ClientID)
	keyID := strings.TrimSpace(opts.KeyID)
	if clientID == "" || keyID == "" || len(opts.HMACKey) < 32 {
		return nil, errors.New("incomplete federation client credentials")
	}
	client := opts.HTTPClient
	if client == nil {
		client = &http.Client{}
	}
	clientCopy := *client
	clientCopy.CheckRedirect = func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}
	clock := opts.Clock
	if clock == nil {
		clock = time.Now
	}
	requestID := opts.RequestID
	if requestID == nil {
		requestID = uuid.NewString
	}
	return &FederationStarter{
		baseURL: baseURL, clientID: clientID, keyID: keyID,
		hmacKey: append([]byte(nil), opts.HMACKey...), httpClient: &clientCopy,
		clock: clock, requestID: requestID,
	}, nil
}

func (s *FederationStarter) Start(ctx context.Context, target Target) (Bootstrap, error) {
	if err := target.Validate(); err != nil {
		return Bootstrap{}, err
	}
	body, err := json.Marshal(struct {
		DelegatedSession string `json:"delegated_session"`
	}{DelegatedSession: target.DelegatedSession})
	if err != nil {
		return Bootstrap{}, ErrFederationUpstream
	}

	req, err := s.signedRequest(ctx, "/auth/federation/bots/"+target.BotID+"/tat/session", body)
	if err != nil {
		return Bootstrap{}, ErrFederationUpstream
	}

	resp, err := s.httpClient.Do(req)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return Bootstrap{}, ErrFederationTimeout
		}
		return Bootstrap{}, ErrFederationUpstream
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusOK:
	case http.StatusUnauthorized:
		return Bootstrap{}, ErrFederationUnauthorized
	case http.StatusNotFound:
		return Bootstrap{}, ErrFederationNotFound
	case http.StatusConflict:
		return Bootstrap{}, ErrFederationConflict
	case http.StatusGatewayTimeout:
		return Bootstrap{}, ErrFederationTimeout
	default:
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		return Bootstrap{}, fmt.Errorf("%w: status %d", ErrFederationUpstream, resp.StatusCode)
	}

	bootstrap, err := decodeBootstrap(resp.Body)
	if err != nil {
		return Bootstrap{}, ErrFederationUpstream
	}
	return bootstrap, nil
}

// ClientID identifies this gateway to the federation authorization page.
func (s *FederationStarter) ClientID() string {
	if s == nil {
		return ""
	}
	return s.clientID
}

func (s *FederationStarter) SealLoginState(host, returnTo, state string, ttl time.Duration) (string, error) {
	if s == nil || ttl <= 0 || strings.TrimSpace(host) == "" || strings.TrimSpace(returnTo) == "" || strings.TrimSpace(state) == "" {
		return "", ErrFederationUpstream
	}
	claims := LoginState{
		Host:      canonicalFederationHost(host),
		ReturnTo:  returnTo,
		State:     state,
		ExpiresAt: s.clock().Add(ttl).Unix(),
	}
	if claims.Host == "" {
		return "", ErrFederationUpstream
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", ErrFederationUpstream
	}
	payloadPart := base64.RawURLEncoding.EncodeToString(payload)
	mac := hmac.New(sha256.New, s.hmacKey)
	_, _ = mac.Write([]byte(loginStateScope + "." + payloadPart))
	return payloadPart + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}

func (s *FederationStarter) OpenLoginState(raw, expectedHost string) (LoginState, error) {
	parts := strings.SplitN(raw, ".", 2)
	if s == nil || len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return LoginState{}, ErrFederationUnauthorized
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return LoginState{}, ErrFederationUnauthorized
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return LoginState{}, ErrFederationUnauthorized
	}
	mac := hmac.New(sha256.New, s.hmacKey)
	_, _ = mac.Write([]byte(loginStateScope + "." + parts[0]))
	if !hmac.Equal(signature, mac.Sum(nil)) {
		return LoginState{}, ErrFederationUnauthorized
	}
	var claims LoginState
	if err := json.Unmarshal(payload, &claims); err != nil || claims.ExpiresAt <= s.clock().Unix() || claims.Host != canonicalFederationHost(expectedHost) || claims.State == "" || claims.ReturnTo == "" {
		return LoginState{}, ErrFederationUnauthorized
	}
	return claims, nil
}

func (s *FederationStarter) Exchange(ctx context.Context, ticket, redirectURI string) (DelegatedSession, error) {
	if s == nil || strings.TrimSpace(ticket) == "" || strings.TrimSpace(redirectURI) == "" {
		return DelegatedSession{}, ErrFederationUnauthorized
	}
	body, err := json.Marshal(struct {
		Ticket      string `json:"ticket"`
		RedirectURI string `json:"redirect_uri"`
	}{Ticket: ticket, RedirectURI: redirectURI})
	if err != nil {
		return DelegatedSession{}, ErrFederationUpstream
	}
	req, err := s.signedRequest(ctx, "/auth/federation/exchange", body)
	if err != nil {
		return DelegatedSession{}, ErrFederationUpstream
	}
	resp, err := s.httpClient.Do(req)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return DelegatedSession{}, ErrFederationTimeout
		}
		return DelegatedSession{}, ErrFederationUpstream
	}
	defer resp.Body.Close()
	if err := federationStatusError(resp.StatusCode); err != nil {
		return DelegatedSession{}, err
	}
	var payload struct {
		DelegatedSession string    `json:"delegated_session"`
		ExpiresAt        time.Time `json:"expires_at"`
	}
	if err := decodeFederationResponse(resp.Body, &payload); err != nil || payload.DelegatedSession == "" || !payload.ExpiresAt.After(s.clock()) {
		return DelegatedSession{}, ErrFederationUpstream
	}
	return DelegatedSession{Value: payload.DelegatedSession, ExpiresAt: payload.ExpiresAt}, nil
}

func (s *FederationStarter) signedRequest(ctx context.Context, path string, body []byte) (*http.Request, error) {
	endpoint := *s.baseURL
	endpoint.Path = strings.TrimRight(endpoint.Path, "/") + path
	endpoint.RawPath = ""
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	timestamp := s.clock().UTC().Format(time.RFC3339)
	requestID := s.requestID()
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(headerClientID, s.clientID)
	req.Header.Set(headerKeyID, s.keyID)
	req.Header.Set(headerTimestamp, timestamp)
	req.Header.Set(headerRequestID, requestID)
	req.Header.Set(headerSignature, s.signature(req, timestamp, requestID, body))
	return req, nil
}

func federationStatusError(status int) error {
	switch status {
	case http.StatusOK:
		return nil
	case http.StatusUnauthorized:
		return ErrFederationUnauthorized
	case http.StatusNotFound:
		return ErrFederationNotFound
	case http.StatusConflict:
		return ErrFederationConflict
	case http.StatusGatewayTimeout:
		return ErrFederationTimeout
	default:
		return ErrFederationUpstream
	}
}

func decodeFederationResponse(body io.Reader, out any) error {
	limited := &io.LimitedReader{R: body, N: maxResponseBody + 1}
	decoder := json.NewDecoder(limited)
	if err := decoder.Decode(out); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) || limited.N == 0 {
		return errors.New("invalid federation response")
	}
	return nil
}

func canonicalFederationHost(raw string) string {
	host := strings.TrimSuffix(strings.ToLower(strings.TrimSpace(raw)), ".")
	if parsed, err := url.Parse("https://" + host); err == nil && parsed.Hostname() != "" {
		return parsed.Hostname()
	}
	return ""
}

func decodeBootstrap(body io.Reader) (Bootstrap, error) {
	var bootstrap Bootstrap
	limited := &io.LimitedReader{R: body, N: maxResponseBody + 1}
	decoder := json.NewDecoder(limited)
	if err := decoder.Decode(&bootstrap); err != nil {
		return Bootstrap{}, err
	}
	// A second value or bytes beyond the bounded body are not part of the
	// federation contract. Reject both instead of accepting a valid JSON prefix.
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return Bootstrap{}, errors.New("invalid federation bootstrap response")
	}
	if limited.N == 0 {
		return Bootstrap{}, errors.New("oversized federation bootstrap response")
	}
	if err := validateBootstrap(bootstrap); err != nil {
		return Bootstrap{}, err
	}
	return bootstrap, nil
}

func (s *FederationStarter) signature(req *http.Request, timestamp, requestID string, body []byte) string {
	bodyHash := sha256.Sum256(body)
	canonical := strings.Join([]string{
		s.clientID,
		s.keyID,
		req.Method,
		req.URL.EscapedPath(),
		req.URL.Query().Encode(),
		timestamp,
		requestID,
		hex.EncodeToString(bodyHash[:]),
	}, "\n")
	mac := hmac.New(sha256.New, s.hmacKey)
	_, _ = mac.Write([]byte(canonical))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func validateBootstrap(bootstrap Bootstrap) error {
	if bootstrap.SessionID == "" || !validRegion(bootstrap.Region) || !validInstanceID(bootstrap.InstanceID) ||
		bootstrap.OwnerUIN == "" || bootstrap.AppID == 0 || bootstrap.WSURL == "" {
		return errors.New("incomplete federation bootstrap")
	}
	wsURL, err := url.Parse(bootstrap.WSURL)
	wantHost := bootstrap.Region + ".forward.tat-tc.tencent.cn"
	if err != nil || wsURL.Scheme != "wss" || !strings.EqualFold(wsURL.Hostname(), wantHost) ||
		wsURL.Port() != "" || wsURL.User != nil || wsURL.RawQuery != "" || wsURL.Fragment != "" || wsURL.Path != "/ws" {
		return errors.New("invalid federation websocket URL")
	}
	return nil
}
