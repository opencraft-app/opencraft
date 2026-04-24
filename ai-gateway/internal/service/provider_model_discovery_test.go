package service

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"

	"git.woa.com/wisp/mono/ai-gateway/internal/model"
)

func TestProviderService_DiscoverModels_OpenAICompatible(t *testing.T) {
	provRepo := newMockProviderRepo()
	svc := NewProviderService(provRepo, nil, []byte("01234567890123456789012345678901"))
	svc.SetHTTPClient(&http.Client{
		Transport: validationRoundTripFunc(func(req *http.Request) (*http.Response, error) {
			if req.URL.Path != "/v1/models" {
				t.Fatalf("expected /v1/models, got %s", req.URL.Path)
			}
			return jsonResponse(http.StatusOK, `{"data":[{"id":"gpt-4o"},{"id":"gpt-4o-mini"},{"id":"gpt-4o"}]}`), nil
		}),
	})

	result, err := svc.DiscoverModels(context.Background(), ProviderModelDiscoveryInput{
		ModelDiscoveryProtocol: model.ModelDiscoveryProtocolOpenAICompatible,
		BaseURL:                "https://provider.example.com",
		APIKey:                 "sk-test",
	})
	if err != nil {
		t.Fatalf("discover models: %v", err)
	}
	if !result.OK {
		t.Fatalf("expected ok result, got %#v", result)
	}
	if result.RawCount != 3 || result.NormalizedCount != 2 {
		t.Fatalf("unexpected counts: %#v", result)
	}
	if len(result.Models) != 2 || result.Models[0] != "gpt-4o" || result.Models[1] != "gpt-4o-mini" {
		t.Fatalf("unexpected models: %#v", result.Models)
	}
}

func TestProviderService_ValidateModelRequest_OpenAICompatible(t *testing.T) {
	provRepo := newMockProviderRepo()
	svc := NewProviderService(provRepo, nil, []byte("01234567890123456789012345678901"))
	svc.SetHTTPClient(&http.Client{
		Transport: validationRoundTripFunc(func(req *http.Request) (*http.Response, error) {
			if req.URL.Path != "/v1/chat/completions" {
				t.Fatalf("expected /v1/chat/completions, got %s", req.URL.Path)
			}
			if req.Method != http.MethodPost {
				t.Fatalf("expected POST, got %s", req.Method)
			}
			return jsonResponse(http.StatusOK, `{"id":"chatcmpl-test"}`), nil
		}),
	})

	result, err := svc.ValidateModelRequest(context.Background(), ProviderModelRequestValidationInput{
		ModelDiscoveryProtocol: model.ModelDiscoveryProtocolOpenAICompatible,
		BaseURL:                "https://provider.example.com",
		APIKey:                 "sk-test",
		Model:                  "gpt-4o-mini",
	})
	if err != nil {
		t.Fatalf("validate model request: %v", err)
	}
	if !result.OK {
		t.Fatalf("expected ok result, got %#v", result)
	}
	if result.Endpoint != "https://provider.example.com/v1/chat/completions" {
		t.Fatalf("unexpected endpoint: %s", result.Endpoint)
	}
	if result.Model != "gpt-4o-mini" {
		t.Fatalf("unexpected model: %s", result.Model)
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
