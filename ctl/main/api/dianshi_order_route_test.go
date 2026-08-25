package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	passlogic "ctl/pkg/logic/pass"
	"ctl/pkg/transport"
)

type recordingDianshiPassLogic struct {
	passlogic.Logic
	req *transport.CreateDianshiPassOrderAndPayRequest
}

func (l *recordingDianshiPassLogic) CreateDianshiPassOrderAndPay(_ string, req *transport.CreateDianshiPassOrderAndPayRequest) (*transport.CreateDianshiPassOrderAndPayResult, error) {
	l.req = req
	return &transport.CreateDianshiPassOrderAndPayResult{
		DealName:   "dianshi-deal-1",
		BigOrderID: "dianshi-big-1",
	}, nil
}

func TestUserDianshiOrderAndPayRequiresUserHeader(t *testing.T) {
	router := newRouter(&instanceHandler{logic: &stubLogic{}}, &bundleHandler{}, &passHandler{})
	req := httptest.NewRequest(http.MethodPost, "/v1/passes/dianshi/order-and-pay", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("got %d want 401; body=%s", rec.Code, rec.Body.String())
	}
}

func TestUserDianshiOrderAndPayRejectsGet(t *testing.T) {
	router := newRouter(&instanceHandler{logic: &stubLogic{}}, &bundleHandler{}, &passHandler{})
	req := httptest.NewRequest(http.MethodGet, "/v1/passes/dianshi/order-and-pay", nil)
	req.Header.Set("X-User-Id", "usr_test")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("got %d want 405; body=%s", rec.Code, rec.Body.String())
	}
}

func TestNormalizeDianshiOrderAndPayPath(t *testing.T) {
	const path = "/v1/passes/dianshi/order-and-pay"
	if got := normalizePath(path); got != path {
		t.Fatalf("normalizePath(%q)=%q", path, got)
	}
}

func TestUserDianshiOrderAndPayDoesNotForwardAutoRenew(t *testing.T) {
	logic := &recordingDianshiPassLogic{}
	router := newRouter(&instanceHandler{logic: &stubLogic{}}, &bundleHandler{}, &passHandler{logic: logic})
	req := httptest.NewRequest(http.MethodPost, "/v1/passes/dianshi/order-and-pay", strings.NewReader(`{
		"bundle_id":"bundle_zero",
		"period":1,
		"time_unit":"m",
		"auto_renew_flag":"auto_renew"
	}`))
	req.Header.Set("X-User-Id", "usr_test")
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("got %d want 200; body=%s", rec.Code, rec.Body.String())
	}
	if logic.req == nil || logic.req.BundleID != "bundle_zero" || logic.req.Period != 1 || logic.req.TimeUnit != "m" {
		t.Fatalf("unexpected dedicated request: %+v", logic.req)
	}
}
