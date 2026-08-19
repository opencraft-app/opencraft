// Package dianshiclient 封装 trade → 点石（opc-activity-price / opc-dianshi-activity）出向调用。
//
// 出向 endpoint：通过 clgateway 反代，base_url 由 env 注入：
//   - DIANSHI_PRICE_BASE_URL：clgateway 的 dianshi-price route 地址
//   - DIANSHI_ORDER_BASE_URL：clgateway 的 dianshi-order route 地址
//
// 协议参考：
//   - .tmp/点石询价（activity_price.activity.get_price）
//   - .tmp/点石下单（POST /activity_web/activity/do_goods）
//
// 鉴权：
//   - 询价无鉴权
//   - 下单：如目标活动 jifei 后台开启鉴权，需带 check_sum =
//     hex(md5(uin + "_" + activity_id + "_" + secret_key))；secret_key 从
//     trade_bundle_activity.secret_key 列读取（per-activity 维度）。
//
// 设计稿：.tmp/dianshi-activity-bundle-design.md §5.1 / §7.1。
package dianshiclient

import (
	"bytes"
	"context"
	"crypto/md5"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"
)

// 协议层常量（与点石协议样例 / 设计稿 §5.1 严格对齐）。
//
// 点石询价 / 下单都遵循 CGW 风格 envelope，但与 jifei CGW 有几处差异：
//   - 询价 envelope.componentName="opc-restriction-strategy"，下单 componentName="qcact-logic"
//   - 下单 envelope.version 在协议样例里是数字 1（而 jifei 是字符串 "1.0"）；本 client
//     按设计稿统一发字符串 "1.0"，由点石侧兼容（实测 OK）
//   - 没有 caller / seqId / x-qcloud-user-id header 概念
//   - 业务 payload 在响应顶层 data 字段（与 jifei v1.7.15 B10 修复后同款）
const (
	// CGWVersion 是 envelope.version 字段。点石下单样例为数字 1、询价样例为字符串 "1.0"，
	// 这里统一发字符串 "1.0"（jifei 同款），降低 client 维护成本。
	CGWVersion = "1.0"

	// InterfaceNameActivityGetPrice 是询价 interfaceName。
	InterfaceNameActivityGetPrice = "activity_price.activity.get_price"

	// InterfaceNameDoGoods 是下单 envelope.interface.interfaceName。
	// 注：协议样例里下单 interface.interfaceName 是空字符串，路径靠 URL path
	// `/activity_web/activity/do_goods` 区分；这里按设计稿明示 "do_goods" 让 trade 内部
	// 日志可读，点石侧实测忽略此字段。
	InterfaceNameDoGoods = "do_goods"

	// ComponentNamePrice 是询价 envelope.componentName。
	ComponentNamePrice = "opc-restriction-strategy"

	// ComponentNameOrder 是下单 envelope.componentName。
	ComponentNameOrder = "qcact-logic"

	// OriginateLightvelaTrade 是下单 envelope.interface.para.originate 默认值，
	// 与 jifei [memory:bhngvb6e] 的 X-QCloud-Component-ID 同思路标识 trade 服务。
	OriginateLightvelaTrade = "lightvela.trade"

	// defaultTimeout 是出向 HTTP 默认超时，30s（与 jifeiclient v1.7.28 BUG-10 修复后同款）。
	defaultTimeout = 30 * time.Second

	// maxResponseBytes 是错误日志保留的响应 body 上限。
	maxResponseBytes = 4096
)

// 哨兵 / typed 错误（与 jifeiclient.Q68 错误模型保持一致）。

// ErrCGWHTTPNon200 表示点石网关返回非 2xx。
var ErrCGWHTTPNon200 = errors.New("dianshi cgw: http non-2xx")

// ErrCGWInvalidEnvelope 表示响应 envelope 字段缺失 / JSON 解码失败。
var ErrCGWInvalidEnvelope = errors.New("dianshi cgw: invalid envelope")

// CGWError 表示点石协议层业务错误（HTTP 200 但 returnCode != 0）。
//
// 上层用 errors.As 提取 ReturnCode / ReturnMessage 后做"降级 vs 透传"决策；
// 例如 placeOrderDianshi 命中本错误时直接业务错返 ctl，与 jifei generateDealsAndPay 失败语义对齐。
type CGWError struct {
	ReturnCode    int
	ReturnMessage string
	InterfaceName string
	EventID       int64
}

// Error 实现 error 接口。
func (e *CGWError) Error() string {
	if e == nil {
		return ""
	}
	return fmt.Sprintf("dianshi cgw business error: interface=%s eventId=%d returnCode=%d returnMessage=%q",
		e.InterfaceName, e.EventID, e.ReturnCode, e.ReturnMessage)
}

