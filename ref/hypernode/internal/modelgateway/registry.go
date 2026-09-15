package modelgateway

import (
	"fmt"
	"net/url"
	"strings"
	"sync"
)

// Provider contains only non-secret routing metadata. API credentials arrive
// on individual HTTP requests. The registry only keeps a volatile, per-user
// copy long enough to inject it into that user's Codex process environment.
type Provider struct {
	ID       string `json:"id"`
	Endpoint string `json:"endpoint"`
}

type Registry struct {
	mu          sync.RWMutex
	providers   map[string]Provider
	credentials map[string]map[string]credential
	active      map[string]string
}

type credential struct {
	providerID  string
	apiKey      string
	model       string
	displayName string
}

type UserRuntimeConfig struct {
	ProviderID  string
	APIKey      string
	Model       string
	DisplayName string
}

func NewRegistry() *Registry {
	return &Registry{
		providers:   make(map[string]Provider),
		credentials: make(map[string]map[string]credential),
		active:      make(map[string]string),
	}
}

func (r *Registry) Register(id, endpoint string) (Provider, error) {
	id = strings.TrimSpace(id)
	if id == "" || strings.ContainsAny(id, "/\\?#") {
		return Provider{}, fmt.Errorf("invalid model provider id")
	}
	normalized, err := NormalizeChatCompletionsEndpoint(endpoint)
	if err != nil {
		return Provider{}, err
	}
	provider := Provider{ID: id, Endpoint: normalized}
	r.mu.Lock()
	r.providers[id] = provider
	r.mu.Unlock()
	return provider, nil
}

func (r *Registry) Unregister(id string) {
	r.mu.Lock()
	delete(r.providers, id)
	r.mu.Unlock()
}

func (r *Registry) Get(id string) (Provider, bool) {
	r.mu.RLock()
	provider, ok := r.providers[id]
	r.mu.RUnlock()
	return provider, ok
}

// SetUserCredential deliberately keeps the API key in memory only. It is not
// serialized to SQLite, TOML, auth.json, logs, or gateway responses.
func (r *Registry) SetUserCredential(username, providerID, apiKey, model, displayName string) error {
	username = strings.TrimSpace(username)
	providerID = strings.TrimSpace(providerID)
	if username == "" {
		return fmt.Errorf("model credential username is required")
	}
	if apiKey == "" {
		return fmt.Errorf("model API key is required")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.providers[providerID]; !ok {
		return fmt.Errorf("unknown model provider %q", providerID)
	}
	profiles := r.credentials[username]
	if profiles == nil {
		profiles = make(map[string]credential)
		r.credentials[username] = profiles
	}
	profiles[providerID] = credential{
		providerID: providerID, apiKey: apiKey,
		model: strings.TrimSpace(model), displayName: strings.TrimSpace(displayName),
	}
	r.active[username] = providerID
	return nil
}

func (r *Registry) UserRuntimeConfig(username string) (UserRuntimeConfig, bool) {
	r.mu.RLock()
	username = strings.TrimSpace(username)
	providerID, active := r.active[username]
	value, ok := r.credentials[username][providerID]
	r.mu.RUnlock()
	if !active || !ok {
		return UserRuntimeConfig{}, false
	}
	return UserRuntimeConfig{
		ProviderID: value.providerID, APIKey: value.apiKey,
		Model: value.model, DisplayName: value.displayName,
	}, true
}

// UserRuntimeConfigForProvider resolves a process-scoped route without
// consulting the user's mutable default selection. An already-running Codex
// backend must remain bound to the provider it was spawned with.
func (r *Registry) UserRuntimeConfigForProvider(username, providerID string) (UserRuntimeConfig, bool) {
	r.mu.RLock()
	username = strings.TrimSpace(username)
	providerID = strings.TrimSpace(providerID)
	value, ok := r.credentials[username][providerID]
	r.mu.RUnlock()
	if providerID == "" || !ok {
		return UserRuntimeConfig{}, false
	}
	return UserRuntimeConfig{
		ProviderID: value.providerID, APIKey: value.apiKey,
		Model: value.model, DisplayName: value.displayName,
	}, true
}

func (r *Registry) UserCredential(username string) (providerID, apiKey string, ok bool) {
	r.mu.RLock()
	username = strings.TrimSpace(username)
	providerID, active := r.active[username]
	value, ok := r.credentials[username][providerID]
	r.mu.RUnlock()
	if !active || !ok {
		return "", "", false
	}
	return value.providerID, value.apiKey, true
}

func (r *Registry) UserCredentialLoaded(username, providerID string) bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	username = strings.TrimSpace(username)
	if providerID == "" {
		providerID = r.active[username]
	}
	_, ok := r.credentials[username][providerID]
	return providerID != "" && ok
}

func (r *Registry) ActivateUserCredential(username, providerID string) error {
	username = strings.TrimSpace(username)
	providerID = strings.TrimSpace(providerID)
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.credentials[username][providerID]; !ok {
		return fmt.Errorf("model credential for provider %q is not loaded", providerID)
	}
	r.active[username] = providerID
	return nil
}

func (r *Registry) DeactivateUserCredential(username string) {
	r.mu.Lock()
	delete(r.active, strings.TrimSpace(username))
	r.mu.Unlock()
}

func (r *Registry) RemoveUserCredential(username, providerID string) {
	username = strings.TrimSpace(username)
	providerID = strings.TrimSpace(providerID)
	r.mu.Lock()
	if profiles := r.credentials[username]; profiles != nil {
		delete(profiles, providerID)
		if len(profiles) == 0 {
			delete(r.credentials, username)
		}
	}
	if r.active[username] == providerID {
		delete(r.active, username)
	}
	r.mu.Unlock()
}

func (r *Registry) ClearUserCredential(username string) {
	r.mu.Lock()
	username = strings.TrimSpace(username)
	delete(r.credentials, username)
	delete(r.active, username)
	r.mu.Unlock()
}

func NormalizeChatCompletionsEndpoint(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	parsed, err := url.Parse(raw)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return "", fmt.Errorf("model endpoint must be an absolute http(s) URL")
	}
	parsed.Fragment = ""
	parsed.RawQuery = ""
	path := strings.TrimRight(parsed.Path, "/")
	switch {
	case strings.HasSuffix(path, "/chat/completions"):
		// Already a full endpoint.
	case strings.HasSuffix(path, "/v1"):
		path += "/chat/completions"
	case path == "":
		path = "/v1/chat/completions"
	default:
		path += "/v1/chat/completions"
	}
	parsed.Path = path
	return parsed.String(), nil
}
