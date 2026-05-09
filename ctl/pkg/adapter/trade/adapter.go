// Package trade 提供 trade 服务的 HTTP 适配器，用于 ctl 反向调用 trade 内部 RPC。
//
// 端点对接（与 trade.internal/httpapi/internalapi/handler.go 保持一致）：
//
//   - POST /internal/trade/orders                        下单（PlaceOrder）
//   - POST /internal/trade/orders/place-and-pay         下单 + 支付一体化（PlaceOrderAndPay，迭代 8B-1.5）
//   - POST /internal/trade/orders/{dealName}/pay-url     生成 / 反查支付页 URL（GeneratePayURL）
//
// 鉴权：HTTP header `Authorization: Bearer <Token>`，Token 与 trade 配置的
// `LIGHTCLAW_INTERNAL_SERVICE_TOKEN` 保持一致；ctl ↔ shadow ↔ ai-gateway
// 共用同一密钥源（见 trade/internal/httpapi/internalapi/handler.go authMiddleware）。
//
// 错误码语义（HTTP status → 错误分类）：
//
//   - 200 OK                       成功
//   - 400 Bad Request              入参非法（trade 侧 InvalidRequest）
//   - 401 Unauthorized             token 错误 / 缺失
//   - 404 Not Found                bundle 不存在 / trade_order 不存在
//   - 409 Conflict                 bundle 已下架 / dealName 唯一约束冲突
//   - 422 Unprocessable Entity     externalUserId 在 shadow 没有绑定记录
//   - 502 Bad Gateway              jifei 上游响应非法 / 其它基础设施错
//   - 503 Service Unavailable      （历史）pay url 不可用 — 8B-1.5 起 trade 改返 mock URL，
//     本错误码理论不再出现，仍保留分支兼容
package trade

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"go.uber.org/zap"
)

// PlaceOrderRequest 与 trade /internal/trade/orders 入参 placeOrderRequest 字段集对齐。
//
// 字段命名遵循 trade 业务层 camelCase 风格（详见 trade-purchase-flow-design.md §4.2.1）。
//
// Uin / AppID 字段：可由调用方显式传，也可留空让 trade 反查 shadow 自动回填（trade
// 启动期需注入 ShadowClient 才生效；当前 trade 配置已默认注入）。
type PlaceOrderRequest struct {
	ExternalUserID string `json:"externalUserId"`
	Uin            string `json:"uin,omitempty"`
	AppID          string `json:"appId,omitempty"`
	BundleID       string `json:"bundleId"`
	Period         int    `json:"period"`
	TimeUnit       string `json:"timeUnit"`
	GoodsNum       int    `json:"goodsNum"`
	PayMode        int    `json:"payMode"`
	RegionID       int    `json:"regionId"`
}

// PlaceOrderResult 与 trade placeOrderResponse 字段集对齐。
//
// PayURL / ExpireAt 在 trade 单步 PlaceOrder（非 PlaceOrderAndPay）流程中始终为空，
// 由调用方再走 GeneratePayURL 拉取支付 URL。
type PlaceOrderResult struct {
	DealName   string `json:"dealName"`
	BigOrderID string `json:"bigOrderId"`
	PayURL     string `json:"payUrl,omitempty"`
	ExpireAt   string `json:"expireAt,omitempty"`
}

// PayURLResult 与 trade payURLResponse 字段集对齐。
type PayURLResult struct {
	PayURL   string `json:"payUrl"`
	ExpireAt string `json:"expireAt,omitempty"`
}

