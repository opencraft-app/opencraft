package httpapi

import (
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"git.woa.com/wisp/mono/site-gateway/internal/hostroute"
	"git.woa.com/wisp/mono/site-gateway/internal/sitemeta"
	"git.woa.com/wisp/mono/site-gateway/internal/usage"
)

func newMeteredHandler(sites *fakeSites, obj *fakeOrigin, meter *usage.Meter) *SiteHandler {
	return NewSiteHandler(Options{
		Resolver: hostroute.New([]string{rootDomain}),
		Sites:    sites,
		Origin:   obj,
		Usage:    meter,
		Logger:   log.New(io.Discard, "", 0),
	})
}

func sampleFor(t *testing.T, meter *usage.Meter, siteID string) usage.Sample {
	t.Helper()
	for _, sample := range meter.Drain() {
		if sample.SiteID == siteID {
			return sample
		}
	}
	return usage.Sample{}
}

// 计量的字节数必须等于实际写给客户端的响应体长度。
func TestMetersActualResponseBodyBytes(t *testing.T) {
	site := "ws-abc"
	body := "<h1>hello</h1>"
	obj := &fakeOrigin{objects: map[string]string{
		"sites/ws-abc/current/index.html": body,
	}}
	meter := usage.NewMeter(0)

	rec := do(newMeteredHandler(activeSite(site), obj, meter), http.MethodGet, site+"."+rootDomain, "/")
	if rec.Code != http.StatusOK {
		t.Fatalf("状态码 = %d", rec.Code)
	}

	got := sampleFor(t, meter, site)
	if got.TrafficBytes != int64(len(body)) {
		t.Fatalf("计量 = %d 字节，期望 %d（实际响应体长度）", got.TrafficBytes, len(body))
	}
	if got.RequestCount != 1 {
		t.Fatalf("请求数 = %d，期望 1", got.RequestCount)
	}
}

// HEAD 没有响应体：Content-Length 头有值，但一个字节都没发出去。
// 用响应头的声明值计数会在这里系统性高估。
func TestHeadRequestMetersZeroBytesButOneRequest(t *testing.T) {
	site := "ws-abc"
	obj := &fakeOrigin{objects: map[string]string{
		"sites/ws-abc/current/index.html": "<h1>hello</h1>",
	}}
	meter := usage.NewMeter(0)

	rec := do(newMeteredHandler(activeSite(site), obj, meter), http.MethodHead, site+"."+rootDomain, "/")
	if rec.Code != http.StatusOK {
		t.Fatalf("状态码 = %d", rec.Code)
	}
	if rec.Body.Len() != 0 {
		t.Fatalf("HEAD 不应有响应体，实际 %q", rec.Body.String())
	}

	got := sampleFor(t, meter, site)
	if got.TrafficBytes != 0 {
		t.Fatalf("HEAD 计量 = %d 字节，期望 0", got.TrafficBytes)
	}
	if got.RequestCount != 1 {
		t.Fatalf("HEAD 请求数 = %d，期望 1", got.RequestCount)
	}
}

// 304 同样没有响应体。条件请求在正常浏览下占比不低，算成全量会明显虚高。
func TestNotModifiedMetersZeroBytesButOneRequest(t *testing.T) {
	site := "ws-abc"
	key := "sites/ws-abc/current/index.html"
	obj := &fakeOrigin{objects: map[string]string{key: "<h1>hello</h1>"}}
	meter := usage.NewMeter(0)

	req := httptest.NewRequest(http.MethodGet, "http://"+site+"."+rootDomain+"/", nil)
	req.Host = site + "." + rootDomain
	req.Header.Set("If-None-Match", "\"etag-"+key+"\"")
	rec := httptest.NewRecorder()
	newMeteredHandler(activeSite(site), obj, meter).ServeHTTP(rec, req)

	if rec.Code != http.StatusNotModified {
		t.Fatalf("状态码 = %d，期望 304", rec.Code)
	}
	got := sampleFor(t, meter, site)
	if got.TrafficBytes != 0 {
		t.Fatalf("304 计量 = %d 字节，期望 0", got.TrafficBytes)
	}
	if got.RequestCount != 1 {
		t.Fatalf("304 请求数 = %d，期望 1", got.RequestCount)
	}
}

