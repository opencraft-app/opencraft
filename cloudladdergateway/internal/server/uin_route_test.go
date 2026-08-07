package server

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/openclaw/openclaw/mono/cloudladdergateway/internal/auth"
	"github.com/openclaw/openclaw/mono/cloudladdergateway/internal/config"
	"github.com/openclaw/openclaw/mono/cloudladdergateway/internal/proxy"
)

// jifeiCallbackBody 构造一条最小的 jifei 回调 envelope，只关心 interface.para.uin。
func jifeiCallbackBody(uin string) string {
	return fmt.Sprintf(
		`{"componentName":"BillingRoute","caller":"BillingRoute",`+
			`"interface":{"interfaceName":"lightvela.pass.createResource",`+
			`"para":{"uin":%s,"appId":251202221,"dealName":"d1"}}}`, uin)
}

// newUinRouteRouter 搭一个「兜底环境 + 两个开发者环境」的三上游拓扑。
func newUinRouteRouter(t *testing.T) (*gin_ResponseCapture, *httptest.Server, *httptest.Server, *httptest.Server) {
	t.Helper()

	hits := &gin_ResponseCapture{}
	fallback := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.fallback++
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"env":"fallback"}`))
	}))
	devA := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.devA++
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"env":"dev-a"}`))
	}))
	devB := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.devB++
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"env":"dev-b"}`))
	}))
	t.Cleanup(func() {
		fallback.Close()
		devA.Close()
		devB.Close()
	})
	hits.router = buildUinRouter(t, fallback.URL, devA.URL, devB.URL)
	return hits, fallback, devA, devB
}

type gin_ResponseCapture struct {
	router               http.Handler
	fallback, devA, devB int
}

func buildUinRouter(t *testing.T, fallbackURL, devAURL, devBURL string) http.Handler {
	t.Helper()
	cfg := config.Config{
		MaxBodyBytes: config.DefaultMaxBodyBytes,
		Routes: []config.RouteConfig{
			{
				ID:       "jifei-callback",
				Upstream: config.UpstreamConfig{BaseURL: fallbackURL},
				UinRoutes: []config.UinRoute{
					{Uin: "700000164995", RouteID: "jifei-callback-dev-a"},
					{Uin: "700000164996", RouteID: "jifei-callback-dev-b"},
					{Uin: "700000164997", RouteID: "jifei-callback-dev-missing"},
				},
			},
			{ID: "jifei-callback-dev-a", Upstream: config.UpstreamConfig{BaseURL: devAURL}},
			{ID: "jifei-callback-dev-b", Upstream: config.UpstreamConfig{BaseURL: devBURL}},
		},
	}
	engine, err := proxy.NewEngine(cfg)
	if err != nil {
		t.Fatalf("new engine: %v", err)
	}
	authenticator, err := auth.New(cfg)
	if err != nil {
		t.Fatalf("new authenticator: %v", err)
	}
	uinRoutes := map[string][]config.UinRoute{}
	for _, route := range cfg.Routes {
		if len(route.UinRoutes) > 0 {
			uinRoutes[route.ID] = route.UinRoutes
		}
	}
	return NewGinRouterWithUinRoutes(engine, authenticator, config.DefaultMaxBodyBytes, uinRoutes)
}

func postCallback(t *testing.T, router http.Handler, body string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost,
		"/v1/proxy/jifei-callback/trade/jifei/callback", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(rec, req)
	return rec
}

// TestUinRouteDispatchesToOwnerEnvironment 是这套机制的核心用例：
// 同一个固定回调入口，按影子账号 uin 把回调分别送到两个开发者环境。
func TestUinRouteDispatchesToOwnerEnvironment(t *testing.T) {
	hits, _, _, _ := newUinRouteRouter(t)

	rec := postCallback(t, hits.router, jifeiCallbackBody(`"700000164995"`))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "dev-a") {
		t.Fatalf("uin 700000164995 应命中 dev-a，实际 %d %s", rec.Code, rec.Body.String())
	}

	rec = postCallback(t, hits.router, jifeiCallbackBody(`"700000164996"`))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "dev-b") {
		t.Fatalf("uin 700000164996 应命中 dev-b，实际 %d %s", rec.Code, rec.Body.String())
	}

	if hits.devA != 1 || hits.devB != 1 || hits.fallback != 0 {
		t.Fatalf("上游命中次数不对: devA=%d devB=%d fallback=%d", hits.devA, hits.devB, hits.fallback)
	}
}

// TestUinRouteFallsBackForUnknownUin 未登记的 uin 走兜底环境，不能 404。
// 现网/预发布的真实用户订单就是走这条路径。
func TestUinRouteFallsBackForUnknownUin(t *testing.T) {
	hits, _, _, _ := newUinRouteRouter(t)

	rec := postCallback(t, hits.router, jifeiCallbackBody(`"999999999999"`))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "fallback") {
		t.Fatalf("未登记 uin 应走兜底，实际 %d %s", rec.Code, rec.Body.String())
	}
	if hits.fallback != 1 || hits.devA != 0 || hits.devB != 0 {
		t.Fatalf("命中次数不对: fallback=%d devA=%d devB=%d", hits.fallback, hits.devA, hits.devB)
	}
}

// TestUinRouteAcceptsNumericUin jifei 实测偶有把 uin 发成数字的情况，两种都要认。
func TestUinRouteAcceptsNumericUin(t *testing.T) {
	hits, _, _, _ := newUinRouteRouter(t)

	rec := postCallback(t, hits.router, jifeiCallbackBody(`700000164995`))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "dev-a") {
		t.Fatalf("数字型 uin 应同样命中 dev-a，实际 %d %s", rec.Code, rec.Body.String())
	}
}

// TestUinRouteRejectsMissingTarget 改派目标不存在时必须报错，绝不能静默回落到兜底环境。
//
// 回归背景：2026-08-05 一条个人环境的订单回调落到 sandbox-bj-7 并在那里凭空发货，
// 静默回落会重演同类跨环境污染，所以这里宁可 404 让计费重试并暴露配置错误。
func TestUinRouteRejectsMissingTarget(t *testing.T) {
	hits, _, _, _ := newUinRouteRouter(t)

	rec := postCallback(t, hits.router, jifeiCallbackBody(`"700000164997"`))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("改派目标缺失应返 404，实际 %d %s", rec.Code, rec.Body.String())
	}
	if hits.fallback != 0 {
		t.Fatalf("绝不能回落到兜底环境，fallback=%d", hits.fallback)
	}
}

// TestUinRouteIgnoresNonJSONBody body 不是 JSON 时退化到兜底，不能 500。
func TestUinRouteIgnoresNonJSONBody(t *testing.T) {
	hits, _, _, _ := newUinRouteRouter(t)

	rec := postCallback(t, hits.router, "not-json")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "fallback") {
		t.Fatalf("非 JSON body 应走兜底，实际 %d %s", rec.Code, rec.Body.String())
	}
}
