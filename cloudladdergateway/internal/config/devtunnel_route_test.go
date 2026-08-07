package config

import (
	"testing"
)

// TestDevtunnelRouteDefaultsToBlackhole 锁定 devtunnel route 的默认安全形态。
//
// 为什么要有这条：devtunnel route 是给开发者个人环境的反向隧道控制面用的，
// 在生产 / 预发布实例上必须等于「不存在」。默认 base_url 是黑洞（127.0.0.1:9），
// 只有显式配了 _BASE_URL 覆盖的实例才真正启用。
func TestDevtunnelRouteDefaultsToBlackhole(t *testing.T) {
	t.Setenv("CLOUDLADDER_PAYMENT_HMAC_SECRET", "test-secret")
	cfg, err := Load("../../config.example.yaml")
	if err != nil {
		t.Fatalf("load example config: %v", err)
	}
	route, ok := findRoute(cfg, "devtunnel")
	if !ok {
		t.Fatalf("devtunnel route not found in example config")
	}
	if route.Upstream.BaseURL != "http://127.0.0.1:9" {
		t.Errorf("devtunnel base_url = %q, 期望黑洞占位 http://127.0.0.1:9（默认必须等于禁用）",
			route.Upstream.BaseURL)
	}
	if host := route.Upstream.Headers["Host"]; host != "" {
		t.Errorf("devtunnel 默认不应带 Host 改写，got %q", host)
	}
}

// TestDevtunnelRouteEnvOverride 验证 devtunnel route 可以整条被 env 覆盖到真实服务，
// 这是「加开发者不重建镜像」的前提。
func TestDevtunnelRouteEnvOverride(t *testing.T) {
	t.Setenv("CLOUDLADDER_PAYMENT_HMAC_SECRET", "test-secret")
	t.Setenv("CLOUDLADDERGATEWAY_ROUTE_DEVTUNNEL_BASE_URL", "http://devtunnel-testing:8080")
	cfg, err := Load("../../config.example.yaml")
	if err != nil {
		t.Fatalf("load example config: %v", err)
	}
	route, ok := findRoute(cfg, "devtunnel")
	if !ok {
		t.Fatalf("devtunnel route not found")
	}
	if route.Upstream.BaseURL != "http://devtunnel-testing:8080" {
		t.Errorf("base_url override 未生效: %q", route.Upstream.BaseURL)
	}
}

// TestJifeiCallbackDevRouteHostOverride 验证 dev 落点可以同时被 _BASE_URL 和
// _HOST_HEADER 覆盖 —— 这是 host 分流形态的关键：多个 dev 落点共享同一个 devtunnel
// 服务地址，靠各自不同的 Host 让 devtunnel 分到对应开发者的 agent。
func TestJifeiCallbackDevRouteHostOverride(t *testing.T) {
	t.Setenv("CLOUDLADDER_PAYMENT_HMAC_SECRET", "test-secret")
	t.Setenv("CLOUDLADDERGATEWAY_ROUTE_JIFEI_CALLBACK_DEV_1_BASE_URL", "http://devtunnel-testing:8080")
	t.Setenv("CLOUDLADDERGATEWAY_ROUTE_JIFEI_CALLBACK_DEV_1_HOST_HEADER", "dev1.tunnel.internal")
	t.Setenv("CLOUDLADDERGATEWAY_ROUTE_JIFEI_CALLBACK_DEV_2_BASE_URL", "http://devtunnel-testing:8080")
	t.Setenv("CLOUDLADDERGATEWAY_ROUTE_JIFEI_CALLBACK_DEV_2_HOST_HEADER", "dev2.tunnel.internal")
	cfg, err := Load("../../config.example.yaml")
	if err != nil {
		t.Fatalf("load example config: %v", err)
	}

	for _, tc := range []struct{ routeID, wantHost string }{
		{"jifei-callback-dev-1", "dev1.tunnel.internal"},
		{"jifei-callback-dev-2", "dev2.tunnel.internal"},
	} {
		route, ok := findRoute(cfg, tc.routeID)
		if !ok {
			t.Fatalf("%s not found", tc.routeID)
		}
		if route.Upstream.BaseURL != "http://devtunnel-testing:8080" {
			t.Errorf("%s base_url = %q", tc.routeID, route.Upstream.BaseURL)
		}
		if got := route.Upstream.Headers["Host"]; got != tc.wantHost {
			t.Errorf("%s Host = %q want %q（host 分流靠这个区分开发者）", tc.routeID, got, tc.wantHost)
		}
	}

	// 未覆盖的 dev-3 必须仍是黑洞，且不带 Host。
	route, ok := findRoute(cfg, "jifei-callback-dev-3")
	if !ok {
		t.Fatalf("jifei-callback-dev-3 not found")
	}
	if route.Upstream.BaseURL != "http://127.0.0.1:9" {
		t.Errorf("未覆盖的 dev-3 应保持黑洞, got %q", route.Upstream.BaseURL)
	}
	if got := route.Upstream.Headers["Host"]; got != "" {
		t.Errorf("未覆盖的 dev-3 不应带 Host, got %q", got)
	}
}

func findRoute(cfg Config, id string) (RouteConfig, bool) {
	for _, r := range cfg.Routes {
		if r.ID == id {
			return r, true
		}
	}
	return RouteConfig{}, false
}
