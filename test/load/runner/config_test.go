package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestLoadConfigDefaultsMatchThousandUserProfile(t *testing.T) {
	cfg := LoadConfig(func(string) string { return "" })

	if cfg.Users != 1000 {
		t.Fatalf("Users=%d want 1000", cfg.Users)
	}
	if cfg.UserArrivalInterval != 500*time.Millisecond {
		t.Fatalf("UserArrivalInterval=%s want 500ms", cfg.UserArrivalInterval)
	}
	if cfg.ChatInterval != 3*time.Second {
		t.Fatalf("ChatInterval=%s want 3s", cfg.ChatInterval)
	}
	if cfg.BYOKProvidersPerUser != 2 {
		t.Fatalf("BYOKProvidersPerUser=%d want 2", cfg.BYOKProvidersPerUser)
	}
	if cfg.BYOKConfigInterval != time.Second {
		t.Fatalf("BYOKConfigInterval=%s want 1s", cfg.BYOKConfigInterval)
	}
	if cfg.PlatformChannels != 4 {
		t.Fatalf("PlatformChannels=%d want 4", cfg.PlatformChannels)
	}
	if cfg.RunDuration != 10*time.Minute {
		t.Fatalf("RunDuration=%s want 10m", cfg.RunDuration)
	}
	if cfg.Provider.Model != "llmgw-mock-chat" || cfg.Provider.BaseURL != "http://mockllm:8080" || cfg.Provider.APIKey != "test-mockllm-key" {
		t.Fatalf("unexpected default provider: %+v", cfg.Provider)
	}
	if cfg.ChatModel != "auto" {
		t.Fatalf("ChatModel=%q want auto", cfg.ChatModel)
	}
}

func TestLoadConfigSupportsSmokeOverrides(t *testing.T) {
	env := map[string]string{
		"LOAD_USERS":                       "5",
		"LOAD_SCENARIO":                    "byok_then_chat",
		"LOAD_USER_ARRIVAL_INTERVAL":       "10ms",
		"LOAD_CHAT_INTERVAL":               "20ms",
		"LOAD_BYOK_PROVIDERS_PER_USER":     "1",
		"LOAD_BYOK_CONFIG_INTERVAL":        "30ms",
		"LOAD_PLATFORM_CHANNELS":           "2",
		"LOAD_SUBSCRIPTION_APPLICATIONS":   "3",
		"LOAD_RUN_DURATION":                "200ms",
		"LOAD_LLMGATEWAY_BASE_URL":         "http://example.test",
		"LOAD_LLMGATEWAY_TRAFFIC_BASE_URL": "http://traffic.example.test",
		"LOAD_LLMGATEWAY_ADMIN_TOKEN":      "admin",
		"LOAD_LLMGATEWAY_INTERNAL_TOKEN":   "internal",
		"LOAD_PROVIDER_BASE_URL":           "http://provider.test",
		"LOAD_PROVIDER_API_KEY":            "sk-test",
		"LOAD_PROVIDER_MODEL":              "model-test",
		"LOAD_CHAT_MODEL":                  "auto-test",
	}
	cfg := LoadConfig(func(key string) string { return env[key] })

	if cfg.Users != 5 || cfg.UserArrivalInterval != 10*time.Millisecond || cfg.ChatInterval != 20*time.Millisecond {
		t.Fatalf("unexpected timing overrides: %+v", cfg)
	}
	if cfg.BYOKProvidersPerUser != 1 || cfg.BYOKConfigInterval != 30*time.Millisecond || cfg.PlatformChannels != 2 || cfg.RunDuration != 200*time.Millisecond {
		t.Fatalf("unexpected count overrides: %+v", cfg)
	}
	if cfg.Scenario != ScenarioBYOKThenChat || cfg.SubscriptionApplications != 3 {
		t.Fatalf("unexpected scenario overrides: %+v", cfg)
	}
	if cfg.Gateway.BaseURL != "http://example.test" || cfg.Gateway.TrafficBaseURL != "http://traffic.example.test" || cfg.Gateway.AdminToken != "admin" || cfg.Gateway.InternalToken != "internal" {
		t.Fatalf("unexpected gateway overrides: %+v", cfg.Gateway)
	}
	if cfg.Provider.BaseURL != "http://provider.test" || cfg.Provider.APIKey != "sk-test" || cfg.Provider.Model != "model-test" {
		t.Fatalf("unexpected provider overrides: %+v", cfg.Provider)
	}
	if cfg.ChatModel != "auto-test" {
		t.Fatalf("unexpected chat model override: %q", cfg.ChatModel)
	}
}

