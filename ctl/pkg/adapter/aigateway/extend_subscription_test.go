// 本文件覆盖 ctl 端 AiGatewayAdapter.ExtendSubscription 的 404 解码精细化（2026-05-24）。
//
// 设计意图：
//   - 旧实现把所有 404 都返回 ErrAiGatewayPlanNotFound，含 ai-gateway 镜像滞后导致
//     的路由 404，会被 caller 误降级为"用户没订阅，跳过"，背面遮蔽部署事故。
//   - 新实现引入 isAiGatewayBusinessErrorBody 严格判别 OpenAI 风格 error.{code,message}
//     JSON：业务 404 → ErrAiGatewayPlanNotFound；路由 404 → ErrAiGatewayRouteNotFound。
package aigateway

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"ctl/pkg/config"
)

// TestExtendSubscription_BusinessNotFound 验证：ai-gateway 返回 OpenAI 风格 404 JSON 时
// 解码为 ErrAiGatewayPlanNotFound（caller 可选择降级 nil）。
func TestExtendSubscription_BusinessNotFound(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/internal/subscriptions/extend" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"error": map[string]string{
				"message": "active subscription not found",
				"type":    "not_found_error",
				"code":    "subscription_not_found",
			},
		})
	}))
	defer server.Close()

	adapter := NewAiGatewayAdapter(&config.AiGatewayConfig{
		BaseURL:              server.URL,
		InternalServiceToken: "internal-token",
		Timeout:              5,
	}, nil)

	_, err := adapter.ExtendSubscription(context.Background(), &ExtendSubscriptionRequest{
		UserID:       "usr_no_sub",
		NewPeriodEnd: time.Date(2026, 7, 23, 0, 0, 0, 0, time.UTC),
	})
	if !errors.Is(err, ErrAiGatewayPlanNotFound) {
		t.Fatalf("expected ErrAiGatewayPlanNotFound for business 404, got %v", err)
	}
}

// TestExtendSubscription_RouteNotFound 验证：gin 默认路由 404 plaintext 响应
// （ai-gateway 镜像未含 R-MR-4 路由的情况）解码为 ErrAiGatewayRouteNotFound，
// 而不是被错误吞为 ErrAiGatewayPlanNotFound。
func TestExtendSubscription_RouteNotFound(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 模拟 gin 默认 NoRoute 行为：返 404 + 纯文本 body
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte("404 page not found\n"))
	}))
	defer server.Close()

	adapter := NewAiGatewayAdapter(&config.AiGatewayConfig{
		BaseURL:              server.URL,
		InternalServiceToken: "internal-token",
		Timeout:              5,
	}, nil)

	_, err := adapter.ExtendSubscription(context.Background(), &ExtendSubscriptionRequest{
		UserID:       "usr_test",
		NewPeriodEnd: time.Date(2026, 7, 23, 0, 0, 0, 0, time.UTC),
	})
	if !errors.Is(err, ErrAiGatewayRouteNotFound) {
		t.Fatalf("expected ErrAiGatewayRouteNotFound for plaintext route 404, got %v", err)
	}
	if errors.Is(err, ErrAiGatewayPlanNotFound) {
		t.Fatalf("route 404 must NOT be misclassified as ErrAiGatewayPlanNotFound, got %v", err)
	}
}

// TestExtendSubscription_RouteNotFound_EmptyBody 验证：404 + 空 body 也归入路由 404
// （某些反向代理可能返空 body，不应被误吞为业务 404）。
func TestExtendSubscription_RouteNotFound_EmptyBody(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()

	adapter := NewAiGatewayAdapter(&config.AiGatewayConfig{
		BaseURL:              server.URL,
		InternalServiceToken: "internal-token",
		Timeout:              5,
	}, nil)

	_, err := adapter.ExtendSubscription(context.Background(), &ExtendSubscriptionRequest{
		UserID:       "usr_test",
		NewPeriodEnd: time.Date(2026, 7, 23, 0, 0, 0, 0, time.UTC),
	})
	if !errors.Is(err, ErrAiGatewayRouteNotFound) {
		t.Fatalf("expected ErrAiGatewayRouteNotFound for empty 404 body, got %v", err)
	}
}

// TestExtendSubscription_Success 验证：200 OK + apiResponse 包装的成功响应正确解码。
func TestExtendSubscription_Success(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(apiResponse{
			Code:    0,
			Message: "ok",
			Data: mustRawJSON(t, ExtendSubscriptionResponse{
				Subscription: &Subscription{
					UserID:    "usr_test",
					Status:    "active",
					PeriodEnd: "2026-07-23T00:00:00Z",
				},
				Updated: true,
			}),
		})
	}))
	defer server.Close()

	adapter := NewAiGatewayAdapter(&config.AiGatewayConfig{
		BaseURL:              server.URL,
		InternalServiceToken: "internal-token",
		Timeout:              5,
	}, nil)

	got, err := adapter.ExtendSubscription(context.Background(), &ExtendSubscriptionRequest{
		UserID:       "usr_test",
		NewPeriodEnd: time.Date(2026, 7, 23, 0, 0, 0, 0, time.UTC),
	})
	if err != nil {
		t.Fatalf("expected nil err, got %v", err)
	}
	if got == nil || !got.Updated {
		t.Fatalf("expected updated=true, got %+v", got)
	}
}

// TestIsAiGatewayBusinessErrorBody 直接验证判别函数：缺 code 或 message 都不算业务错误。
func TestIsAiGatewayBusinessErrorBody(t *testing.T) {
	cases := []struct {
		name string
		body string
		want bool
	}{
		{
			name: "openai_error_with_code_and_message",
			body: `{"error":{"code":"x","message":"y","type":"z"}}`,
			want: true,
		},
		{
			name: "missing_code",
			body: `{"error":{"message":"y","type":"z"}}`,
			want: false,
		},
		{
			name: "missing_message",
			body: `{"error":{"code":"x","type":"z"}}`,
			want: false,
		},
		{
			name: "plaintext_route_404",
			body: "404 page not found\n",
			want: false,
		},
		{
			name: "empty_body",
			body: "",
			want: false,
		},
		{
			name: "empty_json_obj",
			body: "{}",
			want: false,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := isAiGatewayBusinessErrorBody([]byte(c.body))
			if got != c.want {
				t.Fatalf("isAiGatewayBusinessErrorBody(%q) = %v, want %v", c.body, got, c.want)
			}
		})
	}
}
