package website

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestRetentionSchedulerConfigurationAndCancellation(t *testing.T) {
	for _, raw := range []string{"0s", "-1m", "bad", "25h", "59s"} {
		t.Setenv("WEBSITE_RETENTION_SWEEP_INTERVAL", raw)
		if _, err := retentionSweepInterval(); err == nil {
			t.Fatalf("accepted %s", raw)
		}
	}
	for _, raw := range []string{"", "1m", "24h"} {
		t.Setenv("WEBSITE_RETENTION_SWEEP_INTERVAL", raw)
		ctx, cancel := context.WithCancel(context.Background())
		d := &Deployer{}
		done, err := d.StartRetentionScheduler(ctx)
		if err != nil {
			t.Fatal(err)
		}
		cancel()
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Fatal("scheduler failed to stop")
		}
	}
}

func TestRetentionSweepPreservesCursorOnFailure(t *testing.T) {
	for _, tc := range []struct {
		status int
		body   string
		want   string
		ok     bool
	}{
		{200, `{"data":{"next_cursor":"ws-b","scanned":20}}`, "ws-b", true},
		{200, `{"data":{"next_cursor":"","scanned":2}}`, "", true},
		{503, `{}`, "ws-a", false},
		{200, `{}`, "ws-a", false},
		{200, `{"data":{"next_cursor":"ws-a","scanned":20}}`, "ws-a", false},
		{200, `{"data":{"next_cursor":"ws-b","scanned":21}}`, "ws-a", false},
	} {
		t.Run(tc.body+http.StatusText(tc.status), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != "POST" || r.Header.Get("X-Internal-Token") != "secret" || r.URL.Query().Get("cursor") != "ws-a" {
					t.Error("request contract violated")
				}
				w.WriteHeader(tc.status)
				w.Write([]byte(tc.body))
			}))
			defer server.Close()
			d := &Deployer{ctlBaseURL: server.URL, httpClient: server.Client()}
			d.SetInternalToken("secret")
			got, err := d.sweepRetention(context.Background(), "ws-a")
			if got != tc.want || (err == nil) != tc.ok {
				t.Fatalf("got %q %v", got, err)
			}
		})
	}
}
