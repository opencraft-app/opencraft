package sitemeta

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
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