func TestCloudProdProfileRejectsPrepare(t *testing.T) {
	env := map[string]string{
		"LOAD_PROFILE": "cloud_prod",
		"LOAD_PREPARE": "true",
	}
	cfg := LoadConfig(func(key string) string { return env[key] })

	if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "cloud_prod") {
		t.Fatalf("Validate error=%v, want cloud_prod prepare rejection", err)
	}
}

func TestCloudProdProfileRejectsDisablingNewAPIProtection(t *testing.T) {
	env := map[string]string{
		"LOAD_PROFILE":                   "cloud_prod",
		"LOAD_PREPARE":                   "false",
		"LOAD_CHAT_MODEL":                "load-isolated-model",
		"LOAD_DISABLE_NEWAPI_PROTECTION": "true",
	}
	cfg := LoadConfig(func(key string) string { return env[key] })

	if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "protection") {
		t.Fatalf("Validate error=%v, want new-api protection rejection", err)
	}
}

func TestCloudProdProfileRequiresIsolatedChatModel(t *testing.T) {
	env := map[string]string{
		"LOAD_PROFILE": "cloud_prod",
		"LOAD_PREPARE": "false",
	}
	cfg := LoadConfig(func(key string) string { return env[key] })

	if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "isolated load test model") {
		t.Fatalf("Validate error=%v, want isolated model rejection", err)
	}
}

func TestCloudProdProfileAcceptsReadOnlyPreparedRun(t *testing.T) {
	env := map[string]string{
		"LOAD_PROFILE":    "cloud_prod",
		"LOAD_PREPARE":    "false",
		"LOAD_CHAT_MODEL": "load-isolated-model",
	}
	cfg := LoadConfig(func(key string) string { return env[key] })

	if err := cfg.Validate(); err != nil {
		t.Fatalf("Validate error=%v, want valid cloud production profile", err)
	}
	if cfg.MaxConcurrentUsers != 60 {
		t.Fatalf("MaxConcurrentUsers=%d want cloud safety cap 60", cfg.MaxConcurrentUsers)
	}
}

func TestCloudProdProfileRejectsConcurrencyAboveSixty(t *testing.T) {
	env := map[string]string{
		"LOAD_PROFILE":              "cloud_prod",
		"LOAD_PREPARE":              "false",
		"LOAD_CHAT_MODEL":           "load-isolated-model",
		"LOAD_MAX_CONCURRENT_USERS": "61",
	}
	cfg := LoadConfig(func(key string) string { return env[key] })
	if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "60") {
		t.Fatalf("Validate error=%v, want concurrency cap rejection", err)
	}
}

func TestUnknownLoadProfileIsRejected(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Profile = "cloud_prdo"

	if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "unknown load profile") {
		t.Fatalf("Validate error=%v, want unknown profile rejection", err)
	}
}

func TestRunnerEnforcesCloudProdValidation(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Profile = "cloud_prod"
	runner := NewRunner(cfg, nil)

	err := runner.Run(context.Background())
	if err == nil || !strings.Contains(err.Error(), "must not run prepare") {
		t.Fatalf("Run error=%v, want cloud production guard", err)
	}
}

