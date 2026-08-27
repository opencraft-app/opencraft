package sitemeta

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestBySiteIDReturnsSite(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.URL.Path; got != "/internal/ctl/websites/sites/ws-abc" {
			t.Errorf("请求路径 = %q", got)
		}
		if got := r.Header.Get("X-Internal-Token"); got != "secret" {
			t.Errorf("X-Internal-Token = %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"code":"OK","message":"success","data":{"site_id":"ws-abc","status":"active"}}`))
	}))
	defer server.Close()

	c := NewClient(Options{BaseURL: server.URL, InternalToken: "secret"})
	site, err := c.BySiteID(context.Background(), "ws-abc")
	if err != nil {
		t.Fatalf("BySiteID: %v", err)
	}
	if site.SiteID != "ws-abc" || site.Status != StatusActive {
		t.Fatalf("站点 = %+v", site)
	}
}

func TestBySiteIDParsesCloudPath(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"code":"OK","message":"success","data":{` +
			`"site_id":"ws-abc","status":"active",` +
			`"cloud_path":"sites/ws-abc/releases/wr-0123456789abcdef/"}}`))
	}))
	defer server.Close()

	site, err := NewClient(Options{BaseURL: server.URL}).BySiteID(context.Background(), "ws-abc")
	if err != nil {
		t.Fatalf("BySiteID: %v", err)
	}
	if site.CloudPath != "sites/ws-abc/releases/wr-0123456789abcdef/" {
		t.Fatalf("cloud_path = %q", site.CloudPath)
	}
}

func TestBySiteIDParsesUserID(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"code":"OK","message":"success","data":{` +
			`"site_id":"ws-abc","status":"active","user_id":"user-1"}}`))
	}))
	defer server.Close()

	site, err := NewClient(Options{BaseURL: server.URL}).BySiteID(context.Background(), "ws-abc")
	if err != nil {
		t.Fatalf("BySiteID: %v", err)
	}
	if site.UserID != "user-1" {
		t.Fatalf("user_id = %q", site.UserID)
	}
}

