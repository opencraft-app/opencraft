package client

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

func (c *Client) Probe(ctx context.Context, plane Plane) (result Result, err error) {
	start := time.Now()
	path := "/readyz"
	result.Request = RequestSummary{Lane: AuthPublic, Method: http.MethodGet, Path: path}
	defer func() {
		if c.config.Trace != nil {
			c.config.Trace(Trace{Lane: AuthPublic, Method: http.MethodGet, Path: path, StatusCode: result.StatusCode, Duration: time.Since(start), DryRun: result.DryRun, Err: err})
		}
	}()
	baseURL, err := c.planeURL(plane)
	if err != nil {
		return result, err
	}
	if c.config.DryRun {
		result.DryRun = true
		return result, nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(baseURL, "/")+path, nil)
	if err != nil {
		return result, fmt.Errorf("create readiness request: %w", err)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return result, fmt.Errorf("probe %s plane: %w", plane, err)
	}
	defer resp.Body.Close()
	result.StatusCode = resp.StatusCode
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes+1))
	if err != nil {
		return result, fmt.Errorf("read readiness response: %w", err)
	}
	result.Data = raw
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return result, decodeAPIError(resp.StatusCode, http.MethodGet, path, raw)
	}
	return result, nil
}

func (c *Client) planeURL(plane Plane) (string, error) {
	switch plane {
	case PlaneControl:
		if strings.TrimSpace(c.config.ControlURL) == "" {
			return "", fmt.Errorf("control URL is required")
		}
		return c.config.ControlURL, nil
	case PlaneTraffic:
		if strings.TrimSpace(c.config.TrafficURL) == "" {
			return "", fmt.Errorf("traffic URL is required")
		}
		return c.config.TrafficURL, nil
	default:
		return "", fmt.Errorf("unknown plane %q", plane)
	}
}
