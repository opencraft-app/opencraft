package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type apiClient struct {
	baseURL string
	token   string
	client  *http.Client
}

type apiEnvelope struct {
	Success bool            `json:"success"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data"`
}

type apiKey struct {
	ExternalKey    string `json:"external_key"`
	SetID          string `json:"set_id"`
	UpstreamUserID int64  `json:"upstream_user_id"`
}

type userState struct {
	SetID          string `json:"set_id"`
	UpstreamUserID int64  `json:"upstream_user_id"`
}

type bundleState struct {
	SetID              string `json:"set_id"`
	Status             string `json:"status"`
	AppliedFingerprint string `json:"applied_fingerprint"`
}

type channelBundleSnapshot struct {
	ID   string `json:"id"`
	Spec struct {
		Options []struct {
			Key   string `json:"key"`
			Value any    `json:"value"`
		} `json:"options"`
	} `json:"spec"`
}

type upgradeBatch struct {
	ID     string       `json:"id"`
	Status string       `json:"status"`
	Runs   []upgradeRun `json:"runs"`
}

type upgradeRun struct {
	ID             string `json:"id"`
	SetID          string `json:"set_id"`
	FromGeneration int64  `json:"from_generation"`
	ToGeneration   int64  `json:"to_generation"`
	Status         string `json:"status"`
	LastError      string `json:"last_error"`
}

func newAPIClient(baseURL, token string) apiClient {
	return apiClient{
		baseURL: trimURL(baseURL), token: token,
		client: &http.Client{Timeout: 90 * time.Second},
	}
}

func (c apiClient) do(ctx context.Context, method, path string, body, out any) error {
	var reader io.Reader
	if body != nil {
		payload, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(payload)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, reader)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	resp, err := c.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("%s %s returned %d: %s", method, path, resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	var envelope apiEnvelope
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return fmt.Errorf("decode %s %s: %w", method, path, err)
	}
	if !envelope.Success {
		return fmt.Errorf("%s %s failed: %s", method, path, envelope.Message)
	}
	if out != nil && len(envelope.Data) > 0 && string(envelope.Data) != "null" {
		if err := json.Unmarshal(envelope.Data, out); err != nil {
			return fmt.Errorf("decode data from %s %s: %w", method, path, err)
		}
	}
	return nil
}

func (c apiClient) listSets(ctx context.Context) ([]managedSet, error) {
	var sets []managedSet
	err := c.do(ctx, http.MethodGet, "/api/sets", nil, &sets)
	return sets, err
}

func (c apiClient) set(ctx context.Context, id string) (managedSet, error) {
	sets, err := c.listSets(ctx)
	if err != nil {
		return managedSet{}, err
	}
	for _, set := range sets {
		if set.ID == id {
			return set, nil
		}
	}
	return managedSet{}, fmt.Errorf("set %q is not managed", id)
}

func (c apiClient) assignUser(ctx context.Context, userID, setID string) error {
	return retryTransient(ctx, 5, func() error {
		return c.do(ctx, http.MethodPost, "/api/internal/users/"+url.PathEscape(userID)+"/assignment", map[string]any{
			"backend": "new", "set_id": setID,
		}, nil)
	})
}

func (c apiClient) createKey(ctx context.Context, userID string) (apiKey, error) {
	var key apiKey
	err := retryTransient(ctx, 5, func() error {
		return c.do(ctx, http.MethodPost, "/api/users/"+url.PathEscape(userID)+"/keys", nil, &key)
	})
	if err != nil {
		return key, err
	}
	if key.SetID != "" && key.UpstreamUserID != 0 {
		return key, nil
	}
	var state userState
	if err := c.do(ctx, http.MethodGet, "/api/admin/users/"+url.PathEscape(userID)+"/state", nil, &state); err != nil {
		return key, err
	}
	key.SetID = state.SetID
	key.UpstreamUserID = state.UpstreamUserID
	return key, nil
}

func retryTransient(ctx context.Context, attempts int, operation func() error) error {
	var lastErr error
	for attempt := 1; attempt <= attempts; attempt++ {
		lastErr = operation()
		if lastErr == nil || !isTransientControlError(lastErr) || attempt == attempts {
			return lastErr
		}
		if !waitContext(ctx, time.Duration(attempt*attempt)*100*time.Millisecond) {
			return ctx.Err()
		}
	}
	return lastErr
}

func isTransientControlError(err error) bool {
	if err == nil {
		return false
	}
	message := err.Error()
	for _, marker := range []string{
		"Error 1213", "Error 1205", "returned 429", "returned 502", "returned 503",
		"connection reset", "unexpected EOF",
	} {
		if strings.Contains(message, marker) {
			return true
		}
	}
	return false
}

