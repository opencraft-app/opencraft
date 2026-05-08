// Package jifeiclient 封装 trade → jifei 出向的 CGW 协议层 HTTP 客户端。
//
// 协议参考：
//   - 设计稿 §3.5.5 jifei CGW 协议层契约（询价方向）
//   - PDF：`/root/project/mono/.tmp/询价接口+- qcloud.price.getPrice（CGW）.pdf`（22 页 / 2026-05-07 投放）
//   - 拍板项 Q47 / Q48 / Q42 / Q50 / Q51（详见 .tmp/trade-purchase-flow-design.md §10）
//   - 自决项 Q67（generateDeals PascalCase 最小字段集）/ Q68（错误模型）
//
// 设计要点：
//
//  1. **CGW framework 双层结构**：所有 CGW 请求都遵循
//     `{version, componentName, eventId, timestamp, seqId, interface{interfaceName, para}}`
//     7 字段顶层 + `interface.para` 内层业务字段；响应同结构
//     `{returnCode, returnMessage, returnValue{...}}`（returnCode == 0 即业务成功）。
//
//  2. **不签名（Q47）**：trade → jifei 请求方向 CGW 协议层根本无 `auth.signature` 字段，
//     trade 不持有、不传任何签名 — 与 Q48 一道收敛"最小协议表面"。
//
//  3. **CGW 网关鉴权（Q51）**：
//     - HTTP `Host` header：`trade.itd.com`（CGW 网关基于 Host 路由到 jifei 后端）
//     - HTTP `x-qcloud-user-id` header：trade 服务账号 uin（标识请求来源，与业务层
//     `interface.para.ownerUin` / `uin` 字段独立）
//     - 中转机 IP 白名单：由部署侧出口 IP 注册，client 不感知
//
//  4. **错误模型（Q68）**：
//     - HTTP 层失败（连接 / 超时 / 非 2xx）→ 哨兵 `ErrCGWHTTPNon200` 或原始 net error
//     - 协议层失败（HTTP 200 但 returnCode != 0）→ typed `*CGWError{ReturnCode, ReturnMessage}`
//     - 出参解析失败 → 哨兵 `ErrCGWInvalidEnvelope`
//     这样上层 jifei 适配层可以用 `errors.Is` / `errors.As` 区分降级 vs 透传。
//
//  5. **超时**：默认 4s（与 ctlclient 一致，对齐 Q59 同步发货 5s 总预算 - 1s buffer）；
//     调用方可通过 Options.HTTPClient 注入自定义超时 / Transport。
package jifeiclient

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// 协议层常量（与设计稿 §3.5.5 / Q47 / Q51 严格对齐）。
const (
	// CGWVersion 是 CGW framework 顶层 version 字段；PDF 使用 "1.0"。
	CGWVersion = "1.0"

	// CGWHostHeader 是 CGW 网关路由用 Host header；PDF 第 5 页明示。
	// 注意：与请求 URL 的 host 不同 — URL 是中转机 IP / 域名，Host header 才是
	// CGW 内部路由 key（`Host` 是 net/http 自动从 URL 提取，需要显式 req.Host = ... 覆盖）。
	CGWHostHeader = "trade.itd.com"

	// CGWUserIDHeader 是 CGW 网关用户标识 header（Q51）。
	CGWUserIDHeader = "x-qcloud-user-id"

	// 询价 / 下单的 CGW interfaceName 与 componentName。
	// componentName 取 interfaceName 第二段（"price" / "Deal"），与 PDF 第 3 页一致。
	InterfaceNameGetPrice      = "qcloud.price.getPrice"
	InterfaceNameGenerateDeals = "qcloud.Deal.generateDeals"
	ComponentNamePrice         = "price"
	ComponentNameDeal          = "Deal"

	// defaultTimeout 是 jifei CGW 出向请求默认超时；与 ctlclient 一致。
	defaultTimeout = 4 * time.Second

	// maxResponseBytes 是错误日志保留的响应 body 上限，防巨型报文打爆日志。
	maxResponseBytes = 4096
)

// 哨兵 / typed 错误（Q68）。

// ErrCGWHTTPNon200 表示 jifei CGW 网关返回非 2xx 状态码。
var ErrCGWHTTPNon200 = errors.New("jifei cgw: http non-2xx")

// ErrCGWInvalidEnvelope 表示 CGW 响应 envelope 字段缺失 / JSON 解码失败。
var ErrCGWInvalidEnvelope = errors.New("jifei cgw: invalid envelope")

// CGWError 表示 jifei CGW 协议层业务错误（HTTP 200 但 returnCode != 0）。
//
// 上层适配层用 errors.As 提取 ReturnCode / ReturnMessage 后再做"降级 vs 透传 vs 重试"的策略选择
// （例如 Q56 退款响应分类映射）。
type CGWError struct {
	ReturnCode    int
	ReturnMessage string
	InterfaceName string
	EventID       string
}

