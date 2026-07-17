package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"
)

type Runner struct {
	cfg    Config
	client *http.Client
	stats  *Stats
}

type apiResponse[T any] struct {
	Success bool   `json:"success"`
	Message string `json:"message"`
	Data    T      `json:"data"`
}

type userLLMSettings struct {
	Routing   userLLMRouting    `json:"routing"`
	Providers []userLLMProvider `json:"providers"`
}

type userLLMRouting struct {
	Mode string `json:"mode"`
}

type userLLMProvider struct {
	ID            string            `json:"id"`
	Name          string            `json:"name"`
	Protocol      string            `json:"protocol"`
	BaseURL       string            `json:"base_url"`
	APIKey        string            `json:"api_key"`
	ModelMappings map[string]string `json:"model_mappings"`
	Enabled       bool              `json:"enabled"`
}

type externalKey struct {
	APIKey string `json:"api_key"`
	KeyID  string `json:"key_id"`
	Name   string `json:"name"`
}

type managedSet struct {
	ID          string `json:"id"`
	Setup       bool   `json:"setup"`
	AdminUserID int    `json:"admin_user_id"`
}

type channelBundleState struct {
	BundleID           string `json:"bundle_id"`
	SetID              string `json:"set_id"`
	Status             string `json:"status"`
	AppliedFingerprint string `json:"applied_fingerprint"`
}

func NewRunner(cfg Config, client *http.Client) *Runner {
	if client == nil {
		client = &http.Client{Timeout: cfg.HTTPTimeout}
	}
	if client.Timeout == 0 && cfg.HTTPTimeout > 0 {
		copied := *client
		copied.Timeout = cfg.HTTPTimeout
		client = &copied
	}
	return &Runner{cfg: cfg, client: client, stats: NewStats()}
}

func (r *Runner) Run(ctx context.Context) error {
	if err := r.cfg.Validate(); err != nil {
		return err
	}
	if r.cfg.Prepare {
		if err := r.Prepare(ctx); err != nil {
			return err
		}
	}
	if r.cfg.RunDuration > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, r.cfg.RunDuration)
		defer cancel()
	}
	var wg sync.WaitGroup
	var concurrency chan struct{}
	if r.cfg.MaxConcurrentUsers > 0 {
		concurrency = make(chan struct{}, r.cfg.MaxConcurrentUsers)
	}
	for i := 1; i <= r.cfg.Users; i++ {
		if err := sleepContext(ctx, r.cfg.UserArrivalInterval); err != nil {
			break
		}
		index := i
		if concurrency != nil {
			select {
			case concurrency <- struct{}{}:
			case <-ctx.Done():
				wg.Wait()
				return nil
			}
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			if concurrency != nil {
				defer func() { <-concurrency }()
			}
			if err := r.runUser(ctx, index); err != nil {
				r.stats.RecordError("user", err)
			}
		}()
	}
	wg.Wait()
	return nil
}

func (r *Runner) Prepare(ctx context.Context) error {
	if err := r.waitReady(ctx); err != nil {
		return err
	}
	for _, set := range r.cfg.Sets {
		if err := r.adminPost(ctx, "/api/sets", map[string]any{
			"id":       set.ID,
			"name":     set.Name,
			"base_url": set.BaseURL,
			"status":   "active",
		}, nil); err != nil {
			return fmt.Errorf("register set %s: %w", set.ID, err)
		}
		if err := r.adminPost(ctx, "/api/sets/"+url.PathEscape(set.ID)+"/bootstrap", nil, nil); err != nil {
			return fmt.Errorf("bootstrap set %s: %w", set.ID, err)
		}
	}
	sets, err := r.listManagedSets(ctx)
	if err != nil {
		return err
	}
	upstreamPlanIDs := map[string]int{}
	for _, set := range r.cfg.Sets {
		managed, ok := sets[set.ID]
		if !ok || !managed.Setup || managed.AdminUserID <= 0 {
			return fmt.Errorf("set %s is not bootstrapped: %+v", set.ID, managed)
		}
		if err := r.configureSetModelPricing(ctx, managed); err != nil {
			return fmt.Errorf("configure model pricing for %s: %w", set.ID, err)
		}
		upstreamPlanID, err := r.createUpstreamPlan(ctx, managed)
		if err != nil {
			return fmt.Errorf("create upstream plan for %s: %w", set.ID, err)
		}
		upstreamPlanIDs[set.ID] = upstreamPlanID
	}
	if err := r.upsertPlatformChannelBundle(ctx); err != nil {
		return err
	}
	for _, set := range r.cfg.Sets {
		state, err := r.applyChannelBundle(ctx, "load-platform", set.ID)
		if err != nil {
			return fmt.Errorf("apply platform bundle to %s: %w", set.ID, err)
		}
		if state.Status != "synced" {
			return fmt.Errorf("platform bundle status for %s = %s", set.ID, state.Status)
		}
	}
	return r.adminPost(ctx, "/api/plans", map[string]any{
		"id":                r.cfg.Plan.ID,
		"name":              r.cfg.Plan.Name,
		"monthly_tokens":    r.cfg.Plan.MonthlyTokens,
		"period_value":      r.cfg.Plan.PeriodValue,
		"period_unit":       r.cfg.Plan.PeriodUnit,
		"is_active":         true,
		"upstream_plan_ids": upstreamPlanIDs,
	}, nil)
}