// GetPriceRequest 是询价 envelope.interface.para 内层（设计稿 §5.1）。
//
// Uin 不在询价请求中：询价不计算 check_sum，无需 uin。下单端的 DoGoodsRequest.Uin 仍保留
// 供 check_sum 与 jifei 站点路由使用。
type GetPriceRequest struct {
	ActivityID int64                  `json:"activity_id"`
	ClientInfo map[string]interface{} `json:"client_info,omitempty"`
	Goods      []GetPriceGoodsItem    `json:"goods"`
	Preview    int                    `json:"preview,omitempty"`
}

// GetPriceGoodsItem 是询价 goods[] 元素。
//
// PreferenceParam：本期固定 {} 空 object（用户拍板）。其它产品（如点石云函数）的 preference_param
// 字段集见点石平台
// `https://dianshi.woa.com/api/activity/product-base/get-api-params-by-query?goodsID=...`。
type GetPriceGoodsItem struct {
	ActID           int64                  `json:"act_id"`
	PreferenceParam map[string]interface{} `json:"preference_param"`
}

// GetPriceResponse 是询价响应 envelope.data 反序列化目标。
//
// 协议样例：data[].price / total_cost / time_span / time_unit / policy_detail.* 等。
// trade.inquiry.Service.quoteDianshi 把 PriceItems[0].Price / TotalCost 拍平到 QuoteResult。
type GetPriceResponse struct {
	PriceItems []PriceItem `json:"-"`
}

// UnmarshalJSON 兼容点石响应 data 字段为数组的实际形态（envelope.data 是 []PriceItem，
// 而 jifei v1.7.15 B10 解码路径调用方传入 *Response 把 envelope.data 作为整体反序列化目标）。
func (r *GetPriceResponse) UnmarshalJSON(b []byte) error {
	var items []PriceItem
	if err := json.Unmarshal(b, &items); err != nil {
		return err
	}
	r.PriceItems = items
	return nil
}

// MarshalJSON 让单测里的样例响应能直接 marshal 回 JSON 数组形态。
func (r *GetPriceResponse) MarshalJSON() ([]byte, error) {
	if r == nil || r.PriceItems == nil {
		return []byte("null"), nil
	}
	return json.Marshal(r.PriceItems)
}

// PriceItem 是询价响应 data[] 元素（仅保留 trade 实际消费的字段）。
type PriceItem struct {
	ActID          int64           `json:"act_id"`
	AmountUnit     string          `json:"amount_unit"`
	Currency       string          `json:"currency"`
	Pid            int64           `json:"pid"`
	Policy         int             `json:"policy"`
	PolicyDetail   json.RawMessage `json:"policy_detail,omitempty"`
	Price          int64           `json:"price"`
	TotalCost      int64           `json:"total_cost"`
	RealCost       int64           `json:"real_cost"`
	ProductCode    string          `json:"product_code"`
	SubProductCode string          `json:"sub_product_code"`
	TimeSpan       int             `json:"time_span"`
	TimeUnit       string          `json:"time_unit"`
}

// DoGoodsRequest 是下单 envelope.interface.para 内层（设计稿 §5.1）。
//
// Uin 必须保留：① CalcCheckSum(uin, activity_id, secret_key) 签名输入；② jifei 计费侧按
// uin 注册区分国内站 / 国际站、并把 deal 归属到真实账号。
type DoGoodsRequest struct {
	Uin        string                 `json:"uin"`
	ActivityID int64                  `json:"activity_id"`
	FlashSale  int                    `json:"flash_sale,omitempty"`
	Originate  string                 `json:"originate,omitempty"`
	UserIP     string                 `json:"user_ip,omitempty"`
	Refer      string                 `json:"refer,omitempty"`
	Goods      []DoGoodsItem          `json:"goods"`
	ClientInfo map[string]interface{} `json:"client_info,omitempty"`
	CheckSum   string                 `json:"check_sum,omitempty"` // §7.1 签名，secret_key 为空时不出现
	Preview    int                    `json:"preview,omitempty"`
}

// DoGoodsItem 是下单 goods[] 元素。
//
// PreferenceParam：下单时用户拍板"仅含 externalUserId"——trade 在 placeOrderDianshi 装配时
// 写入 {"externalUserId": req.ExternalUserID}。
type DoGoodsItem struct {
	ActID           int64                  `json:"act_id"`
	PreferenceParam map[string]interface{} `json:"preference_param"`
}

// DoGoodsResponse 是下单响应 envelope.data 反序列化目标。
//
// 协议样例 data 是对象（不是数组）：{deal_names: [...], big_deal_no: "..."}。
// trade.placeorder.Service.placeOrderDianshi 取 DealNames[0] 作为主 deal_name。
type DoGoodsResponse struct {
	DealNames []string `json:"deal_names"`
	BigDealNo string   `json:"big_deal_no"`
}

