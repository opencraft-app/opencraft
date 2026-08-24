package oidc

import (
	"encoding/base64"
	"errors"
	"fmt"
	"net/url"
	"strings"
)

var (
	ErrInvalidClient  = errors.New("invalid oidc client")
	ErrInvalidRequest = errors.New("invalid oidc request")
	ErrInvalidGrant   = errors.New("invalid oidc grant")
)

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
		if _, exists := registry.clients[client.ID]; exists {
			return nil, fmt.Errorf("%w: duplicate client %q", ErrInvalidClient, client.ID)
		}
		for i, redirectURI := range client.RedirectURIs {
			normalized, err := normalizeRedirectURI(redirectURI)
			if err != nil {
				return nil, fmt.Errorf("%w: invalid redirect URI for %q", ErrInvalidClient, client.ID)
			}
			client.RedirectURIs[i] = normalized
		}
		registry.clients[client.ID] = client
	}
	return registry, nil
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
	if err := validateRedirectURIStructure(redirectURI); err != nil {
		return "", ErrInvalidClient
	}
	for _, allowed := range client.RedirectURIs {
		if allowed == redirectURI {
			return redirectURI, nil
		}
	}
	return "", ErrInvalidClient
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
	if host == "" || parsed.Port() != "" || host != strings.ToLower(host) || strings.HasSuffix(host, ".") {
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