// Error 实现 error 接口。
func (e *CGWError) Error() string {
	if e == nil {
		return ""
	}
	return fmt.Sprintf("jifei cgw business error: interface=%s eventId=%s returnCode=%d returnMessage=%q",
		e.InterfaceName, e.EventID, e.ReturnCode, e.ReturnMessage)
}

// Client 是 trade → jifei CGW 出向客户端的对外接口（便于 mock）。
type Client interface {
	// GetPrice 调用 jifei CGW `qcloud.price.getPrice` 询价接口。
	//
	// 入参 req 已经是 CGW para 内层业务字段（OwnerUin / Uin / ResInfo[]）；
	// client 内部负责拼 framework 顶层 7 字段、HTTP header、错误码翻译。
	GetPrice(ctx context.Context, req *GetPriceRequest) (*GetPriceResponse, error)

	// GenerateDeals 调用 jifei CGW `qcloud.Deal.generateDeals` 下单接口。
	//
	// 入参 req 已经是 CGW para 内层业务字段（OwnerUin / Uin / GoodsInfos[]）；
	// 出参 PascalCase（与 PDF 第 8 页 PriceInfos / BigDealId / DealNames[] 严格对齐）。
	GenerateDeals(ctx context.Context, req *GenerateDealsRequest) (*GenerateDealsResponse, error)
}

// Options 是 Client 可选构造参数。
type Options struct {
	// HTTPClient 允许调用方注入自定义 HTTP client（用于注入 mTLS / 自定义 Transport / 测试）。
	// 不传则用默认 http.Client{Timeout: defaultTimeout}。
	HTTPClient *http.Client

	// EventIDProvider 允许测试注入确定性 eventId 生成器。生产留空走 cryptoRandHex。
	EventIDProvider func() string

	// NowProvider 允许测试注入确定性时间戳。生产留空走 time.Now。
	NowProvider func() time.Time
}

type client struct {
	baseURL         string
	xQCloudUserID   string
	httpClient      *http.Client
	eventIDProvider func() string
	nowProvider     func() time.Time
}

// New 构造 jifei CGW client。
//
// 参数：
//   - baseURL：CGW 网关入口 URL（如 https://trade.itd.com 或 http://9.139.137.40:8080，
//     具体形态取决于部署 — 中转机 IP 直连或网关域名都允许；HTTP Host header 由 client 写死）。
//   - xQCloudUserID：trade 服务账号 uin，写入每次请求的 `x-qcloud-user-id` header。
//   - opts...：可选 Options（HTTPClient / EventIDProvider / NowProvider）。
//
// baseURL / xQCloudUserID 会做 TrimSpace；空字符串保留（由 do 阶段在拼 URL 时报错）。
func New(baseURL, xQCloudUserID string, opts ...Options) Client {
	c := &client{
		baseURL:       strings.TrimRight(strings.TrimSpace(baseURL), "/"),
		xQCloudUserID: strings.TrimSpace(xQCloudUserID),
		httpClient:    &http.Client{Timeout: defaultTimeout},
		eventIDProvider: cryptoRandHex,
		nowProvider:     time.Now,
	}
	if len(opts) > 0 {
		o := opts[0]
		if o.HTTPClient != nil {
			c.httpClient = o.HTTPClient
		}
		if o.EventIDProvider != nil {
			c.eventIDProvider = o.EventIDProvider
		}
		if o.NowProvider != nil {
			c.nowProvider = o.NowProvider
		}
	}
	return c
}

// envelope 是 CGW framework 顶层结构（请求 / 响应共用）。
//
// 请求方向：调用方填 Version / ComponentName / EventID / Timestamp / SeqID / Interface；
// 响应方向：jifei 填 ReturnCode / ReturnMessage / ReturnValue（Version / ComponentName / EventID
// 通常被回显，client 不强校验）。
type envelope struct {
	Version       string          `json:"version,omitempty"`
	ComponentName string          `json:"componentName,omitempty"`
	EventID       string          `json:"eventId,omitempty"`
	Timestamp     string          `json:"timestamp,omitempty"`
	SeqID         string          `json:"seqId,omitempty"`
	Interface     *interfaceBlock `json:"interface,omitempty"`

	// 响应字段
	ReturnCode    *int            `json:"returnCode,omitempty"`
	ReturnMessage string          `json:"returnMessage,omitempty"`
	ReturnValue   json.RawMessage `json:"returnValue,omitempty"`
}

// interfaceBlock 是 framework 内层 interface 字段。
type interfaceBlock struct {
	InterfaceName string          `json:"interfaceName"`
	Para          json.RawMessage `json:"para"`
}