// 同一个站点的多次请求在一个窗口内合并。
func TestMultipleRequestsAccumulateForSameSite(t *testing.T) {
	site := "ws-abc"
	obj := &fakeOrigin{objects: map[string]string{
		"sites/ws-abc/current/index.html":       "0123456789",
		"sites/ws-abc/current/app.js":           "abc",
		"sites/ws-abc/current/about/index.html": "xy",
	}}
	meter := usage.NewMeter(0)
	handler := newMeteredHandler(activeSite(site), obj, meter)
	host := site + "." + rootDomain

	do(handler, http.MethodGet, host, "/")
	do(handler, http.MethodGet, host, "/app.js")
	do(handler, http.MethodGet, host, "/about/")

	got := sampleFor(t, meter, site)
	if got.TrafficBytes != 15 {
		t.Fatalf("累计 = %d 字节，期望 15", got.TrafficBytes)
	}
	if got.RequestCount != 3 {
		t.Fatalf("累计请求数 = %d，期望 3", got.RequestCount)
	}
}

// 站点自带的 404 页面也是真实发出去的字节，必须计入。
func TestSite404BodyIsMetered(t *testing.T) {
	site := "ws-abc"
	obj := &fakeOrigin{objects: map[string]string{
		"sites/ws-abc/current/404.html": "custom not found",
	}}
	meter := usage.NewMeter(0)

	rec := do(newMeteredHandler(activeSite(site), obj, meter), http.MethodGet, site+"."+rootDomain, "/missing.html")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("状态码 = %d", rec.Code)
	}
	if got := sampleFor(t, meter, site); got.TrafficBytes != int64(len("custom not found")) {
		t.Fatalf("404 页计量 = %d 字节，期望 %d", got.TrafficBytes, len("custom not found"))
	}
}

// 计量必须放在站点解析之后：随机子域名扫描不能在计数器里创建条目，
// 这是内存有界的关键前提，比上界本身更重要。
func TestUnresolvedHostCreatesNoMeterEntry(t *testing.T) {
	meter := usage.NewMeter(0)
	handler := newMeteredHandler(activeSite("ws-abc"), &fakeOrigin{}, meter)

	for _, host := range []string{
		"shop.example.com",
		"ws-scan-0001." + rootDomain,
		"ws-scan-0002." + rootDomain,
	} {
		do(handler, http.MethodGet, host, "/")
	}

	if size := meter.Size(); size != 0 {
		t.Fatalf("未解析到站点的请求创建了 %d 个计量条目，期望 0", size)
	}
}

// 已下线 / 已封禁的站点不回源、也不计流量：它们一个字节的 COS 成本都没产生。
func TestGatedSitesAreNotMetered(t *testing.T) {
	for _, status := range []string{sitemeta.StatusSuspended, sitemeta.StatusBlocked, sitemeta.StatusDeleted} {
		site := "ws-abc"
		sites := &fakeSites{sites: map[string]*sitemeta.Site{
			site: {SiteID: site, Status: status},
		}}
		meter := usage.NewMeter(0)
		do(newMeteredHandler(sites, &fakeOrigin{}, meter), http.MethodGet, site+"."+rootDomain, "/")

		if size := meter.Size(); size != 0 {
			t.Fatalf("状态 %s 的站点产生了计量条目 %d 个，期望 0", status, size)
		}
	}
}

// ---- 超额拦截 ----

func quotaSite(siteID string, limit, used int64) *fakeSites {
	return &fakeSites{sites: map[string]*sitemeta.Site{
		siteID: {
			SiteID:              siteID,
			Status:              sitemeta.StatusActive,
			MonthlyTrafficBytes: limit,
			UsedTrafficBytes:    used,
		},
	}}
}

