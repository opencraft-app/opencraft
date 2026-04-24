package handler

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"git.woa.com/wisp/mono/ai-gateway/internal/model"
)

func TestAdminValidateProvider_Success(t *testing.T) {
	r, h := setupAdminTest(t)
	r.POST("/api/admin/providers/validate", h.ValidateProvider)
	h.providerSvc.SetHTTPClient(&http.Client{
		Transport: validationRoundTripFunc(func(req *http.Request) (*http.Response, error) {
			if req.URL.Path != "/v1/models" {
				t.Fatalf("expected /v1/models, got %s", req.URL.Path)
			}
			if got := req.Header.Get("Authorization"); got != "Bearer sk-test" {
				t.Fatalf("expected bearer auth, got %q", got)
			}
			return jsonResponse(http.StatusOK, `{"data":[{"id":"gpt-4"}]}`), nil
		}),
	})

	body := `{"provider_type":"openai","base_url":"https://provider.example.com","api_key":"sk-test"}`
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/admin/providers/validate", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d, body: %s", w.Code, w.Body.String())
	}

	var resp map[string]interface{}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}

	if ok, _ := resp["ok"].(bool); !ok {
		t.Fatalf("expected ok=true, got %#v", resp)
	}
	if endpoint, _ := resp["endpoint"].(string); endpoint != "https://provider.example.com/v1/models" {
		t.Fatalf("expected endpoint https://provider.example.com/v1/models, got %q", endpoint)
	}
	if usedSaved, _ := resp["used_saved_api_key"].(bool); usedSaved {
		t.Fatalf("expected used_saved_api_key=false, got %#v", resp)
	}
	if statusCode, _ := resp["status_code"].(float64); statusCode != http.StatusOK {
		t.Fatalf("expected status_code=200, got %#v", resp["status_code"])
	}
}

func TestAdminValidateProvider_UsesStoredAPIKey(t *testing.T) {
	r, h := setupAdminTest(t)
	r.POST("/api/admin/providers/validate", h.ValidateProvider)
	h.providerSvc.SetHTTPClient(&http.Client{
		Transport: validationRoundTripFunc(func(req *http.Request) (*http.Response, error) {
			if got := req.Header.Get("Authorization"); got != "Bearer sk-saved" {
				t.Fatalf("expected stored key to be used, got %q", got)
			}
			return jsonResponse(http.StatusOK, `{"data":[{"id":"gpt-4"}]}`), nil
		}),
	})

	provider := &model.Provider{
		Name:         "Saved Provider",
		ProviderType: model.ProviderTypeOpenAI,
		APIKey:       "sk-saved",
		BaseURL:      "https://provider.example.com",
		TotalQuota:   1000,
		Status:       model.ProviderStatusActive,
	}
	if err := h.providerSvc.Create(provider); err != nil {
		t.Fatalf("create provider: %v", err)
	}

	body := fmt.Sprintf(`{"provider_id":"%s","provider_type":"openai","base_url":"https://provider.example.com"}`, provider.ID.String())
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/admin/providers/validate", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d, body: %s", w.Code, w.Body.String())
	}

	var resp map[string]interface{}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}

	if ok, _ := resp["ok"].(bool); !ok {
		t.Fatalf("expected ok=true, got %#v", resp)
	}
	if usedSaved, _ := resp["used_saved_api_key"].(bool); !usedSaved {
		t.Fatalf("expected used_saved_api_key=true, got %#v", resp)
	}
}

func TestAdminValidateProvider_AuthenticationFailure(t *testing.T) {
	r, h := setupAdminTest(t)
	r.POST("/api/admin/providers/validate", h.ValidateProvider)
	h.providerSvc.SetHTTPClient(&http.Client{
		Transport: validationRoundTripFunc(func(req *http.Request) (*http.Response, error) {
			return jsonResponse(http.StatusUnauthorized, `{"error":"invalid api key"}`), nil
		}),
	})

	body := `{"provider_type":"openai","base_url":"https://provider.example.com","api_key":"sk-wrong"}`
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/admin/providers/validate", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d, body: %s", w.Code, w.Body.String())
	}

	var resp map[string]interface{}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}

	if ok, _ := resp["ok"].(bool); ok {
		t.Fatalf("expected ok=false, got %#v", resp)
	}
	if errorType, _ := resp["error_type"].(string); errorType != "authentication" {
		t.Fatalf("expected error_type=authentication, got %#v", resp["error_type"])
	}
	if statusCode, _ := resp["status_code"].(float64); statusCode != http.StatusUnauthorized {
		t.Fatalf("expected status_code=401, got %#v", resp["status_code"])
	}
}

