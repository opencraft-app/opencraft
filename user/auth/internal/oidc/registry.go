package oidc

import (
	"encoding/base64"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strings"
)

var (
	ErrInvalidClient  = errors.New("invalid oidc client")
	ErrInvalidRequest = errors.New("invalid oidc request")
	ErrInvalidGrant   = errors.New("invalid oidc grant")
)

// OpenCraft clients are first-party public clients, not authentication
// providers. They share the OIDC authorization authority and may exchange a
// grant for a normal LightVela API session through the first-party session
// adapter.
const NativeClientID = "opencraft-native-v1"
const NativeRedirectURI = "opencraft://auth/lightvela"
const WebClientID = "opencraft-web-v1"
const WebCNRedirectURI = "https://chat.lightvela.com/auth/lightvela/callback"
const WebInternationalRedirectURI = "https://chat.lightvela.ai/auth/lightvela/callback"

// This is an explicitly registered first-party exception, not a general-purpose
// redirect pattern. Authorization codes still bind to the concrete callback.
const WebDevCloudRedirectURI = "https://*.devcloud.woa.com/auth/lightvela/callback"

var devCloudHostPattern = regexp.MustCompile(`^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+devcloud\.woa\.com$`)

func IsFirstPartySessionClient(clientID string) bool {
	switch strings.TrimSpace(clientID) {
	case NativeClientID, WebClientID:
		return true
	default:
		return false
	}
}

type Client struct {
	ID           string
	DisplayName  string
	RedirectURIs []string
}

type Registry struct {
	clients map[string]Client
}

func NewRegistry(clients []Client) (*Registry, error) {
	if len(clients) == 0 {
		return nil, fmt.Errorf("%w: empty registry", ErrInvalidClient)
	}
	registry := &Registry{clients: make(map[string]Client, len(clients))}
	for _, client := range clients {
		client.ID = strings.TrimSpace(client.ID)
		client.DisplayName = strings.TrimSpace(client.DisplayName)
		if client.ID == "" || client.DisplayName == "" || len(client.RedirectURIs) == 0 {
			return nil, fmt.Errorf("%w: incomplete client", ErrInvalidClient)
		}
		if client.ID == NativeClientID && (len(client.RedirectURIs) != 1 || client.RedirectURIs[0] != NativeRedirectURI) {
			return nil, fmt.Errorf("%w: native client requires its exact callback", ErrInvalidClient)
		}
		if client.ID == WebClientID {
			if err := ValidateWebClientRedirectURIs(client.RedirectURIs); err != nil {
				return nil, err
			}
		}
		if _, exists := registry.clients[client.ID]; exists {
			return nil, fmt.Errorf("%w: duplicate client %q", ErrInvalidClient, client.ID)
		}
		for i, redirectURI := range client.RedirectURIs {
			if client.ID == WebClientID && redirectURI == WebDevCloudRedirectURI {
				continue
			}
			normalized, err := normalizeRedirectURI(redirectURI)
			if client.ID == NativeClientID && redirectURI == NativeRedirectURI {
				normalized, err = redirectURI, nil
			}
			if err != nil {
				return nil, fmt.Errorf("%w: invalid redirect URI for %q", ErrInvalidClient, client.ID)
			}
			client.RedirectURIs[i] = normalized
		}
		registry.clients[client.ID] = client
	}
	return registry, nil
}

// ValidateWebClientRedirectURIs keeps the canonical callbacks mandatory and
// permits only the opt-in DevCloud deployment family in addition to them.
func ValidateWebClientRedirectURIs(redirects []string) error {
	expected := []string{WebCNRedirectURI, WebInternationalRedirectURI}
	if len(redirects) == 3 {
		expected = append(expected, WebDevCloudRedirectURI)
	}
	if !equalStringSets(redirects, expected) {
		return fmt.Errorf("%w: invalid web client callbacks", ErrInvalidClient)
	}
	return nil
}

func equalStringSets(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	seen := make(map[string]int, len(left))
	for _, value := range left {
		seen[value]++
	}
	for _, value := range right {
		seen[value]--
		if seen[value] < 0 {
			return false
		}
	}
	return true
}

func (r *Registry) Client(clientID string) (Client, bool) {
	if r == nil {
		return Client{}, false
	}
	client, ok := r.clients[strings.TrimSpace(clientID)]
	return client, ok
}

func (r *Registry) ValidateRedirectURI(clientID string, redirectURI string) (string, error) {
	client, ok := r.Client(clientID)
	if !ok {
		return "", ErrInvalidClient
	}
	if err := validateRedirectURIStructure(redirectURI); err != nil && !(client.ID == NativeClientID && redirectURI == NativeRedirectURI) {
		return "", ErrInvalidClient
	}
	for _, allowed := range client.RedirectURIs {
		if client.ID == WebClientID && allowed == WebDevCloudRedirectURI {
			if isDevCloudRedirectURI(redirectURI) {
				return redirectURI, nil
			}
			continue
		}
		if allowed == redirectURI {
			return redirectURI, nil
		}
	}
	return "", ErrInvalidClient
}

func isDevCloudRedirectURI(raw string) bool {
	if _, err := normalizeRedirectURI(raw); err != nil {
		return false
	}
	parsed, _ := url.Parse(raw)
	return parsed.Path == "/auth/lightvela/callback" && len(parsed.Host) <= 253 && devCloudHostPattern.MatchString(parsed.Host)
}

func normalizeRedirectURI(raw string) (string, error) {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.User != nil || parsed.Fragment != "" || parsed.RawQuery != "" || parsed.RawPath != "" || parsed.Opaque != "" {
		return "", ErrInvalidClient
	}
	if parsed.Scheme != "https" {
		return "", ErrInvalidClient
	}
	host := parsed.Hostname()
	if host == "" || strings.Contains(host, "*") || parsed.Port() != "" || host != strings.ToLower(host) || strings.HasSuffix(host, ".") {
		return "", ErrInvalidClient
	}
	if parsed.Path == "" || parsed.Host != host {
		return "", ErrInvalidClient
	}
	canonical := (&url.URL{
		Scheme: "https",
		Host:   host,
		Path:   parsed.Path,
	}).String()
	if raw != canonical {
		return "", ErrInvalidClient
	}
	return canonical, nil
}

func validateRedirectURIStructure(raw string) error {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.User != nil || parsed.Fragment != "" || parsed.RawQuery != "" || parsed.RawPath != "" || parsed.Opaque != "" {
		return ErrInvalidClient
	}
	if parsed.Scheme != "https" || parsed.Host == "" || parsed.Path == "" || parsed.Port() != "" {
		return ErrInvalidClient
	}
	host := parsed.Hostname()
	if host == "" || strings.HasSuffix(host, ".") || host != parsed.Host {
		return ErrInvalidClient
	}
	return nil
}

func validateS256CodeChallenge(value string) error {
	if len(value) != 43 {
		return ErrInvalidRequest
	}
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil || len(decoded) != 32 {
		return ErrInvalidRequest
	}
	return nil
}