func (c apiClient) grantQuota(ctx context.Context, key apiKey, quota int64) error {
	return c.do(ctx, http.MethodPost, "/_llmgateway_console/"+url.PathEscape(key.SetID)+"/api/user/manage", map[string]any{
		"id": key.UpstreamUserID, "action": "add_quota", "mode": "add", "value": quota,
	}, nil)
}

func (c apiClient) upsertBundle(ctx context.Context, cfg config) error {
	options, err := c.soakPricingOptions(ctx, cfg.Model)
	if err != nil {
		return err
	}
	mapping, _ := json.Marshal(map[string]string{cfg.Model: cfg.UpstreamModel})
	return c.do(ctx, http.MethodPost, "/api/channel-bundles", map[string]any{
		"id": cfg.BundleID, "name": "Set upgrade soak mock channel",
		"description": "Controlled E2E channel backed by kagent mockllm through the SSE pacer.",
		"spec": map[string]any{
			"version": 1, "kind": "newapi-channel-bundle",
			"options": options,
			"channels": []map[string]any{{
				"id": "upgrade-soak-openai", "name": "Set upgrade soak mock channel", "type": 1,
				"key": cfg.UpstreamKey, "base_url": cfg.PacerPublicURL,
				"models": cfg.Model, "model_mapping": string(mapping), "group": "default",
				"priority": 100, "weight": 0, "status": "enabled",
			}},
		},
	}, nil)
}

func (c apiClient) soakPricingOptions(ctx context.Context, model string) ([]map[string]string, error) {
	var bundles []channelBundleSnapshot
	if err := c.do(ctx, http.MethodGet, "/api/channel-bundles", nil, &bundles); err != nil {
		return nil, fmt.Errorf("read golden channel bundle: %w", err)
	}
	var golden *channelBundleSnapshot
	for index := range bundles {
		if bundles[index].ID == "golden-channels" {
			golden = &bundles[index]
			break
		}
	}
	if golden == nil {
		return nil, fmt.Errorf("golden channel bundle %q is required before running shared-environment soak", "golden-channels")
	}
	byKey := make(map[string]any, len(golden.Spec.Options))
	for _, option := range golden.Spec.Options {
		byKey[option.Key] = option.Value
	}
	result := make([]map[string]string, 0, 2)
	for _, key := range []string{"CompletionRatio", "ModelRatio"} {
		value, ok := byKey[key]
		if !ok {
			return nil, fmt.Errorf("golden channel bundle %q does not contain %s", golden.ID, key)
		}
		values, err := decodeRatioSnapshot(value)
		if err != nil {
			return nil, fmt.Errorf("decode golden %s: %w", key, err)
		}
		values[model] = 1
		raw, err := json.Marshal(values)
		if err != nil {
			return nil, fmt.Errorf("encode merged %s: %w", key, err)
		}
		result = append(result, map[string]string{"key": key, "value": string(raw)})
	}
	return result, nil
}

func decodeRatioSnapshot(value any) (map[string]any, error) {
	if result, ok := value.(map[string]any); ok {
		copy := make(map[string]any, len(result)+1)
		for key, item := range result {
			copy[key] = item
		}
		return copy, nil
	}
	text, ok := value.(string)
	if !ok {
		return nil, fmt.Errorf("expected JSON object or string, got %T", value)
	}
	result := map[string]any{}
	if err := json.Unmarshal([]byte(text), &result); err != nil {
		return nil, err
	}
	return result, nil
}

func (c apiClient) applyBundle(ctx context.Context, bundleID, setID string) error {
	var state bundleState
	if err := c.do(ctx, http.MethodPost, "/api/channel-bundles/"+url.PathEscape(bundleID)+"/apply", map[string]string{"set_id": setID}, &state); err != nil {
		return err
	}
	if state.Status != "synced" || state.AppliedFingerprint == "" {
		return fmt.Errorf("bundle %s on set %s is %q", bundleID, setID, state.Status)
	}
	return nil
}

func (c apiClient) createUpgrade(ctx context.Context, cfg config) (upgradeBatch, error) {
	var batch upgradeBatch
	err := c.do(ctx, http.MethodPost, "/api/admin/set-upgrades", map[string]any{
		"set_ids": []string{cfg.TargetSetID}, "target_image": cfg.TargetImage,
		"source": cfg.Source, "namespace": cfg.Namespace, "fleet": cfg.Fleet,
		"max_parallel": 1, "stop_on_failure": true,
		"drain_timeout_seconds":   int(cfg.DrainTimeout.Seconds()),
		"rollback_window_seconds": int(cfg.RollbackWindow.Seconds()),
	}, &batch)
	return batch, err
}

func (c apiClient) upgrade(ctx context.Context, id string) (upgradeBatch, error) {
	var batch upgradeBatch
	err := c.do(ctx, http.MethodGet, "/api/admin/set-upgrades/"+url.PathEscape(id), nil, &batch)
	return batch, err
}
