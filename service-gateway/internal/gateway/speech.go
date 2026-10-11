package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

const speechRouteName = "speech"
const speechMaxBodyBytes = 4 * 1024 * 1024

var errSpeechKeyPending = errors.New("user key pending")

type SpeechConfig struct {
	ControlURL     string   `yaml:"control_url"`
	TrafficURL     string   `yaml:"traffic_url"`
	AdminTokenEnv  string   `yaml:"admin_token_env"`
	AllowedOrigins []string `yaml:"allowed_origins"`
}

type cachedSpeechKey struct {
	key     string
	expires time.Time
	err     error
}
type speechKeyFlight struct {
	done chan struct{}
	key  string
	err  error
}

// A cache is scoped to one regional service instance, never the credential authority.
type speechKeyCache struct {
	mu       sync.Mutex
	entries  map[string]cachedSpeechKey
	flights  map[string]*speechKeyFlight
	ttl      time.Duration
	capacity int
	resolve  func(context.Context, string) (string, error)
}

func (c *speechKeyCache) get(ctx context.Context, user string) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	c.mu.Lock()
	if entry, ok := c.entries[user]; ok && time.Now().Before(entry.expires) {
		c.mu.Unlock()
		return entry.key, entry.err
	}
	flight := c.flights[user]
	if flight == nil {
		if len(c.flights) >= 64 {
			c.mu.Unlock()
			return "", errors.New("key resolver busy")
		}
		flight = &speechKeyFlight{done: make(chan struct{})}
		c.flights[user] = flight
		go func() {
			// One caller cancelling must not cancel other callers' shared resolution.
			lookup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			key, err := c.resolve(lookup, user)
			c.mu.Lock()
			defer c.mu.Unlock()
			flight.key, flight.err = key, err
			if (err == nil && key != "") || errors.Is(err, errSpeechKeyPending) {
				now := time.Now()
				for id, entry := range c.entries {
					if !now.Before(entry.expires) {
						delete(c.entries, id)
					}
				}
				if len(c.entries) >= c.capacity {
					var oldest string
					var expires time.Time
					for id, entry := range c.entries {
						if oldest == "" || entry.expires.Before(expires) {
							oldest, expires = id, entry.expires
						}
					}
					delete(c.entries, oldest)
				}
				c.entries[user] = cachedSpeechKey{key: key, expires: now.Add(c.ttl), err: err}
			}
			delete(c.flights, user)
			close(flight.done)
		}()
	}
	c.mu.Unlock()
	select {
	case <-ctx.Done():
		return "", ctx.Err()
	case <-flight.done:
		return flight.key, flight.err
	}
}

func (c *speechKeyCache) invalidate(user, key string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if entry, ok := c.entries[user]; ok && entry.key == key {
		delete(c.entries, user)
	}
}

type speechService struct {
	cfg    SpeechConfig
	token  string
	client *http.Client
	keys   *speechKeyCache
}

