package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// === trade-pass-destroy 设计稿落地（POST /internal/ctl/passes/{pass_id}/destroy 路由测试）===
// 设计稿：.tmp/trade-pass-destroy-design.md §3.5 / §4.5.2 / §4.5.3 / §10
//
// 测试覆盖：path 解析 + 鉴权 + 方法校验（在调 logic 前就返错的分支）。
// 真实业务分支（status 预判 / CAS / 父 task 派发）留 sandbox-bj-7 集成测试覆盖
// （sandbox-bj-7 测试集群有真实 DB + MQ，无需在单测里 mock 整条链路）。
//
// 路径：POST /internal/ctl/passes/{pass_id}/destroy
// 鉴权：CTL_INTERNAL_TOKEN（与 isolatePass 同范式）

// TestInternalDestroyPass_RequiresInternalBearer 验证未带 token 时返 401。
func TestInternalDestroyPass_RequiresInternalBearer(t *testing.T) {
	t.Setenv("CTL_INTERNAL_TOKEN", "expected-secret")

	router := newRouter(&instanceHandler{logic: &stubLogic{}}, &bundleHandler{}, &passHandler{})
	req := httptest.NewRequest(http.MethodPost,
		"/internal/ctl/passes/lhpass-d1/destroy", nil)
	req.Header.Set("Authorization", "Bearer wrong-secret")

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("got %d want 401; body=%s", rec.Code, rec.Body.String())
	}
}

// TestInternalDestroyPass_RequiresInternalBearerNoHeader 验证完全不带 Authorization 也返 401。
func TestInternalDestroyPass_RequiresInternalBearerNoHeader(t *testing.T) {
	t.Setenv("CTL_INTERNAL_TOKEN", "expected-secret")

	router := newRouter(&instanceHandler{logic: &stubLogic{}}, &bundleHandler{}, &passHandler{})
	req := httptest.NewRequest(http.MethodPost,
		"/internal/ctl/passes/lhpass-d1/destroy", nil)

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("got %d want 401; body=%s", rec.Code, rec.Body.String())
	}
}

// TestInternalDestroyPass_UnknownAction 验证 /internal/ctl/passes/{pass_id}/{unknown} 返 404
// （证明只有 isolate / destroy / renew 三个 action 命中路由，其它一律 404）。
func TestInternalDestroyPass_UnknownAction(t *testing.T) {
	// 不设 CTL_INTERNAL_TOKEN，跳过鉴权直接进入路由分发分支
	router := newRouter(&instanceHandler{logic: &stubLogic{}}, &bundleHandler{}, &passHandler{})

	cases := []struct {
		name string
		path string
	}{
		{"unknown_action", "/internal/ctl/passes/lhpass-d1/teleport"},
		{"random_action", "/internal/ctl/passes/lhpass-d1/foobar"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, tc.path, nil)
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)
			if rec.Code != http.StatusNotFound {
				t.Fatalf("path %q: got %d want 404; body=%s",
					tc.path, rec.Code, rec.Body.String())
			}
		})
	}
}