func TestBySiteIDParsesShareAccessPolicy(t *testing.T) {
	expiresAt := time.Date(2026, 9, 23, 10, 0, 0, 0, time.UTC)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"code":"OK","message":"success","data":{` +
			`"site_id":"ws-abc","status":"active","access_mode":"share_code",` +
			`"share_generation":"generation-7","share_expires_at":"2026-09-23T10:00:00Z"}}`))
	}))
	defer server.Close()

	site, err := NewClient(Options{BaseURL: server.URL}).BySiteID(context.Background(), "ws-abc")
	if err != nil {
		t.Fatalf("BySiteID: %v", err)
	}
	if site.AccessMode != AccessModeShareCode || site.ShareGeneration != "generation-7" ||
		site.ShareExpiresAt == nil || !site.ShareExpiresAt.Equal(expiresAt) {
		t.Fatalf("share access policy = %+v", site)
	}
	if !site.ShareAccessActiveAt(expiresAt.Add(-time.Second)) || site.ShareAccessActiveAt(expiresAt) {
		t.Fatalf("share expiry boundary was not enforced: %+v", site)
	}
	if got := NormalizeAccessMode("unexpected"); got != AccessModeOwnerOnly {
		t.Fatalf("unknown access mode normalized to %q", got)
	}
}

func TestBySiteIDNotFound(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()

	c := NewClient(Options{BaseURL: server.URL})
	if _, err := c.BySiteID(context.Background(), "ws-missing"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("期望 ErrNotFound，实际 %v", err)
	}
}

func TestBySiteIDCachesHit(t *testing.T) {
	var calls int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&calls, 1)
		_, _ = w.Write([]byte(`{"code":"OK","message":"success","data":{"site_id":"ws-abc","status":"active"}}`))
	}))
	defer server.Close()

	c := NewClient(Options{BaseURL: server.URL, PositiveTTL: time.Minute})
	for i := 0; i < 3; i++ {
		if _, err := c.BySiteID(context.Background(), "ws-abc"); err != nil {
			t.Fatalf("第 %d 次 BySiteID: %v", i, err)
		}
	}
	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Fatalf("回源 %d 次，期望 1 次", got)
	}
}

func TestBySiteIDFreshBypassesStaleCacheAndRefreshesEntry(t *testing.T) {
	var calls int32
	var userID atomic.Value
	userID.Store("user-1")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&calls, 1)
		_, _ = w.Write([]byte(`{"code":"OK","message":"success","data":{"site_id":"ws-abc","status":"active","user_id":"` + userID.Load().(string) + `"}}`))
	}))
	defer server.Close()

	c := NewClient(Options{BaseURL: server.URL, PositiveTTL: time.Minute})
	site, err := c.BySiteID(context.Background(), "ws-abc")
	if err != nil {
		t.Fatalf("首次 BySiteID: %v", err)
	}
	if site.UserID != "user-1" {
		t.Fatalf("首次 user_id = %q", site.UserID)
	}

	userID.Store("user-2")

	cachedSite, err := c.BySiteID(context.Background(), "ws-abc")
	if err != nil {
		t.Fatalf("缓存 BySiteID: %v", err)
	}
	if cachedSite.UserID != "user-1" {
		t.Fatalf("缓存 user_id = %q, 期望旧值 user-1", cachedSite.UserID)
	}

	freshSite, err := c.BySiteIDFresh(context.Background(), "ws-abc")
	if err != nil {
		t.Fatalf("BySiteIDFresh: %v", err)
	}
	if freshSite.UserID != "user-2" {
		t.Fatalf("fresh user_id = %q, 期望新值 user-2", freshSite.UserID)
	}

	refreshedSite, err := c.BySiteID(context.Background(), "ws-abc")
	if err != nil {
		t.Fatalf("刷新后 BySiteID: %v", err)
	}
	if refreshedSite.UserID != "user-2" {
		t.Fatalf("刷新后 user_id = %q, 期望新值 user-2", refreshedSite.UserID)
	}
	if got := atomic.LoadInt32(&calls); got != 2 {
		t.Fatalf("回源 %d 次，期望 2 次", got)
	}
}

func TestBySiteIDCachesNotFound(t *testing.T) {
	var calls int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&calls, 1)
		w.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()

	c := NewClient(Options{BaseURL: server.URL, NegativeTTL: time.Minute})
	for i := 0; i < 3; i++ {
		if _, err := c.BySiteID(context.Background(), "ws-missing"); !errors.Is(err, ErrNotFound) {
			t.Fatalf("第 %d 次期望 ErrNotFound，实际 %v", i, err)
		}
	}
	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Fatalf("回源 %d 次，期望 1 次", got)
	}
}

func TestCacheExpires(t *testing.T) {
	var calls int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&calls, 1)
		_, _ = w.Write([]byte(`{"code":"OK","message":"success","data":{"site_id":"ws-abc","status":"active"}}`))
	}))
	defer server.Close()

	c := NewClient(Options{BaseURL: server.URL, PositiveTTL: 10 * time.Millisecond})
	if _, err := c.BySiteID(context.Background(), "ws-abc"); err != nil {
		t.Fatalf("首次: %v", err)
	}
	time.Sleep(30 * time.Millisecond)
	if _, err := c.BySiteID(context.Background(), "ws-abc"); err != nil {
		t.Fatalf("过期后: %v", err)
	}
	if got := atomic.LoadInt32(&calls); got != 2 {
		t.Fatalf("回源 %d 次，期望 2 次", got)
	}
}

// ctl 抖动不能被固化成一段时间内的持续失败，所以失败不写缓存。
func TestTransientErrorIsNotCached(t *testing.T) {
	var calls int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if atomic.AddInt32(&calls, 1) == 1 {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		_, _ = w.Write([]byte(`{"code":"OK","message":"success","data":{"site_id":"ws-abc","status":"active"}}`))
	}))
	defer server.Close()

	c := NewClient(Options{BaseURL: server.URL, PositiveTTL: time.Minute})
	if _, err := c.BySiteID(context.Background(), "ws-abc"); err == nil {
		t.Fatal("首次应返回错误")
	}
	site, err := c.BySiteID(context.Background(), "ws-abc")
	if err != nil {
		t.Fatalf("重试应成功，实际 %v", err)
	}
	if site.Status != StatusActive {
		t.Fatalf("站点 = %+v", site)
	}
}

// 额度与已用量必须跟着状态一起解析出来，否则超额门禁永远拿到 0（等于不限额）。
func TestBySiteIDParsesTrafficBudget(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"code":"OK","message":"success","data":{` +
			`"site_id":"ws-abc","status":"active",` +
			`"monthly_traffic_bytes":1099511627776,"used_traffic_bytes":123456}}`))
	}))
	defer server.Close()

	c := NewClient(Options{BaseURL: server.URL})
	site, err := c.BySiteID(context.Background(), "ws-abc")
	if err != nil {
		t.Fatalf("BySiteID: %v", err)
	}
	if site.MonthlyTrafficBytes != 1099511627776 {
		t.Fatalf("monthly_traffic_bytes = %d", site.MonthlyTrafficBytes)
	}
	if site.UsedTrafficBytes != 123456 {
		t.Fatalf("used_traffic_bytes = %d", site.UsedTrafficBytes)
	}
	if site.TrafficExhausted() {
		t.Fatal("远未超额的站点不应被判为流量用尽")
	}
}

func TestTrafficExhausted(t *testing.T) {
	tests := []struct {
		name  string
		limit int64
		used  int64
		want  bool
	}{
		{"未超额", 1000, 999, false},
		{"刚好用尽", 1000, 1000, true},
		{"已超额", 1000, 5000, true},
		{"额度未配置视为不限额", 0, 999999, false},
		{"额度为负视为不限额", -1, 999999, false},
		{"零用量", 1000, 0, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			site := &Site{MonthlyTrafficBytes: tt.limit, UsedTrafficBytes: tt.used}
			if got := site.TrafficExhausted(); got != tt.want {
				t.Fatalf("TrafficExhausted() = %v, want %v", got, tt.want)
			}
		})
	}
	var nilSite *Site
	if nilSite.TrafficExhausted() {
		t.Fatal("nil 站点不应被判为流量用尽")
	}
}