func newSpeechService(cfg SpeechConfig) (*speechService, error) {
	for _, value := range []string{cfg.ControlURL, cfg.TrafficURL} {
		u, err := url.Parse(value)
		if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
			return nil, errors.New("speech requires control and traffic origin URLs")
		}
	}
	token := strings.TrimSpace(os.Getenv(cfg.AdminTokenEnv))
	if token == "" {
		return nil, errors.New("speech admin token env is required")
	}
	s := &speechService{cfg: cfg, token: token, client: &http.Client{Timeout: 95 * time.Second, Transport: newUpstreamTransport(90 * time.Second), CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
	s.keys = &speechKeyCache{entries: map[string]cachedSpeechKey{}, flights: map[string]*speechKeyFlight{}, ttl: 60 * time.Second, capacity: 4096, resolve: s.resolveKey}
	return s, nil
}

func speechRoute(cfg SpeechConfig) Route {
	return Route{Name: speechRouteName, Prefix: "/api/speech", Upstream: cfg.TrafficURL, Access: AccessAuthenticated,
		Methods: []string{http.MethodGet, http.MethodPost, http.MethodOptions}, AllowedOrigins: cfg.AllowedOrigins,
		PathPolicy: PathPolicyAllowlist, PathAllow: []PublicRule{{Method: http.MethodGet, Path: "/api/speech/capabilities"}, {Method: http.MethodPost, Path: "/api/speech/transcriptions"}}}
}

func (s *speechService) resolveKey(ctx context.Context, user string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(s.cfg.ControlURL, "/")+"/api/admin/users/"+url.PathEscape(user)+"/api-keys", strings.NewReader(`{"name":"default"}`))
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+s.token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.client.Do(req)
	if err != nil {
		return "", errors.New("key lookup unavailable")
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusAccepted {
		return "", errSpeechKeyPending
	}
	if resp.StatusCode != http.StatusOK {
		return "", errors.New("user key unavailable")
	}
	var body struct {
		Success bool `json:"success"`
		Data    struct {
			Key string `json:"api_key"`
		} `json:"data"`
	}
	if json.NewDecoder(io.LimitReader(resp.Body, 8192)).Decode(&body) != nil || !body.Success || !strings.HasPrefix(body.Data.Key, "sk-") || len(body.Data.Key) > 1024 {
		return "", errors.New("invalid key response")
	}
	return body.Data.Key, nil
}

func (s *speechService) serve(w http.ResponseWriter, r *http.Request, user string) {
	w.Header().Set("Cache-Control", "no-store")
	if r.URL.Path == "/api/speech/capabilities" {
		if _, err := s.keys.get(r.Context(), user); err != nil {
			writeJSON(w, 503, map[string]string{"error": "speech_unavailable"})
			return
		}
		// No token material or model-management surface crosses this boundary.
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"available": true, "model": "ep-hyasr3", "max_duration_ms": 120000, "max_audio_bytes": 3840044})
		return
	}
	media, params, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || media != "multipart/form-data" || params["boundary"] == "" {
		writeJSON(w, 400, map[string]string{"error": "invalid_audio"})
		return
	}
	if r.ContentLength > speechMaxBodyBytes {
		writeJSON(w, 413, map[string]string{"error": "audio_too_large"})
		return
	}
	key, err := s.keys.get(r.Context(), user)
	if err != nil {
		writeJSON(w, 503, map[string]string{"error": "speech_unavailable"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 95*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(s.cfg.TrafficURL, "/")+"/v1/audio/transcriptions", http.MaxBytesReader(w, r.Body, speechMaxBodyBytes))
	if err != nil {
		writeJSON(w, 502, map[string]string{"error": "speech_unavailable"})
		return
	}
	req.ContentLength = r.ContentLength
	req.Header.Set("Content-Type", r.Header.Get("Content-Type"))
	req.Header.Set("Authorization", "Bearer "+key)
	// Do not forward login cookies, user-provided credentials, redirects or identity headers.
	resp, err := s.client.Do(req)
	if err != nil {
		status := http.StatusBadGateway
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			status = http.StatusRequestEntityTooLarge
		}
		writeJSON(w, status, map[string]string{"error": "transcription_failed"})
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode == 401 || resp.StatusCode == 403 {
		s.keys.invalidate(user, key)
	}
	if resp.StatusCode != 200 {
		status := resp.StatusCode
		if status == 401 || status == 403 {
			status = 503
		}
		if status < 400 || status > 599 {
			status = 502
		}
		// Supplier error bodies may contain sensitive diagnostics. Never relay them.
		writeJSON(w, status, map[string]string{"error": "transcription_failed"})
		return
	}
	var body struct {
		Text string `json:"text"`
	}
	if json.NewDecoder(io.LimitReader(resp.Body, 128*1024)).Decode(&body) != nil || len(body.Text) > 128000 {
		writeJSON(w, 502, map[string]string{"error": "invalid_transcription"})
		return
	}
	writeJSON(w, 200, map[string]string{"text": body.Text})
}
