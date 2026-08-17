package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	passlogic "ctl/pkg/logic/pass"
)

type cloudapiPassLogic struct {
	passlogic.Logic

	called bool
	uin    int64
	appID  int64
	passID string
	detail *passlogic.PassDetail
}

func (l *cloudapiPassLogic) DescribePassByCloudAccount(uin, appID int64, passID string) (*passlogic.PassDetail, error) {
	l.called = true
	l.uin = uin
	l.appID = appID
	l.passID = passID
	return l.detail, nil
}

func TestCloudAPIDescribePassAcceptsCloudAPIRequestWithoutSecretKey(t *testing.T) {
	resetCloudAPIConfigForTest()
	t.Cleanup(resetCloudAPIConfigForTest)
	t.Setenv("CTL_CLOUDAPI_ALLOWED_REGIONS", "ap-shanghai")

	expired := time.Date(2026, 8, 20, 10, 30, 0, 0, time.UTC)
	logic := &cloudapiPassLogic{detail: &passlogic.PassDetail{
		PassID:      "pass_cloudapi_1",
		UserID:      "usr_cloudapi_1",
		BundleID:    "bundle_launch_01",
		Uin:         330500000004,
		AppID:       1447552654,
		ExpiredTime: expired,
		Status:      "active",
	}}
	router := newRouter(&instanceHandler{logic: &stubLogic{}}, &bundleHandler{}, &passHandler{logic: logic})

	body := `{"Uin":330500000004,"AppId":1447552654,"PassId":"pass_cloudapi_1"}`
	req := httptest.NewRequest(http.MethodPost, "/cloudapi", strings.NewReader(body))
	req.Host = "clgateway.production.polaris:8095"
	req.Header.Set("Content-Type", "application/json; charset=utf-8")
	req.Header.Set("X-TC-Action", "DescribePass")
	req.Header.Set("X-TC-Version", "2026-08-06")
	req.Header.Set("X-TC-Region", "ap-shanghai")

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	if !logic.called || logic.uin != 330500000004 || logic.appID != 1447552654 || logic.passID != "pass_cloudapi_1" {
		t.Fatalf("logic called=%t uin=%d appID=%d passID=%q", logic.called, logic.uin, logic.appID, logic.passID)
	}
	var payload struct {
		Response struct {
			RequestID string `json:"RequestId"`
			Pass      struct {
				PassID      string `json:"PassId"`
				UserID      string `json:"UserId"`
				BundleID    string `json:"BundleId"`
				Uin         int64  `json:"Uin"`
				AppID       int64  `json:"AppId"`
				Status      string `json:"Status"`
				ExpiredTime string `json:"ExpiredTime"`
			} `json:"Pass"`
		} `json:"Response"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v body=%s", err, rec.Body.String())
	}
	if payload.Response.RequestID == "" {
		t.Fatalf("expected RequestId in response")
	}
	if payload.Response.Pass.PassID != "pass_cloudapi_1" || payload.Response.Pass.ExpiredTime != expired.Format(time.RFC3339) {
		t.Fatalf("unexpected pass response: %+v", payload.Response.Pass)
	}
}

func TestCloudAPIDescribePassRejectsUnsupportedRegionBeforeQuery(t *testing.T) {
	resetCloudAPIConfigForTest()
	t.Cleanup(resetCloudAPIConfigForTest)
	t.Setenv("CTL_CLOUDAPI_ALLOWED_REGIONS", "ap-shanghai")

	logic := &cloudapiPassLogic{}
	router := newRouter(&instanceHandler{logic: &stubLogic{}}, &bundleHandler{}, &passHandler{logic: logic})

	body := `{"Uin":330500000004,"AppId":1447552654,"PassId":"pass_cloudapi_1"}`
	req := httptest.NewRequest(http.MethodPost, "/cloudapi", strings.NewReader(body))
	req.Host = "clgateway.production.polaris:8095"
	req.Header.Set("Content-Type", "application/json; charset=utf-8")
	req.Header.Set("X-TC-Action", "DescribePass")
	req.Header.Set("X-TC-Version", "2026-08-06")
	req.Header.Set("X-TC-Region", "ap-beijing")

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("cloud api errors should use HTTP 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	if logic.called {
		t.Fatalf("logic should not be called for unsupported region")
	}
	var payload struct {
		Response struct {
			Error *struct {
				Code string `json:"Code"`
			} `json:"Error"`
		} `json:"Response"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v body=%s", err, rec.Body.String())
	}
	if payload.Response.Error == nil || payload.Response.Error.Code != "InvalidParameter.Region" {
		t.Fatalf("unexpected error payload: %s", rec.Body.String())
	}
}

func TestCloudAPIDescribePassRejectsUnsupportedActionBeforeQuery(t *testing.T) {
	resetCloudAPIConfigForTest()
	t.Cleanup(resetCloudAPIConfigForTest)
	t.Setenv("CTL_CLOUDAPI_ALLOWED_REGIONS", "ap-shanghai")

	logic := &cloudapiPassLogic{}
	router := newRouter(&instanceHandler{logic: &stubLogic{}}, &bundleHandler{}, &passHandler{logic: logic})

	body := `{"Uin":330500000004,"AppId":1447552654,"PassId":"pass_cloudapi_1"}`
	req := httptest.NewRequest(http.MethodPost, "/cloudapi", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json; charset=utf-8")
	req.Header.Set("X-TC-Action", "DeletePass")
	req.Header.Set("X-TC-Version", "2026-08-06")
	req.Header.Set("X-TC-Region", "ap-shanghai")

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("cloud api errors should use HTTP 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	if logic.called {
		t.Fatalf("logic should not be called for unsupported action")
	}
	var payload struct {
		Response struct {
			Error *struct {
				Code string `json:"Code"`
			} `json:"Error"`
		} `json:"Response"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v body=%s", err, rec.Body.String())
	}
	if payload.Response.Error == nil || payload.Response.Error.Code != "InvalidAction" {
		t.Fatalf("unexpected error payload: %s", rec.Body.String())
	}
}
