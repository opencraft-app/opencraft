package federation

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"strings"
)

var ErrInvalidClient = errors.New("invalid federation client")

type CallbackHost struct {
	Host              string
	IncludeSubdomains bool
}

type Client struct {
	ID                string
	DisplayName       string
	CallbackPath      string
	CallbackHosts     []CallbackHost
	ExactCallbackURLs []string
	HMACKeys          map[string][]byte
}

type Registry struct {
	clients map[string]Client
}

func NewRegistry(clients []Client) (*Registry, error) {
	registry := &Registry{clients: make(map[string]Client, len(clients))}
	for _, client := range clients {
		client.ID = strings.TrimSpace(client.ID)
		client.DisplayName = strings.TrimSpace(client.DisplayName)
		if client.ID == "" || client.DisplayName == "" || client.CallbackPath == "" || (len(client.CallbackHosts) == 0 && len(client.ExactCallbackURLs) == 0) || len(client.HMACKeys) == 0 {
			return nil, fmt.Errorf("%w: incomplete client", ErrInvalidClient)
		}
		if _, exists := registry.clients[client.ID]; exists {
			return nil, fmt.Errorf("%w: duplicate client %q", ErrInvalidClient, client.ID)
		}
		for keyID, secret := range client.HMACKeys {
			if strings.TrimSpace(keyID) == "" || len(secret) < 32 {
				return nil, fmt.Errorf("%w: invalid HMAC key for %q", ErrInvalidClient, client.ID)
			}
		}
		for i, raw := range client.ExactCallbackURLs {
			normalized, err := normalizeExactCallback(raw, client.CallbackPath)
			if err != nil {
				return nil, fmt.Errorf("%w: invalid exact callback for %q", ErrInvalidClient, client.ID)
			}
			client.ExactCallbackURLs[i] = normalized
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

func (r *Registry) ValidateCallback(clientID, raw string) (string, error) {
	client, ok := r.Client(clientID)
	if !ok {
		return "", ErrInvalidClient
	}
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Scheme != "https" || parsed.User != nil || parsed.Fragment != "" || parsed.RawQuery != "" || parsed.Opaque != "" {
		if normalized, exactErr := normalizeExactCallback(raw, client.CallbackPath); exactErr == nil && slicesContain(client.ExactCallbackURLs, normalized) {
			return normalized, nil
		}
		return "", fmt.Errorf("%w: invalid callback URL", ErrInvalidClient)
	}
	if parsed.Path != client.CallbackPath || parsed.RawPath != "" {
		return "", fmt.Errorf("%w: invalid callback path", ErrInvalidClient)
	}
	normalizedHTTPS := (&url.URL{Scheme: "https", Host: strings.ToLower(parsed.Host), Path: client.CallbackPath}).String()
	if slicesContain(client.ExactCallbackURLs, normalizedHTTPS) {
		return normalizedHTTPS, nil
	}
	host := strings.ToLower(strings.TrimSuffix(parsed.Hostname(), "."))
	port := parsed.Port()
	if host == "" || net.ParseIP(host) != nil || (port != "" && port != "443") {
		return "", fmt.Errorf("%w: invalid callback host", ErrInvalidClient)
	}
	owned := false
	for _, allowed := range client.CallbackHosts {
		allowedHost := strings.ToLower(strings.TrimSuffix(strings.TrimSpace(allowed.Host), "."))
		if host == allowedHost || (allowed.IncludeSubdomains && strings.HasSuffix(host, "."+allowedHost)) {
			owned = true
			break
		}
	}
	if !owned {
		return "", fmt.Errorf("%w: callback host is not registered", ErrInvalidClient)
	}
	return (&url.URL{Scheme: "https", Host: host, Path: client.CallbackPath}).String(), nil
}

func normalizeExactCallback(raw string, callbackPath string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.User != nil || parsed.Fragment != "" || parsed.RawQuery != "" || parsed.Opaque != "" || parsed.RawPath != "" || parsed.Path != callbackPath {
		return "", ErrInvalidClient
	}
	scheme := strings.ToLower(parsed.Scheme)
	hostname := strings.ToLower(strings.TrimSuffix(parsed.Hostname(), "."))
	if hostname == "" {
		return "", ErrInvalidClient
	}
	if scheme == "http" && hostname != "localhost" && hostname != "127.0.0.1" && hostname != "::1" {
		return "", ErrInvalidClient
	}
	if scheme != "http" && scheme != "https" {
		return "", ErrInvalidClient
	}
	host := hostname
	if strings.Contains(hostname, ":") {
		host = "[" + hostname + "]"
	}
	if port := parsed.Port(); port != "" && !((scheme == "https" && port == "443") || (scheme == "http" && port == "80")) {
		host += ":" + port
	}
	return (&url.URL{Scheme: scheme, Host: host, Path: callbackPath}).String(), nil
}

func slicesContain(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
