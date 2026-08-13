package httpapi

import (
	"context"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"git.woa.com/wisp/mono/site-gateway/internal/hostroute"
	"git.woa.com/wisp/mono/site-gateway/internal/origin"
	"git.woa.com/wisp/mono/site-gateway/internal/sitemeta"
)

const rootDomain = "sites.lightclaw.tech"

type fakeSites struct {
	sites map[string]*sitemeta.Site
	err   error
}

func (f *fakeSites) BySiteID(_ context.Context, siteID string) (*sitemeta.Site, error) {
	if f.err != nil {
		return nil, f.err
	}
	site, ok := f.sites[siteID]
	if !ok {
		return nil, sitemeta.ErrNotFound
	}
	return site, nil
}

type fakeOrigin struct {
	objects  map[string]string
	requests []string
	err      error
}

func (f *fakeOrigin) Get(_ context.Context, key string) (*origin.Object, error) {
	f.requests = append(f.requests, key)
	if f.err != nil {
		return nil, f.err
	}
	body, ok := f.objects[key]
	if !ok {
		return nil, origin.ErrNotFound
	}
	return &origin.Object{
		Body:          io.NopCloser(strings.NewReader(body)),
		ContentType:   "text/html; charset=utf-8",
		ContentLength: int64(len(body)),
		ETag:          "\"etag-" + key + "\"",
	}, nil
}

func newHandler(sites *fakeSites, obj *fakeOrigin) *SiteHandler {
	return NewSiteHandler(Options{
		Resolver: hostroute.New([]string{rootDomain}),
		Sites:    sites,
		Origin:   obj,
		Logger:   log.New(io.Discard, "", 0),
	})
}

func activeSite(siteID string) *fakeSites {
	return &fakeSites{sites: map[string]*sitemeta.Site{
		siteID: {SiteID: siteID, Status: sitemeta.StatusActive},
	}}
}

func do(h http.Handler, method string, host string, path string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, "http://"+host+path, nil)
	req.Host = host
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestServesIndexForRootPath(t *testing.T) {
	site := "ws-abc"
	obj := &fakeOrigin{objects: map[string]string{
		"sites/ws-abc/current/index.html": "<h1>hello</h1>",
	}}
	rec := do(newHandler(activeSite(site), obj), http.MethodGet, site+"."+rootDomain, "/")

	if rec.Code != http.StatusOK {
		t.Fatalf("状态码 = %d", rec.Code)
	}
	if body := rec.Body.String(); body != "<h1>hello</h1>" {
		t.Fatalf("响应体 = %q", body)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-cache" {
		t.Fatalf("HTML 必须每次回源校验，Cache-Control = %q", got)
	}
	if got := rec.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("X-Content-Type-Options = %q", got)
	}
}

func TestServesOnlyFromActiveImmutableRelease(t *testing.T) {
	site := "ws-abc"
	prefix := "sites/ws-abc/releases/wr-0123456789abcdef/"
	sites := activeSite(site)
	sites.sites[site].CloudPath = prefix
	obj := &fakeOrigin{objects: map[string]string{
		"sites/ws-abc/current/index.html": "stale",
		prefix + "index.html":             "active",
	}}

	rec := do(newHandler(sites, obj), http.MethodGet, site+"."+rootDomain, "/")
	if rec.Code != http.StatusOK || rec.Body.String() != "active" {
		t.Fatalf("response = %d/%q", rec.Code, rec.Body.String())
	}
	if len(obj.requests) != 1 || obj.requests[0] != prefix+"index.html" {
		t.Fatalf("origin requests = %v", obj.requests)
	}
}

func TestRejectsCloudPathOwnedByAnotherSite(t *testing.T) {
	site := "ws-abc"
	sites := activeSite(site)
	sites.sites[site].CloudPath = "sites/ws-victim/releases/wr-0123456789abcdef/"
	obj := &fakeOrigin{objects: map[string]string{
		"sites/ws-victim/releases/wr-0123456789abcdef/index.html": "victim",
	}}

	rec := do(newHandler(sites, obj), http.MethodGet, site+"."+rootDomain, "/")
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", rec.Code)
	}
	if len(obj.requests) != 0 {
		t.Fatalf("invalid cloud_path reached origin: %v", obj.requests)
	}
}

func TestServesDirectoryIndex(t *testing.T) {
	site := "ws-abc"
	obj := &fakeOrigin{objects: map[string]string{
		"sites/ws-abc/current/about/index.html": "about page",
	}}
	rec := do(newHandler(activeSite(site), obj), http.MethodGet, site+"."+rootDomain, "/about")

	if rec.Code != http.StatusOK {
		t.Fatalf("状态码 = %d", rec.Code)
	}
	if body := rec.Body.String(); body != "about page" {
		t.Fatalf("响应体 = %q", body)
	}
}