func TestPrepareDoesNotRewriteNewAPIPerformanceProtectionByDefault(t *testing.T) {
	var optionKeys []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPut && strings.Contains(r.URL.Path, "/api/option/"):
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatalf("decode option body: %v", err)
			}
			optionKeys = append(optionKeys, body["key"].(string))
			writeLoadTestJSON(t, w, map[string]any{"success": true})
		default:
			writeLoadTestJSON(t, w, map[string]any{"success": true})
		}
	}))
	defer server.Close()

	cfg := DefaultConfig()
	cfg.Gateway.BaseURL = server.URL
	runner := NewRunner(cfg, server.Client())

	if err := runner.configureSetModelPricing(context.Background(), managedSet{ID: "set-a", AdminUserID: 1}); err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(optionKeys, "\n")
	for _, forbidden := range []string{
		"performance_setting.monitor_cpu_threshold",
		"performance_setting.monitor_memory_threshold",
		"performance_setting.monitor_disk_threshold",
	} {
		if strings.Contains(joined, forbidden) {
			t.Fatalf("prepare must not rewrite %s by default; keys:\n%s", forbidden, joined)
		}
	}
}

func TestLocalPrepareCanExplicitlyDisableNewAPIPerformanceProtection(t *testing.T) {
	var optionKeys []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodPut && strings.Contains(r.URL.Path, "/api/option/") {
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatalf("decode option body: %v", err)
			}
			optionKeys = append(optionKeys, body["key"].(string))
		}
		writeLoadTestJSON(t, w, map[string]any{"success": true})
	}))
	defer server.Close()

	cfg := DefaultConfig()
	cfg.Gateway.BaseURL = server.URL
	cfg.DisableNewAPIProtection = true
	runner := NewRunner(cfg, server.Client())

	if err := runner.configureSetModelPricing(context.Background(), managedSet{ID: "set-a", AdminUserID: 1}); err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(optionKeys, "\n")
	for _, expected := range []string{
		"performance_setting.monitor_cpu_threshold",
		"performance_setting.monitor_memory_threshold",
		"performance_setting.monitor_disk_threshold",
	} {
		if !strings.Contains(joined, expected) {
			t.Fatalf("explicit local override must write %s; keys:\n%s", expected, joined)
		}
	}
}

func TestRunPlatformOnlyScenarioSkipsBYOKSettings(t *testing.T) {
	var byokCalls int
	var chatCalls int
	server := newLoadRunnerUserServer(t, func(w http.ResponseWriter, r *http.Request) bool {
		if strings.Contains(r.URL.Path, "/llm-settings") {
			byokCalls++
		}
		if r.URL.Path == "/v1/chat/completions" {
			chatCalls++
		}
		return false
	})
	defer server.Close()

	cfg := oneUserScenarioConfig(server.URL, ScenarioPlatformOnly)
	runner := NewRunner(cfg, server.Client())

	if err := runner.runUser(context.Background(), 1); err != nil {
		t.Fatal(err)
	}
	if byokCalls != 0 {
		t.Fatalf("platform_only should not touch BYOK settings, got %d calls", byokCalls)
	}
	if chatCalls != 1 {
		t.Fatalf("chat calls=%d want 1", chatCalls)
	}
}

func TestRunBYOKThenChatScenarioSyncsBeforeFirstChat(t *testing.T) {
	var calls []string
	server := newLoadRunnerUserServer(t, func(w http.ResponseWriter, r *http.Request) bool {
		if strings.Contains(r.URL.Path, "/llm-settings/sync") {
			calls = append(calls, "sync")
		}
		if r.URL.Path == "/v1/chat/completions" {
			calls = append(calls, "chat")
		}
		return false
	})
	defer server.Close()

	cfg := oneUserScenarioConfig(server.URL, ScenarioBYOKThenChat)
	cfg.BYOKProvidersPerUser = 2
	runner := NewRunner(cfg, server.Client())

	if err := runner.runUser(context.Background(), 1); err != nil {
		t.Fatal(err)
	}
	if strings.Join(calls, ",") != "sync,sync,chat" {
		t.Fatalf("calls=%v want sync,sync,chat", calls)
	}
}

