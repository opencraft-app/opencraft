package cases

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"git.woa.com/wisp/mono2/llmgateway/test/regression/framework"
)

type HTTPInfrastructure struct {
	Client *http.Client
}

func (h HTTPInfrastructure) Preflight(ctx context.Context, cfg Config) (framework.Observations, error) {
	client := h.Client
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	checks := []struct {
		name string
		url  string
	}{
		{name: "control", url: strings.TrimRight(cfg.ControlURL, "/") + "/readyz"},
		{name: "traffic", url: strings.TrimRight(cfg.TrafficURL, "/") + "/readyz"},
		{name: "mock", url: strings.TrimRight(cfg.MockURL, "/") + "/health"},
		{name: "pacer", url: strings.TrimRight(cfg.PacerURL, "/") + "/healthz"},
	}
	result := framework.Observations{}
	for _, check := range checks {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, check.url, nil)
		if err != nil {
			return nil, err
		}
		resp, err := client.Do(req)
		if err != nil {
			return nil, fmt.Errorf("%s readiness check failed: %w", check.name, err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return nil, fmt.Errorf("%s readiness check returned %d", check.name, resp.StatusCode)
		}
		result[check.name+"_ready"] = true
	}
	return result, nil
}

type CombinedInfrastructure []Infrastructure

func (c CombinedInfrastructure) Preflight(ctx context.Context, cfg Config) (framework.Observations, error) {
	result := framework.Observations{}
	for _, infrastructure := range c {
		if infrastructure == nil {
			continue
		}
		observations, err := infrastructure.Preflight(ctx, cfg)
		if err != nil {
			return nil, err
		}
		for key, value := range observations {
			result[key] = value
		}
	}
	return result, nil
}