// 超额后返回 403 且**不回源**：这是把闸放在网关的主要收益，
// 超额之后不再产生新的 COS 流量成本。
func TestOverQuotaReturnsForbiddenWithoutOriginFetch(t *testing.T) {
	site := "ws-abc"
	obj := &fakeOrigin{objects: map[string]string{
		"sites/ws-abc/current/index.html": "still published",
	}}
	meter := usage.NewMeter(0)

	rec := do(newMeteredHandler(quotaSite(site, 1000, 1000), obj, meter),
		http.MethodGet, site+"."+rootDomain, "/")

	if rec.Code != http.StatusForbidden {
		t.Fatalf("状态码 = %d，期望 403", rec.Code)
	}
	if len(obj.requests) != 0 {
		t.Fatalf("超额时不应回源，实际请求了 %v", obj.requests)
	}
	if !strings.Contains(rec.Body.String(), "本月流量已用尽") {
		t.Fatalf("应返回流量用尽页，实际 %q", rec.Body.String())
	}
	// 被拦下的请求不再计流量，否则站点被闸住之后用量还会继续涨。
	if size := meter.Size(); size != 0 {
		t.Fatalf("超额被拦的请求产生了 %d 个计量条目，期望 0", size)
	}
}

// 已用量超过额度（不只是相等）同样拦下。
func TestQuotaExceededByMoreThanLimitIsBlocked(t *testing.T) {
	site := "ws-abc"
	obj := &fakeOrigin{objects: map[string]string{"sites/ws-abc/current/index.html": "x"}}
	rec := do(newMeteredHandler(quotaSite(site, 1000, 999999), obj, usage.NewMeter(0)),
		http.MethodGet, site+"."+rootDomain, "/")
	if rec.Code != http.StatusForbidden {
		t.Fatalf("状态码 = %d，期望 403", rec.Code)
	}
	if len(obj.requests) != 0 {
		t.Fatalf("不应回源，实际 %v", obj.requests)
	}
}

// 未超额时必须正常服务：闸门不能误伤。
func TestUnderQuotaServesNormally(t *testing.T) {
	site := "ws-abc"
	body := "<h1>hello</h1>"
	obj := &fakeOrigin{objects: map[string]string{"sites/ws-abc/current/index.html": body}}
	meter := usage.NewMeter(0)

	rec := do(newMeteredHandler(quotaSite(site, 1000, 999), obj, meter),
		http.MethodGet, site+"."+rootDomain, "/")

	if rec.Code != http.StatusOK {
		t.Fatalf("状态码 = %d，期望 200", rec.Code)
	}
	if rec.Body.String() != body {
		t.Fatalf("响应体 = %q", rec.Body.String())
	}
	if got := sampleFor(t, meter, site); got.TrafficBytes != int64(len(body)) {
		t.Fatalf("计量 = %d 字节，期望 %d", got.TrafficBytes, len(body))
	}
}

// 额度为 0 表示不限额（未配置或 ctl 查不到），必须放行——
// 一次配额查询失败就把用户站点整体 403 是更差的失败模式。
func TestZeroQuotaMeansUnlimited(t *testing.T) {
	site := "ws-abc"
	obj := &fakeOrigin{objects: map[string]string{"sites/ws-abc/current/index.html": "hello"}}
	rec := do(newMeteredHandler(quotaSite(site, 0, 999999999), obj, usage.NewMeter(0)),
		http.MethodGet, site+"."+rootDomain, "/")
	if rec.Code != http.StatusOK {
		t.Fatalf("状态码 = %d，期望 200（额度 0 = 不限额）", rec.Code)
	}
}

// 超额拦截对 HEAD 一样生效，否则可以用 HEAD 继续探测站点是否还在。
func TestOverQuotaBlocksHeadToo(t *testing.T) {
	site := "ws-abc"
	obj := &fakeOrigin{objects: map[string]string{"sites/ws-abc/current/index.html": "x"}}
	rec := do(newMeteredHandler(quotaSite(site, 10, 10), obj, usage.NewMeter(0)),
		http.MethodHead, site+"."+rootDomain, "/")
	if rec.Code != http.StatusForbidden {
		t.Fatalf("状态码 = %d，期望 403", rec.Code)
	}
	if len(obj.requests) != 0 {
		t.Fatalf("不应回源，实际 %v", obj.requests)
	}
}