// 缓存必须有界：条目是按 Host 推导的 siteID 建的，其中包含查不到的站点，
// 随机子域名扫描能凭空塞进任意多个 key。
func TestCacheIsBounded(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()

	c := NewClient(Options{BaseURL: server.URL, NegativeTTL: time.Hour, MaxEntries: 8})
	for i := 0; i < 500; i++ {
		_, _ = c.BySiteID(context.Background(), "ws-scan-"+strconv.Itoa(i))
	}
	if size := c.CacheSize(); size > 8 {
		t.Fatalf("缓存条目数 = %d，期望不超过上界 8", size)
	}
}

// 达到上界后仍然要能正确回答查询：淘汰缓存只是多一次回源，绝不能影响判定。
func TestBoundedCacheStillAnswersCorrectly(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/ws-real") {
			_, _ = w.Write([]byte(`{"code":"OK","message":"success","data":{"site_id":"ws-real","status":"active"}}`))
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()

	c := NewClient(Options{BaseURL: server.URL, PositiveTTL: time.Hour, NegativeTTL: time.Hour, MaxEntries: 4})
	for i := 0; i < 100; i++ {
		_, _ = c.BySiteID(context.Background(), "ws-scan-"+strconv.Itoa(i))
	}
	site, err := c.BySiteID(context.Background(), "ws-real")
	if err != nil {
		t.Fatalf("被扫描挤过之后仍应能查到真实站点，实际 %v", err)
	}
	if site.Status != StatusActive {
		t.Fatalf("站点 = %+v", site)
	}
}

func TestRejectsResponseWithoutSiteID(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"code":"OK","message":"success","data":{"status":"active"}}`))
	}))
	defer server.Close()

	c := NewClient(Options{BaseURL: server.URL})
	if _, err := c.BySiteID(context.Background(), "ws-abc"); err == nil {
		t.Fatal("缺少 site_id 的响应应当报错")
	}
}

// ---- Custom Domain Lookup Tests ----

func TestSiteIDByDomainReturnsSiteID(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.URL.Path; got != "/internal/ctl/websites/domains/blog.example.com" {
			t.Errorf("请求路径 = %q", got)
		}
		if got := r.Header.Get("X-Internal-Token"); got != "secret" {
			t.Errorf("X-Internal-Token = %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"code":"OK","message":"success","data":{"domain":"blog.example.com","site_id":"ws-abc"}}`))
	}))
	defer server.Close()

	c := NewClient(Options{BaseURL: server.URL, InternalToken: "secret"})
	siteID, err := c.SiteIDByDomain(context.Background(), "blog.example.com")
	if err != nil {
		t.Fatalf("SiteIDByDomain: %v", err)
	}
	if siteID != "ws-abc" {
		t.Fatalf("siteID = %q, expected ws-abc", siteID)
	}
}

func TestSiteIDByDomainNotFound(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"code":"WEBSITE_DOMAIN_NOT_FOUND","message":"not found"}`))
	}))
	defer server.Close()

	c := NewClient(Options{BaseURL: server.URL, InternalToken: "secret"})
	_, err := c.SiteIDByDomain(context.Background(), "nonexistent.com")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
}

func TestSiteIDByDomainCached(t *testing.T) {
	var callCount int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&callCount, 1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"code":"OK","data":{"site_id":"ws-abc"}}`))
	}))
	defer server.Close()

	c := NewClient(Options{
		BaseURL:       server.URL,
		InternalToken: "secret",
		PositiveTTL:   30 * time.Second,
	})

	// First call hits the server
	siteID, err := c.SiteIDByDomain(context.Background(), "blog.example.com")
	if err != nil {
		t.Fatal(err)
	}
	if siteID != "ws-abc" {
		t.Fatalf("siteID = %q", siteID)
	}

	// Second call should hit cache
	siteID2, err := c.SiteIDByDomain(context.Background(), "blog.example.com")
	if err != nil {
		t.Fatal(err)
	}
	if siteID2 != "ws-abc" {
		t.Fatalf("siteID = %q", siteID2)
	}

	if got := atomic.LoadInt32(&callCount); got != 1 {
		t.Fatalf("expected 1 server call, got %d", got)
	}
}

func TestSiteIDByDomainNormalizesInput(t *testing.T) {
	var receivedPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedPath = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"code":"OK","data":{"site_id":"ws-abc"}}`))
	}))
	defer server.Close()

	c := NewClient(Options{BaseURL: server.URL, InternalToken: "secret"})

	// Uppercase + trailing dot should be normalized
	if _, err := c.SiteIDByDomain(context.Background(), "Blog.Example.COM."); err != nil {
		t.Fatal(err)
	}
	if receivedPath != "/internal/ctl/websites/domains/blog.example.com" {
		t.Fatalf("path = %q", receivedPath)
	}
}