// Adapter trade 服务适配器接口。
type Adapter interface {
	// PlaceOrder 调 trade POST /internal/trade/orders 创建一笔 jifei 订单。
	PlaceOrder(ctx context.Context, req *PlaceOrderRequest) (*PlaceOrderResult, error)

	// PlaceOrderAndPay 调 trade POST /internal/trade/orders/place-and-pay
	// 一体化创建订单 + 自动支付（迭代 8B-1.5 测试链路用）。
	//
	// 与 PlaceOrder 的差异（详见 trade-purchase-flow-design.md §4.2.x）：
	//   - PlaceOrder：仅创建 jifei 订单，落库 status='pending_pay'，调用方再走
	//     GeneratePayURL 拿支付 URL 引导用户在浏览器付款；jifei 异步收款回调后
	//     才推进 trade_order 到 'provisioned'。
	//   - PlaceOrderAndPay：调 jifei `qcloud.Deal.generateDealsAndPay` 一体化接口，
	//     **一次调用** 完成"创建订单 + 同步支付 + 触发 checkCreate / createResource
	//     回调"，跳过支付 URL；落库 status='paid_pending_provision'。
	//
	// 主要使用场景：
	//   - 联调测试 / 自动化 e2e：测试代金券充足的环境跑通 trade ↔ jifei ↔
	//     ctl.createResource 端到端链路，免人工浏览器付款
	//   - 降配场景：jifei 协议规范要求降配必须用本接口（本期未涉及）
	//
	// 出参 PayURL/ExpireAt 永远为空（一体化接口跳过支付 URL 概念），调用方应仅
	// 关心 DealName / BigOrderID。
	PlaceOrderAndPay(ctx context.Context, req *PlaceOrderRequest) (*PlaceOrderResult, error)

	// GeneratePayURL 调 trade POST /internal/trade/orders/{dealName}/pay-url
	// 生成 / 反查支付页 URL。
	//
	// 8B-1.5 行为约束：trade 侧 trade_order.pay_url 缓存未命中时返 **mock URL**
	// （不再返 503 ErrPayURLUnavailable），保持调用方契约不变。
	GeneratePayURL(ctx context.Context, dealName string) (*PayURLResult, error)
}

// Config trade 适配器配置（与 ShadowConfig / AiGatewayConfig 风格一致）。
type Config struct {
	BaseURL string `toml:"base_url"` // trade 服务内部地址，如 http://trade.lightclaw.svc.cluster.local
	Token   string `toml:"token"`    // Bearer Token，与 trade LIGHTCLAW_INTERNAL_SERVICE_TOKEN 一致
	Timeout int    `toml:"timeout"`  // 请求超时（秒），默认 10
}

type adapter struct {
	config *Config
	client *http.Client
	logger *zap.Logger
}

// NewTradeAdapter 创建 trade 适配器。
func NewTradeAdapter(cfg *Config, logger *zap.Logger) Adapter {
	if cfg == nil {
		cfg = &Config{}
	}
	timeout := time.Duration(cfg.Timeout) * time.Second
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	return &adapter{
		config: cfg,
		client: &http.Client{Timeout: timeout},
		logger: logger,
	}
}

// errorResponse 与 trade internalapi handler 错误响应（gin.H{code, message}）对齐。
type errorResponse struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Error 是 trade 上游业务错误的封装，调用方可 errors.As 拿到 Code / Status 做分类降级。
type Error struct {
	Status     int    // HTTP 状态码
	Code       string // trade 返回的业务错误码（如 BundleNotFound / BindingNotFound）
	Message    string // trade 返回的错误消息
	Endpoint   string // 调用的端点路径（用于日志）
}

// Error 实现 error 接口。
func (e *Error) Error() string {
	if e == nil {
		return ""
	}
	return fmt.Sprintf("trade adapter: %s -> %d %s: %s",
		e.Endpoint, e.Status, e.Code, e.Message)
}

