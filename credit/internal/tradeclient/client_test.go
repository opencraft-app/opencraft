package tradeclient

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"git.woa.com/wisp/mono/credit/internal/store"
	"git.woa.com/wisp/mono/credit/internal/usage"
)

func TestReportUsage(t *testing.T) {
	var got usage.ReportRequest
	client := NewClient("http://trade.local", "token")
	client.client.Transport = roundTripper(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path != "/internal/trade/credit/resources/usage/report" || r.Header.Get("Authorization") != "Bearer token" {
			t.Fatalf("unexpected request: %s auth=%q", r.URL.Path, r.Header.Get("Authorization"))
		}
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Fatal(err)
		}
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(`{"retCode":0}`)), Header: make(http.Header)}, nil
	})
	_, err := client.ReportUsage(context.Background(), usage.ReportRequest{
		PackageID: "cpkg-1", PackageExpiredTime: time.Date(2026, 10, 3, 0, 0, 0, 0, time.UTC), CreditUsedDay: store.CreditAmount(12500),
	})
	if err != nil {
		t.Fatalf("ReportUsage: %v", err)
	}
	if got.PackageID != "cpkg-1" || got.CreditUsedDay != store.CreditAmount(12500) {
		t.Fatalf("unexpected request: %+v", got)
	}
}

type roundTripper func(*http.Request) (*http.Response, error)

func (f roundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}
