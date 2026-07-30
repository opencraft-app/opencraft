package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"git.woa.com/wisp/mono2/llmgateway/internal/gateway"
)

func TestInternalUserLLMSettingsSavesAndMasksProviderKeys(t *testing.T) {
	store := gateway.NewMemoryStore()
	svc := gateway.NewService(store, nil, gateway.Options{})
	handler := NewServer(svc, Config{InternalToken: "internal-token"})

	body := `{
		"routing": {"mode": "byok_first"},
		"providers": [{
			"id": "provider-1",
			"name": "腾讯云 MaaS",
			"protocol": "openai_compatible",
			"base_url": "https://tokenhub.tencentmaas.com",
			"api_key": "sk-user-secret",
			"model_mappings": {"auto": "minimax-m2.7"},
			"enabled": true
		}]
	}`
	putReq := httptest.NewRequest(http.MethodPut, "/api/internal/users/user-1/llm-settings", bytes.NewBufferString(body))
	putReq.Header.Set("Authorization", "Bearer internal-token")
	putRec := httptest.NewRecorder()
	handler.ServeHTTP(putRec, putReq)
	if putRec.Code != http.StatusOK {
		t.Fatalf("put status=%d body=%s", putRec.Code, putRec.Body.String())
	}

	getReq := httptest.NewRequest(http.MethodGet, "/api/internal/users/user-1/llm-settings", nil)
	getReq.Header.Set("Authorization", "Bearer internal-token")
	getRec := httptest.NewRecorder()
	handler.ServeHTTP(getRec, getReq)
	if getRec.Code != http.StatusOK {
		t.Fatalf("get status=%d body=%s", getRec.Code, getRec.Body.String())
	}
	if strings.Contains(getRec.Body.String(), "sk-user-secret") {
		t.Fatalf("response leaked provider key: %s", getRec.Body.String())
	}
	var resp struct {
		Success bool `json:"success"`
		Data    struct {
			Routing struct {
				Mode string `json:"mode"`
			} `json:"routing"`
			Providers []struct {
				ID            string            `json:"id"`
				Name          string            `json:"name"`
				Protocol      string            `json:"protocol"`
				BaseURL       string            `json:"base_url"`
				KeyHash       string            `json:"key_hash"`
				ModelMappings map[string]string `json:"model_mappings"`
				Enabled       bool              `json:"enabled"`
			} `json:"providers"`
		} `json:"data"`
	}
	if err := json.NewDecoder(getRec.Body).Decode(&resp); err != nil {
		t.Fatal(err)
	}
	if !resp.Success || resp.Data.Routing.Mode != "byok_first" {
		t.Fatalf("unexpected routing response: %+v", resp)
	}
	if len(resp.Data.Providers) != 1 {
		t.Fatalf("providers len=%d, want 1", len(resp.Data.Providers))
	}
	provider := resp.Data.Providers[0]
	if provider.ID != "provider-1" || provider.KeyHash == "" || provider.ModelMappings["auto"] != "minimax-m2.7" {
		t.Fatalf("unexpected provider response: %+v", provider)
	}
}

