package contentaudit

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) Do(req *http.Request) (*http.Response, error) {
	return f(req)
}

func TestCreateTextTaskSendsProxyToken(t *testing.T) {
	var gotToken string
	client, err := New(Config{
		Endpoint:   "https://proxy.example.com/contentaudit/submit/",
		ProxyToken: "proxy-token",
		HTTPClient: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			gotToken = req.Header.Get("X-Proxy-Token")
			if req.URL.String() != "https://proxy.example.com/contentaudit/submit/risk-control-forge/content/CreateTextTask" {
				t.Fatalf("url = %q", req.URL.String())
			}
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     make(http.Header),
				Body:       io.NopCloser(strings.NewReader(`{"Response":{"RequestID":"rid"}}`)),
				Request:    req,
			}, nil
		}),
	})
	if err != nil {
		t.Fatalf("New returned error: %v", err)
	}

	_, err = client.CreateTextTask(context.Background(), CreateTextTaskRequest{
		ProductID: "8121009",
		SID:       "300071",
		RequestID: "rid",
	})
	if err != nil {
		t.Fatalf("CreateTextTask returned error: %v", err)
	}
	if gotToken != "proxy-token" {
		t.Fatalf("X-Proxy-Token = %q, want proxy-token", gotToken)
	}
}

func TestCreateTextTaskOmitsEmptyProxyToken(t *testing.T) {
	var gotToken string
	client, err := New(Config{
		Endpoint: "https://proxy.example.com/contentaudit/submit",
		HTTPClient: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			gotToken = req.Header.Get("X-Proxy-Token")
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     make(http.Header),
				Body:       io.NopCloser(strings.NewReader(`{"Response":{"RequestID":"rid"}}`)),
				Request:    req,
			}, nil
		}),
	})
	if err != nil {
		t.Fatalf("New returned error: %v", err)
	}

	_, err = client.CreateTextTask(context.Background(), CreateTextTaskRequest{
		ProductID: "8121009",
		SID:       "300071",
		RequestID: "rid",
	})
	if err != nil {
		t.Fatalf("CreateTextTask returned error: %v", err)
	}
	if gotToken != "" {
		t.Fatalf("X-Proxy-Token = %q, want empty", gotToken)
	}
}

func TestCreateTextTaskDecodesAsyncPendingResponse(t *testing.T) {
	client, err := New(Config{
		Endpoint: "https://proxy.example.com/contentaudit/submit",
		HTTPClient: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     make(http.Header),
				Body: io.NopCloser(strings.NewReader(`{
					"Response": {
						"RequestID": "rid",
						"Data": {
							"Result": {
								"StdRetMsg": "UNKNOWN",
								"Detector": "strategy"
							},
							"AhResultCode": 0,
							"HasAsyncPending": true
						}
					}
				}`)),
				Request: req,
			}, nil
		}),
	})
	if err != nil {
		t.Fatalf("New returned error: %v", err)
	}

	resp, err := client.CreateTextTask(context.Background(), CreateTextTaskRequest{
		ProductID: "30003",
		SID:       "300025",
		RequestID: "rid",
	})
	if err != nil {
		t.Fatalf("CreateTextTask returned error: %v", err)
	}
	if resp.Response.Data == nil || !resp.Response.Data.HasAsyncPending {
		t.Fatalf("expected async pending response, got %+v", resp.Response.Data)
	}
	if resp.Response.Data.Result == nil || resp.Response.Data.Result.StdRetMsg != "UNKNOWN" {
		t.Fatalf("expected std return message, got %+v", resp.Response.Data.Result)
	}
}