// 一个站点的请求永远只能落到自己的前缀，这是多租户隔离的核心不变量。
func TestNeverReadsAnotherSitePrefix(t *testing.T) {
	site := "ws-abc"
	obj := &fakeOrigin{objects: map[string]string{
		"sites/ws-victim/current/index.html": "victim content",
		"sites/ws-victim/data/secret.json":   "secret",
	}}
	handler := newHandler(activeSite(site), obj)

	for _, path := range []string{
		"/../ws-victim/current/index.html",
		"/../../sites/ws-victim/data/secret.json",
		"/a/../../../sites/ws-victim/current/index.html",
	} {
		rec := do(handler, http.MethodGet, site+"."+rootDomain, path)
		if strings.Contains(rec.Body.String(), "victim") || strings.Contains(rec.Body.String(), "secret") {
			t.Fatalf("路径 %q 读到了其他站点的内容", path)
		}
	}
	for _, key := range obj.requests {
		if !strings.HasPrefix(key, "sites/ws-abc/") {
			t.Fatalf("回源了越界 key %q", key)
		}
	}
}

func TestUnknownHostIsRejected(t *testing.T) {
	obj := &fakeOrigin{objects: map[string]string{}}
	handler := newHandler(activeSite("ws-abc"), obj)

	// 未绑定的自定义域名不能回落到任何站点，否则错配域名会把流量导给别人。
	rec := do(handler, http.MethodGet, "shop.example.com", "/")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("状态码 = %d，期望 404", rec.Code)
	}
	if len(obj.requests) != 0 {
		t.Fatalf("不应回源，实际请求了 %v", obj.requests)
	}
}

func TestSuspendedSiteReturnsForbidden(t *testing.T) {
	site := "ws-abc"
	sites := &fakeSites{sites: map[string]*sitemeta.Site{
		site: {SiteID: site, Status: sitemeta.StatusSuspended},
	}}
	obj := &fakeOrigin{objects: map[string]string{
		"sites/ws-abc/current/index.html": "still here",
	}}
	rec := do(newHandler(sites, obj), http.MethodGet, site+"."+rootDomain, "/")

	if rec.Code != http.StatusForbidden {
		t.Fatalf("状态码 = %d，期望 403", rec.Code)
	}
	// 下线只是不再对外服务，制品仍保留以便续费恢复，因此不应回源。
	if len(obj.requests) != 0 {
		t.Fatalf("下线站点不应回源，实际请求了 %v", obj.requests)
	}
}

func TestBlockedSiteReturnsForbidden(t *testing.T) {
	site := "ws-abc"
	sites := &fakeSites{sites: map[string]*sitemeta.Site{
		site: {SiteID: site, Status: sitemeta.StatusBlocked},
	}}
	rec := do(newHandler(sites, &fakeOrigin{}), http.MethodGet, site+"."+rootDomain, "/")
	if rec.Code != http.StatusForbidden {
		t.Fatalf("状态码 = %d，期望 403", rec.Code)
	}
}

func TestDeletedSiteReturnsNotFound(t *testing.T) {
	site := "ws-abc"
	sites := &fakeSites{sites: map[string]*sitemeta.Site{
		site: {SiteID: site, Status: sitemeta.StatusDeleted},
	}}
	rec := do(newHandler(sites, &fakeOrigin{}), http.MethodGet, site+"."+rootDomain, "/")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("状态码 = %d，期望 404", rec.Code)
	}
}

func TestMissingObjectFallsBackToSite404(t *testing.T) {
	site := "ws-abc"
	obj := &fakeOrigin{objects: map[string]string{
		"sites/ws-abc/current/404.html": "custom not found",
	}}
	rec := do(newHandler(activeSite(site), obj), http.MethodGet, site+"."+rootDomain, "/missing.html")

	if rec.Code != http.StatusNotFound {
		t.Fatalf("状态码 = %d", rec.Code)
	}
	if body := rec.Body.String(); body != "custom not found" {
		t.Fatalf("响应体 = %q", body)
	}
}

func TestMissingObjectWithoutSite404UsesBuiltinPage(t *testing.T) {
	site := "ws-abc"
	rec := do(newHandler(activeSite(site), &fakeOrigin{objects: map[string]string{}}), http.MethodGet, site+"."+rootDomain, "/missing.html")

	if rec.Code != http.StatusNotFound {
		t.Fatalf("状态码 = %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "页面不存在") {
		t.Fatalf("应返回内置 404 页，实际 %q", rec.Body.String())
	}
}

func TestHeadRequestOmitsBody(t *testing.T) {
	site := "ws-abc"
	obj := &fakeOrigin{objects: map[string]string{
		"sites/ws-abc/current/index.html": "<h1>hello</h1>",
	}}
	rec := do(newHandler(activeSite(site), obj), http.MethodHead, site+"."+rootDomain, "/")

	if rec.Code != http.StatusOK {
		t.Fatalf("状态码 = %d", rec.Code)
	}
	if rec.Body.Len() != 0 {
		t.Fatalf("HEAD 不应有响应体，实际 %q", rec.Body.String())
	}
}

func TestPostIsRejected(t *testing.T) {
	site := "ws-abc"
	rec := do(newHandler(activeSite(site), &fakeOrigin{}), http.MethodPost, site+"."+rootDomain, "/")
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("状态码 = %d，期望 405", rec.Code)
	}
}