func (a *adapter) PlaceOrder(ctx context.Context, req *PlaceOrderRequest) (*PlaceOrderResult, error) {
	if a.config.BaseURL == "" {
		return nil, fmt.Errorf("trade adapter: base_url not configured")
	}
	if req == nil {
		return nil, fmt.Errorf("trade adapter: PlaceOrder request is nil")
	}

	endpoint := strings.TrimRight(a.config.BaseURL, "/") + "/internal/trade/orders"
	var result PlaceOrderResult
	if err := a.doJSON(ctx, http.MethodPost, endpoint, req, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

func (a *adapter) PlaceOrderAndPay(ctx context.Context, req *PlaceOrderRequest) (*PlaceOrderResult, error) {
	if a.config.BaseURL == "" {
		return nil, fmt.Errorf("trade adapter: base_url not configured")
	}
	if req == nil {
		return nil, fmt.Errorf("trade adapter: PlaceOrderAndPay request is nil")
	}

	endpoint := strings.TrimRight(a.config.BaseURL, "/") + "/internal/trade/orders/place-and-pay"
	var result PlaceOrderResult
	if err := a.doJSON(ctx, http.MethodPost, endpoint, req, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

func (a *adapter) GeneratePayURL(ctx context.Context, dealName string) (*PayURLResult, error) {
	if a.config.BaseURL == "" {
		return nil, fmt.Errorf("trade adapter: base_url not configured")
	}
	dealName = strings.TrimSpace(dealName)
	if dealName == "" {
		return nil, fmt.Errorf("trade adapter: GeneratePayURL: dealName is required")
	}

	// dealName 来自 jifei 生成的订单号（"20260509000000001-001" 这种带 "-" 的），
	// 出于路径安全考虑做一次 PathEscape 兼容（jifei 当前未观察到特殊字符，但保留防御）。
	endpoint := strings.TrimRight(a.config.BaseURL, "/") +
		"/internal/trade/orders/" + url.PathEscape(dealName) + "/pay-url"

	var result PayURLResult
	if err := a.doJSON(ctx, http.MethodPost, endpoint, nil, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// doJSON 是 PlaceOrder / GeneratePayURL 共用的 HTTP 调用骨架。
//
// 行为：
//   - reqBody == nil → 不发 body，不设 Content-Type；非 nil → JSON 序列化后发送
//   - 2xx → 解码 respBody 返回
//   - 4xx / 5xx → 解码 errorResponse 包装为 *Error 返回（调用方 errors.As 分类）
//   - HTTP 失败 / decode 失败 → 返 raw error
func (a *adapter) doJSON(ctx context.Context, method, endpoint string, reqBody, respBody any) error {
	var bodyReader io.Reader
	if reqBody != nil {
		buf, err := json.Marshal(reqBody)
		if err != nil {
			return fmt.Errorf("trade adapter: marshal request: %w", err)
		}
		bodyReader = bytes.NewReader(buf)
	}

	httpReq, err := http.NewRequestWithContext(ctx, method, endpoint, bodyReader)
	if err != nil {
		return fmt.Errorf("trade adapter: build request: %w", err)
	}
	if reqBody != nil {
		httpReq.Header.Set("Content-Type", "application/json")
	}
	if a.config.Token != "" {
		httpReq.Header.Set("Authorization", "Bearer "+a.config.Token)
	}

	resp, err := a.client.Do(httpReq)
	if err != nil {
		return fmt.Errorf("trade adapter: request failed: %w", err)
	}
	defer resp.Body.Close()

	rawBody, readErr := io.ReadAll(resp.Body)
	if readErr != nil {
		return fmt.Errorf("trade adapter: read response: %w", readErr)
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		// 解析 trade 业务错误响应，失败时降级用 raw body。
		var er errorResponse
		_ = json.Unmarshal(rawBody, &er)
		if er.Code == "" {
			er.Code = fmt.Sprintf("HTTP%d", resp.StatusCode)
		}
		if er.Message == "" {
			er.Message = strings.TrimSpace(string(rawBody))
		}
		if a.logger != nil {
			a.logger.Warn("trade adapter non-2xx",
				zap.String("endpoint", endpoint),
				zap.Int("status", resp.StatusCode),
				zap.String("code", er.Code),
				zap.String("message", er.Message),
			)
		}
		return &Error{
			Status:   resp.StatusCode,
			Code:     er.Code,
			Message:  er.Message,
			Endpoint: endpoint,
		}
	}

	if respBody != nil {
		if err := json.Unmarshal(rawBody, respBody); err != nil {
			return fmt.Errorf("trade adapter: decode response: %w", err)
		}
	}
	return nil
}
