package ctlclient

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRevokeUsesInternalExactNameContract(t *testing.T) {
	var request RevokeRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/internal/ctl/passes/free-credit/revoke" || r.Header.Get("Authorization") != "Bearer internal-token" {
			t.Fatalf("path=%s auth=%q", r.URL.Path, r.Header.Get("Authorization"))
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Fatal(err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"code":"OK","message":"success","data":{}}`))
	}))
	defer server.Close()

	client := New(server.URL, "internal-token")
	err := client.Revoke(t.Context(), RevokeRequest{
		UserID: "usr-1", SubscriptionNames: []string{"free-credit:referral:reward-1"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if request.UserID != "usr-1" || len(request.SubscriptionNames) != 1 || request.SubscriptionNames[0] != "free-credit:referral:reward-1" {
		t.Fatalf("unexpected request: %+v", request)
	}
}
