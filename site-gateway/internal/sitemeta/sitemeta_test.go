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
