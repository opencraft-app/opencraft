package main

import (
	websitelogic "ctl/pkg/logic/website"
	"ctl/pkg/model/website"
	"net/http"
	"net/http/httptest"
	"testing"
)

type retentionLogicStub struct {
	websitelogic.Logic
	site string
}

func (f *retentionLogicStub) ScheduleReleaseRetention(site string) (*website.OperationEntity, error) {
	f.site = site
	return nil, nil
}
func TestInternalRetentionRouteRequiresTokenAndPost(t *testing.T) {
	t.Setenv("WEBSITE_INTERNAL_API_TOKEN", "test-secret")
	for _, tc := range []struct {
		method, token string
		status        int
	}{
		{"POST", "", 401}, {"POST", "wrong", 401}, {"GET", "test-secret", 405}, {"POST", "test-secret", 200},
	} {
		t.Run(tc.method+tc.token, func(t *testing.T) {
			f := &retentionLogicStub{}
			h := &websiteHandler{logic: f}
			req := httptest.NewRequest(tc.method, "/internal/ctl/websites/sites/ws-1/retention", nil)
			req.Header.Set("X-Internal-Token", tc.token)
			rec := httptest.NewRecorder()
			h.handleInternalSite(rec, req)
			if rec.Code != tc.status {
				t.Fatalf("status=%d want=%d", rec.Code, tc.status)
			}
			if (f.site != "") != (tc.status == http.StatusOK) {
				t.Fatal("unexpected logic invocation")
			}
		})
	}
}

func (f *retentionLogicStub) SweepReleaseRetention(cursor string) (*websitelogic.RetentionSweepResult, error) {
	f.site = cursor
	return &websitelogic.RetentionSweepResult{}, nil
}
func TestInternalRetentionSweepRequiresTokenAndPost(t *testing.T) {
	t.Setenv("WEBSITE_INTERNAL_API_TOKEN", "test-secret")
	for _, tc := range []struct {
		method, token string
		status        int
	}{{"POST", "", 401}, {"GET", "test-secret", 405}, {"POST", "test-secret", 200}} {
		f := &retentionLogicStub{}
		h := &websiteHandler{logic: f}
		req := httptest.NewRequest(tc.method, "/internal/ctl/websites/retention/sweep?cursor=ws-9", nil)
		req.Header.Set("X-Internal-Token", tc.token)
		rec := httptest.NewRecorder()
		h.handleInternalRetentionSweep(rec, req)
		if rec.Code != tc.status {
			t.Fatalf("got %d want %d", rec.Code, tc.status)
		}
		if (f.site == "ws-9") != (tc.status == 200) {
			t.Fatal("unexpected sweep invocation")
		}
	}
}
