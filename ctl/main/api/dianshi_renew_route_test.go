package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRenewOrderAndPayCTLRoutesRemoved(t *testing.T) {
	router := newRouter(&instanceHandler{logic: &stubLogic{}}, &bundleHandler{}, &passHandler{})
	for _, path := range []string{
		"/v1/passes/pass-1/renew/order-and-pay",
		"/admin/api/ctl/passes/pass-1/renew/order-and-pay",
		"/internal/ctl/passes/pass-1/renew/dianshi-order-and-pay",
	} {
		t.Run(path, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(`{"period":1,"time_unit":"m"}`))
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)
			if rec.Code != http.StatusNotFound {
				t.Fatalf("got %d want 404; body=%s", rec.Code, rec.Body.String())
			}
		})
	}
}