func TestInternalUserLLMSettingsSyncQueuesPendingWorkWithoutCallingNewAPI(t *testing.T) {
	store := gateway.NewMemoryStore()
	if err := store.SaveSet(context.Background(), gateway.Set{
		ID:               "set-a",
		Name:             "Set A",
		BaseURL:          "http://newapi.invalid",
		Status:           gateway.SetStatusActive,
		AdminUserID:      1,
		AdminAccessToken: "admin-token",
		Setup:            true,
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveUserBinding(context.Background(), gateway.UserBinding{
		ExternalUserID:  "user-1",
		SetID:           "set-a",
		UpstreamUserID:  42,
		Username:        "sgw-user",
		Password:        "password",
		ProvisionStatus: gateway.BindingProvisionStatusTokenReady,
	}); err != nil {
		t.Fatal(err)
	}
	called := false
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		http.Error(w, "sync endpoint should not call new-api", http.StatusTeapot)
	}))
	defer upstream.Close()
	set, ok, err := store.GetSet(context.Background(), "set-a")
	if err != nil || !ok {
		t.Fatalf("get set ok=%v err=%v", ok, err)
	}
	set.BaseURL = upstream.URL
	if err := store.SaveSet(context.Background(), set); err != nil {
		t.Fatal(err)
	}

	svc := gateway.NewService(store, upstream.Client().Transport, gateway.Options{})
	handler := NewServer(svc, Config{InternalToken: "internal-token"})

	putReq := httptest.NewRequest(http.MethodPut, "/api/internal/users/user-1/llm-settings", bytes.NewBufferString(`{
		"routing": {"mode": "byok_first"},
		"providers": [{
			"id": "provider-1",
			"name": "腾讯云 MaaS",
			"protocol": "openai_compatible",
			"base_url": "https://tokenhub.tencentmaas.com",
			"api_key": "sk-user-secret",
			"model_mappings": {"auto": "minimax-m2.7"},
			"enabled": true
		}]
	}`))
	putReq.Header.Set("Authorization", "Bearer internal-token")
	putRec := httptest.NewRecorder()
	handler.ServeHTTP(putRec, putReq)
	if putRec.Code != http.StatusOK {
		t.Fatalf("put status=%d body=%s", putRec.Code, putRec.Body.String())
	}

	syncReq := httptest.NewRequest(http.MethodPost, "/api/internal/users/user-1/llm-settings/sync", nil)
	syncReq.Header.Set("Authorization", "Bearer internal-token")
	syncRec := httptest.NewRecorder()
	handler.ServeHTTP(syncRec, syncReq)
	if syncRec.Code != http.StatusOK {
		t.Fatalf("sync status=%d body=%s", syncRec.Code, syncRec.Body.String())
	}
	if called {
		t.Fatal("HTTP sync should enqueue pending BYOK work instead of calling new-api inline")
	}
	var syncResp struct {
		Success bool `json:"success"`
		Data    struct {
			UserID    string `json:"user_id"`
			SetID     string `json:"set_id"`
			BYOKGroup string `json:"byok_group"`
			Status    string `json:"status"`
			Providers []struct {
				ID         string `json:"id"`
				SyncStatus string `json:"sync_status"`
			} `json:"providers"`
		} `json:"data"`
	}
	if err := json.NewDecoder(strings.NewReader(syncRec.Body.String())).Decode(&syncResp); err != nil {
		t.Fatalf("decode sync response: %v body=%s", err, syncRec.Body.String())
	}
	if !syncResp.Success || syncResp.Data.UserID != "user-1" || syncResp.Data.SetID != "set-a" || syncResp.Data.Status != gateway.LLMProviderSyncPending {
		t.Fatalf("unexpected queued response: %+v body=%s", syncResp, syncRec.Body.String())
	}
	if len(syncResp.Data.Providers) != 1 || syncResp.Data.Providers[0].SyncStatus != gateway.LLMProviderSyncPending {
		t.Fatalf("provider not marked pending: %+v body=%s", syncResp.Data.Providers, syncRec.Body.String())
	}
}

