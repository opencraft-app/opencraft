package devroute

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/openclaw/openclaw/mono/shared/cloudladdertransport"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) { return f(req) }

func TestClientMatchesGatewayStringUINWireContract(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			UIN        string `json:"uin"`
			TargetIP   string `json:"targetIp"`
			Port       int    `json:"port"`
			TTLSeconds int    `json:"ttlSeconds"`
		}
		decoder := json.NewDecoder(r.Body)
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&request); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"uin":       request.UIN,
			"status":    "active",
			"targetIp":  request.TargetIP,
			"port":      request.Port,
			"expiresAt": "2026-09-17T20:00:00Z",
			"updatedAt": "2026-09-17T12:00:00Z",
		})
	}))
	defer server.Close()

	client, err := New(Config{
		GatewayBaseURL: server.URL,
		RouteID:        "developer-route-control",
		Caller:         "lightclaw-auth",
		Secret:         "test-secret",
	})
	if err != nil {
		t.Fatal(err)
	}
	registration, err := client.Register(context.Background(), RegisterInput{
		Uin: 450860000013, TargetIP: "9.134.214.121", Port: 18084, TTLSeconds: 28800,
	})
	if err != nil {
		t.Fatal(err)
	}
	if registration.Uin != 450860000013 || registration.Status != "active" {
		t.Fatalf("unexpected registration: %+v", registration)
	}
}

func TestClientSignsServerDerivedRegistration(t *testing.T) {
	now := time.Date(2026, 9, 8, 9, 30, 0, 0, time.UTC)
	var request *http.Request
	client, err := New(Config{
		GatewayBaseURL: "http://gateway.testing",
		RouteID:        "developer-route-control",
		Caller:         "lightclaw-auth",
		Secret:         "test-secret",
		Now:            func() time.Time { return now },
		HTTPClient: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			request = req
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     make(http.Header),
				Body:       io.NopCloser(strings.NewReader(`{"uin":"450860000013","status":"active","targetIp":"9.134.214.121","port":18084,"tunnelHost":"uin-450860000013.tunnel.internal","tunnelToken":"lvdt1.450860000013.test","expiresAt":"2026-09-08T17:30:00Z","updatedAt":"2026-09-08T09:30:00Z"}`)),
				Request:    req,
			}, nil
		})},
	})
	if err != nil {
		t.Fatal(err)
	}
	registration, err := client.Register(context.Background(), RegisterInput{
		Uin: 450860000013, TargetIP: "9.134.214.121", Port: 18084, TTLSeconds: 28800,
	})
	if err != nil {
		t.Fatal(err)
	}
	if registration.TunnelHost != "uin-450860000013.tunnel.internal" || registration.TunnelToken != "lvdt1.450860000013.test" {
		t.Fatalf("unexpected registration: %+v", registration)
	}
	if request.URL.Path != registrationPath || request.URL.RawQuery != "" {
		t.Fatalf("unexpected request URL: %s", request.URL.String())
	}
	body, err := io.ReadAll(request.Body)
	if err != nil {
		t.Fatal(err)
	}
	timestamp := request.Header.Get(cloudladdertransport.HeaderTimestamp)
	expected := cloudladdertransport.Sign("test-secret", cloudladdertransport.Request{
		Caller:    "lightclaw-auth",
		RouteID:   "developer-route-control",
		Method:    http.MethodPost,
		Path:      registrationPath,
		Body:      body,
		Timestamp: timestamp,
	})
	if got := request.Header.Get(cloudladdertransport.HeaderCaller); got != "lightclaw-auth" {
		t.Fatalf("caller=%q", got)
	}
	if got := request.Header.Get(cloudladdertransport.HeaderSignature); got != expected {
		t.Fatalf("signature=%q want=%q", got, expected)
	}
	if strings.Contains(string(body), "session") || !strings.Contains(string(body), `"uin":"450860000013"`) || !strings.Contains(string(body), `"targetIp":"9.134.214.121"`) {
		t.Fatalf("unexpected body: %s", body)
	}
}

func TestClientSignsUINQueryForGetAndDisable(t *testing.T) {
	for _, method := range []string{http.MethodGet, http.MethodDelete} {
		t.Run(method, func(t *testing.T) {
			var request *http.Request
			client, err := New(Config{
				GatewayBaseURL: "http://gateway.testing/base",
				RouteID:        "developer-route-control",
				Caller:         "lightclaw-auth",
				Secret:         "test-secret",
				Now:            func() time.Time { return time.Date(2026, 9, 8, 9, 30, 0, 0, time.UTC) },
				HTTPClient: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
					request = req
					return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"uin":"450860000013","status":"disabled"}`)), Request: req}, nil
				})},
			})
			if err != nil {
				t.Fatal(err)
			}
			if method == http.MethodGet {
				_, err = client.Get(context.Background(), 450860000013)
			} else {
				_, err = client.Disable(context.Background(), 450860000013)
			}
			if err != nil {
				t.Fatal(err)
			}
			if request.URL.Path != "/base"+registrationPath || request.URL.Query().Get("uin") != "450860000013" {
				t.Fatalf("unexpected URL: %s", request.URL.String())
			}
			expected := cloudladdertransport.Sign("test-secret", cloudladdertransport.Request{
				Caller:    "lightclaw-auth",
				RouteID:   "developer-route-control",
				Method:    method,
				Path:      registrationPath,
				Query:     "uin=450860000013",
				Timestamp: request.Header.Get(cloudladdertransport.HeaderTimestamp),
			})
			if got := request.Header.Get(cloudladdertransport.HeaderSignature); got != expected {
				t.Fatalf("signature=%q want=%q", got, expected)
			}
		})
	}
}

func TestClientReturnsStructuredGatewayError(t *testing.T) {
	client, err := New(Config{
		GatewayBaseURL: "http://gateway.testing",
		RouteID:        "developer-route-control",
		Caller:         "lightclaw-auth",
		Secret:         "test-secret",
		HTTPClient: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: http.StatusBadGateway, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"code":"target_unreachable","message":"target probe failed"}`)), Request: req}, nil
		})},
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.Get(context.Background(), 450860000013)
	var gatewayErr *Error
	if !errors.As(err, &gatewayErr) || gatewayErr.Status != http.StatusBadGateway || gatewayErr.Code != "target_unreachable" {
		t.Fatalf("unexpected error: %#v", err)
	}
}
