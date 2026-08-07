package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sort"
	"strconv"
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

func TestCloudAPIDescribePassUsesTencentCloudSignatureAndOriginalProxyPath(t *testing.T) {
	resetCloudAPIConfigForTest()
	t.Cleanup(resetCloudAPIConfigForTest)
	t.Setenv("CTL_CLOUDAPI_SECRET_ID", "AKIDEXAMPLE")
	t.Setenv("CTL_CLOUDAPI_SECRET_KEY", "SECRETKEYEXAMPLE")
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
	req.Header.Set("X-CloudLadder-Original-Host", "clgateway.production.polaris:8095")
	req.Header.Set("X-CloudLadder-Original-Path", "/v1/proxy/lightvela-cloudapi/cloudapi")
	req.Header.Set("X-CloudLadder-Original-Query", "")
	signCloudAPIRequestForTest(t, req, body, "AKIDEXAMPLE", "SECRETKEYEXAMPLE", "lightvela", "/v1/proxy/lightvela-cloudapi/cloudapi")

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
	t.Setenv("CTL_CLOUDAPI_SECRET_ID", "AKIDEXAMPLE")
	t.Setenv("CTL_CLOUDAPI_SECRET_KEY", "SECRETKEYEXAMPLE")
	t.Setenv("CTL_CLOUDAPI_ALLOWED_REGIONS", "ap-shanghai")

	logic := &cloudapiPassLogic{}
	router := newRouter(&instanceHandler{logic: &stubLogic{}}, &bundleHandler{}, &passHandler{logic: logic})

	body := `{"Uin":330500000004,"AppId":1447552654,"PassId":"pass_cloudapi_1"}`
	req := httptest.NewRequest(http.MethodPost, "/cloudapi", strings.NewReader(body))
	req.Host = "clgateway.production.polaris:8095"
	req.Header.Set("Content-Type", "application/json; charset=utf-8")
	req.Header.Set("X-TC-Region", "ap-beijing")
	signCloudAPIRequestForTest(t, req, body, "AKIDEXAMPLE", "SECRETKEYEXAMPLE", "lightvela", "/cloudapi")

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

func signCloudAPIRequestForTest(t *testing.T, req *http.Request, payload, secretID, secretKey, service, canonicalPath string) {
	t.Helper()
	now := time.Now().UTC()
	date := now.Format("2006-01-02")
	timestamp := now.Unix()

	req.Header.Set("X-TC-Action", "DescribePass")
	req.Header.Set("X-TC-Version", "2026-08-06")
	req.Header.Set("X-TC-Timestamp", strconv.FormatInt(timestamp, 10))
	if req.Header.Get("X-TC-Region") == "" {
		req.Header.Set("X-TC-Region", "ap-shanghai")
	}

	signedHeaders := []string{"content-type", "host"}
	canonicalHeaders := canonicalHeadersForTest(req, signedHeaders)
	payloadHash := sha256.Sum256([]byte(payload))
	canonicalRequest := strings.Join([]string{
		req.Method,
		canonicalPath,
		req.URL.RawQuery,
		canonicalHeaders,
		strings.Join(signedHeaders, ";"),
		hex.EncodeToString(payloadHash[:]),
	}, "\n")
	canonicalRequestHash := sha256.Sum256([]byte(canonicalRequest))
	credentialScope := date + "/" + service + "/tc3_request"
	stringToSign := strings.Join([]string{
		"TC3-HMAC-SHA256",
		strconv.FormatInt(timestamp, 10),
		credentialScope,
		hex.EncodeToString(canonicalRequestHash[:]),
	}, "\n")

	secretDate := hmacSHA256ForTest([]byte("TC3"+secretKey), date)
	secretService := hmacSHA256ForTest(secretDate, service)
	secretSigning := hmacSHA256ForTest(secretService, "tc3_request")
	signature := hex.EncodeToString(hmacSHA256ForTest(secretSigning, stringToSign))
	req.Header.Set("Authorization", "TC3-HMAC-SHA256 Credential="+secretID+"/"+credentialScope+", SignedHeaders="+strings.Join(signedHeaders, ";")+", Signature="+signature)
}

func canonicalHeadersForTest(req *http.Request, signedHeaders []string) string {
	sort.Strings(signedHeaders)
	var b strings.Builder
	for _, name := range signedHeaders {
		value := req.Header.Get(name)
		if name == "host" {
			value = req.Host
		}
		b.WriteString(name)
		b.WriteByte(':')
		b.WriteString(strings.Join(strings.Fields(value), " "))
		b.WriteByte('\n')
	}
	return b.String()
}

func hmacSHA256ForTest(key []byte, data string) []byte {
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(data))
	return mac.Sum(nil)
}