// 数据面下线后 /__vela/ 不再是保留前缀，必须完整走静态回源：
// 既不能残留一个特判分支，也不能让它变成一个能写东西的入口。
func TestFormerReservedPrefixIsPlainStatic(t *testing.T) {
	site := "ws-abc"
	obj := &fakeOrigin{objects: map[string]string{
		"sites/ws-abc/current/index.html": "<h1>hello</h1>",
	}}
	handler := newHandler(activeSite(site), obj)
	host := site + "." + rootDomain

	rec := do(handler, http.MethodGet, host, "/__vela/data/notes")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("GET /__vela/data/notes = %d，期望 404", rec.Code)
	}
	// 回源尝试的必须是站点自己的 current/ 前缀，而不是任何 data/ 空间。
	if len(obj.requests) == 0 {
		t.Fatal("应当按静态路径回源，实际一次都没请求")
	}
	for _, key := range obj.requests {
		if !strings.HasPrefix(key, "sites/ws-abc/current/") {
			t.Fatalf("回源了非静态 key %q", key)
		}
	}

	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodDelete} {
		rec := do(handler, method, host, "/__vela/data/notes")
		if rec.Code != http.StatusMethodNotAllowed {
			t.Fatalf("%s /__vela/data/notes = %d，期望 405", method, rec.Code)
		}
	}
}

// 静态路径的方法限制对任意路径一致生效，且必须给出 Allow 头。
func TestWriteMethodsAreRejectedEverywhere(t *testing.T) {
	site := "ws-abc"
	handler := newHandler(activeSite(site), &fakeOrigin{})
	host := site + "." + rootDomain

	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete} {
		for _, p := range []string{"/", "/index.html", "/api/notes"} {
			rec := do(handler, method, host, p)
			if rec.Code != http.StatusMethodNotAllowed {
				t.Fatalf("%s %s = %d，期望 405", method, p, rec.Code)
			}
			if got := rec.Header().Get("Allow"); got != "GET, HEAD" {
				t.Fatalf("%s %s 的 Allow = %q", method, p, got)
			}
		}
	}
}

func TestConditionalRequestReturnsNotModified(t *testing.T) {
	site := "ws-abc"
	key := "sites/ws-abc/current/index.html"
	obj := &fakeOrigin{objects: map[string]string{key: "<h1>hello</h1>"}}

	req := httptest.NewRequest(http.MethodGet, "http://"+site+"."+rootDomain+"/", nil)
	req.Host = site + "." + rootDomain
	req.Header.Set("If-None-Match", "\"etag-"+key+"\"")
	rec := httptest.NewRecorder()
	newHandler(activeSite(site), obj).ServeHTTP(rec, req)

	if rec.Code != http.StatusNotModified {
		t.Fatalf("状态码 = %d，期望 304", rec.Code)
	}
	if rec.Body.Len() != 0 {
		t.Fatalf("304 不应有响应体")
	}
}

func TestOriginErrorReturnsBadGateway(t *testing.T) {
	site := "ws-abc"
	obj := &fakeOrigin{err: context.DeadlineExceeded}
	rec := do(newHandler(activeSite(site), obj), http.MethodGet, site+"."+rootDomain, "/")
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("状态码 = %d，期望 502", rec.Code)
	}
}

func TestSiteLookupErrorReturnsBadGateway(t *testing.T) {
	sites := &fakeSites{err: context.DeadlineExceeded}
	rec := do(newHandler(sites, &fakeOrigin{}), http.MethodGet, "ws-abc."+rootDomain, "/")
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("状态码 = %d，期望 502", rec.Code)
	}
}

// ---- Custom Domain Fallback Tests ----

// fakeDomainLookup 实现 sitemeta.DomainLookup 接口，供测试使用。
type fakeDomainLookup struct {
	domains map[string]string // domain → siteID
}

func (f *fakeDomainLookup) SiteIDByDomain(_ context.Context, domain string) (string, error) {
	siteID, ok := f.domains[domain]
	if !ok {
		return "", sitemeta.ErrNotFound
	}
	return siteID, nil
}