// do 是所有 CGW 请求的统一执行入口。
//
// 步骤：
//  1. 把业务字段 para 序列化（para 已经是上层封装好的 *Request struct）
//  2. 拼 framework envelope（Version / ComponentName / EventID / Timestamp / SeqID / Interface）
//  3. 发起 POST，注入 `Host` header + `x-qcloud-user-id` header（Q51 鉴权）
//  4. 解析响应 envelope，按 returnCode 分类：
//     - HTTP 非 2xx → 包 ErrCGWHTTPNon200
//     - returnCode == nil 或 envelope 解码失败 → 包 ErrCGWInvalidEnvelope
//     - returnCode != 0 → 返回 *CGWError
//     - returnCode == 0 → 把 returnValue 反序列化到 outResp（调用方传的 *Response struct）
func (c *client) do(
	ctx context.Context,
	interfaceName, componentName string,
	para any,
	outResp any,
) error {
	if c.baseURL == "" {
		return fmt.Errorf("jifeiclient: baseURL is required")
	}

	paraBytes, err := json.Marshal(para)
	if err != nil {
		return fmt.Errorf("jifeiclient: marshal para: %w", err)
	}

	eventID := c.eventIDProvider()
	env := envelope{
		Version:       CGWVersion,
		ComponentName: componentName,
		EventID:       eventID,
		Timestamp:     fmt.Sprintf("%d", c.nowProvider().UnixMilli()),
		SeqID:         c.eventIDProvider(),
		Interface: &interfaceBlock{
			InterfaceName: interfaceName,
			Para:          paraBytes,
		},
	}

	bodyBytes, err := json.Marshal(env)
	if err != nil {
		return fmt.Errorf("jifeiclient: marshal envelope: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL, bytes.NewReader(bodyBytes))
	if err != nil {
		return fmt.Errorf("jifeiclient: build request: %w", err)
	}

	// Q51 鉴权：CGW Host header（基于此路由到 jifei 后端）+ x-qcloud-user-id（调用来源标识）。
	// 注意：req.Host = ... 是显式覆盖；req.Header.Set("Host", ...) 在 net/http 中不生效。
	req.Host = CGWHostHeader
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(CGWUserIDHeader, c.xQCloudUserID)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("jifeiclient: http do (interface=%s eventId=%s): %w",
			interfaceName, eventID, err)
	}
	defer resp.Body.Close()

	respBytes, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("jifeiclient: %w: status=%d interface=%s eventId=%s body=%s",
			ErrCGWHTTPNon200, resp.StatusCode, interfaceName, eventID, truncate(respBytes, maxResponseBytes))
	}

	var respEnv envelope
	if err := json.Unmarshal(respBytes, &respEnv); err != nil {
		return fmt.Errorf("jifeiclient: %w: unmarshal envelope (interface=%s eventId=%s body=%s): %v",
			ErrCGWInvalidEnvelope, interfaceName, eventID, truncate(respBytes, maxResponseBytes), err)
	}
	if respEnv.ReturnCode == nil {
		return fmt.Errorf("jifeiclient: %w: returnCode missing (interface=%s eventId=%s body=%s)",
			ErrCGWInvalidEnvelope, interfaceName, eventID, truncate(respBytes, maxResponseBytes))
	}
	if rc := *respEnv.ReturnCode; rc != 0 {
		return &CGWError{
			ReturnCode:    rc,
			ReturnMessage: respEnv.ReturnMessage,
			InterfaceName: interfaceName,
			EventID:       eventID,
		}
	}

	if outResp == nil {
		return nil
	}
	if len(respEnv.ReturnValue) == 0 || string(respEnv.ReturnValue) == "null" {
		// returnValue 为空但 returnCode == 0 — 协议上视为成功无 payload，调用方处理 zero value。
		return nil
	}
	if err := json.Unmarshal(respEnv.ReturnValue, outResp); err != nil {
		return fmt.Errorf("jifeiclient: %w: unmarshal returnValue (interface=%s eventId=%s): %v",
			ErrCGWInvalidEnvelope, interfaceName, eventID, err)
	}
	return nil
}

// cryptoRandHex 生成 16 字节十六进制串作为默认 eventId / seqId。
//
// 失败时退化为基于纳秒时间戳的伪随机串（不会 panic — CGW 协议层只要求 eventId 全局唯一，
// 极小概率重复对调用链路无副作用）。
func cryptoRandHex() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("ts-%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b[:])
}

// truncate 截断字节切片到 max 长度，超出补 "...(truncated)"。
func truncate(b []byte, max int) string {
	if len(b) <= max {
		return string(b)
	}
	return string(b[:max]) + "...(truncated)"
}
