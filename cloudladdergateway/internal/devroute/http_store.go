package devroute

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"

	"github.com/openclaw/openclaw/mono/cloudladdergateway/internal/tunnelcap"
	"github.com/openclaw/openclaw/mono/shared/cloudladdertransport"
)

const (
	developerRouteRegistryPath         = "/auth/internal/dev-environments/registration"
	developerRouteRegistryMaxBodyBytes = int64(1 << 20)
)

type HTTPStoreOptions struct {
	BaseURL          string
	Secret           string
	Caller           string
	RouteID          string
	Client           *http.Client
	Now              func() time.Time
	AllowedCIDRs     []string
	AllowedPorts     []int
	DeliveryMode     string
	TunnelBaseURL    string
	TunnelHostSuffix string
}

// HTTPStore persists developer route registrations through testing Auth.
// registry. Auth owns the durable MySQL state; CloudLadder still validates every
// value before using it as an upstream target.
type HTTPStore struct {
	baseURL          *url.URL
	secret           string
	caller           string
	routeID          string
	client           *http.Client
	now              func() time.Time
	allowedCIDRs     []netip.Prefix
	allowedPorts     map[int]struct{}
	deliveryMode     string
	tunnelBaseURL    string
	tunnelHostSuffix string
}

type registryRegistration struct {
	UIN             string     `json:"uin"`
	UserID          string     `json:"userId"`
	BaseURL         string     `json:"baseUrl"`
	DeliveryMode    string     `json:"deliveryMode"`
	SourceIP        string     `json:"sourceIp"`
	Port            int        `json:"port"`
	TunnelHost      string     `json:"tunnelHost"`
	TunnelTokenHash string     `json:"tunnelTokenHash"`
	RenewedAt       time.Time  `json:"renewedAt"`
	TTLSeconds      int        `json:"ttlSeconds"`
	DisabledAt      *time.Time `json:"disabledAt,omitempty"`
}

func NewHTTPStore(opts HTTPStoreOptions) (*HTTPStore, error) {
	baseURL, err := url.Parse(strings.TrimRight(strings.TrimSpace(opts.BaseURL), "/"))
	if err != nil || baseURL.Scheme == "" || baseURL.Host == "" || baseURL.User != nil || baseURL.RawQuery != "" || baseURL.Fragment != "" {
		return nil, errors.New("developer route registry base url must be an absolute http(s) url without credentials or query")
	}
	if baseURL.Scheme != "http" && baseURL.Scheme != "https" {
		return nil, errors.New("developer route registry base url must use http or https")
	}
	secret := strings.TrimSpace(opts.Secret)
	caller := strings.TrimSpace(opts.Caller)
	routeID := strings.TrimSpace(opts.RouteID)
	if secret == "" || caller == "" || routeID == "" {
		return nil, errors.New("developer route registry secret, caller, and route id are required")
	}
	allowedCIDRs, err := parsePrefixes(opts.AllowedCIDRs)
	if err != nil || len(allowedCIDRs) == 0 {
		return nil, errors.New("developer route registry requires valid allowed cidrs")
	}
	allowedPorts := make(map[int]struct{}, len(opts.AllowedPorts))
	for _, port := range opts.AllowedPorts {
		if port < 1 || port > 65535 {
			return nil, fmt.Errorf("invalid allowed port %d", port)
		}
		allowedPorts[port] = struct{}{}
	}
	if len(allowedPorts) == 0 {
		return nil, errors.New("developer route registry requires allowed ports")
	}
	deliveryMode := strings.ToLower(strings.TrimSpace(opts.DeliveryMode))
	if deliveryMode != DeliveryModeDirect && deliveryMode != DeliveryModeDevtunnel {
		return nil, fmt.Errorf("unsupported developer route delivery mode %q", deliveryMode)
	}
	tunnelBaseURL := strings.TrimRight(strings.TrimSpace(opts.TunnelBaseURL), "/")
	tunnelHostSuffix := normalizeTunnelHostSuffix(opts.TunnelHostSuffix)
	if deliveryMode == DeliveryModeDevtunnel {
		if err := validateTunnelBaseURL(tunnelBaseURL); err != nil {
			return nil, err
		}
		if tunnelHostSuffix == "" {
			return nil, errors.New("devtunnel host suffix is required")
		}
	}
	client := http.DefaultClient
	if opts.Client != nil {
		client = opts.Client
	}
	clientCopy := *client
	clientCopy.CheckRedirect = func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	return &HTTPStore{
		baseURL: baseURL, secret: secret, caller: caller, routeID: routeID,
		client: &clientCopy, now: now, allowedCIDRs: allowedCIDRs, allowedPorts: allowedPorts,
		deliveryMode: deliveryMode, tunnelBaseURL: tunnelBaseURL, tunnelHostSuffix: tunnelHostSuffix,
	}, nil
}

