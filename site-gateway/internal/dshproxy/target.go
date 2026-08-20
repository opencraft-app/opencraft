package dshproxy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"git.woa.com/wisp/mono/site-gateway/internal/tatproxy"
)

var (
	ErrMissingKey        = errors.New("missing DSH key")
	ErrTargetNotFound    = errors.New("DSH target not found")
	ErrTargetUnavailable = errors.New("DSH target resolver unavailable")
	ErrInvalidTarget     = errors.New("invalid DSH target response")
)

type Target = tatproxy.Target

type Resolver interface {
	Resolve(context.Context, string) (Target, error)
}

type HTTPResolver struct {
	url    string
	client *http.Client
}

func NewHTTPResolver(url string, client *http.Client) (*HTTPResolver, error) {
	url = strings.TrimSpace(url)
	if url == "" {
		return nil, errors.New("DSH target resolver URL is required")
	}
	if client == nil {
		return nil, errors.New("DSH target resolver HTTP client is required")
	}
	clientCopy := *client
	if clientCopy.CheckRedirect == nil {
		clientCopy.CheckRedirect = func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		}
	}
	return &HTTPResolver{url: url, client: &clientCopy}, nil
}

func (r *HTTPResolver) Resolve(ctx context.Context, key string) (Target, error) {
	if strings.TrimSpace(key) == "" {
		return Target{}, ErrMissingKey
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, r.url, nil)
	if err != nil {
		return Target{}, fmt.Errorf("%w: build request", ErrTargetUnavailable)
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Key", key)
	resp, err := r.client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return Target{}, ctx.Err()
		}
		return Target{}, fmt.Errorf("%w: request failed", ErrTargetUnavailable)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
		return Target{}, ErrTargetNotFound
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
		return Target{}, fmt.Errorf("%w: status %d", ErrTargetUnavailable, resp.StatusCode)
	}
	var envelope struct {
		Data struct {
			Region     string `json:"region"`
			InstanceID string `json:"instance_id"`
		} `json:"data"`
	}
	decoder := json.NewDecoder(io.LimitReader(resp.Body, 1<<20))
	if err := decoder.Decode(&envelope); err != nil {
		return Target{}, fmt.Errorf("%w: malformed JSON", ErrInvalidTarget)
	}
	target := Target{
		Region:     strings.TrimSpace(envelope.Data.Region),
		InstanceID: strings.TrimSpace(envelope.Data.InstanceID),
	}
	if target.Region == "" || target.InstanceID == "" {
		return Target{}, fmt.Errorf("%w: missing region or instance_id", ErrInvalidTarget)
	}
	if err := target.Validate(); err != nil {
		return Target{}, fmt.Errorf("%w: invalid region or instance_id", ErrInvalidTarget)
	}
	return target, nil
}