func TestAdminDiscoverProviderModels_OpenAICompatible(t *testing.T) {
	r, h := setupAdminTest(t)
	r.POST("/api/admin/providers/discover-models", h.DiscoverProviderModels)
	h.providerSvc.SetHTTPClient(&http.Client{
		Transport: validationRoundTripFunc(func(req *http.Request) (*http.Response, error) {
			if req.Method != http.MethodGet {
				t.Fatalf("expected GET, got %s", req.Method)
			}
			if req.URL.Path != "/v1/models" {
				t.Fatalf("expected /v1/models, got %s", req.URL.Path)
			}
			if got := req.Header.Get("Authorization"); got != "Bearer sk-test" {
				t.Fatalf("expected bearer auth, got %q", got)
			}
			return jsonResponse(http.StatusOK, `{"data":[{"id":"gpt-4o"},{"id":"gpt-4o-mini"},{"id":"gpt-4o"}]}`), nil
		}),
	})

	body := `{"model_discovery_protocol":"openai_compatible","base_url":"https://provider.example.com","api_key":"sk-test"}`
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/admin/providers/discover-models", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d, body: %s", w.Code, w.Body.String())
	}

	var resp map[string]interface{}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}

	if ok, _ := resp["ok"].(bool); !ok {
		t.Fatalf("expected ok=true, got %#v", resp)
	}
	models, _ := resp["models"].([]interface{})
	if len(models) != 2 {
		t.Fatalf("expected 2 normalized models, got %#v", resp["models"])
	}
	if rawCount, _ := resp["raw_count"].(float64); rawCount != 3 {
		t.Fatalf("expected raw_count=3, got %#v", resp["raw_count"])
	}
	if normalizedCount, _ := resp["normalized_count"].(float64); normalizedCount != 2 {
		t.Fatalf("expected normalized_count=2, got %#v", resp["normalized_count"])
	}
}

func TestAdminValidateProviderModelRequest_OpenAICompatible(t *testing.T) {
	r, h := setupAdminTest(t)
	r.POST("/api/admin/providers/validate-model-request", h.ValidateProviderModelRequest)
	h.providerSvc.SetHTTPClient(&http.Client{
		Transport: validationRoundTripFunc(func(req *http.Request) (*http.Response, error) {
			if req.Method != http.MethodPost {
				t.Fatalf("expected POST, got %s", req.Method)
			}
			if req.URL.Path != "/v1/chat/completions" {
				t.Fatalf("expected /v1/chat/completions, got %s", req.URL.Path)
			}
			if got := req.Header.Get("Authorization"); got != "Bearer sk-test" {
				t.Fatalf("expected bearer auth, got %q", got)
			}
			var body map[string]interface{}
			if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
				t.Fatalf("decode request body: %v", err)
			}
			if body["model"] != "gpt-4o-mini" {
				t.Fatalf("expected model gpt-4o-mini, got %#v", body["model"])
			}
			return jsonResponse(http.StatusOK, `{"id":"chatcmpl-test"}`), nil
		}),
	})

	body := `{"model_discovery_protocol":"openai_compatible","base_url":"https://provider.example.com","api_key":"sk-test","model":"gpt-4o-mini"}`
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/admin/providers/validate-model-request", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d, body: %s", w.Code, w.Body.String())
	}

	var resp map[string]interface{}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}

	if ok, _ := resp["ok"].(bool); !ok {
		t.Fatalf("expected ok=true, got %#v", resp)
	}
	if endpoint, _ := resp["endpoint"].(string); endpoint != "https://provider.example.com/v1/chat/completions" {
		t.Fatalf("expected chat completions endpoint, got %#v", resp["endpoint"])
	}
	if modelName, _ := resp["model"].(string); modelName != "gpt-4o-mini" {
		t.Fatalf("expected model echo, got %#v", resp["model"])
	}
}

type validationRoundTripFunc func(req *http.Request) (*http.Response, error)

func (fn validationRoundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return fn(req)
}

func jsonResponse(statusCode int, body string) *http.Response {
	return &http.Response{
		StatusCode: statusCode,
		Header: http.Header{
			"Content-Type": []string{"application/json"},
		},
		Body: io.NopCloser(strings.NewReader(body)),
	}
}