func TestRunBYOKSyncOnlyScenarioSkipsChat(t *testing.T) {
	var chatCalls int
	var syncCalls int
	server := newLoadRunnerUserServer(t, func(w http.ResponseWriter, r *http.Request) bool {
		if strings.Contains(r.URL.Path, "/llm-settings/sync") {
			syncCalls++
		}
		if r.URL.Path == "/v1/chat/completions" {
			chatCalls++
		}
		return false
	})
	defer server.Close()

	cfg := oneUserScenarioConfig(server.URL, ScenarioBYOKSyncOnly)
	cfg.BYOKProvidersPerUser = 2
	runner := NewRunner(cfg, server.Client())

	if err := runner.runUser(context.Background(), 1); err != nil {
		t.Fatal(err)
	}
	if syncCalls != 2 {
		t.Fatalf("sync calls=%d want 2", syncCalls)
	}
	if chatCalls != 0 {
		t.Fatalf("byok_sync_only should not send chat, got %d calls", chatCalls)
	}
}

func TestRunRenewalBurstScenarioAppliesSubscriptionMultipleTimes(t *testing.T) {
	var applyCalls int
	server := newLoadRunnerUserServer(t, func(w http.ResponseWriter, r *http.Request) bool {
		if r.Method == http.MethodPost && r.URL.Path == "/api/internal/subscriptions/apply" {
			applyCalls++
		}
		return false
	})
	defer server.Close()

	cfg := oneUserScenarioConfig(server.URL, ScenarioRenewalBurst)
	cfg.SubscriptionApplications = 3
	runner := NewRunner(cfg, server.Client())

	if err := runner.runUser(context.Background(), 1); err != nil {
		t.Fatal(err)
	}
	if applyCalls != 3 {
		t.Fatalf("subscription apply calls=%d want 3", applyCalls)
	}
}

func oneUserScenarioConfig(baseURL string, scenario Scenario) Config {
	cfg := DefaultConfig()
	cfg.Gateway.BaseURL = baseURL
	cfg.Gateway.TrafficBaseURL = baseURL
	cfg.Scenario = scenario
	cfg.Users = 1
	cfg.RunID = ""
	cfg.UserArrivalInterval = 0
	cfg.ChatInterval = 0
	cfg.BYOKConfigInterval = 0
	cfg.UserChatRequests = 1
	cfg.Prepare = false
	return cfg
}

func newLoadRunnerUserServer(t *testing.T, intercept func(http.ResponseWriter, *http.Request) bool) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if intercept != nil && intercept(w, r) {
			return
		}
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/internal/subscriptions/apply":
			writeLoadTestJSON(t, w, map[string]any{"success": true, "data": map[string]any{"user_id": "load-user-000001"}})
		case r.Method == http.MethodPost && r.URL.Path == "/api/admin/users/load-user-000001/api-keys":
			writeLoadTestJSON(t, w, map[string]any{"success": true, "data": map[string]any{
				"api_key": "sk-load-user-000001",
				"key_id":  "key-1",
				"name":    "load",
			}})
		case r.Method == http.MethodPut && r.URL.Path == "/api/internal/users/load-user-000001/llm-settings":
			var body userLLMSettings
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatalf("decode llm settings: %v", err)
			}
			writeLoadTestJSON(t, w, map[string]any{"success": true, "data": body})
		case r.Method == http.MethodPost && r.URL.Path == "/api/internal/users/load-user-000001/llm-settings/sync":
			writeLoadTestJSON(t, w, map[string]any{"success": true, "data": map[string]any{"user_id": "load-user-000001"}})
		case r.Method == http.MethodPost && r.URL.Path == "/v1/chat/completions":
			if got := r.Header.Get("Authorization"); got != "Bearer sk-load-user-000001" {
				t.Fatalf("Authorization=%q", got)
			}
			writeLoadTestJSON(t, w, map[string]any{"id": "chatcmpl-load", "choices": []map[string]any{{"message": map[string]string{"content": "ok"}}}})
		default:
			http.Error(w, "unexpected request", http.StatusNotFound)
		}
	}))
}