func (r *Runner) runUser(ctx context.Context, index int) error {
	userID := r.cfg.userID(index)
	if err := r.applySubscriptions(ctx, userID); err != nil {
		return err
	}

	switch r.cfg.Scenario {
	case ScenarioPlatformOnly:
		key, err := r.createAPIKey(ctx, userID)
		if err != nil {
			return err
		}
		return r.chatLoop(ctx, userID, key.APIKey)
	case ScenarioBYOKThenChat:
		if err := r.configureUserBYOK(ctx, userID); err != nil {
			return err
		}
		key, err := r.createAPIKey(ctx, userID)
		if err != nil {
			return err
		}
		return r.chatLoop(ctx, userID, key.APIKey)
	case ScenarioBYOKSyncOnly:
		return r.configureUserBYOK(ctx, userID)
	case ScenarioRenewalBurst:
		key, err := r.createAPIKey(ctx, userID)
		if err != nil {
			return err
		}
		return r.chatLoop(ctx, userID, key.APIKey)
	default:
		return r.runMixedConcurrentUser(ctx, userID)
	}
}

func (r *Runner) applySubscriptions(ctx context.Context, userID string) error {
	for i := 0; i < r.cfg.SubscriptionApplications; i++ {
		if err := r.internalPost(ctx, "/api/internal/subscriptions/apply", map[string]any{
			"user_id": userID,
			"plan_id": r.cfg.Plan.ID,
		}, nil); err != nil {
			return fmt.Errorf("apply subscription: %w", err)
		}
	}
	return nil
}

func (r *Runner) createAPIKey(ctx context.Context, userID string) (externalKey, error) {
	var key externalKey
	if err := r.adminPost(ctx, "/api/admin/users/"+url.PathEscape(userID)+"/api-keys", map[string]any{"name": "load"}, &key); err != nil {
		return externalKey{}, fmt.Errorf("create api key: %w", err)
	}
	if key.APIKey == "" {
		return externalKey{}, fmt.Errorf("empty api key")
	}
	return key, nil
}

func (r *Runner) runMixedConcurrentUser(ctx context.Context, userID string) error {
	key, err := r.createAPIKey(ctx, userID)
	if err != nil {
		return err
	}
	byokDone := make(chan error, 1)
	go func() {
		byokDone <- r.configureUserBYOK(ctx, userID)
	}()

	chatErr := r.chatLoop(ctx, userID, key.APIKey)
	byokErr := <-byokDone
	if chatErr != nil {
		return chatErr
	}
	return byokErr
}

func (r *Runner) configureUserBYOK(ctx context.Context, userID string) error {
	for i := 1; i <= r.cfg.BYOKProvidersPerUser; i++ {
		if err := sleepContext(ctx, r.cfg.BYOKConfigInterval); err != nil {
			return nil
		}
		settings := buildUserLLMSettings(userID, r.cfg, i)
		if err := r.internalPut(ctx, "/api/internal/users/"+url.PathEscape(userID)+"/llm-settings", settings, nil); err != nil {
			return fmt.Errorf("save byok settings: %w", err)
		}
		if err := r.internalPost(ctx, "/api/internal/users/"+url.PathEscape(userID)+"/llm-settings/sync", nil, nil); err != nil {
			return fmt.Errorf("sync byok settings: %w", err)
		}
	}
	return nil
}

