package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// === trade-pass-renew 设计稿落地（POST /internal/ctl/passes/{pass_id}/renew 路由测试）===
// 设计稿：.tmp/trade-pass-renew-design.md §3.1 / §4.7 / §5.5 / R-D-2
//
// 测试覆盖：path 解析 + 鉴权 + 方法校验（在调 logic 前就返错的分支）。
// 真实业务分支（status 预判 / CAS / 父 task 派发 / 同步异步双分支）留 sandbox-bj-7
// 集成测试 + ctl/pkg/logic/pass/renew_test.go 覆盖（前者真实 DB + MQ；后者 logic 单元）。
//
// 路径：POST /internal/ctl/passes/{pass_id}/renew
// 鉴权：CTL_INTERNAL_TOKEN（与 isolatePass / destroyPass 同范式）

// TestInternalRenewPass_RequiresInternalBearer 验证带错误 token 时返 401。
func TestInternalRenewPass_RequiresInternalBearer(t *testing.T) {
	t.Setenv("CTL_INTERNAL_TOKEN", "expected-secret")

	router := newRouter(&instanceHandler{logic: &stubLogic{}}, &bundleHandler{}, &passHandler{})
	req := httptest.NewRequest(http.MethodPost,
		"/internal/ctl/passes/lhpass-r1/renew", nil)
	req.Header.Set("Authorization", "Bearer wrong-secret")

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("got %d want 401; body=%s", rec.Code, rec.Body.String())
	}
}

// TestInternalRenewPass_RequiresInternalBearerNoHeader 验证完全不带 Authorization 也返 401。
func TestInternalRenewPass_RequiresInternalBearerNoHeader(t *testing.T) {
	t.Setenv("CTL_INTERNAL_TOKEN", "expected-secret")

	router := newRouter(&instanceHandler{logic: &stubLogic{}}, &bundleHandler{}, &passHandler{})
	req := httptest.NewRequest(http.MethodPost,
		"/internal/ctl/passes/lhpass-r1/renew", nil)

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("got %d want 401; body=%s", rec.Code, rec.Body.String())
	}
}

// TestInternalRenewPass_MethodNotAllowed 验证非 POST 方法返 405。
func TestInternalRenewPass_MethodNotAllowed(t *testing.T) {
	// 不设 CTL_INTERNAL_TOKEN，跳过鉴权直接进入路由分发分支
	router := newRouter(&instanceHandler{logic: &stubLogic{}}, &bundleHandler{}, &passHandler{})

	for _, method := range []string{http.MethodGet, http.MethodPut, http.MethodDelete} {
		t.Run(method, func(t *testing.T) {
			req := httptest.NewRequest(method,
				"/internal/ctl/passes/lhpass-r1/renew", nil)
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)
			if rec.Code != http.StatusMethodNotAllowed {
				t.Fatalf("method %s: got %d want 405; body=%s",
					method, rec.Code, rec.Body.String())
			}
		})
	}
}

// TestInternalRenewPass_SinglePathSegmentNotFound 验证单段路径
// /internal/ctl/passes/renew 仍返 404（设计稿 §4.7 / §5.5 v3.9 校准：
// renew 已对齐 isolate/destroy 走双段 `/internal/ctl/passes/{pass_id}/{action}`，
// 单段路径不是合法入口）。
func TestInternalRenewPass_SinglePathSegmentNotFound(t *testing.T) {
	router := newRouter(&instanceHandler{logic: &stubLogic{}}, &bundleHandler{}, &passHandler{})

	req := httptest.NewRequest(http.MethodPost,
		"/internal/ctl/passes/renew",
		strings.NewReader(`{"time_span":1,"time_unit":"m"}`))
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("got %d want 404; body=%s", rec.Code, rec.Body.String())
	}
}

// TestInternalRenewPass_RouteDispatchedToHandler 验证双段路径 /internal/ctl/passes/{pass_id}/renew
// 命中 renewPass handler（即 *不* 返 404 unknown action）。
//
// 因为 &passHandler{}.logic 为 nil，命中 handler 后调 h.logic.RenewPass 会 panic / nil deref，
// 真实业务分支留 sandbox-bj-7 集成测试覆盖；本单元测试只验证：
//   - 不返 404（如 destroy_route_test.go 中 "renew_action_not_yet_landed" 旧断言）
//   - 进入 handler 后路径分发正确
//
// 因此这里通过 GET（method not allowed → 405）来证明命中了 renewPass handler 的 method 校验，
// 而不是被 handleInternalPasses 返 404 unknown action。
func TestInternalRenewPass_RouteDispatchedToHandler(t *testing.T) {
	router := newRouter(&instanceHandler{logic: &stubLogic{}}, &bundleHandler{}, &passHandler{})

	req := httptest.NewRequest(http.MethodGet,
		"/internal/ctl/passes/lhpass-r1/renew", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	// 期望命中 renewPass handler 的 method 校验返 405；如果是 handleInternalPasses
	// 的 default 分支返 404，则证明路由没注册。
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405 from renewPass method check (proves route dispatched), got %d; body=%s",
			rec.Code, rec.Body.String())
	}
}