// Client 是 trade → 点石出向客户端对外接口（便于 mock）。
type Client interface {
	// GetActivityPrice 调用点石 `activity_price.activity.get_price` 询价接口。
	GetActivityPrice(ctx context.Context, req *GetPriceRequest) (*GetPriceResponse, error)

	// DoGoods 调用点石 `/activity_web/activity/do_goods` 下单接口。
	//
	// 入参 req 已经是 envelope.para 内层（含 check_sum）；client 内部负责拼 envelope。
	DoGoods(ctx context.Context, req *DoGoodsRequest) (*DoGoodsResponse, error)
}

// Options 是 Client 可选构造参数。
type Options struct {
	HTTPClient      *http.Client
	EventIDProvider func() int64
	NowProvider     func() time.Time
	Preview         int
}

type client struct {
	priceBaseURL    string
	orderBaseURL    string
	httpClient      *http.Client
	eventIDProvider func() int64
	nowProvider     func() time.Time
	preview         int
}

// New 构造点石 client。
//
// 参数：
//   - priceBaseURL：clgateway 的 dianshi-price route 入口，对应 env DIANSHI_PRICE_BASE_URL
//   - orderBaseURL：clgateway 的 dianshi-order route 入口，对应 env DIANSHI_ORDER_BASE_URL
//
// 任一 baseURL 为空都允许构造；只有真正调用对应方法时才会报错（让 trade main.go 即便
// env 缺失也能起 / 让单测能只 mock 单个方向）。
func New(priceBaseURL, orderBaseURL string, opts ...Options) Client {
	c := &client{
		priceBaseURL:    strings.TrimRight(strings.TrimSpace(priceBaseURL), "/"),
		orderBaseURL:    strings.TrimRight(strings.TrimSpace(orderBaseURL), "/"),
		httpClient:      &http.Client{Timeout: defaultTimeout},
		eventIDProvider: randomEventID,
		nowProvider:     time.Now,
	}
	if len(opts) > 0 {
		o := opts[0]
		c.preview = o.Preview
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

// envelope 是点石 CGW framework 顶层结构。
//
// 与 jifei envelope 差异：
//   - 没有 caller / seqId
//   - 响应方向 returnValue 仍是数字 0/1，业务 payload 在 data 顶层
//   - 请求方向 version 用 RawMessage 兼容数字与字符串两种形态
type envelope struct {
	Version       json.RawMessage `json:"version,omitempty"`
	ComponentName string          `json:"componentName,omitempty"`
	EventID       int64           `json:"eventId,omitempty"`
	Timestamp     int64           `json:"timestamp,omitempty"`
	Interface     *interfaceBlock `json:"interface,omitempty"`

	// 响应字段
	ReturnCode    *int            `json:"returnCode,omitempty"`
	ReturnMessage string          `json:"returnMessage,omitempty"`
	ReturnValue   json.RawMessage `json:"returnValue,omitempty"`
	Data          json.RawMessage `json:"data,omitempty"`
}

// interfaceBlock 是 envelope.interface 子层。
type interfaceBlock struct {
	InterfaceName string          `json:"interfaceName"`
	Para          json.RawMessage `json:"para"`
}

// GetActivityPrice 调用点石 `activity_price.activity.get_price`。
func (c *client) GetActivityPrice(ctx context.Context, req *GetPriceRequest) (*GetPriceResponse, error) {
	if req == nil {
		return nil, fmt.Errorf("dianshiclient: GetActivityPrice nil request")
	}
	if c.priceBaseURL == "" {
		return nil, fmt.Errorf("dianshiclient: priceBaseURL is required")
	}
	out := &GetPriceResponse{}
	outbound := *req
	outbound.Preview = c.preview
	if err := c.do(ctx, c.priceBaseURL, InterfaceNameActivityGetPrice, ComponentNamePrice, &outbound, out); err != nil {
		return nil, err
	}
	return out, nil
}

// DoGoods 调用点石 `/activity_web/activity/do_goods`。
func (c *client) DoGoods(ctx context.Context, req *DoGoodsRequest) (*DoGoodsResponse, error) {
	if req == nil {
		return nil, fmt.Errorf("dianshiclient: DoGoods nil request")
	}
	if c.orderBaseURL == "" {
		return nil, fmt.Errorf("dianshiclient: orderBaseURL is required")
	}
	out := &DoGoodsResponse{}
	outbound := *req
	outbound.Preview = c.preview
	if err := c.do(ctx, c.orderBaseURL, InterfaceNameDoGoods, ComponentNameOrder, &outbound, out); err != nil {
		return nil, err
	}
	return out, nil
}

// do 是所有点石 CGW 请求的统一执行入口。
//
// 步骤：
//  1. marshal para 业务字段
//  2. 拼 envelope（version "1.0" / componentName / eventId int64 / timestamp ms / interface{...}）
//  3. POST targetURL（priceBaseURL / orderBaseURL）
//  4. 解析响应 envelope，按 returnCode 分类（HTTP 非 2xx → ErrCGWHTTPNon200；envelope 失败 →
//     ErrCGWInvalidEnvelope；returnCode != 0 → *CGWError；returnCode == 0 → 把 data 反序列化到 outResp）
func (c *client) do(
	ctx context.Context,
	targetURL, interfaceName, componentName string,
	para any,
	outResp any,
) error {
	paraBytes, err := json.Marshal(para)
	if err != nil {
		return fmt.Errorf("dianshiclient: marshal para: %w", err)
	}

	eventID := c.eventIDProvider()
	versionRaw, _ := json.Marshal(CGWVersion)
	env := envelope{
		Version:       versionRaw,
		ComponentName: componentName,
		EventID:       eventID,
		Timestamp:     c.nowProvider().UnixMilli(),
		Interface: &interfaceBlock{
			InterfaceName: interfaceName,
			Para:          paraBytes,
		},
	}
	bodyBytes, err := json.Marshal(env)
	if err != nil {
		return fmt.Errorf("dianshiclient: marshal envelope: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, targetURL, bytes.NewReader(bodyBytes))
	if err != nil {
		return fmt.Errorf("dianshiclient: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	// 联调期临时 dump（与 jifeiclient v1.7.28 同款思路），便于排障。联调结束后可删。
	log.Printf("[dianshi-out] interface=%s eventId=%d url=%s body=%s",
		interfaceName, eventID, targetURL, string(bodyBytes))

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("dianshiclient: http do (interface=%s eventId=%d): %w",
			interfaceName, eventID, err)
	}
	defer resp.Body.Close()

	respBytes, _ := io.ReadAll(resp.Body)
	log.Printf("[dianshi-in] interface=%s eventId=%d status=%d body=%s",
		interfaceName, eventID, resp.StatusCode, string(respBytes))

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("dianshiclient: %w: status=%d interface=%s eventId=%d body=%s",
			ErrCGWHTTPNon200, resp.StatusCode, interfaceName, eventID, truncate(respBytes, maxResponseBytes))
	}

	var respEnv envelope
	if err := json.Unmarshal(respBytes, &respEnv); err != nil {
		return fmt.Errorf("dianshiclient: %w: unmarshal envelope (interface=%s eventId=%d body=%s): %v",
			ErrCGWInvalidEnvelope, interfaceName, eventID, truncate(respBytes, maxResponseBytes), err)
	}
	if respEnv.ReturnCode == nil {
		return fmt.Errorf("dianshiclient: %w: returnCode missing (interface=%s eventId=%d body=%s)",
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
	if len(respEnv.Data) == 0 || string(respEnv.Data) == "null" {
		return nil
	}
	if err := json.Unmarshal(respEnv.Data, outResp); err != nil {
		return fmt.Errorf("dianshiclient: %w: unmarshal data (interface=%s eventId=%d): %v",
			ErrCGWInvalidEnvelope, interfaceName, eventID, err)
	}
	return nil
}

// CalcCheckSum 计算点石下单签名（设计稿 §7.1）：hex(md5(uin + "_" + activity_id + "_" + secret_key))。
//
// secret_key 为空时返空字符串——调用方据此决定是否在 envelope 写出 check_sum 字段。
func CalcCheckSum(uin string, activityID int64, secretKey string) string {
	if secretKey == "" {
		return ""
	}
	msg := fmt.Sprintf("%s_%d_%s", uin, activityID, secretKey)
	sum := md5.Sum([]byte(msg))
	return hex.EncodeToString(sum[:])
}

// randomEventID 生成 [1, 2^31) 范围的随机正整数（与 jifeiclient.randomEventIDInt64 同款思路）。
func randomEventID() int64 {
	var b [4]byte
	if _, err := rand.Read(b[:]); err != nil {
		return time.Now().UnixNano() & 0x7fffffff
	}
	v := int64(b[0])<<24 | int64(b[1])<<16 | int64(b[2])<<8 | int64(b[3])
	v &= 0x7fffffff
	if v == 0 {
		v = 1
	}
	return v
}

func truncate(b []byte, max int) string {
	if len(b) <= max {
		return string(b)
	}
	return string(b[:max]) + "...(truncated)"
}
