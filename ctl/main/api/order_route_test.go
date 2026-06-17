package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// === ctl-order-status-query 设计稿落地（GET /v1/orders/{dealName}/status 路由测试）===
// 设计稿：.tmp/ctl-order-status-query-design.md §5.5 + Q-OS-1 / Q-OS-3 / Q-OS-7 / Q-OS-8
//
// 测试覆盖：path 解析 + 鉴权 + 方法校验（在调 logic 前就返错的分支）。
// 真实业务分支（trade adapter 调用 / B7 降级 / B4 越权）留 trade 内部单测 +
// sandbox-bj-7 集成测试覆盖（已分别在 trade C3 / C4 切片中测过）。
//
// 路径：GET /v1/orders/{dealName}/status
// 鉴权：X-User-Id（前端鉴权 header）

// TestUserOrderStatus_RequiresUserHeader 验证缺 X-User-Id 时返 401。
func TestUserOrderStatus_RequiresUserHeader(t *testing.T) {
	router := newRouter(&instanceHandler{logic: &stubLogic{}}, &bundleHandler{}, &passHandler{})
	req := httptest.NewRequest(http.MethodGet,
		"/v1/orders/deal-test-001/status", nil)
	// 故意不设 X-User-Id

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("got %d want 401; body=%s", rec.Code, rec.Body.String())
	}
}

// TestUserOrderStatus_MethodNotAllowed 验证非 GET 方法返 405。
//
// Q-OS-3 拍板：本接口只允许 GET（前端轮询 + 浏览器缓存友好 + 没有副作用）。
func TestUserOrderStatus_MethodNotAllowed(t *testing.T) {
	router := newRouter(&instanceHandler{logic: &stubLogic{}}, &bundleHandler{}, &passHandler{})
	cases := []string{
		http.MethodPost,
		http.MethodPut,
		http.MethodDelete,
		http.MethodPatch,
	}
	for _, method := range cases {
		t.Run(method, func(t *testing.T) {
			req := httptest.NewRequest(method, "/v1/orders/deal-test-001/status", nil)
			req.Header.Set("X-User-Id", "u-test-1")
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)
			if rec.Code != http.StatusMethodNotAllowed {
				t.Fatalf("method %q: got %d want 405; body=%s",
					method, rec.Code, rec.Body.String())
			}
		})
	}
}

// TestUserOrderStatus_UnknownSubpath 验证 /v1/orders/{...}/{unknown} 返 404
//
// Q-OS-7 拍板：本期只支持 single-order /status 子路径，其它任何子路径都应 404
// （为后续可能扩展批量查询、订单详情查询保留路径空间）。
func TestUserOrderStatus_UnknownSubpath(t *testing.T) {
	router := newRouter(&instanceHandler{logic: &stubLogic{}}, &bundleHandler{}, &passHandler{})
	cases := []struct {
		name string
		path string
	}{
		{"naked_v1_orders", "/v1/orders/"},
		{"orders_no_action", "/v1/orders/deal-test-001"},
		{"unknown_action", "/v1/orders/deal-test-001/teleport"},
		{"too_many_segments", "/v1/orders/deal-test-001/status/extra"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, tc.path, nil)
			req.Header.Set("X-User-Id", "u-test-1")
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)
			if rec.Code != http.StatusNotFound {
				t.Fatalf("path %q: got %d want 404; body=%s",
					tc.path, rec.Code, rec.Body.String())
			}
		})
	}
}
