package client

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestClientKeepsAuthenticationLanesSeparate(t *testing.T) {
	type request struct {
		method string
		path   string
		auth   string
		body   string
	}
	requests := make([]request, 0, 3)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		requests = append(requests, request{method: r.Method, path: r.URL.Path, auth: r.Header.Get("Authorization"), body: string(raw)})
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/internal/users/ensure":
			_, _ = w.Write([]byte(`{"success":true,"data":{"external_user_id":"user-1"}}`))
		case "/api/admin/users/user-1/api-keys":
			_, _ = w.Write([]byte(`{"success":true,"data":{"api_key":"sk-issued"}}`))
		case "/v1/chat/completions":
			_, _ = w.Write([]byte(`{"id":"chat-1","choices":[{"message":{"content":"你好"}}]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	api, err := New(Config{
		ControlURL:    server.URL,
		TrafficURL:    server.URL,
		InternalToken: "internal-secret",
		AdminToken:    "admin-secret",
		APIKey:        "sk-caller",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := api.EnsureUser(context.Background(), EnsureUserInput{UserID: "user-1"}); err != nil {
		t.Fatal(err)
	}
	if _, err := api.CreateAPIKey(context.Background(), "user-1", "default"); err != nil {
		t.Fatal(err)
	}
	if _, err := api.Chat(context.Background(), ChatInput{Model: "auto", Prompt: "你好"}); err != nil {
		t.Fatal(err)
	}

	want := []request{
		{method: http.MethodPost, path: "/api/internal/users/ensure", auth: "Bearer internal-secret"},
		{method: http.MethodPost, path: "/api/admin/users/user-1/api-keys", auth: "Bearer admin-secret"},
		{method: http.MethodPost, path: "/v1/chat/completions", auth: "Bearer sk-caller"},
	}
	if len(requests) != len(want) {
		t.Fatalf("requests=%+v", requests)
	}
	for i := range want {
		if requests[i].method != want[i].method || requests[i].path != want[i].path || requests[i].auth != want[i].auth {
			t.Fatalf("request[%d]=%+v want=%+v", i, requests[i], want[i])
		}
	}
}

func TestClientErrorDoesNotLeakToken(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"success":false,"message":"access token invalid"}`))
	}))
	defer server.Close()

	api, err := New(Config{ControlURL: server.URL, InternalToken: "do-not-leak"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = api.EnsureUser(context.Background(), EnsureUserInput{UserID: "user-1"})
	if err == nil || !strings.Contains(err.Error(), "401") || !strings.Contains(err.Error(), "access token invalid") {
		t.Fatalf("error=%v", err)
	}
	if strings.Contains(err.Error(), "do-not-leak") {
		t.Fatalf("token leaked in error: %v", err)
	}
}

func TestClientDryRunDoesNotSendRequest(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { requests++ }))
	defer server.Close()

	api, err := New(Config{ControlURL: server.URL, InternalToken: "internal", DryRun: true})
	if err != nil {
		t.Fatal(err)
	}
	result, err := api.EnsureUser(context.Background(), EnsureUserInput{UserID: "user-1"})
	if err != nil {
		t.Fatal(err)
	}
	if !result.DryRun || requests != 0 || result.Request.Path != "/api/internal/users/ensure" {
		t.Fatalf("result=%+v requests=%d", result, requests)
	}
}

func TestTrafficResponsePreservesOpenAIEnvelope(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"object":"list","data":[{"id":"auto","object":"model"}]}`))
	}))
	defer server.Close()

	api, err := New(Config{TrafficURL: server.URL, APIKey: "sk-user"})
	if err != nil {
		t.Fatal(err)
	}
	result, err := api.Models(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var payload struct {
		Object string `json:"object"`
		Data   []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := result.Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if payload.Object != "list" || len(payload.Data) != 1 || payload.Data[0].ID != "auto" {
		t.Fatalf("payload=%+v", payload)
	}
}
