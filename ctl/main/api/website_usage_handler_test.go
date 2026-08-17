package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	websitelogic "ctl/pkg/logic/website"
)

// fakeUsageLogic 只实现用量相关的方法，其余接口方法由嵌入的 nil 接口占位。
// 一旦被意外调用会 panic，这正好暴露路由把请求分发错了。
type fakeUsageLogic struct {
	websitelogic.Logic
	gotReports     []websitelogic.TrafficUsageReport
	gotSiteID      string
	gotStorage     int64
	storageCalled  bool
	usageCallCount int
	err            error
}

func (f *fakeUsageLogic) RecordTrafficUsage(reports []websitelogic.TrafficUsageReport) (int, error) {
	f.usageCallCount++
	f.gotReports = reports
	if f.err != nil {
		return 0, f.err
	}
	return len(reports), nil
}

func (f *fakeUsageLogic) UpdateSiteStorage(siteID string, storageBytes int64) error {
	f.storageCalled = true
	f.gotSiteID = siteID
	f.gotStorage = storageBytes
	return f.err
}

func newUsageRequest(t *testing.T, method, path, token, body string) *http.Request {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if token != "" {
		req.Header.Set("X-Internal-Token", token)
	}
	req.Header.Set("Content-Type", "application/json")
	return req
}

// 上报接口是 fail-closed 的：没有正确的内部 token 一律 401，且不能触达逻辑层。
func TestUsageReportRequiresInternalToken(t *testing.T) {
	t.Setenv("WEBSITE_INTERNAL_API_TOKEN", "expected-token")
	fake := &fakeUsageLogic{}
	h := &websiteHandler{logic: fake}

	for _, token := range []string{"", "wrong-token"} {
		rec := httptest.NewRecorder()
		h.handleInternalUsage(rec, newUsageRequest(t, http.MethodPost,
			"/internal/ctl/websites/usage", token, `{"reports":[{"site_id":"ws-1","traffic_bytes":1}]}`))
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("token %q: 状态码 = %d，期望 401", token, rec.Code)
		}
		if fake.usageCallCount != 0 {
			t.Fatalf("token %q 不应触达逻辑层", token)
		}
	}
}

func TestUsageReportRejectsNonPost(t *testing.T) {
	t.Setenv("WEBSITE_INTERNAL_API_TOKEN", "expected-token")
	fake := &fakeUsageLogic{}
	h := &websiteHandler{logic: fake}

	for _, method := range []string{http.MethodGet, http.MethodPut, http.MethodDelete} {
		rec := httptest.NewRecorder()
		h.handleInternalUsage(rec, newUsageRequest(t, method,
			"/internal/ctl/websites/usage", "expected-token", ""))
		if rec.Code != http.StatusMethodNotAllowed {
			t.Fatalf("%s: 状态码 = %d，期望 405", method, rec.Code)
		}
		if fake.usageCallCount != 0 {
			t.Fatalf("%s 不应触达逻辑层", method)
		}
	}
}

