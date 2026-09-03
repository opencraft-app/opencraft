package config

import (
	"net/http"
	"testing"

	"github.com/openclaw/openclaw/mono/cloudladdergateway/internal/rules"
)

// TestExampleConfigRouteConditionsCompile 兜住「condition 语法写错」这一整类事故。
//
// condition 是 Starlark，只在**请求匹配时**才求值，所以写错不会让进程起不来，也不会
// 被配置校验拦住 —— 表现是这条 route 永远匹配不上（线上看到的是 404 / 走了兜底）。
// 曾经真的把布尔或写成 `||`（Starlark 要 `or`），devtunnel 控制面因此整条不可用。
// 这里对每条 route 的 condition 都跑一次求值，只断言「能编译、不报错」。
func TestExampleConfigRouteConditionsCompile(t *testing.T) {
	t.Setenv("CLOUDLADDER_PAYMENT_HMAC_SECRET", "test-secret")
	cfg, err := Load("../../config.example.yaml")
	if err != nil {
		t.Fatalf("load example config: %v", err)
	}
	if len(cfg.Routes) == 0 {
		t.Fatalf("example config 里一条 route 都没有，测试失去意义")
	}

	// 覆盖常见方法，避免某条 condition 只在特定方法下才走到出错的分支。
	for _, method := range []string{http.MethodGet, http.MethodPost} {
		for _, route := range cfg.Routes {
			if route.Condition == "" {
				continue
			}
			req := rules.Request{
				RouteID: route.ID,
				Caller:  "jifei",
				Method:  method,
				Path:    "/trade/jifei/callback",
				Headers: http.Header{},
			}
			if _, err := rules.Eval(route.Condition, req, nil); err != nil {
				t.Errorf("route %q condition 求值失败(method=%s): %v\ncondition: %s",
					route.ID, method, err, route.Condition)
			}
		}
	}
}
