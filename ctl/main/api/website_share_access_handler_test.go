package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"ctl/pkg/errcode"
	websitelogic "ctl/pkg/logic/website"
)

type fakeShareAccessLogic struct {
	websitelogic.Logic
	setResult    *websitelogic.ShareAccessResult
	resetResult  *websitelogic.ShareAccessResult
	verifyResult *websitelogic.ShareVerifyResult
	setUserID    string
	setSiteID    string
	setMode      string
	setDuration  int
	resetUserID  string
	resetSiteID  string
	verifySiteID string
	verifyCode   string
	verifyIP     string
	err          error
}

func (f *fakeShareAccessLogic) SetAccessPolicy(userID, siteID, mode string, durationDays int) (*websitelogic.ShareAccessResult, error) {
	f.setUserID, f.setSiteID, f.setMode, f.setDuration = userID, siteID, mode, durationDays
	return f.setResult, f.err
}

func (f *fakeShareAccessLogic) ResetShareCode(userID, siteID string) (*websitelogic.ShareAccessResult, error) {
	f.resetUserID, f.resetSiteID = userID, siteID
	return f.resetResult, f.err
}

func (f *fakeShareAccessLogic) VerifyShareCode(siteID, code, clientIP string) (*websitelogic.ShareVerifyResult, error) {
	f.verifySiteID, f.verifyCode, f.verifyIP = siteID, code, clientIP
	return f.verifyResult, f.err
}

func TestWebsiteAccessAndResetRoutesUseAuthenticatedOwner(t *testing.T) {
	expiresAt := time.Date(2026, 8, 28, 3, 0, 0, 0, time.UTC)
	fake := &fakeShareAccessLogic{
		setResult:   &websitelogic.ShareAccessResult{Mode: "share_code", Code: "7KQ9XM", ExpiresAt: expiresAt},
		resetResult: &websitelogic.ShareAccessResult{Mode: "share_code", Code: "8MR4ZT", ExpiresAt: expiresAt},
	}
	h := &websiteHandler{logic: fake}

	accessReq := httptest.NewRequest(http.MethodPut, "/v1/websites/ws-1/access", strings.NewReader(`{"mode":"share_code","duration_days":7}`))
	accessReq.Header.Set(headerUserID, "user-1")
	accessRec := httptest.NewRecorder()
	h.handleWebsitesByID(accessRec, accessReq)
	if accessRec.Code != http.StatusOK {
		t.Fatalf("access status = %d, body=%s", accessRec.Code, accessRec.Body.String())
	}
	if fake.setUserID != "user-1" || fake.setSiteID != "ws-1" || fake.setMode != "share_code" || fake.setDuration != 7 {
		t.Fatalf("SetAccessPolicy args = %q/%q/%q/%d", fake.setUserID, fake.setSiteID, fake.setMode, fake.setDuration)
	}

	resetReq := httptest.NewRequest(http.MethodPost, "/v1/websites/ws-1/share-code/reset", nil)
	resetReq.Header.Set(headerUserID, "user-1")
	resetRec := httptest.NewRecorder()
	h.handleWebsitesByID(resetRec, resetReq)
	if resetRec.Code != http.StatusOK {
		t.Fatalf("reset status = %d, body=%s", resetRec.Code, resetRec.Body.String())
	}
	if fake.resetUserID != "user-1" || fake.resetSiteID != "ws-1" {
		t.Fatalf("ResetShareCode args = %q/%q", fake.resetUserID, fake.resetSiteID)
	}
}

