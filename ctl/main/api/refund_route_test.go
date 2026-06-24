package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// === trade-pass-refund 设计稿落地（POST /admin/api/ctl/passes/{pass_id}/refund 路由测试）===
// 设计稿：.tmp/trade-pass-refund-design.md v0.5 §3.3 + §11 拍板项（Q1=a 仅 admin 路径）
//
// 与 destroy_route_test.go 对偶（同款"路由分发 + 方法校验"覆盖范围）：
//   - 路径分发命中（避免与 /v1 用户面路径冲突）
//   - Method != POST → 405
//   - 路径段不完整 → 404
//   - 未知 action 与 /delete 同分发表 → 404
//
// 真实业务分支（passID 校验 / pass 不存在 / status 预判 / trade 调用错误码）
// 留 sandbox-bj-7 集成测试覆盖。

// TestAdminRefundPass_RouteRejectsNonPost 验证 admin refund 路由仅接受 POST。
//
// 设计稿 v0.5 §3.3：POST /admin/api/ctl/passes/{pass_id}/refund 是唯一允许方法；
// GET / PUT / DELETE 都应返 405 Method Not Allowed。
func TestAdminRefundPass_RouteRejectsNonPost(t *testing.T) {
	router := newRouter(&instanceHandler{logic: &stubLogic{}}, &bundleHandler{}, &passHandler{})

	cases := []struct {
		name   string
		method string
	}{
		{"GET", http.MethodGet},
		{"PUT", http.MethodPut},
		{"DELETE", http.MethodDelete},
		{"PATCH", http.MethodPatch},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(tc.method,
				"/admin/api/ctl/passes/lhpass-r1/refund", nil)
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)
			if rec.Code != http.StatusMethodNotAllowed {
				t.Fatalf("method %s: got %d want 405; body=%s",
					tc.method, rec.Code, rec.Body.String())
			}
			// 校验 Allow header 提示客户端正确 method（与 adminDeletePass 同款 handler 约定）
			if allow := rec.Header().Get("Allow"); allow != http.MethodPost {
				t.Errorf("Allow header: got %q want POST", allow)
			}
		})
	}
}

// TestAdminRefundPass_RouteUnknownAction 验证 /admin/api/ctl/passes/{pass_id}/{unknown} 返 404。
//
// 证明 handleAdminPassesByID 的 2 段路径分发表只识别 delete / refund 两个 action，
// 其它任何 verb 一律走 errcode.ErrNotFound。
func TestAdminRefundPass_RouteUnknownAction(t *testing.T) {
	router := newRouter(&instanceHandler{logic: &stubLogic{}}, &bundleHandler{}, &passHandler{})

	cases := []struct {
		name string
		path string
	}{
		{"unknown_2_segment_verb", "/admin/api/ctl/passes/lhpass-r1/teleport"},
		{"random_2_segment_verb", "/admin/api/ctl/passes/lhpass-r1/foobar"},
		{"close_typo_for_refund", "/admin/api/ctl/passes/lhpass-r1/refunds"},
		{"missing_action_segment", "/admin/api/ctl/passes/lhpass-r1"},
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

// TestAdminRefundPass_RouteUserFacingNotMounted 验证 refund 接口**不暴露用户面路径**（v0.5 Q1=a 拍板）。
//
// /v1/passes/{pass_id}/refund 应返 404（路由未挂载），避免用户面通过对偶推断访问退款功能。
func TestAdminRefundPass_RouteUserFacingNotMounted(t *testing.T) {
	router := newRouter(&instanceHandler{logic: &stubLogic{}}, &bundleHandler{}, &passHandler{})

	req := httptest.NewRequest(http.MethodPost,
		"/v1/passes/lhpass-r1/refund", nil)
	// 模拟用户面鉴权 header（如果路由真有挂载，鉴权会过）
	req.Header.Set("X-User-Id", "usr_test")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("/v1/passes/{passID}/refund must NOT be mounted (Q1=a admin-only); got %d body=%s",
			rec.Code, rec.Body.String())
	}
}

// TestAdminRefundPass_NormalizePath 验证 normalizePath 把动态 pass_id 段归一到 {passId}
// 静态白名单，避免 prometheus 高基数标签污染（与 /delete 同款收敛）。
func TestAdminRefundPass_NormalizePath(t *testing.T) {
	cases := []struct {
		name string
		path string
		want string
	}{
		{
			name: "ascii_pass_id",
			path: "/admin/api/ctl/passes/lhpass-abc123/refund",
			want: "/admin/api/ctl/passes/{passId}/refund",
		},
		{
			name: "uuid_pass_id",
			path: "/admin/api/ctl/passes/550e8400-e29b-41d4-a716-446655440000/refund",
			want: "/admin/api/ctl/passes/{passId}/refund",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := normalizePath(tc.path); got != tc.want {
				t.Fatalf("normalizePath(%q) = %q, want %q", tc.path, got, tc.want)
			}
		})
	}
}

// TestAdminRefundPass_InvalidJSONBody 验证 body 含非法 JSON → 400 PASS_INVALID_PARAM。
//
// Q4=a 拍板：body 可选 operator_uin / reason；ContentLength > 0 时必须 decode 成功。
// 与 adminDeletePass body decode 错误处理同款。
func TestAdminRefundPass_InvalidJSONBody(t *testing.T) {
	router := newRouter(&instanceHandler{logic: &stubLogic{}}, &bundleHandler{}, &passHandler{})

	req := httptest.NewRequest(http.MethodPost,
		"/admin/api/ctl/passes/lhpass-r1/refund",
		strings.NewReader("{ this is not valid json"))
	req.Header.Set("Content-Type", "application/json")

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("invalid JSON body: got %d want 400; body=%s", rec.Code, rec.Body.String())
	}
}
