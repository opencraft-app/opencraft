// Package ctlclient 封装 trade → ctl 的内部反向调用。
//
// 设计稿对齐（trade-purchase-flow-design §5.2 / §5.4 / §6 / §7.5）：
//   - checkCreate：调 GetBundleByID + ListPassesByUser 做实时校验
//     （Q24 / Q33：bundle 自校验；Q25 / Q66 修订 / Q69：互斥占用查询）
//   - createResource：调 CompletePass 完成发货
//     （Q42 / billing-integration B3：trade 透传完整入参，ctl 不做幂等）
//
// 协议层：
//   - 鉴权：Authorization: Bearer <internalServiceToken>
//     与 ctl 的 requireInternalBearer 对齐（CTL_INTERNAL_TOKEN）
//   - 错误模型：透传 ctl 的 errorResponse{code, message, request_id, details}
//     ctl 侧 5xx / 业务错（401/404/4xx）一律包装为 *Error，附带 RequestID 便于排障
//
// 超时：所有方法默认 4 秒（设计稿 Q59 同步发货 5 秒预算 - 1 秒 buffer），
// 调用方可通过 ctx 进一步收紧；超出 4 秒由 http.Client 强制中断。
package ctlclient

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Client 是 ctl 内部反向调用契约。
//
// 抽象成 interface 便于上层 service / handler 注入 mock 做单元测试，
// 也允许迭代 8+ 替换实现（如切到 tRPC / connect-go 时不破坏调用方）。
type Client interface {
	// GetBundleByID 调 GET /internal/ctl/bundles/{bundleId}
	//
	// 返回 ctl 维护的 bundle 业务规格精简子集（剥离 ai_gateway_plans /
	// sub_product_code / time_span / time_unit 等内部字段，详见 ctl
	// transport.InternalBundleDetail 注释）。
	//
	// trade 用法：checkCreate 阶段拿 bundle_state / bundle_sales_state 做自校验。
	GetBundleByID(ctx context.Context, bundleID string) (*BundleDetail, error)

	// ListPassesByUser 调 GET /internal/ctl/passes?external_user_id=xxx
	//
	// 返回当前 user_id 名下**全部** pass 记录（不论是否过期 / 隔离 / 删除）。
	//
	// trade 用法（Q66 修订 + Q69 拍板，2026-05-09）：checkCreate 阶段判定互斥占用 —
	// **列表非空即互斥占用**，无条件阻断新购下单（过期 pass 走续费路径，不走新购）。
	// trade 业务层只关心数组长度，不需要逐条检查时间字段。
	ListPassesByUser(ctx context.Context, externalUserID string) ([]*PassDetail, error)

	// CompletePass 调 POST /internal/ctl/passes/complete
	//
	// 由 trade createResource 在 jifei 同步发货流程中调用，将 jifei 协议层
	// 透传字段（uin / app_id / time_span / time_unit / deal_name / renew_flag）
	// 提交给 ctl 完成付费 pass 写入 + ai-gateway 订阅联动。
	//
	// 注意（v4 收敛 / billing-integration B3）：
	//   - ctl 内部不再做幂等（兜底防御 USER_HAS_ACTIVE_PASS 即拒）
	//   - trade 侧由 trade_flow 抢占式幂等（Q61）保证不重复调
	CompletePass(ctx context.Context, req *CompletePassRequest) (*PassDetail, error)
}

// BundleDetail 镜像 ctl/pkg/transport.InternalBundleDetail。
//
// 不直接 import ctl 的 transport 包是为了维持服务间封装边界 —
// ctl 的 transport 包是 ctl 私有 DTO，不是公共 contract；
// 跨服务共享待迭代 8+ 上线时再抽 contract 仓。
type BundleDetail struct {
	BundleID              string `json:"bundle_id"`
	BundleName            string `json:"bundle_name"`
	BundleState           string `json:"bundle_state"`            // ONLINE / OFFLINE
	AgentQuota            int64  `json:"agent_quota"`             // 设备配额
	Credit                int64  `json:"credit"`                  // 用户可见积分额度
	BundleSalesAvailCount int    `json:"bundle_sales_available_count"`
	BundleSalesTotalCount int    `json:"bundle_sales_total_count"`
	BundleSalesState      string `json:"bundle_sales_state"` // 计算字段 AVAILABLE / SOLD_OUT
}