// 一个请求带上多个站点：这是批量上报的核心形状，逐请求上报会让 ctl 承受站点的全部 QPS。
func TestUsageReportAcceptsBatch(t *testing.T) {
	t.Setenv("WEBSITE_INTERNAL_API_TOKEN", "expected-token")
	fake := &fakeUsageLogic{}
	h := &websiteHandler{logic: fake}

	rec := httptest.NewRecorder()
	h.handleInternalUsage(rec, newUsageRequest(t, http.MethodPost,
		"/internal/ctl/websites/usage", "expected-token",
		`{"window_id":"w1","reports":[`+
			`{"site_id":"ws-1","traffic_bytes":100,"request_count":2},`+
			`{"site_id":"ws-2","traffic_bytes":200,"request_count":3}]}`))

	if rec.Code != http.StatusOK {
		t.Fatalf("状态码 = %d，body %s", rec.Code, rec.Body.String())
	}
	if len(fake.gotReports) != 2 {
		t.Fatalf("逻辑层收到 %d 条，期望 2", len(fake.gotReports))
	}
	if fake.gotReports[0].SiteID != "ws-1" || fake.gotReports[0].TrafficBytes != 100 ||
		fake.gotReports[0].RequestCount != 2 {
		t.Fatalf("第一条 = %+v", fake.gotReports[0])
	}

	var resp struct {
		Data struct {
			Accepted int `json:"accepted"`
			Received int `json:"received"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Data.Accepted != 2 || resp.Data.Received != 2 {
		t.Fatalf("响应 = %+v", resp.Data)
	}
}

// 超大批次必须被拒：一个畸形请求不该让 ctl 做无上限的逐站点查询。
func TestUsageReportRejectsOversizedBatch(t *testing.T) {
	t.Setenv("WEBSITE_INTERNAL_API_TOKEN", "expected-token")
	fake := &fakeUsageLogic{}
	h := &websiteHandler{logic: fake}

	entries := make([]string, 0, maxUsageReportsPerRequest+1)
	for i := 0; i <= maxUsageReportsPerRequest; i++ {
		entries = append(entries, fmt.Sprintf(`{"site_id":"ws-%d","traffic_bytes":1}`, i))
	}
	rec := httptest.NewRecorder()
	h.handleInternalUsage(rec, newUsageRequest(t, http.MethodPost,
		"/internal/ctl/websites/usage", "expected-token",
		`{"reports":[`+strings.Join(entries, ",")+`]}`))

	if rec.Code == http.StatusOK {
		t.Fatal("超过上限的批次应被拒绝")
	}
	if fake.usageCallCount != 0 {
		t.Fatal("超限批次不应触达逻辑层")
	}
}

func TestUsageReportRejectsMalformedBody(t *testing.T) {
	t.Setenv("WEBSITE_INTERNAL_API_TOKEN", "expected-token")
	fake := &fakeUsageLogic{}
	h := &websiteHandler{logic: fake}

	rec := httptest.NewRecorder()
	h.handleInternalUsage(rec, newUsageRequest(t, http.MethodPost,
		"/internal/ctl/websites/usage", "expected-token", `{"reports":`))
	if rec.Code == http.StatusOK {
		t.Fatal("非法 JSON 应被拒绝")
	}
	if fake.usageCallCount != 0 {
		t.Fatal("非法 JSON 不应触达逻辑层")
	}
}

// ---- 存储上报 ----

func TestStorageReportRequiresInternalToken(t *testing.T) {
	t.Setenv("WEBSITE_INTERNAL_API_TOKEN", "expected-token")
	fake := &fakeUsageLogic{}
	h := &websiteHandler{logic: fake}

	rec := httptest.NewRecorder()
	h.handleInternalSite(rec, newUsageRequest(t, http.MethodPost,
		"/internal/ctl/websites/sites/ws-1/storage", "", `{"storage_bytes":100}`))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("状态码 = %d，期望 401", rec.Code)
	}
	if fake.storageCalled {
		t.Fatal("不应触达逻辑层")
	}
}

func TestStorageReportUpdatesSite(t *testing.T) {
	t.Setenv("WEBSITE_INTERNAL_API_TOKEN", "expected-token")
	fake := &fakeUsageLogic{}
	h := &websiteHandler{logic: fake}

	rec := httptest.NewRecorder()
	h.handleInternalSite(rec, newUsageRequest(t, http.MethodPost,
		"/internal/ctl/websites/sites/ws-464eb1f654cd5d91/storage", "expected-token",
		`{"storage_bytes":123456}`))

	if rec.Code != http.StatusOK {
		t.Fatalf("状态码 = %d，body %s", rec.Code, rec.Body.String())
	}
	if fake.gotSiteID != "ws-464eb1f654cd5d91" {
		t.Fatalf("逻辑层收到 site_id = %q", fake.gotSiteID)
	}
	if fake.gotStorage != 123456 {
		t.Fatalf("逻辑层收到 storage_bytes = %d", fake.gotStorage)
	}
}

func TestStorageReportRejectsNonPost(t *testing.T) {
	t.Setenv("WEBSITE_INTERNAL_API_TOKEN", "expected-token")
	fake := &fakeUsageLogic{}
	h := &websiteHandler{logic: fake}

	for _, method := range []string{http.MethodGet, http.MethodPut, http.MethodDelete} {
		rec := httptest.NewRecorder()
		h.handleInternalSite(rec, newUsageRequest(t, method,
			"/internal/ctl/websites/sites/ws-1/storage", "expected-token", `{"storage_bytes":1}`))
		if rec.Code != http.StatusMethodNotAllowed {
			t.Fatalf("%s: 状态码 = %d，期望 405", method, rec.Code)
		}
		if fake.storageCalled {
			t.Fatalf("%s 不应触达逻辑层", method)
		}
	}
}

// 未知子路径不能被静默当成存储上报，也不能被截断成站点查询。
func TestUnknownSiteSubpathIsRejected(t *testing.T) {
	t.Setenv("WEBSITE_INTERNAL_API_TOKEN", "expected-token")
	fake := &fakeUsageLogic{}
	h := &websiteHandler{logic: fake}

	rec := httptest.NewRecorder()
	h.handleInternalSite(rec, newUsageRequest(t, http.MethodPost,
		"/internal/ctl/websites/sites/ws-1/quota", "expected-token", `{}`))
	if rec.Code == http.StatusOK {
		t.Fatalf("未知子路径应被拒绝，实际 200 body %s", rec.Body.String())
	}
	if fake.storageCalled {
		t.Fatal("未知子路径不应触达逻辑层")
	}
}