func (r *Runner) chatLoop(ctx context.Context, userID string, apiKey string) error {
	requests := 0
	for {
		if r.cfg.UserChatRequests > 0 && requests >= r.cfg.UserChatRequests {
			return nil
		}
		if err := sleepContext(ctx, r.cfg.ChatInterval); err != nil {
			return nil
		}
		requests++
		start := time.Now()
		err := r.chatOnce(ctx, userID, apiKey)
		r.stats.RecordLatency("chat", time.Since(start), err)
		if err != nil && r.cfg.UserChatRequests > 0 {
			return err
		}
	}
}

func (r *Runner) chatOnce(ctx context.Context, userID string, apiKey string) error {
	body := map[string]any{
		"model": r.cfg.ChatModel,
		"messages": []map[string]string{
			{"role": "system", "content": "You are a load test assistant."},
			{"role": "user", "content": "你好"},
		},
		"stream": r.cfg.Stream,
	}
	req, err := r.newTrafficJSONRequest(ctx, http.MethodPost, "/v1/chat/completions", body)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	resp, err := r.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("chat user %s status=%d body=%s", userID, resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	return nil
}

func buildUserLLMSettings(userID string, cfg Config, providerCount int) userLLMSettings {
	if providerCount > cfg.BYOKProvidersPerUser {
		providerCount = cfg.BYOKProvidersPerUser
	}
	settings := userLLMSettings{
		Routing:   userLLMRouting{Mode: "byok_first"},
		Providers: make([]userLLMProvider, 0, providerCount),
	}
	for i := 1; i <= providerCount; i++ {
		settings.Providers = append(settings.Providers, userLLMProvider{
			ID:       fmt.Sprintf("byok-%d", i),
			Name:     fmt.Sprintf("BYOK %d", i),
			Protocol: "openai_compatible",
			BaseURL:  cfg.Provider.BaseURL,
			APIKey:   fmt.Sprintf("sk-byok-%s-%02d", sanitizeKeyPart(userID), i),
			ModelMappings: map[string]string{
				cfg.ChatModel: cfg.Provider.Model,
			},
			Enabled: true,
		})
	}
	return settings
}

func sanitizeKeyPart(value string) string {
	replacer := strings.NewReplacer("_", "-", ":", "-", "/", "-", " ", "-")
	return replacer.Replace(value)
}

func (r *Runner) waitReady(ctx context.Context) error {
	deadline := time.Now().Add(2 * time.Minute)
	for {
		req, _ := r.newJSONRequest(ctx, http.MethodGet, "/readyz", nil)
		resp, err := r.client.Do(req)
		if err == nil && resp.StatusCode >= 200 && resp.StatusCode < 300 {
			_ = resp.Body.Close()
			return nil
		}
		if resp != nil {
			_ = resp.Body.Close()
		}
		if time.Now().After(deadline) {
			if err != nil {
				return err
			}
			return fmt.Errorf("llmgateway not ready")
		}
		if err := sleepContext(ctx, 500*time.Millisecond); err != nil {
			return err
		}
	}
}

func (r *Runner) listManagedSets(ctx context.Context) (map[string]managedSet, error) {
	var sets []managedSet
	if err := r.adminGet(ctx, "/api/sets", &sets); err != nil {
		return nil, err
	}
	result := map[string]managedSet{}
	for _, set := range sets {
		result[set.ID] = set
	}
	return result, nil
}

func (r *Runner) configureSetModelPricing(ctx context.Context, set managedSet) error {
	for _, key := range []string{"ModelRatio", "CompletionRatio"} {
		ratios := map[string]float64{
			r.cfg.ChatModel:      1,
			r.cfg.Provider.Model: 1,
		}
		raw, err := json.Marshal(ratios)
		if err != nil {
			return err
		}
		if err := r.consolePut(ctx, set, "/api/option/", map[string]any{
			"key":   key,
			"value": string(raw),
		}, nil); err != nil {
			return err
		}
	}
	if !r.cfg.DisableNewAPIProtection {
		return nil
	}
	// 仅供隔离的本地极限压测使用；cloud_prod profile 会拒绝这个开关。
	for _, key := range []string{
		"performance_setting.monitor_cpu_threshold",
		"performance_setting.monitor_memory_threshold",
		"performance_setting.monitor_disk_threshold",
	} {
		if err := r.consolePut(ctx, set, "/api/option/", map[string]any{
			"key":   key,
			"value": 0,
		}, nil); err != nil {
			return err
		}
	}
	return nil
}

func (r *Runner) createUpstreamPlan(ctx context.Context, set managedSet) (int, error) {
	var out struct {
		ID int `json:"id"`
	}
	err := r.consolePost(ctx, set, "/api/subscription/admin/plans", map[string]any{
		"plan": map[string]any{
			"title":              fmt.Sprintf("%s %s", r.cfg.Plan.Name, r.cfg.RunID),
			"subtitle":           "llmgateway load profile",
			"price_amount":       0,
			"currency":           "USD",
			"duration_unit":      "month",
			"duration_value":     1,
			"enabled":            true,
			"total_amount":       r.cfg.Plan.MonthlyTokens,
			"allow_balance_pay":  true,
			"quota_reset_period": "never",
		},
	}, &out)
	return out.ID, err
}

func (r *Runner) upsertPlatformChannelBundle(ctx context.Context) error {
	channels := make([]map[string]any, 0, r.cfg.PlatformChannels)
	modelMapping := map[string]string{r.cfg.ChatModel: r.cfg.Provider.Model}
	rawModelMapping, err := json.Marshal(modelMapping)
	if err != nil {
		return err
	}
	for i := 1; i <= r.cfg.PlatformChannels; i++ {
		channels = append(channels, map[string]any{
			"id":            fmt.Sprintf("load-platform-%02d", i),
			"name":          fmt.Sprintf("Load Platform %02d", i),
			"type":          1,
			"key":           r.cfg.Provider.APIKey,
			"base_url":      r.cfg.Provider.BaseURL,
			"models":        r.cfg.ChatModel,
			"model_mapping": string(rawModelMapping),
			"group":         "default",
			"priority":      i * 10,
			"weight":        100,
			"status":        "enabled",
		})
	}
	return r.adminPost(ctx, "/api/channel-bundles", map[string]any{
		"id":   "load-platform",
		"name": "Load platform channels",
		"spec": map[string]any{
			"version":  1,
			"kind":     "newapi-channel-bundle",
			"options":  platformBundleOptions(r.cfg),
			"channels": channels,
		},
	}, nil)
}

func platformBundleOptions(cfg Config) []map[string]any {
	ratios := map[string]float64{
		cfg.ChatModel:      1,
		cfg.Provider.Model: 1,
	}
	raw, _ := json.Marshal(ratios)
	value := string(raw)
	return []map[string]any{
		{"key": "CompletionRatio", "value": value},
		{"key": "ModelRatio", "value": value},
	}
}

func (r *Runner) applyChannelBundle(ctx context.Context, bundleID string, setID string) (channelBundleState, error) {
	var state channelBundleState
	err := r.adminPost(ctx, "/api/channel-bundles/"+url.PathEscape(bundleID)+"/apply", map[string]any{
		"set_id": setID,
	}, &state)
	return state, err
}

func (r *Runner) adminGet(ctx context.Context, path string, out any) error {
	return r.doWrapped(ctx, http.MethodGet, path, r.cfg.Gateway.AdminToken, nil, out)
}

func (r *Runner) adminPost(ctx context.Context, path string, body any, out any) error {
	return r.doWrapped(ctx, http.MethodPost, path, r.cfg.Gateway.AdminToken, body, out)
}

func (r *Runner) internalPost(ctx context.Context, path string, body any, out any) error {
	return r.doWrapped(ctx, http.MethodPost, path, r.cfg.Gateway.InternalToken, body, out)
}

func (r *Runner) internalPut(ctx context.Context, path string, body any, out any) error {
	return r.doWrapped(ctx, http.MethodPut, path, r.cfg.Gateway.InternalToken, body, out)
}

func (r *Runner) consolePost(ctx context.Context, set managedSet, path string, body any, out any) error {
	return r.consoleDo(ctx, http.MethodPost, set, path, body, out)
}

func (r *Runner) consolePut(ctx context.Context, set managedSet, path string, body any, out any) error {
	return r.consoleDo(ctx, http.MethodPut, set, path, body, out)
}

func (r *Runner) consoleDo(ctx context.Context, method string, set managedSet, path string, body any, out any) error {
	proxyPath := "/_llmgateway_console/" + url.PathEscape(set.ID) + path
	req, err := r.newJSONRequest(ctx, method, proxyPath, body)
	if err != nil {
		return err
	}
	req.Header.Set("New-Api-User", fmt.Sprintf("%d", set.AdminUserID))
	return r.doRequest(req, out)
}

func (r *Runner) doWrapped(ctx context.Context, method string, path string, token string, body any, out any) error {
	req, err := r.newJSONRequest(ctx, method, path, body)
	if err != nil {
		return err
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	return r.doRequest(req, out)
}

func (r *Runner) doRequest(req *http.Request, out any) error {
	resp, err := r.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("%s %s status=%d body=%s", req.Method, req.URL.Path, resp.StatusCode, raw)
	}
	var wrapped apiResponse[json.RawMessage]
	if err := json.Unmarshal(raw, &wrapped); err == nil && (wrapped.Success || wrapped.Message != "" || len(wrapped.Data) > 0) {
		if !wrapped.Success {
			return fmt.Errorf("%s %s failed: %s", req.Method, req.URL.Path, wrapped.Message)
		}
		if out == nil || len(wrapped.Data) == 0 || string(wrapped.Data) == "null" {
			return nil
		}
		return json.Unmarshal(wrapped.Data, out)
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(raw, out)
}

func (r *Runner) newJSONRequest(ctx context.Context, method string, path string, body any) (*http.Request, error) {
	return r.newJSONRequestWithBase(ctx, strings.TrimRight(r.cfg.Gateway.BaseURL, "/"), method, path, body)
}

func (r *Runner) newTrafficJSONRequest(ctx context.Context, method string, path string, body any) (*http.Request, error) {
	baseURL := strings.TrimRight(r.cfg.Gateway.TrafficBaseURL, "/")
	if baseURL == "" {
		baseURL = strings.TrimRight(r.cfg.Gateway.BaseURL, "/")
	}
	return r.newJSONRequestWithBase(ctx, baseURL, method, path, body)
}

func (r *Runner) newJSONRequestWithBase(ctx context.Context, baseURL string, method string, path string, body any) (*http.Request, error) {
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, baseURL+path, reader)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Accept", "application/json")
	return req, nil
}

func sleepContext(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
			return nil
		}
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

type Stats struct {
	mu         sync.Mutex
	Counters   map[string]int64           `json:"counters"`
	Errors     map[string]int64           `json:"errors"`
	LastErrors map[string]string          `json:"last_errors"`
	Latencies  map[string][]time.Duration `json:"-"`
}

type StatsSnapshot struct {
	Counters   map[string]int64        `json:"counters"`
	Errors     map[string]int64        `json:"errors"`
	LastErrors map[string]string       `json:"last_errors,omitempty"`
	Latency    map[string]LatencyStats `json:"latency"`
}

type LatencyStats struct {
	Count int   `json:"count"`
	P50MS int64 `json:"p50_ms"`
	P95MS int64 `json:"p95_ms"`
	P99MS int64 `json:"p99_ms"`
	MaxMS int64 `json:"max_ms"`
}

func NewStats() *Stats {
	return &Stats{
		Counters:   map[string]int64{},
		Errors:     map[string]int64{},
		LastErrors: map[string]string{},
		Latencies:  map[string][]time.Duration{},
	}
}

func (s *Stats) RecordLatency(name string, latency time.Duration, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Counters[name+"_requests"]++
	if err != nil {
		s.Errors[name]++
		s.LastErrors[name] = err.Error()
		return
	}
	s.Counters[name+"_success"]++
	s.Latencies[name] = append(s.Latencies[name], latency)
}

func (s *Stats) RecordError(name string, err error) {
	if err == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Errors[name]++
	s.LastErrors[name] = err.Error()
}

func (s *Stats) Snapshot() StatsSnapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := StatsSnapshot{
		Counters:   map[string]int64{},
		Errors:     map[string]int64{},
		LastErrors: map[string]string{},
		Latency:    map[string]LatencyStats{},
	}
	for k, v := range s.Counters {
		out.Counters[k] = v
	}
	for k, v := range s.Errors {
		out.Errors[k] = v
	}
	for k, v := range s.LastErrors {
		out.LastErrors[k] = v
	}
	for k, values := range s.Latencies {
		copied := append([]time.Duration(nil), values...)
		sort.Slice(copied, func(i, j int) bool { return copied[i] < copied[j] })
		out.Latency[k] = LatencyStats{
			Count: len(copied),
			P50MS: percentileMS(copied, 0.50),
			P95MS: percentileMS(copied, 0.95),
			P99MS: percentileMS(copied, 0.99),
			MaxMS: copied[len(copied)-1].Milliseconds(),
		}
	}
	return out
}

func (s StatsSnapshot) HasErrors() bool {
	for _, count := range s.Errors {
		if count > 0 {
			return true
		}
	}
	return false
}

func percentileMS(values []time.Duration, p float64) int64 {
	if len(values) == 0 {
		return 0
	}
	index := int(float64(len(values)-1) * p)
	return values[index].Milliseconds()
}