func TestInternalShareVerifyRequiresTokenAndForwardsTrustedIPHeader(t *testing.T) {
	t.Setenv("WEBSITE_INTERNAL_API_TOKEN", "expected-token")
	expiresAt := time.Date(2026, 8, 28, 3, 0, 0, 0, time.UTC)
	fake := &fakeShareAccessLogic{verifyResult: &websitelogic.ShareVerifyResult{
		Verified: true, Generation: "generation-7", ExpiresAt: expiresAt,
	}}
	h := &websiteHandler{logic: fake}

	unauthorized := httptest.NewRecorder()
	h.handleInternalSite(unauthorized, httptest.NewRequest(http.MethodPost,
		"/internal/ctl/websites/sites/ws-1/share-code/verify", strings.NewReader(`{"code":"7KQ9XM"}`)))
	if unauthorized.Code != http.StatusUnauthorized || fake.verifySiteID != "" {
		t.Fatalf("unauthorized status=%d verifySiteID=%q", unauthorized.Code, fake.verifySiteID)
	}

	req := httptest.NewRequest(http.MethodPost,
		"/internal/ctl/websites/sites/ws-1/share-code/verify", strings.NewReader(`{"code":"7KQ9XM"}`))
	req.Header.Set("X-Internal-Token", "expected-token")
	req.Header.Set("X-Site-Client-IP", "203.0.113.7")
	rec := httptest.NewRecorder()
	h.handleInternalSite(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	if fake.verifySiteID != "ws-1" || fake.verifyCode != "7KQ9XM" || fake.verifyIP != "203.0.113.7" {
		t.Fatalf("VerifyShareCode args = %q/%q/%q", fake.verifySiteID, fake.verifyCode, fake.verifyIP)
	}
	var response struct {
		Data websitelogic.ShareVerifyResult `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if !response.Data.Verified || response.Data.Generation != "generation-7" || !response.Data.ExpiresAt.Equal(expiresAt) {
		t.Fatalf("response = %+v", response.Data)
	}
}

func TestShareAccessRoutesRejectWrongMethods(t *testing.T) {
	h := &websiteHandler{logic: &fakeShareAccessLogic{}}
	for _, tc := range []struct {
		method string
		path   string
	}{
		{http.MethodPost, "/v1/websites/ws-1/access"},
		{http.MethodGet, "/v1/websites/ws-1/share-code/reset"},
	} {
		req := httptest.NewRequest(tc.method, tc.path, nil)
		req.Header.Set(headerUserID, "user-1")
		rec := httptest.NewRecorder()
		h.handleWebsitesByID(rec, req)
		if rec.Code != http.StatusMethodNotAllowed {
			t.Fatalf("%s %s status=%d, body=%s", tc.method, tc.path, rec.Code, rec.Body.String())
		}
	}
}

func TestInternalShareVerifyMapsSecurityErrorsWithoutEchoingCode(t *testing.T) {
	t.Setenv("WEBSITE_INTERNAL_API_TOKEN", "expected-token")
	for _, tc := range []struct {
		name   string
		err    error
		status int
	}{
		{"invalid", errcode.ErrWebsiteShareCodeInvalid, http.StatusForbidden},
		{"limited", errcode.ErrWebsiteShareRateLimited, http.StatusTooManyRequests},
		{"unavailable", errcode.ErrWebsiteShareUnavailable, http.StatusServiceUnavailable},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fake := &fakeShareAccessLogic{err: tc.err}
			h := &websiteHandler{logic: fake}
			req := httptest.NewRequest(http.MethodPost,
				"/internal/ctl/websites/sites/ws-1/share-code/verify", strings.NewReader(`{"code":"SECRET7"}`))
			req.Header.Set("X-Internal-Token", "expected-token")
			rec := httptest.NewRecorder()
			h.handleInternalSite(rec, req)
			if rec.Code != tc.status {
				t.Fatalf("status=%d, want %d; body=%s", rec.Code, tc.status, rec.Body.String())
			}
			if strings.Contains(rec.Body.String(), "SECRET7") {
				t.Fatalf("response echoed share code: %s", rec.Body.String())
			}
			var target *errcode.Error
			if !errors.As(tc.err, &target) {
				t.Fatalf("test error is not a business error: %v", tc.err)
			}
		})
	}
}