func TestInternalUserLLMSettingsSyncCreatesPrivateNewAPIChannelAndToken(t *testing.T) {
	var groupRatioBody map[string]any
	var channelBody map[string]any
	var channelUpdateBody map[string]any
	var tokenBody map[string]any
	var userUpdateBody map[string]any
	var byokGroup string
	var byokChannelName string
	var byokTokenName string
	var manageCalls int
	var manageBody map[string]any
	var channelCreated bool
	var optionReadCalls int

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/option/":
			optionReadCalls++
			_, _ = w.Write([]byte(`{"success":true,"data":[{"key":"GroupRatio","value":"{\"default\":1}"}]}`))
		case r.Method == http.MethodPut && r.URL.Path == "/api/option/":
			if err := json.NewDecoder(r.Body).Decode(&groupRatioBody); err != nil {
				t.Fatalf("decode group ratio body: %v", err)
			}
			groupRatios := map[string]float64{}
			if raw, ok := groupRatioBody["value"].(string); ok {
				if err := json.Unmarshal([]byte(raw), &groupRatios); err != nil {
					t.Fatalf("decode group ratio value: %v", err)
				}
			}
			for group := range groupRatios {
				if group != "default" {
					byokGroup = group
				}
			}
			_, _ = w.Write([]byte(`{"success":true,"data":{}}`))
		case r.Method == http.MethodGet && r.URL.Path == "/api/channel/search":
			byokChannelName = r.URL.Query().Get("keyword")
			if channelCreated {
				_, _ = w.Write([]byte(`{"success":true,"data":{"items":[{"id":17,"name":"` + byokChannelName + `","type":1,"status":1,"models":"auto","group":"` + byokGroup + `","base_url":"https://tokenhub.tencentmaas.com"}],"total":1}}`))
				return
			}
			_, _ = w.Write([]byte(`{"success":true,"data":{"items":[],"total":0}}`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/channel/":
			if err := json.NewDecoder(r.Body).Decode(&channelBody); err != nil {
				t.Fatalf("decode channel body: %v", err)
			}
			channelCreated = true
			_, _ = w.Write([]byte(`{"success":true,"data":{}}`))
		case r.Method == http.MethodPut && r.URL.Path == "/api/channel/":
			if err := json.NewDecoder(r.Body).Decode(&channelUpdateBody); err != nil {
				t.Fatalf("decode channel update body: %v", err)
			}
			_, _ = w.Write([]byte(`{"success":true,"data":{}}`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/user/login":
			_, _ = w.Write([]byte(`{"success":true,"data":{"id":42,"username":"sgw-user","role":1,"status":1,"group":"default"}}`))
		case r.Method == http.MethodGet && r.URL.Path == "/api/user/search":
			_, _ = w.Write([]byte(`{"success":true,"data":{"items":[{"id":42,"username":"sgw-user","display_name":"Existing User","role":1,"status":1,"group":"default"}]}}`))
		case r.Method == http.MethodGet && r.URL.Path == "/api/user/token":
			_, _ = w.Write([]byte(`{"success":true,"data":"user-access-token"}`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/token/":
			if err := json.NewDecoder(r.Body).Decode(&tokenBody); err != nil {
				t.Fatalf("decode token body: %v", err)
			}
			_, _ = w.Write([]byte(`{"success":true,"data":{}}`))
		case r.Method == http.MethodPut && r.URL.Path == "/api/user/":
			if err := json.NewDecoder(r.Body).Decode(&userUpdateBody); err != nil {
				t.Fatalf("decode user update body: %v", err)
			}
			_, _ = w.Write([]byte(`{"success":true,"data":{}}`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/user/manage":
			manageCalls++
			if err := json.NewDecoder(r.Body).Decode(&manageBody); err != nil {
				t.Fatalf("decode manage body: %v", err)
			}
			_, _ = w.Write([]byte(`{"success":true,"data":{}}`))
		case r.Method == http.MethodGet && r.URL.Path == "/api/token/search":
			byokTokenName = r.URL.Query().Get("keyword")
			_, _ = w.Write([]byte(`{"success":true,"data":{"items":[{"id":77,"name":"` + byokTokenName + `"}]}}`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/token/77/key":
			_, _ = w.Write([]byte(`{"success":true,"data":{"key":"sk-byok-upstream"}}`))
		default:
			t.Fatalf("unexpected upstream request: %s %s", r.Method, r.URL.String())
		}
	}))
	defer upstream.Close()

	store := gateway.NewMemoryStore()
	if err := store.SaveSet(t.Context(), gateway.Set{
		ID:               "set-a",
		Name:             "Set A",
		BaseURL:          upstream.URL,
		Status:           gateway.SetStatusActive,
		Setup:            true,
		AdminUserID:      1,
		AdminAccessToken: "admin-access-token",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReplacePlatformGroupRatios(t.Context(), "set-a", "stable", map[string]float64{"default": 1}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveUserBinding(t.Context(), gateway.UserBinding{
		ExternalUserID:  "user-1",
		SetID:           "set-a",
		UpstreamUserID:  42,
		Username:        "sgw-user",
		Password:        "password",
		ProvisionStatus: gateway.BindingProvisionStatusTokenReady,
	}); err != nil {
		t.Fatal(err)
	}
	svc := gateway.NewService(store, upstream.Client().Transport, gateway.Options{})
	handler := NewServer(svc, Config{InternalToken: "internal-token"})

	putReq := httptest.NewRequest(http.MethodPut, "/api/internal/users/user-1/llm-settings", bytes.NewBufferString(`{
		"routing": {"mode": "byok_first"},
		"providers": [{
			"id": "provider-1",
			"name": "腾讯云 MaaS",
			"protocol": "openai_compatible",
			"base_url": "https://tokenhub.tencentmaas.com",
			"api_key": "sk-user-secret",
			"model_mappings": {"auto": "minimax-m2.7"},
			"enabled": true
		}]
	}`))
	putReq.Header.Set("Authorization", "Bearer internal-token")
	putRec := httptest.NewRecorder()
	handler.ServeHTTP(putRec, putReq)
	if putRec.Code != http.StatusOK {
		t.Fatalf("put status=%d body=%s", putRec.Code, putRec.Body.String())
	}

	syncResult, err := svc.SyncUserLLMSettings(context.Background(), "user-1")
	if err != nil {
		t.Fatalf("sync settings: %v", err)
	}
	if len(syncResult.Providers) != 1 ||
		syncResult.Providers[0].RemoteChannelID != 17 ||
		syncResult.Providers[0].SyncStatus != gateway.LLMProviderSyncSynced {
		t.Fatalf("sync response did not expose created remote channel: %+v", syncResult)
	}
	if optionReadCalls != 0 {
		t.Fatalf("synchronous BYOK sync read remote GroupRatio %d times", optionReadCalls)
	}
	task, ok, err := store.GetBYOKSyncTask(t.Context(), "user-1")
	if err != nil || !ok {
		t.Fatalf("get completed BYOK task = %v, %v", ok, err)
	}
	if task.Status != gateway.BYOKSyncTaskStatusSucceeded || task.AppliedVersion != task.RequestedVersion {
		t.Fatalf("synchronous BYOK task did not complete: %+v", task)
	}

	if groupRatioBody["key"] != "GroupRatio" || byokGroup == "" || !strings.Contains(groupRatioBody["value"].(string), `"`+byokGroup+`":0`) {
		t.Fatalf("unexpected group ratio update: %#v", groupRatioBody)
	}
	channel := channelBody["channel"].(map[string]any)
	if channel["group"] != byokGroup || channel["models"] != "auto" {
		t.Fatalf("unexpected channel group/models: %#v", channel)
	}
	if channel["key"] != "sk-user-secret" || channel["base_url"] != "https://tokenhub.tencentmaas.com" {
		t.Fatalf("unexpected channel credentials: %#v", channel)
	}
	if !strings.Contains(channel["model_mapping"].(string), `"auto":"minimax-m2.7"`) {
		t.Fatalf("unexpected model mapping: %#v", channel["model_mapping"])
	}
	if channelUpdateBody["id"] != float64(17) || channelUpdateBody["name"] != byokChannelName {
		t.Fatalf("created channel was not updated to refresh new-api routing cache: %#v", channelUpdateBody)
	}
	if tokenBody["group"] != byokGroup || tokenBody["unlimited_quota"] != true {
		t.Fatalf("unexpected token request: %#v", tokenBody)
	}
	if tokenBody["name"] != byokTokenName || len(byokTokenName) > 32 {
		t.Fatalf("unexpected short BYOK token name: body=%#v search=%q", tokenBody, byokTokenName)
	}
	if userUpdateBody == nil || userUpdateBody["id"] != float64(42) || userUpdateBody["username"] != "sgw-user" || userUpdateBody["group"] != byokGroup {
		t.Fatalf("BYOK sync must grant the user access to the private new-api group: %#v", userUpdateBody)
	}
	if manageCalls != 0 {
		t.Fatalf("unexpected user manage call during BYOK sync: %#v", manageBody)
	}
}