// PassDetail 镜像 ctl/pkg/transport.PassResponse。
//
// 字段含义详见 ctl pass.go transport 定义；这里 trade 主要消费：
//   - PassID / BundleID / ExpiredTime / IsolatedTime / DeletedTime —
//     互斥占用判定保留字段方便排障/审计（Q69：trade 只关心列表非空，不需要
//     逐条检查时间字段，但保留字段用于日志记录"互斥被哪条 pass 占用"）
//   - Uin / AppID — createResource 透传校验
type PassDetail struct {
	PassID       string     `json:"pass_id"`
	UserID       string     `json:"user_id"`
	BundleID     string     `json:"bundle_id"`
	BundleName   string     `json:"bundle_name"`
	Uin          int64      `json:"uin"`
	AppID        int64      `json:"app_id"`
	CreatedTime  time.Time  `json:"created_time"`
	ExpiredTime  time.Time  `json:"expired_time"`
	IsolatedTime *time.Time `json:"isolated_time"`
	DeletedTime  *time.Time `json:"deleted_time"`
	UpdatedTime  time.Time  `json:"updated_time"`

	CreditTotal     int64 `json:"credit_total"`
	CreditAvailable int64 `json:"credit_available"`
}

// CompletePassRequest 镜像 ctl/pkg/transport.CompletePassRequest。
//
// 字段语义详见 ctl 侧定义；trade 在 createResource 回调收到 jifei 协议层
// 字段后构造此请求体提交给 ctl。
type CompletePassRequest struct {
	UserID    string `json:"user_id"`
	BundleID  string `json:"bundle_id"`
	TimeSpan  int    `json:"time_span"`
	TimeUnit  string `json:"time_unit"`
	Uin       int64  `json:"uin"`
	AppID     int64  `json:"app_id"`
	DealName  string `json:"deal_name"`
	RenewFlag string `json:"renew_flag,omitempty"`
}

// Error 是 ctl HTTP 错误响应的强类型化封装。
//
// 调用方用 errors.As(err, &ctlclient.Error{}) 拿到结构化字段；
// HTTPStatus 用于区分 4xx（业务错，trade 透传）/ 5xx（基础设施错，trade 重试或 503）。
type Error struct {
	HTTPStatus int    // 上游 HTTP status
	Code       string // ctl errcode.Error.Code（如 "PASS_BUNDLE_OFFLINE" / "INVALID_PARAM"）
	Message    string // 人类可读消息
	RequestID  string // ctl 侧 request_id，用于跨服务日志串联
}

func (e *Error) Error() string {
	if e == nil {
		return ""
	}
	return fmt.Sprintf("ctl http %d code=%s message=%q request_id=%s",
		e.HTTPStatus, e.Code, e.Message, e.RequestID)
}

// ErrNotFound 在 ctl 返回 404 时返回，方便调用方 errors.Is 判定。
//
// 典型场景：
//   - GetBundleByID 时 bundleID 在 ctl 不存在
//   - ListPassesByUser 时（理论不返 404，但保留兼容）
var ErrNotFound = errors.New("ctlclient: not found")

// ErrUnauthorized 在 ctl 返回 401 时返回，通常意味着 InternalServiceToken
// 与 ctl 配置的 CTL_INTERNAL_TOKEN 不一致 — 属于配置错而非业务错。
var ErrUnauthorized = errors.New("ctlclient: unauthorized")

// envelope 反序列化 ctl 的 successResponse / errorResponse 框架。
//
// ctl 侧 server.go 的 successResponse / errorResponse 都是 {code, message,
// request_id, data?, details?} 的形态，这里用一个 envelope 同时承载两种语义。
type envelope struct {
	Code      string          `json:"code"`
	Message   string          `json:"message"`
	RequestID string          `json:"request_id,omitempty"`
	Data      json.RawMessage `json:"data,omitempty"`
	Details   any             `json:"details,omitempty"`
}

// httpClient 是 Client 的标准实现。
type httpClient struct {
	baseURL    string
	token      string
	httpClient *http.Client
}

// Options 可选配置。空值走默认。
type Options struct {
	// HTTPClient 自定义底层客户端（注入 tracing transport 用）；
	// 默认为 &http.Client{Timeout: 4s}
	HTTPClient *http.Client
}

// New 构造 ctlclient.Client。
//
// 必填参数：
//   - baseURL：ctl 内部接入地址，如 http://ctl.lightclaw-svc.svc.cluster.local:8080
//   - internalServiceToken：与 ctl CTL_INTERNAL_TOKEN 一致的 Bearer token
func New(baseURL, internalServiceToken string, opts ...Options) Client {
	c := &httpClient{
		baseURL: strings.TrimRight(strings.TrimSpace(baseURL), "/"),
		token:   strings.TrimSpace(internalServiceToken),
	}
	if len(opts) > 0 && opts[0].HTTPClient != nil {
		c.httpClient = opts[0].HTTPClient
	} else {
		c.httpClient = &http.Client{Timeout: 4 * time.Second}
	}
	return c
}

