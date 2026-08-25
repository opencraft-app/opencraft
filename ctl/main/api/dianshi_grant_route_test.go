package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	passlogic "ctl/pkg/logic/pass"
	"ctl/pkg/transport"
)

type recordingDianshiGrantLogic struct {
	passlogic.Logic
	userID string
	req    *transport.GrantDianshiSubscriptionRequest
}

func (l *recordingDianshiGrantLogic) GrantDianshiSubscription(userID string, req *transport.GrantDianshiSubscriptionRequest) (*transport.GrantDianshiSubscriptionResult, error) {
	l.userID = userID
	l.req = req
	return &transport.GrantDianshiSubscriptionResult{Status: "granted", DealName: "deal-1", BigOrderID: "big-1"}, nil
}

func TestInternalDianshiGrantRequiresConfiguredBearer(t *testing.T) {
	t.Setenv("LIGHTCLAW_INTERNAL_SERVICE_TOKEN", "internal-token")
	router := newRouter(&instanceHandler{logic: &stubLogic{}}, &bundleHandler{}, &passHandler{})
	req := httptest.NewRequest(http.MethodPost, "/internal/ctl/subscriptions/dianshi/grant", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("got %d want 401; body=%s", rec.Code, rec.Body.String())
	}
}

func TestInternalDianshiGrantForwardsUserAndCampaignProduct(t *testing.T) {
	t.Setenv("LIGHTCLAW_INTERNAL_SERVICE_TOKEN", "internal-token")
	logic := &recordingDianshiGrantLogic{}
	router := newRouter(&instanceHandler{logic: &stubLogic{}}, &bundleHandler{}, &passHandler{logic: logic})
	req := httptest.NewRequest(http.MethodPost, "/internal/ctl/subscriptions/dianshi/grant", strings.NewReader(`{
		"external_user_id":"usr_grant",
		"bundle_id":"bundle_launch_ai_01",
		"activity_id":165523570799387,
		"act_id":142163399386388,
		"time_span_unit":"1m",
		"secret_key":"campaign-secret"
	}`))
	req.Header.Set("Authorization", "Bearer internal-token")
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d want 200; body=%s", rec.Code, rec.Body.String())
	}
	if logic.userID != "usr_grant" || logic.req == nil ||
		logic.req.BundleID != "bundle_launch_ai_01" ||
		logic.req.ActivityID != 165523570799387 ||
		logic.req.ActID != 142163399386388 ||
		logic.req.TimeSpanUnit != "1m" ||
		logic.req.SecretKey != "campaign-secret" {
		t.Fatalf("unexpected forwarded request user=%q req=%+v", logic.userID, logic.req)
	}
	if !strings.Contains(rec.Body.String(), `"status":"granted"`) {
		t.Fatalf("unexpected response: %s", rec.Body.String())
	}
}

func TestNormalizeInternalDianshiGrantPath(t *testing.T) {
	const path = "/internal/ctl/subscriptions/dianshi/grant"
	if got := normalizePath(path); got != path {
		t.Fatalf("normalizePath(%q)=%q", path, got)
	}
}