func (s *HTTPStore) Ready(ctx context.Context) error {
	resp, err := s.do(ctx, http.MethodGet, developerRouteRegistryPath+"/ready", nil, nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		return fmt.Errorf("developer route registry readiness returned status %d", resp.StatusCode)
	}
	return nil
}

func (s *HTTPStore) Get(ctx context.Context, uin string) (Registration, error) {
	uin = strings.TrimSpace(uin)
	if !validUIN(uin) {
		return Registration{}, errors.New("developer route registry uin is invalid")
	}
	query := url.Values{"uin": []string{uin}}
	resp, err := s.do(ctx, http.MethodGet, developerRouteRegistryPath, query, nil)
	if err != nil {
		return Registration{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return Registration{}, ErrNotFound
	}
	if resp.StatusCode != http.StatusOK {
		return Registration{}, fmt.Errorf("developer route registry get returned status %d", resp.StatusCode)
	}
	var stored registryRegistration
	decoder := json.NewDecoder(io.LimitReader(resp.Body, developerRouteRegistryMaxBodyBytes+1))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&stored); err != nil || decoder.Decode(&struct{}{}) != io.EOF {
		return Registration{}, errors.New("developer route registry returned an invalid registration")
	}
	registration, err := s.fromRegistry(stored, uin)
	if err != nil {
		return Registration{}, err
	}
	return registration, nil
}

func (s *HTTPStore) Upsert(ctx context.Context, registration Registration) error {
	if err := s.validateRegistration(registration, registration.UIN); err != nil {
		return err
	}
	body, err := json.Marshal(toRegistryRegistration(registration))
	if err != nil {
		return fmt.Errorf("encode developer route registration: %w", err)
	}
	resp, err := s.do(ctx, http.MethodPut, developerRouteRegistryPath, nil, body)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		return fmt.Errorf("developer route registry upsert returned status %d", resp.StatusCode)
	}
	return nil
}

func (s *HTTPStore) Disable(ctx context.Context, uin string, disabledAt time.Time) error {
	uin = strings.TrimSpace(uin)
	if !validUIN(uin) || disabledAt.IsZero() {
		return errors.New("developer route registry disable request is invalid")
	}
	body, err := json.Marshal(map[string]time.Time{"disabledAt": disabledAt.UTC()})
	if err != nil {
		return fmt.Errorf("encode developer route disable request: %w", err)
	}
	query := url.Values{"uin": []string{uin}}
	resp, err := s.do(ctx, http.MethodDelete, developerRouteRegistryPath, query, body)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return ErrNotFound
	}
	if resp.StatusCode != http.StatusNoContent {
		return fmt.Errorf("developer route registry disable returned status %d", resp.StatusCode)
	}
	return nil
}

func (s *HTTPStore) do(ctx context.Context, method string, path string, query url.Values, body []byte) (*http.Response, error) {
	endpoint := *s.baseURL
	escapedPath := strings.TrimRight(endpoint.EscapedPath(), "/") + path
	unescapedPath, err := url.PathUnescape(escapedPath)
	if err != nil {
		return nil, errors.New("developer route registry path is invalid")
	}
	endpoint.Path = unescapedPath
	endpoint.RawPath = escapedPath
	endpoint.RawQuery = query.Encode()
	request, err := http.NewRequestWithContext(ctx, method, endpoint.String(), bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("build developer route registry request: %w", err)
	}
	request.Header.Set("Accept", "application/json")
	if len(body) > 0 {
		request.Header.Set("Content-Type", "application/json")
	}
	cloudladdertransport.SignHTTPHeaders(s.secret, request.Header, cloudladdertransport.Request{
		Caller: s.caller, RouteID: s.routeID, Method: method,
		Path: endpoint.EscapedPath(), Query: endpoint.RawQuery, Body: body,
	}, s.now().UTC())
	response, err := s.client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("call developer route registry: %w", err)
	}
	return response, nil
}