func newHandlerWithCustomDomain(sites *fakeSites, obj *fakeOrigin, dl *fakeDomainLookup) *SiteHandler {
	return NewSiteHandler(Options{
		Resolver:     hostroute.New([]string{rootDomain}),
		Sites:        sites,
		DomainLookup: dl,
		Origin:       obj,
		Logger:       log.New(io.Discard, "", 0),
	})
}

func TestCustomDomainResolvesToSite(t *testing.T) {
	site := "ws-abc"
	prefix := "sites/ws-abc/releases/wr-0123456789abcdef/"
	sites := activeSite(site)
	sites.sites[site].CloudPath = prefix
	obj := &fakeOrigin{objects: map[string]string{
		prefix + "index.html": "<h1>custom domain works</h1>",
	}}
	dl := &fakeDomainLookup{domains: map[string]string{
		"blog.example.com": site,
	}}

	h := newHandlerWithCustomDomain(sites, obj, dl)
	rec := do(h, http.MethodGet, "blog.example.com", "/")

	if rec.Code != http.StatusOK {
		t.Fatalf("状态码 = %d, expected 200", rec.Code)
	}
	if body := rec.Body.String(); body != "<h1>custom domain works</h1>" {
		t.Fatalf("响应体 = %q", body)
	}
}

func TestCustomDomainNotFoundReturns404(t *testing.T) {
	sites := activeSite("ws-abc")
	obj := &fakeOrigin{}
	dl := &fakeDomainLookup{domains: map[string]string{}}

	h := newHandlerWithCustomDomain(sites, obj, dl)
	rec := do(h, http.MethodGet, "unknown.example.com", "/")

	if rec.Code != http.StatusNotFound {
		t.Fatalf("状态码 = %d, expected 404", rec.Code)
	}
}

func TestCustomDomainDoesNotFallBackToRandomSite(t *testing.T) {
	// Even if the domain resolves to a siteID, the site must exist
	// and be active — no fallback to any other site.
	site := "ws-abc"
	prefix := "sites/ws-abc/releases/wr-0123456789abcdef/"
	sites := activeSite(site)
	sites.sites[site].CloudPath = prefix
	obj := &fakeOrigin{objects: map[string]string{
		prefix + "index.html": "<h1>real site</h1>",
	}}
	dl := &fakeDomainLookup{domains: map[string]string{
		"blog.example.com": "ws-different", // points to a different, non-existent site
	}}

	h := newHandlerWithCustomDomain(sites, obj, dl)
	rec := do(h, http.MethodGet, "blog.example.com", "/")

	// Should get 404, NOT the content of ws-abc
	if rec.Code != http.StatusNotFound {
		t.Fatalf("状态码 = %d, expected 404 for non-existent site", rec.Code)
	}
}

func TestCustomDomainNilDomainLookupBehavesSame(t *testing.T) {
	// When DomainLookup is nil, unresolved hosts return 404
	// exactly as before the feature was added.
	sites := activeSite("ws-abc")
	obj := &fakeOrigin{}

	h := newHandler(sites, obj) // no DomainLookup
	rec := do(h, http.MethodGet, "blog.example.com", "/")

	if rec.Code != http.StatusNotFound {
		t.Fatalf("状态码 = %d, expected 404 without DomainLookup", rec.Code)
	}
}

func TestCustomDomainSuspendedSiteReturns403(t *testing.T) {
	site := "ws-abc"
	sites := &fakeSites{sites: map[string]*sitemeta.Site{
		site: {SiteID: site, Status: sitemeta.StatusSuspended},
	}}
	obj := &fakeOrigin{}
	dl := &fakeDomainLookup{domains: map[string]string{
		"blog.example.com": site,
	}}

	h := newHandlerWithCustomDomain(sites, obj, dl)
	rec := do(h, http.MethodGet, "blog.example.com", "/")

	if rec.Code != http.StatusForbidden {
		t.Fatalf("状态码 = %d, expected 403 for suspended site", rec.Code)
	}
}

func TestRandomSubdomainStillWorksWithDomainLookup(t *testing.T) {
	// Ensure random subdomains still work when DomainLookup is set
	site := "ws-abc"
	prefix := "sites/ws-abc/releases/wr-0123456789abcdef/"
	sites := activeSite(site)
	sites.sites[site].CloudPath = prefix
	obj := &fakeOrigin{objects: map[string]string{
		prefix + "index.html": "<h1>random subdomain</h1>",
	}}
	dl := &fakeDomainLookup{domains: map[string]string{
		"blog.example.com": "ws-other",
	}}

	h := newHandlerWithCustomDomain(sites, obj, dl)
	rec := do(h, http.MethodGet, site+"."+rootDomain, "/")

	if rec.Code != http.StatusOK {
		t.Fatalf("状态码 = %d, expected 200 for random subdomain", rec.Code)
	}
	if body := rec.Body.String(); body != "<h1>random subdomain</h1>" {
		t.Fatalf("响应体 = %q", body)
	}
}