func TestUserLLMSettingsAddsBYOKProvidersOneByOne(t *testing.T) {
	cfg := DefaultConfig()

	first := buildUserLLMSettings("user-1", cfg, 1)
	assertProviderCount(t, first, 1)
	if first.Routing.Mode != "byok_first" {
		t.Fatalf("routing mode=%q want byok_first", first.Routing.Mode)
	}
	if first.Providers[0].ID != "byok-1" || first.Providers[0].ModelMappings[cfg.ChatModel] != cfg.Provider.Model {
		t.Fatalf("unexpected first provider: %+v", first.Providers[0])
	}

	second := buildUserLLMSettings("user-1", cfg, 2)
	assertProviderCount(t, second, 2)
	if second.Providers[1].ID != "byok-2" || second.Providers[1].APIKey == second.Providers[0].APIKey {
		t.Fatalf("unexpected second provider: %+v", second.Providers)
	}
}

func TestPlatformChannelBundleUsesVirtualChatModel(t *testing.T) {
	var bundle struct {
		Spec struct {
			Options []struct {
				Key string `json:"key"`
			} `json:"options"`
			Channels []struct {
				Models       string `json:"models"`
				ModelMapping string `json:"model_mapping"`
			} `json:"channels"`
		} `json:"spec"`
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/channel-bundles" {
			http.Error(w, "unexpected request", http.StatusNotFound)
			return
		}
		if err := json.NewDecoder(r.Body).Decode(&bundle); err != nil {
			t.Fatalf("decode bundle: %v", err)
		}
		writeLoadTestJSON(t, w, map[string]any{"success": true})
	}))
	defer server.Close()

	cfg := DefaultConfig()
	cfg.Gateway.BaseURL = server.URL
	cfg.PlatformChannels = 1
	runner := NewRunner(cfg, server.Client())
	if err := runner.upsertPlatformChannelBundle(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(bundle.Spec.Channels) != 1 {
		t.Fatalf("channels=%d want 1", len(bundle.Spec.Channels))
	}
	if len(bundle.Spec.Options) != 2 || bundle.Spec.Options[0].Key != "CompletionRatio" || bundle.Spec.Options[1].Key != "ModelRatio" {
		t.Fatalf("unexpected bundle options: %+v", bundle.Spec.Options)
	}
	if bundle.Spec.Channels[0].Models != cfg.ChatModel {
		t.Fatalf("models=%q want %q", bundle.Spec.Channels[0].Models, cfg.ChatModel)
	}
	if !strings.Contains(bundle.Spec.Channels[0].ModelMapping, cfg.Provider.Model) {
		t.Fatalf("model mapping %q does not include provider model %q", bundle.Spec.Channels[0].ModelMapping, cfg.Provider.Model)
	}
}

func TestStatsSnapshotIncludesLastError(t *testing.T) {
	stats := NewStats()
	stats.RecordLatency("chat", time.Millisecond, assertErr("status=400"))
	snapshot := stats.Snapshot()
	if snapshot.Errors["chat"] != 1 {
		t.Fatalf("chat errors=%d want 1", snapshot.Errors["chat"])
	}
	if snapshot.LastErrors["chat"] != "status=400" {
		t.Fatalf("last chat error=%q", snapshot.LastErrors["chat"])
	}
	if !snapshot.HasErrors() {
		t.Fatal("snapshot should report errors")
	}
}

func TestExitCodeFailsWhenLoadReportHasErrors(t *testing.T) {
	if code := exitCodeFor(nil, StatsSnapshot{}); code != 0 {
		t.Fatalf("exit code=%d want 0", code)
	}
	if code := exitCodeFor(assertErr("prepare failed"), StatsSnapshot{}); code == 0 {
		t.Fatal("runner error should fail the process")
	}
	if code := exitCodeFor(nil, StatsSnapshot{Errors: map[string]int64{"chat": 1}}); code == 0 {
		t.Fatal("load report errors should fail the process")
	}
}