func (s *HTTPStore) fromRegistry(stored registryRegistration, requestedUIN string) (Registration, error) {
	registration := Registration{
		UIN: strings.TrimSpace(stored.UIN), UserID: strings.TrimSpace(stored.UserID),
		BaseURL:      strings.TrimRight(strings.TrimSpace(stored.BaseURL), "/"),
		DeliveryMode: strings.ToLower(strings.TrimSpace(stored.DeliveryMode)),
		SourceIP:     strings.TrimSpace(stored.SourceIP), Port: stored.Port,
		TunnelHost:      strings.ToLower(strings.TrimSpace(stored.TunnelHost)),
		TunnelTokenHash: strings.ToLower(strings.TrimSpace(stored.TunnelTokenHash)),
		RenewedAt:       stored.RenewedAt.UTC(), TTL: time.Duration(stored.TTLSeconds) * time.Second,
		DisabledAt: stored.DisabledAt,
	}
	if registration.DisabledAt != nil {
		disabledAt := registration.DisabledAt.UTC()
		registration.DisabledAt = &disabledAt
	}
	if err := s.validateRegistration(registration, requestedUIN); err != nil {
		return Registration{}, err
	}
	return registration, nil
}

func (s *HTTPStore) validateRegistration(registration Registration, requestedUIN string) error {
	uin := strings.TrimSpace(registration.UIN)
	if !validUIN(uin) || uin != strings.TrimSpace(requestedUIN) || strings.TrimSpace(registration.UserID) == "" || registration.RenewedAt.IsZero() || registration.TTL < time.Minute || registration.TTL > 24*time.Hour {
		return errors.New("developer route registry registration is incomplete")
	}
	deliveryMode := strings.ToLower(strings.TrimSpace(registration.DeliveryMode))
	if deliveryMode != s.deliveryMode {
		return errors.New("developer route registry delivery mode does not match gateway")
	}
	sourceIP := strings.TrimSpace(registration.SourceIP)
	address, err := netip.ParseAddr(sourceIP)
	if err != nil {
		return errors.New("developer route registry source ip is not allowed")
	}
	address = address.Unmap()
	if address.Zone() != "" || address.String() != sourceIP || !containsAddress(s.allowedCIDRs, address) {
		return errors.New("developer route registry source ip is not allowed")
	}
	if _, ok := s.allowedPorts[registration.Port]; !ok {
		return errors.New("developer route registry port is not allowed")
	}
	baseURL := strings.TrimRight(strings.TrimSpace(registration.BaseURL), "/")
	tunnelHost := strings.ToLower(strings.TrimSpace(registration.TunnelHost))
	tunnelTokenHash := strings.ToLower(strings.TrimSpace(registration.TunnelTokenHash))
	switch deliveryMode {
	case DeliveryModeDirect:
		if tunnelHost != "" || tunnelTokenHash != "" {
			return errors.New("direct developer route must not contain tunnel credentials")
		}
		if err := validateDirectBaseURL(baseURL, address, registration.Port); err != nil {
			return err
		}
	case DeliveryModeDevtunnel:
		if baseURL != s.tunnelBaseURL {
			return errors.New("developer route registry tunnel base url does not match gateway")
		}
		if tunnelHost != tunnelHostForUIN(uin, s.tunnelHostSuffix) {
			return errors.New("developer route registry tunnel host does not match uin")
		}
		if !tunnelcap.ValidDigest(tunnelTokenHash) {
			return errors.New("developer route registry tunnel capability digest is invalid")
		}
	}
	return nil
}

func toRegistryRegistration(registration Registration) registryRegistration {
	return registryRegistration{
		UIN: strings.TrimSpace(registration.UIN), UserID: strings.TrimSpace(registration.UserID),
		BaseURL:      strings.TrimRight(strings.TrimSpace(registration.BaseURL), "/"),
		DeliveryMode: strings.ToLower(strings.TrimSpace(registration.DeliveryMode)),
		SourceIP:     strings.TrimSpace(registration.SourceIP), Port: registration.Port,
		TunnelHost:      strings.ToLower(strings.TrimSpace(registration.TunnelHost)),
		TunnelTokenHash: strings.ToLower(strings.TrimSpace(registration.TunnelTokenHash)),
		RenewedAt:       registration.RenewedAt.UTC(), TTLSeconds: int(registration.TTL / time.Second),
		DisabledAt: registration.DisabledAt,
	}
}
