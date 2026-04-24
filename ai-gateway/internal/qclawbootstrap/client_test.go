package qclawbootstrap

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestClientUpsertProviderAndMapping(t *testing.T) {
	var createProvider providerPayload
	var createMapping mappingPayload

	client := NewClient("http://ai-gateway.local", "admin-token")
	client.httpClient = &http.Client{
		Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
			rec := responseRecorder{status: http.StatusOK}
			switch r.URL.Path {
			case "/api/admin/providers":
				switch r.Method {
				case http.MethodGet:
					_ = json.NewEncoder(&rec.body).Encode(map[string]any{
						"items": []map[string]any{},
						"total": 0,
					})
				case http.MethodPost:
					if err := json.NewDecoder(r.Body).Decode(&createProvider); err != nil {
						t.Fatalf("decode provider body: %v", err)
					}
					_ = json.NewEncoder(&rec.body).Encode(map[string]any{
						"id":   "provider-1",
						"name": createProvider.Name,
					})
				default:
					t.Fatalf("unexpected method %s", r.Method)
				}
			case "/api/admin/model-mappings":
				switch r.Method {
				case http.MethodGet:
					_ = json.NewEncoder(&rec.body).Encode(map[string]any{
						"items": []map[string]any{},
						"total": 0,
					})
				case http.MethodPost:
					if err := json.NewDecoder(r.Body).Decode(&createMapping); err != nil {
						t.Fatalf("decode mapping body: %v", err)
					}
					_ = json.NewEncoder(&rec.body).Encode(map[string]any{
						"id":            "mapping-1",
						"model_pattern": createMapping.ModelPattern,
					})
				default:
					t.Fatalf("unexpected method %s", r.Method)
				}
			default:
				t.Fatalf("unexpected path %s", r.URL.Path)
			}
			return rec.response(), nil
		}),
	}

	providerID, err := client.UpsertProvider(context.Background(), BuildProviderPayload("qclaw-local", "http://127.0.0.1:28789", "token", "openclaw:main"))
	if err != nil {
		t.Fatalf("UpsertProvider: %v", err)
	}
	if providerID != "provider-1" {
		t.Fatalf("unexpected provider id: %q", providerID)
	}
	if createProvider.Name != "qclaw-local" {
		t.Fatalf("provider create body mismatch: %#v", createProvider)
	}

	if err := client.UpsertModelMapping(context.Background(), BuildMappingPayload("gpt-4o-mini", providerID)); err != nil {
		t.Fatalf("UpsertModelMapping: %v", err)
	}
	if createMapping.ProviderID != "provider-1" {
		t.Fatalf("mapping body mismatch: %#v", createMapping)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) {
	return f(r)
}

type responseRecorder struct {
	status int
	body   strings.Builder
}

func (r responseRecorder) response() *http.Response {
	return &http.Response{
		StatusCode: r.status,
		Body:       io.NopCloser(strings.NewReader(r.body.String())),
		Header:     make(http.Header),
	}
}