type assertErr string

func (e assertErr) Error() string {
	return string(e)
}

func TestRunOneUserCallsGatewayInBusinessOrder(t *testing.T) {
	var calls []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.Method+" "+r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/internal/subscriptions/apply":
			writeLoadTestJSON(t, w, map[string]any{"success": true, "data": map[string]any{"user_id": "load-user-000001"}})
		case r.Method == http.MethodPost && r.URL.Path == "/api/admin/users/load-user-000001/api-keys":
			writeLoadTestJSON(t, w, map[string]any{"success": true, "data": map[string]any{
				"api_key": "sk-load-user-000001",
				"key_id":  "key-1",
				"name":    "load",
			}})
		case r.Method == http.MethodPut && r.URL.Path == "/api/internal/users/load-user-000001/llm-settings":
			var body userLLMSettings
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatalf("decode llm settings: %v", err)
			}
			if len(body.Providers) == 0 || len(body.Providers) > 2 {
				t.Fatalf("unexpected provider count in settings: %+v", body)
			}
			writeLoadTestJSON(t, w, map[string]any{"success": true, "data": body})
		case r.Method == http.MethodPost && r.URL.Path == "/api/internal/users/load-user-000001/llm-settings/sync":
			writeLoadTestJSON(t, w, map[string]any{"success": true, "data": map[string]any{"user_id": "load-user-000001"}})
		case r.Method == http.MethodPost && r.URL.Path == "/v1/chat/completions":
			if got := r.Header.Get("Authorization"); got != "Bearer sk-load-user-000001" {
				t.Fatalf("Authorization=%q", got)
			}
			writeLoadTestJSON(t, w, map[string]any{"id": "chatcmpl-load", "choices": []map[string]any{{"message": map[string]string{"content": "ok"}}}})
		default:
			http.Error(w, "unexpected request", http.StatusNotFound)
		}
	}))
	defer server.Close()

	cfg := DefaultConfig()
	cfg.Gateway.BaseURL = server.URL
	cfg.Users = 1
	cfg.BYOKConfigInterval = 0
	cfg.ChatInterval = 0
	cfg.UserChatRequests = 1
	runner := NewRunner(cfg, server.Client())

	if err := runner.runUser(context.Background(), 1); err != nil {
		t.Fatal(err)
	}

	joined := strings.Join(calls, "\n")
	for _, want := range []string{
		"POST /api/internal/subscriptions/apply",
		"POST /api/admin/users/load-user-000001/api-keys",
		"PUT /api/internal/users/load-user-000001/llm-settings",
		"POST /api/internal/users/load-user-000001/llm-settings/sync",
		"POST /v1/chat/completions",
	} {
		if !strings.Contains(joined, want) {
			t.Fatalf("missing call %q in:\n%s", want, joined)
		}
	}
}

func TestChatOnceIncludesResponseBodyOnFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"error":"model price missing"}`, http.StatusBadRequest)
	}))
	defer server.Close()

	cfg := DefaultConfig()
	cfg.Gateway.BaseURL = server.URL
	runner := NewRunner(cfg, server.Client())

	err := runner.chatOnce(context.Background(), "load-user-000001", "sk-test")
	if err == nil {
		t.Fatal("expected chat error")
	}
	if !strings.Contains(err.Error(), "status=400") || !strings.Contains(err.Error(), "model price missing") {
		t.Fatalf("error %q should include status and response body", err.Error())
	}
}

func assertProviderCount(t *testing.T, settings userLLMSettings, want int) {
	t.Helper()
	if len(settings.Providers) != want {
		t.Fatalf("provider count=%d want=%d: %+v", len(settings.Providers), want, settings)
	}
}

func writeLoadTestJSON(t *testing.T, w http.ResponseWriter, payload any) {
	t.Helper()
	if err := json.NewEncoder(w).Encode(payload); err != nil {
		t.Fatal(err)
	}
}