func (c *httpClient) GetBundleByID(ctx context.Context, bundleID string) (*BundleDetail, error) {
	if strings.TrimSpace(bundleID) == "" {
		return nil, fmt.Errorf("ctlclient: bundleID is required")
	}
	endpoint := c.baseURL + "/internal/ctl/bundles/" + url.PathEscape(bundleID)

	var detail BundleDetail
	if err := c.do(ctx, http.MethodGet, endpoint, nil, &detail); err != nil {
		return nil, err
	}
	return &detail, nil
}

func (c *httpClient) ListPassesByUser(ctx context.Context, externalUserID string) ([]*PassDetail, error) {
	if strings.TrimSpace(externalUserID) == "" {
		return nil, fmt.Errorf("ctlclient: externalUserID is required")
	}
	q := url.Values{}
	q.Set("external_user_id", externalUserID)
	endpoint := c.baseURL + "/internal/ctl/passes?" + q.Encode()

	// ctl 返回 {data: {passes: [...]}}, 这里反序列化到 listPassesResponse 桥接结构
	var resp struct {
		Passes []*PassDetail `json:"passes"`
	}
	if err := c.do(ctx, http.MethodGet, endpoint, nil, &resp); err != nil {
		return nil, err
	}
	return resp.Passes, nil
}

func (c *httpClient) CompletePass(ctx context.Context, req *CompletePassRequest) (*PassDetail, error) {
	if req == nil {
		return nil, fmt.Errorf("ctlclient: CompletePass req is nil")
	}
	endpoint := c.baseURL + "/internal/ctl/passes/complete"

	var detail PassDetail
	if err := c.do(ctx, http.MethodPost, endpoint, req, &detail); err != nil {
		return nil, err
	}
	return &detail, nil
}

// do 是统一的 HTTP 调用入口，承载序列化、鉴权、状态码识别、envelope 解包。
//
// out 必须是指针；nil out 表示忽略响应体的 data 字段。
func (c *httpClient) do(ctx context.Context, method, endpoint string, body any, out any) error {
	var bodyReader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("ctlclient: marshal request body: %w", err)
		}
		bodyReader = bytes.NewReader(raw)
	}

	httpReq, err := http.NewRequestWithContext(ctx, method, endpoint, bodyReader)
	if err != nil {
		return fmt.Errorf("ctlclient: build request: %w", err)
	}
	if body != nil {
		httpReq.Header.Set("Content-Type", "application/json")
	}
	httpReq.Header.Set("Accept", "application/json")
	if c.token != "" {
		httpReq.Header.Set("Authorization", "Bearer "+c.token)
	}

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return fmt.Errorf("ctlclient: do request: %w", err)
	}
	defer resp.Body.Close()

	rawBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("ctlclient: read response: %w", err)
	}

	// 优先按 envelope 解析；若失败说明 ctl 返回了非标准结构（极少见，但保留兜底）
	var env envelope
	envParseErr := json.Unmarshal(rawBody, &env)

	switch {
	case resp.StatusCode == http.StatusUnauthorized:
		return fmt.Errorf("%w: status=%d code=%s message=%q request_id=%s",
			ErrUnauthorized, resp.StatusCode, env.Code, env.Message, env.RequestID)
	case resp.StatusCode == http.StatusNotFound:
		return fmt.Errorf("%w: status=%d code=%s message=%q request_id=%s",
			ErrNotFound, resp.StatusCode, env.Code, env.Message, env.RequestID)
	case resp.StatusCode >= 400:
		// 4xx / 5xx 业务错或基础设施错
		if envParseErr != nil {
			return &Error{
				HTTPStatus: resp.StatusCode,
				Code:       "",
				Message:    string(rawBody),
				RequestID:  "",
			}
		}
		return &Error{
			HTTPStatus: resp.StatusCode,
			Code:       env.Code,
			Message:    env.Message,
			RequestID:  env.RequestID,
		}
	}

	// 2xx 路径
	if envParseErr != nil {
		return fmt.Errorf("ctlclient: parse success envelope: %w body=%s", envParseErr, truncate(rawBody, 256))
	}
	if out == nil {
		return nil
	}
	if len(env.Data) == 0 || string(env.Data) == "null" {
		return nil
	}
	if err := json.Unmarshal(env.Data, out); err != nil {
		return fmt.Errorf("ctlclient: unmarshal data into %T: %w body=%s", out, err, truncate(env.Data, 256))
	}
	return nil
}

// truncate 截断 byte slice 用于 error 日志，避免巨型 body 干扰排障。
func truncate(b []byte, n int) string {
	if len(b) <= n {
		return string(b)
	}
	return string(b[:n]) + "...(truncated)"
}
