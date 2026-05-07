package discovery

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/openclaw/openclaw/mono/cloudladdergateway/internal/config"
)

type PolarisResolver struct {
	sidecarURL   string
	cacheTTL     time.Duration
	staleOnError bool
	httpClient   *http.Client

	mu    sync.RWMutex
	cache map[string]cachedInstance
}

type cachedInstance struct {
	address   string
	expiresAt time.Time
}

type polarisResponse struct {
	Code      int               `json:"code"`
	Info      string            `json:"info"`
	Instances []polarisInstance `json:"instances"`
}

type polarisInstance struct {
	Host string `json:"host"`
	Port int    `json:"port"`
}

func NewPolarisResolver(cfg config.PolarisDiscoveryConfig, transport http.RoundTripper) (*PolarisResolver, error) {
	if cfg.SidecarURL == "" {
		cfg.SidecarURL = "http://127.0.0.1:8080"
	}
	cacheTTL, err := config.ParseDuration(cfg.CacheTTL, 30*time.Second)
	if err != nil {
		return nil, err
	}
	staleOnError := true
	if cfg.StaleOnError != nil {
		staleOnError = *cfg.StaleOnError
	}
	client := &http.Client{Timeout: 5 * time.Second}
	if transport != nil {
		client.Transport = transport
	}
	return &PolarisResolver{
		sidecarURL:   strings.TrimRight(cfg.SidecarURL, "/"),
		cacheTTL:     cacheTTL,
		staleOnError: staleOnError,
		httpClient:   client,
		cache:        map[string]cachedInstance{},
	}, nil
}

func (r *PolarisResolver) Resolve(ctx context.Context, service string, namespace string) (string, error) {
	key := service + ":" + namespace
	now := time.Now()

	r.mu.RLock()
	cached, ok := r.cache[key]
	if ok && now.Before(cached.expiresAt) {
		r.mu.RUnlock()
		return cached.address, nil
	}
	r.mu.RUnlock()

	address, err := r.query(ctx, service, namespace)
	if err != nil {
		r.mu.RLock()
		cached, ok := r.cache[key]
		r.mu.RUnlock()
		if r.staleOnError && ok {
			return cached.address, nil
		}
		return "", err
	}

	r.mu.Lock()
	r.cache[key] = cachedInstance{address: address, expiresAt: now.Add(r.cacheTTL)}
	r.mu.Unlock()
	return address, nil
}

func (r *PolarisResolver) query(ctx context.Context, service string, namespace string) (string, error) {
	payload, err := json.Marshal(map[string]string{
		"service":   service,
		"namespace": namespace,
	})
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, r.sidecarURL+"/v1/GetOneInstance", bytes.NewReader(payload))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := r.httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("query polaris sidecar: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("polaris sidecar returned status %d", resp.StatusCode)
	}
	var decoded polarisResponse
	if err := json.NewDecoder(resp.Body).Decode(&decoded); err != nil {
		return "", fmt.Errorf("decode polaris response: %w", err)
	}
	if len(decoded.Instances) == 0 {
		return "", fmt.Errorf("polaris returned no instances for %s/%s: code=%d info=%s", namespace, service, decoded.Code, decoded.Info)
	}
	instance := decoded.Instances[0]
	if instance.Host == "" || instance.Port <= 0 {
		return "", fmt.Errorf("polaris returned invalid instance for %s/%s", namespace, service)
	}
	return fmt.Sprintf("%s:%d", instance.Host, instance.Port), nil
}
