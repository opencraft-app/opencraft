// Package trade 提供 trade 服务的 HTTP 适配器，用于 ctl 反向调用 trade 内部 RPC。
//
// 端点对接（与 trade.internal/httpapi/internalapi/handler.go 保持一致）：
//
//   - POST /internal/trade/inquiry/batch                 批量询价（InquiryBatch，迭代 8C describeBundles 用）
//   - POST /internal/trade/inquiry/renew                 续费询价（InquiryRenew，v1.7.21 B16 / R-C-4）
//   - POST /internal/trade/orders                        下单（PlaceOrder）
//   - POST /internal/trade/orders/place-and-pay         下单 + 支付一体化（PlaceOrderAndPay，迭代 8B-1.5）
//   - POST /internal/trade/orders/renew                 续费下单（PlaceRenewOrder，trade-pass-renew R-D-5）
//   - POST /internal/trade/orders/renew/place-and-pay   续费下单 + 支付一体化（PlaceRenewOrderAndPay，R-D-7 测试用）
//   - POST /internal/trade/orders/{dealName}/pay-url     生成 / 反查支付页 URL（GeneratePayURL）
//   - GET  /internal/trade/orders/by-resource/{passID}   查询存量 Pass 原始购买周期
//   - POST /internal/trade/flows/{flowID}/complete      推进 trade_flow 终态（CompleteFlow，trade-pass-isolate §10 Q22-I-E）
//   - POST /internal/trade/resources/{resourceID}/delete 触发 jifei 销毁前置（DeleteResource，trade-pass-destroy §3.5 / §4.5.3）
//   - POST /internal/trade/resources/{resourceID}/refund 触发 jifei 同步退款（RefundResource，trade-pass-refund-design.md v0.5）
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
	AutoRenewFlag  string `json:"auto_renew_flag,omitempty"`
	// 注：Q41 修订 2026-05-11 删除 RegionID 字段。trade 内部固定 1（广州），ctl 不再透传。
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

// PlaceRenewOrderRequest 与 trade /internal/trade/orders/renew 入参 placeRenewOrderRequest 字段集对齐。
//
// 设计稿：.tmp/trade-pass-renew-design.md §3.3 / §4.4 / R-D-5
//
// 与 PlaceOrderRequest 的关键差异：
//   - 新增 ResourceID（必填）：续费目标 pass_id
//   - 新增 CurDeadline（必填，v1.7.20 B15）：jifei goodsDetail.curDeadline 透传
//     （PDF §4.3 续费独有必填字段）。真源 = ctl pass.expired_time，由 ctl logic
//     从 DB 读出后按 "2006-01-02 15:04:05" 格式拼字符串透传给 trade，trade 不做
//     反查、不计算、不解析、不校验业务语义，仅做必填非空校验后注入 jifei goodsDetail。
//   - 复用 ExternalUserID / Uin / AppID / BundleID / Period / TimeUnit / GoodsNum / PayMode 8 字段
//
// shadow 反查策略与 PlaceOrderRequest 一致：调用方可仅传 ExternalUserID，trade 内部反查回填。
type PlaceRenewOrderRequest struct {
	ExternalUserID string `json:"externalUserId"`
	Uin            string `json:"uin,omitempty"`
	AppID          string `json:"appId,omitempty"`
	BundleID       string `json:"bundleId"`
	ResourceID     string `json:"resourceId"`
	CurDeadline    string `json:"curDeadline"` // PDF §4.3 续费必填; 格式 "2006-01-02 15:04:05" (与 jifei 协议字符串形态一致)
	Period         int    `json:"period"`
	TimeUnit       string `json:"timeUnit"`
	GoodsNum       int    `json:"goodsNum"`
	PayMode        int    `json:"payMode"`
}

// MoveInOrderRequest 与 trade /internal/trade/orders/move-in 入参对齐。
type MoveInOrderRequest struct {
	ExternalUserID string `json:"externalUserId"`
	Uin            string `json:"uin,omitempty"`
	AppID          string `json:"appId,omitempty"`
	BundleID       string `json:"bundleId"`
	ResourceID     string `json:"resourceId"`
	CurDeadline    string `json:"curDeadline"`
}

// PayURLResult 与 trade payURLResponse 字段集对齐（v1.7.30 R-D-2 扩展，2026-05-23）。
//
// 字段语义：
//   - PayURL：jifei Midas 收银台 URL（前端跳转用）
//   - ExpireAt：保留位（jifei 当前未返过期时间）
//   - TokenID / OrderID / MidasAppID：jifei 协议外字段（PDF 未列、实测稳定返）；
//     **指针类型 + omitempty**：jifei 未返时为 nil，后续 JSON 序列化跳过该字段（D3 兜底）
//   - NeedCharge：1 = 需跳支付 / 0 = 已扣完
//   - Uin / AppID：用户腾讯云 uin / appId（来自 trade_order，**不是米大师商户号**）
type PayURLResult struct {
	PayURL     string  `json:"payUrl"`
	ExpireAt   string  `json:"expireAt,omitempty"`
	TokenID    *string `json:"tokenId,omitempty"`
	OrderID    *string `json:"orderId,omitempty"`
	MidasAppID *string `json:"midasAppId,omitempty"`
	NeedCharge int     `json:"needCharge"`
	Uin        string  `json:"uin,omitempty"`
	AppID      string  `json:"appId,omitempty"`
}

// GeneratePayURLOptions 拉取支付 URL 时的可选参数（v1.7.31 接口拆分新增）。
//
// 透传给 trade pay-url 端点，trade 再透传给 jifei getMidasEarmarking。
// 全部字段可选；空值时不透传（兼容现有行为）。
type GeneratePayURLOptions struct {
	Platform  string `json:"platform,omitempty"`   // "pc" / "mobile"，默认 "pc"
	WxOpenID  string `json:"wx_open_id,omitempty"` // 微信场景必填
	WxAppID   string `json:"wx_app_id,omitempty"`  // 微信场景必填，ctl 侧注入固定值
	CancelURL string `json:"cancel_url,omitempty"` // 取消支付后的前端回跳地址
	ReturnURL string `json:"return_url,omitempty"` // 完成支付后的前端回跳地址
}

// CompleteFlowRequest 与 trade /internal/trade/flows/{flow_id}/complete 入参对齐。
//
// 字段命名 snake_case 与 trade internalapi 处理 trade_flow 系列接口保持一致；
// 其它 jifei 系接口因 jifei 协议 camelCase 而采用 camelCase，trade_flow 是
// ctl ↔ trade 内部协议，无 jifei 历史包袱，统一 snake_case。
type CompleteFlowRequest struct {
	Result  string `json:"result"`            // "completed" / "failed"
	Message string `json:"message,omitempty"` // 可选错误说明
}

// DeleteResourceRequest 与 trade /internal/trade/resources/{resourceID}/delete 入参对齐。
//
// 设计稿：.tmp/trade-pass-destroy-design.md §3.5 / §4.5.3 / §11-A Q2 / Q26 / Q27
//
// 字段命名遵循 trade jifei 系接口一致的 camelCase 风格（与 PlaceOrderRequest 同范式）。
//
// 字段说明（3 字段最小集，与 placeorder/inquiry 链路一致）：
//   - UIN / AppID 必填（pass.uin / pass.app_id），由 ctl 调用方在 logic 层从 pass entity 读出后透传
//   - BundleID：trade 端在调 jifei 前按 BundleID 反查 trade.bundle_definition，
//     **同一次反查内取得 ProductCode + SubProductCode**（Q26 + Q27 拍板）
//
// 注：
//   - Q41 修订（2026-05-11）：删除 RegionID 字段。trade 内部固定 1（广州），ctl 不再透传。
//   - Q27 修订（2026-05-17）：删除 SubProductCode 字段。ctl bundle 表不持有 sub_product_code
//     （Q33/Q25/Q37 拍板），由 trade 端反查 BundleDefinition 取值（与 ProductCode 同源）。
type DeleteResourceRequest struct {
	UIN      string `json:"uin"`
	AppID    int64  `json:"appId"`
	BundleID string `json:"bundleId"`
}

// DeleteResourceResult 与 trade /internal/trade/resources/{resourceID}/delete 出参对齐。
//
// ReferenceID 由 trade 端按 `<resourceID>_<UnixNano>` 格式生成（Q20 方案 C，
// 设计稿 §3.5 / §11-A Q20）；调用方透传给前端做审计/排障。
type DeleteResourceResult struct {
	ReferenceID string `json:"referenceId"`
}

// RefundResourceRequest 与 trade /internal/trade/resources/{resourceID}/refund 入参对齐。
//
// 设计稿：.tmp/trade-pass-refund-design.md v0.7 §3 + §4
//
// 字段说明（4 字段最小集 + v0.7 加回 OwnerUin）：
//   - OwnerUin：pass.uin 转 string（必填，v0.7 加回，传递给 trade 后走进 jifei OnlineRefund
//     para 内平铺的 ownerUin 字段。trade pass 单 uin 模型下 OwnerUin == UIN（ctl pass 表
//     只存单 uin，调用方同时给两字段传同值）。
//   - UIN / AppID 必填（pass.uin / pass.app_id），由 ctl 调用方在 logic 层从 pass entity 读出后透传
//   - BundleID：trade 端在调 jifei 前按 BundleID 反查 trade.bundle_definition 取 SubProductCode
//     （与 DeleteResource 同款 Q26+Q27 拍板）
//
// **路由演进史（v0.5.1 → v0.6 → v0.7）**：
//   - v0.5.1：OwnerUin 错放到 envelope.interface.extraPara（销毁链路资源中心专有路径）
//   - v0.6（2026-06-23）：路由切到 jifei-test 非签名链路，但过度纠正地删除 OwnerUin
//   - **v0.7（2026-06-24）**：加回 OwnerUin。trade 端 OnlineRefund 与 generateDeals 同属
//     qcloud.Deal.* 接口族，para 内平铺 ownerUin（与 generateDeals.go:37 / generateDealsAndPay.go:31 /
//     getPrice.go:66 同款）。jifei-test 入口仍对 ownerUin 做硬校验，缺则返
//     returnCode=100001 "invalid ownerUin"。详见 jifeiclient/onlinerefund.go 头部 v0.7 注释。
//
// 拍板项对齐（v0.7）：
//   - Q3=a 单条退款，本 DTO 不携带批量字段
//   - Q5=a OnlineRefund 不传 category_ids / goodsCategoryId，本 DTO 不携带
//   - Q41 trade 内部固定 region，ctl 不透传 RegionID
type RefundResourceRequest struct {
	OwnerUin string `json:"ownerUin"`
	UIN      string `json:"uin"`
	AppID    int64  `json:"appId"`
	BundleID string `json:"bundleId"`
}

// RefundResourceResult 与 trade /internal/trade/resources/{resourceID}/refund 出参对齐。
//
// trade 同步透传 jifei OnlineRefund 返回的退款单号（doc §5）。本期 Q3=a 单条退款，
// dealNames[0] / bigDealIds[0] 均为单个字符串。调用方可透传给前端 / 客服面板供审计追账。
type RefundResourceResult struct {
	DealName  string `json:"dealName"`
	BigDealID string `json:"bigDealId"`
}

// InquiryBatchRequest 与 trade /internal/trade/inquiry/batch 入参 inquiryBatchRequest 字段集对齐。
//
// 设计稿 §3.4 / §10 Q-CGW-01：
//   - period / timeUnit 来自调用方 HTTP 入参（Q24 拍板，bundle 不再持有时长）
//   - 入参不带 subProductCode（Q25 拍板，trade 内部按 bundleId 查 trade_bundle_definition）
//   - ExternalUserID 是当前登录用户的业务 ID；ShadowClient 已注入时调用方可只传 ExternalUserID，
//     trade 自动反查 (Uin, AppID)
//   - 公开页未登录场景（Q31 选项 b）：ctl 不应调到本接口，前端走"无价 bundle 列表"分支
type InquiryBatchRequest struct {
	ExternalUserID string   `json:"externalUserId"`
	Uin            string   `json:"uin,omitempty"`
	AppID          string   `json:"appId,omitempty"`
	BundleIDs      []string `json:"bundleIds"`
	Period         int      `json:"period"`   // 时长数值（如 1 / 12）
	TimeUnit       string   `json:"timeUnit"` // "m" / "y"
	GoodsNum       int      `json:"goodsNum"` // 本期固定 1（Q41）
	PayMode        int      `json:"payMode"`  // 0/1/2，本期固定 1（预付，Q42）
	// 注：Q41 修订 2026-05-11 删除 RegionID 字段。trade 内部固定 1（广州），ctl 不再透传。
}

// BundleQuote 是 trade 询价响应单条 bundle 报价（用于 ctl 端 JSON 反序列化）。
//
// **字段集精简（v1.7.28 BUG-04 拍板 = C 路径）**：仅保留 ctl 业务真消费的字段
// （bundle 标识 + 价格 6 字段），删除 jifei 协议层死字段。设计原则:
//
//  1. ctl 是 lightclaw 业务层，**不应感知 jifei 协议层** product_code / sub_product_code / pid
//     等字段（这些归 trade 持有 + ELK 落日志兜底，前端排障应看后端日志而不是 response body）
//  2. bundle_name / time_span / time_unit / goods_num 是 ctl 入参回显，ctl 自己已知
//     不需要从 trade 响应反向获取
//  3. trade `QuoteResult` 仍持有完整 jifei 协议字段（trade 内部审计需要），ctl 这里只是
//     JSON 反序列化的接收 struct — Go json 默认忽略 struct 中未定义的字段，删除字段
//     不会因 trade 返了多余字段而报错
//
// 字段语义：
//   - BundleID：用于 fetchBundleQuotes map key + 审计
//   - Price / TotalCost / TaxPrice / RealTotalCost：价格（带小数字符串，单位分）
//   - Currency：币种（"CNY" 等）
//   - Discount：policyDetail.total 拍平折扣率（100 = 无折扣）
//
// 与 trade.inquiry.QuoteResult 对照：trade 端字段更全，ctl 端 BundleQuote 是其严格子集。
type BundleQuote struct {
	BundleID      string  `json:"bundle_id"`
	Price         string  `json:"price"`           // 单价（带小数字符串）
	TotalCost     string  `json:"total_cost"`      // 折扣前总价
	TaxPrice      string  `json:"tax_price"`       // 实付金额对应税额
	RealTotalCost string  `json:"real_total_cost"` // 实付总价（折扣后）
	Currency      string  `json:"currency"`        // 通常 "CNY"
	Discount      float64 `json:"discount"`        // policyDetail.total 拍平
}

// InquiryBatchResult 与 trade inquiryBatchResponse 字段集对齐。
type InquiryBatchResult struct {
	Prices []*BundleQuote `json:"prices"`
}

// InquiryRenewRequest 与 trade /internal/trade/inquiry/renew 入参 inquiryRenewRequest 字段集对齐。
//
// 设计稿：.tmp/trade-pass-renew-design.md §3.5 / §4.3 / §14（v1.7.21 B16 协议校准）/ R-C-4
//
// 与 InquiryBatchRequest 关键差异：
//   - 单 bundle 询价（续费场景下用户当前只关心自己的 pass.bundle_id），无 BundleIDs 数组
//   - 新增 ResourceID（必填）：续费目标 pass_id
//   - 新增 CurDeadline（必填，PDF §4.3 jifei goodsDetail.curDeadline 协议字段）：原资源到期时间，
//     由 ctl 调用方从 passEntity.ExpiredTime 按 "2006-01-02 15:04:05" 格式拼字符串透传
//   - 复用 ExternalUserID / Uin / AppID / BundleID / Period / TimeUnit / GoodsNum / PayMode 8 字段
//
// shadow 反查策略与 InquiryBatchRequest 一致：调用方可仅传 ExternalUserID，trade 内部反查回填。
type InquiryRenewRequest struct {
	ExternalUserID string `json:"externalUserId"`
	Uin            string `json:"uin,omitempty"`
	AppID          string `json:"appId,omitempty"`
	BundleID       string `json:"bundleId"`
	ResourceID     string `json:"resourceId"`
	CurDeadline    string `json:"curDeadline"` // PDF §4.3 续费必填; 格式 "2006-01-02 15:04:05" (与 jifei 协议字符串形态一致)
	Period         int    `json:"period"`
	TimeUnit       string `json:"timeUnit"`
	GoodsNum       int    `json:"goodsNum"`
	PayMode        int    `json:"payMode"`
}

// InquiryRenewResult 与 trade inquiryRenewResponse 字段集对齐。
//
// 形态与 InquiryBatchResult 完全一致（BundleQuote 同型）；续费询价单条结果在 prices 数组首元素，
// 调用方按 result.Prices[0] 取即可。
type InquiryRenewResult struct {
	Prices []*BundleQuote `json:"prices"`
}

// Adapter trade 服务适配器接口。
type Adapter interface {
	// InquiryBatch 调 trade POST /internal/trade/inquiry/batch 批量询价。
	//
	// 用途（迭代 8C 设计稿 §3.4 / §10 Q-CGW-01）：
	//   - ctl describeBundles handler 在拿到 ONLINE bundle 列表后调本接口拉取每个 bundle 的
	//     当前报价，回填到 user-facing UserBundleResponse.Price 字段
	//   - jifei 询价 SDK 在 trade 侧已支持单 RPC 多 bundle 询价（trade 内部串行调 jifei），
	//     ctl 一次 RPC 拿全部报价
	//
	// 错误降级语义（调用方约定）：
	//   - 任一 bundle 询价失败 → trade 返回 4xx/5xx；ctl 调用方应捕获后整批回填 nil，
	//     不阻断 bundle 列表展示（设计稿 §10 Q-CGW-01）
	InquiryBatch(ctx context.Context, req *InquiryBatchRequest) (*InquiryBatchResult, error)

	// InquiryRenew 调 trade POST /internal/trade/inquiry/renew 单 bundle 续费询价（v1.7.21 B16 / R-C-4）。
	//
	// 与 InquiryBatch 的对偶关系：
	//   - InquiryBatch  → trade.Quote()      → jifei.GetPrice (Action="purchase") — 新购询价
	//   - InquiryRenew  → trade.QuoteRenew() → jifei.GetPrice (Action="renew")    — 续费询价
	//
	// 入参带 ResourceID + CurDeadline（PDF §4.3 续费独有 2 字段），其他字段集与 InquiryBatch 一致。
	//
	// 错误集与 InquiryBatch 共用同一组 sentinel 错误（4xx → *Error）。
	InquiryRenew(ctx context.Context, req *InquiryRenewRequest) (*InquiryRenewResult, error)

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

	// PlaceDianshiOrderAndPay uses the dedicated Dianshi do_goods_and_pay path.
	// Trade rejects bundles that are not eligible for the configured activity.
	PlaceDianshiOrderAndPay(ctx context.Context, req *PlaceOrderRequest) (*PlaceOrderResult, error)

	// MoveInOrderAndPay 调 trade POST /internal/trade/orders/move-in，为存量 pass 创建外部资源迁入单。
	MoveInOrderAndPay(ctx context.Context, req *MoveInOrderRequest) (*PlaceOrderResult, error)

	// PlaceRenewOrder 调 trade POST /internal/trade/orders/renew 创建一笔续费 jifei 订单（R-D-5）。
	//
	// 设计稿：.tmp/trade-pass-renew-design.md §3.3 / §4.4
	//
	// 与 PlaceOrder 的对偶关系：
	//   - PlaceOrder       → trade.PlaceOrder       → jifei.generateDeals (新购，order_type='create')
	//   - PlaceRenewOrder  → trade.PlaceRenewOrder  → jifei.generateDeals (续费，order_type='renew',
	//                        resource_id=req.ResourceID 直接写入 trade_order)
	//
	// 出参 schema 与 PlaceOrder 一致（dealName + bigOrderId；PayURL/ExpireAt 留空走两步流程）；
	// 调用方可平滑共用 PlaceOrderResult DTO。
	//
	// 错误集与 PlaceOrder 共用同一组（4xx → *Error；5xx → 携带 status 的 *Error）。
	PlaceRenewOrder(ctx context.Context, req *PlaceRenewOrderRequest) (*PlaceOrderResult, error)

	// PlaceRenewOrderAndPay 调 trade POST /internal/trade/orders/renew/place-and-pay
	// 一体化创建续费订单 + 自动支付（R-D-7，测试链路用）。
	//
	// 设计稿：.tmp/trade-pass-renew-design.md §3.3 / §4.4 / R-D-7
	//
	// 与 PlaceRenewOrder 的差异（与 PlaceOrderAndPay vs PlaceOrder 同范式）：
	//   - PlaceRenewOrder       → jifei generateDeals 仅创建续费订单，调用方再走
	//     GeneratePayURL 拉支付 URL 引导用户付款
	//   - PlaceRenewOrderAndPay → jifei generateDealsAndPay 一体化接口，**一次调用**
	//     完成"创建续费订单 + 同步支付 + 触发 checkRenew/renewResource 回调"，
	//     跳过支付 URL；落库 status='paid_pending_provision'
	//
	// 入参 schema 与 PlaceRenewOrder 完全一致（PlaceRenewOrderRequest，9 字段含
	// ResourceID 必填）；出参亦复用 PlaceOrderResult（PayURL/ExpireAt 永远为空）。
	//
	// 使用场景：联调测试 / 自动化 e2e；现网控制台禁止暴露给真实用户（与
	// PlaceOrderAndPay 同语义）。
	PlaceRenewOrderAndPay(ctx context.Context, req *PlaceRenewOrderRequest) (*PlaceOrderResult, error)

	// GeneratePayURL 调 trade POST /internal/trade/orders/{dealName}/pay-url
	// 生成 / 反查支付页 URL。
	//
	// 8B-1.5 行为约束：trade 侧 trade_order.pay_url 缓存未命中时返 **mock URL**
	// （不再返 503 ErrPayURLUnavailable），保持调用方契约不变。
	//
	// opts 可为 nil（兼容现有行为）；非 nil 时透传 platform / wxOpenId / wxAppId 给 trade。
	GeneratePayURL(ctx context.Context, dealName string, opts *GeneratePayURLOptions) (*PayURLResult, error)

	// CompleteFlow 调 trade POST /internal/trade/flows/{flow_id}/complete
	// 推进 trade_flow 终态（trade-pass-isolate §10 Q22-I-E / 端到端闭环 2026-05-15）。
	//
	// 用途：
	//   - ctl 父 task IsolatePass markSuccess 前 best-effort 反向调本接口，
	//     trade 侧把 trade_flow.status 从 in_progress 推进到 completed/failed
	//   - flowID == 0 时调用方应直接跳过本调用（dev/test 兼容路径），不要传 0 进来
	//
	// 入参：
	//   - flowID：trade_flow.id PK，由 trade dispatcher 在 isolateResource 入口写库时生成
	//   - result：终态字符串，"completed" / "failed"，与 trade_flow.status 枚举对齐
	//   - message：可选错误说明，仅在 result="failed" 时建议带；trade 侧落 trade_flow.message 列
	//
	// 错误语义（HTTP status → 调用方分类）：
	//   - 200 OK                   trade 侧已成功推进或已是该终态（幂等）
	//   - 400 Bad Request          flowID 0 / result 非法
	//   - 401 Unauthorized         token 错误
	//   - 404 Not Found            flowID 不存在（极端场景）
	//   - 5xx                      trade 侧 DB / panic
	//
	// 调用方应将 4xx/5xx 错误视为非关键，best-effort 失败仅日志告警，不阻塞 task markSuccess。
	CompleteFlow(ctx context.Context, flowID int64, result, message string) error

	// DeleteResource 调 trade POST /internal/trade/resources/{resourceID}/delete
	// 触发 trade 端调 jifei.ModifyResourceStatus(operateName=PRE_DESTROY) 通知计费侧销毁意图。
	//
	// 设计稿：.tmp/trade-pass-destroy-design.md §3.5 / §4.5.3 / §11-A Q2 / Q26 / Q27
	//
	// 用途（入口 A：用户主动销毁链路）：
	//   - ctl.DeletePass logic 完成 isolated → deleting CAS 后，同步调本接口
	//   - trade 端同步调 jifei 网关；jifei 受理后异步反向调 trade.destroyResource
	//     开启销毁主链（ctl.DestroyPass → 销毁父 task）
	//   - **本接口仅触发 jifei 销毁意图，不直接销毁资源**；调用方收到 200 即可同步返前端
	//
	// 入参：
	//   - resourceID：pass.pass_id（path 段，trade 端用作 jifei resourcesParamSet[0].resourceIds[0]）
	//   - req：UIN / AppID / BundleID 3 字段必填（Q27 修订 2026-05-17：SubProductCode 不再入参，
	//     trade 反查 BundleDefinition 取值）
	//
	// 返回：
	//   - DeleteResourceResult.ReferenceID：trade 端生成 `<resourceID>_<UnixNano>` 格式幂等键，
	//     调用方记录用于客服排障（与前端审计链路对齐）
	//
	// 错误语义（HTTP status → 调用方分类）：
	//   - 200 OK                       trade 已成功通知 jifei
	//   - 400 InvalidRequest           入参非法（UIN/AppID/BundleID 缺失）
	//   - 401 Unauthorized             token 错误
	//   - 404 BundleDefinitionNotFound BundleID 不存在 trade.bundle_definition
	//   - 502 UpstreamBusinessError    jifei 业务错（如 returnCode != 0）
	//   - 502 UpstreamHTTPError        jifei HTTP 非 200
	//   - 502 UpstreamInvalidResponse  jifei 响应解码失败
	//   - 500 InternalError            trade 端 DB / panic
	//
	// 调用方降级策略（设计稿 §4.5.1）：
	//   - trade 调用失败时，pass.status 已是 deleting（CAS 在 trade 调用前完成），
	//     **不回滚** deleting 状态；监控兜底告警，由人工或后续 reconcile worker 处理
	DeleteResource(ctx context.Context, resourceID string, req *DeleteResourceRequest) (*DeleteResourceResult, error)

	// RefundResource 调 trade POST /internal/trade/resources/{resourceID}/refund
	// 触发 trade 端调 jifei.OnlineRefund 同步退款。
	//
	// 设计稿：.tmp/trade-pass-refund-design.md v0.5 §3 + §4 + §11 拍板项汇总
	//
	// 用途（admin 入口：后台 / 客服为指定 pass 发起退款）：
	//   - ctl.RefundPass logic 校验 pass.status='active' && 未过期 后调本接口；
	//     **不动 pass.status**（Q3=b 拍板），全程靠 jifei 同步业务码拒重调
	//   - trade 端作为**无状态翻译层**同步调 jifei OnlineRefund；
	//     jifei 同步返 dealNames[0] / bigDealIds[0] 后透传给 ctl 、ctl 透传给调用方
	//   - **后续**：jifei 异步回 isolateResource(billingIsolateType=refund) 触发现有
	//     v1.7.30 BUG-35 退费分支 → ctl IsolatePass 路径推进 pass 状态机到 isolated
	//
	// 入参：
	//   - resourceID：pass.pass_id（path 段，trade 端用作 jifei goodsInfo[sp_xxx].resourceIdList[0]）
	//   - req：UIN / AppID / BundleID 3 字段必填（与 DeleteResource 同款，SubProductCode
	//     由 trade 反查 BundleDefinition 取值，ctl 不透传）
	//
	// 返回：
	//   - RefundResourceResult.DealName：jifei 退款小订单号，调用方透传给前端做审计追账
	//   - RefundResourceResult.BigDealID：jifei 退款大订单号
	//
	// 错误语义（HTTP status → 调用方分类）：
	//   - 200 OK                       trade 同步调 jifei 成功，dealName / bigDealId 已返
	//   - 400 InvalidRequest           入参非法（UIN/AppID/BundleID 缺失）
	//   - 401 Unauthorized             token 错误
	//   - 404 BundleDefinitionNotFound BundleID 不存在 trade.bundle_definition
	//   - 502 UpstreamBusinessError    jifei 业务错（returnCode != 0），含：
	//     - 101103 订单未发货完成 → 调用方可提示“请稍后重试”
	//     - allowReturn != 1 → sp_xxx 业务侧拒绝退款（如免费试用 bundle）
	//     - pid not found → jifei 价格表缺失
	//   - 502 UpstreamHTTPError        jifei HTTP 非 200 / 网络错
	//   - 502 UpstreamInvalidResponse  jifei 响应解码失败 或 returnCode=0 但 dealNames/bigDealIds 为空
	//   - 500 InternalError            trade 端基础设施错（DB / panic / 反序列化等）
	//
	// 调用方重试策略（设计稿 Q7=a 拍板）：
	//   - 本期不做自动重试，任何失败透传错误码 + message 给 admin 面板
	//   - 双击 / 重试场景代价（Q8b=b 拍板）：jifei 会拒 101103 / allowReturn!=1，调用方
	//     看到“已退款”提示；不会产生多笔退款资金损失
	RefundResource(ctx context.Context, resourceID string, req *RefundResourceRequest) (*RefundResourceResult, error)

	// QueryOrderStatus 调 trade POST /internal/trade/orders/{dealName}/query-status
	// 订单状态反查（v1.7.32 引入，详见 .tmp/ctl-order-status-query-design.md §5.5）。
	//
	// **ctl 一次性 RPC** —— trade 内部完成所有 trade_order 状态机逻辑（B1 本地终态短路 +
	// B4 越权校验 + jifei.getDealsByKeyIndex 反查 + B2 DB 同步），ctl 透明。
	//
	// 入参：
	//   - dealName：jifei 子订单号，必填。
	//   - externalUserID：当前请求用户的 lightclaw user_id（来自 X-User-Id），必填，
	//     trade 会用它做 B4 越权校验（不匹配返 404 ORDER_NOT_FOUND）。
	//
	// 错误语义（与 GeneratePayURL / DeleteResource 同范式）：
	//   - 200【含 B7 降级】→ 返 *OrderStatusResult（如果 jifei 不可达，result.Source="local" + UpstreamErr 非空）
	//   - 400 InvalidRequest → *Error（dealName 空 / external_user_id 空 / JSON 非法）
	//   - 404 OrderNotFound → *Error（trade_order 不存在 / B4 越权兜底，不区分）
	//   - 5xx InternalError → *Error
	//
	// **重要**：B7 jifei 不可达场景（200 + Source="local"）**不是错误**，调用方需检查
	// result.Source / result.UpstreamErr 字段判断是否为降级路径。
	QueryOrderStatus(ctx context.Context, dealName, externalUserID string) (*OrderStatusResult, error)

	// ListDianshiRecords 查询点石来源订单和活动参与记录，供 admin 后台排障/重试下单。
	ListDianshiRecords(ctx context.Context, filter DianshiRecordFilter) (*DianshiRecordsResult, error)

	// DeleteDianshiOrder 删除点石来源订单，供 admin 后台清理后重试下单。
	DeleteDianshiOrder(ctx context.Context, dealName string) (*DeleteDianshiRecordResult, error)

	// DeleteDianshiParticipation 删除点石活动参与记录，供 admin 后台清理后重试下单。
	DeleteDianshiParticipation(ctx context.Context, id int64) (*DeleteDianshiRecordResult, error)
}

// Config trade 适配器配置（与 ShadowConfig / AiGatewayConfig 风格一致）。
type Config struct {
	BaseURL string `toml:"base_url"` // trade 服务内部地址，如 http://trade.lightclaw.svc.cluster.local
	Token   string `toml:"token"`    // Bearer Token，与 trade LIGHTCLAW_INTERNAL_SERVICE_TOKEN 一致
	Timeout int    `toml:"timeout"`  // 请求超时（秒），默认 30（v1.7.32 从 10s 提升）
}

type adapter struct {
	config *Config
	client *http.Client
	logger *zap.Logger
}

// defaultTradeTimeout 是 trade 适配器默认 HTTP 请求超时（v1.7.32 从 10s 提升到3s>；原因：
//
//	jifei.qcloud.Deal.generateDealsAndPay / inquiryRenew 同步动作实测稳定 8~15s，
//	原 10s 默认贴近业务上限，一旦游戏环境 jifei mock 陯峰就超时；且 http.Client.Timeout
//	与 caller 传入的 ctx.Deadline 取两者较小值，logic.go 里写的 30s ctx 会被 10s
//	客户端 Timeout 压死（v1.7.32 现网 BUG：产环 ConfigMap 手工设 5s 进一步诱发下单
//	assumed-fail：实际上 trade 后端已受理并下发 jifei，ctl 这边却已 5s 断连重试）。
const defaultTradeTimeout = 30 * time.Second

// NewTradeAdapter 创建 trade 适配器。
func NewTradeAdapter(cfg *Config, logger *zap.Logger) Adapter {
	if cfg == nil {
		cfg = &Config{}
	}
	timeout := time.Duration(cfg.Timeout) * time.Second
	if timeout <= 0 {
		timeout = defaultTradeTimeout
	}
	// 逻辑层 InquiryRenew 走 15s、PlaceOrderAndPay / PlaceRenewOrderAndPay 走 30s ctx；
	// 这里 client.Timeout 必须 >= 业务侧 ctx 超时上限，否则会提前“假超时”。
	// 10s 以下设置几乎可以认为是配置误取值，走 warn 提醒（不抹平避免运维有意调低）。
	if logger != nil && timeout < 10*time.Second {
		logger.Warn("trade adapter timeout too small, may truncate caller ctx",
			zap.Duration("timeout", timeout),
			zap.Duration("recommended_min", 10*time.Second),
			zap.Duration("recommended_default", defaultTradeTimeout))
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
	Status   int    // HTTP 状态码
	Code     string // trade 返回的业务错误码（如 BundleNotFound / BindingNotFound）
	Message  string // trade 返回的错误消息
	Endpoint string // 调用的端点路径（用于日志）
}

// Error 实现 error 接口。
func (e *Error) Error() string {
	if e == nil {
		return ""
	}
	return fmt.Sprintf("trade adapter: %s -> %d %s: %s",
		e.Endpoint, e.Status, e.Code, e.Message)
}

func (a *adapter) InquiryBatch(ctx context.Context, req *InquiryBatchRequest) (*InquiryBatchResult, error) {
	if a.config.BaseURL == "" {
		return nil, fmt.Errorf("trade adapter: base_url not configured")
	}
	if req == nil {
		return nil, fmt.Errorf("trade adapter: InquiryBatch request is nil")
	}
	if len(req.BundleIDs) == 0 {
		return nil, fmt.Errorf("trade adapter: InquiryBatch: bundleIds is required")
	}

	endpoint := strings.TrimRight(a.config.BaseURL, "/") + "/internal/trade/inquiry/batch"
	var result InquiryBatchResult
	if err := a.doJSON(ctx, http.MethodPost, endpoint, req, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// InquiryRenew 详见 Adapter.InquiryRenew 接口注释（v1.7.21 B16 / R-C-4 续费询价）。
func (a *adapter) InquiryRenew(ctx context.Context, req *InquiryRenewRequest) (*InquiryRenewResult, error) {
	if a.config.BaseURL == "" {
		return nil, fmt.Errorf("trade adapter: base_url not configured")
	}
	if req == nil {
		return nil, fmt.Errorf("trade adapter: InquiryRenew request is nil")
	}
	if strings.TrimSpace(req.BundleID) == "" {
		return nil, fmt.Errorf("trade adapter: InquiryRenew: bundleId is required")
	}
	if strings.TrimSpace(req.ResourceID) == "" {
		return nil, fmt.Errorf("trade adapter: InquiryRenew: resourceId is required")
	}
	if strings.TrimSpace(req.CurDeadline) == "" {
		return nil, fmt.Errorf("trade adapter: InquiryRenew: curDeadline is required")
	}

	endpoint := strings.TrimRight(a.config.BaseURL, "/") + "/internal/trade/inquiry/renew"
	var result InquiryRenewResult
	if err := a.doJSON(ctx, http.MethodPost, endpoint, req, &result); err != nil {
		return nil, err
	}
	return &result, nil
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

func (a *adapter) PlaceDianshiOrderAndPay(ctx context.Context, req *PlaceOrderRequest) (*PlaceOrderResult, error) {
	if a.config.BaseURL == "" {
		return nil, fmt.Errorf("trade adapter: base_url not configured")
	}
	if req == nil {
		return nil, fmt.Errorf("trade adapter: PlaceDianshiOrderAndPay request is nil")
	}

	endpoint := strings.TrimRight(a.config.BaseURL, "/") + "/internal/trade/dianshi/orders/place-and-pay"
	var result PlaceOrderResult
	if err := a.doJSON(ctx, http.MethodPost, endpoint, req, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

func (a *adapter) MoveInOrderAndPay(ctx context.Context, req *MoveInOrderRequest) (*PlaceOrderResult, error) {
	if a.config.BaseURL == "" {
		return nil, fmt.Errorf("trade adapter: base_url not configured")
	}
	if req == nil {
		return nil, fmt.Errorf("trade adapter: MoveInOrderAndPay request is nil")
	}

	endpoint := strings.TrimRight(a.config.BaseURL, "/") + "/internal/trade/orders/move-in"
	var result PlaceOrderResult
	if err := a.doJSON(ctx, http.MethodPost, endpoint, req, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// PlaceRenewOrder 详见 Adapter.PlaceRenewOrder 接口注释（trade-pass-renew §3.3 / §4.4 / R-D-5）。
func (a *adapter) PlaceRenewOrder(ctx context.Context, req *PlaceRenewOrderRequest) (*PlaceOrderResult, error) {
	if a.config.BaseURL == "" {
		return nil, fmt.Errorf("trade adapter: base_url not configured")
	}
	if req == nil {
		return nil, fmt.Errorf("trade adapter: PlaceRenewOrder request is nil")
	}

	endpoint := strings.TrimRight(a.config.BaseURL, "/") + "/internal/trade/orders/renew"
	var result PlaceOrderResult
	if err := a.doJSON(ctx, http.MethodPost, endpoint, req, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// PlaceRenewOrderAndPay 详见 Adapter.PlaceRenewOrderAndPay 接口注释（trade-pass-renew §3.3 / §4.4 / R-D-7）。
func (a *adapter) PlaceRenewOrderAndPay(ctx context.Context, req *PlaceRenewOrderRequest) (*PlaceOrderResult, error) {
	if a.config.BaseURL == "" {
		return nil, fmt.Errorf("trade adapter: base_url not configured")
	}
	if req == nil {
		return nil, fmt.Errorf("trade adapter: PlaceRenewOrderAndPay request is nil")
	}

	endpoint := strings.TrimRight(a.config.BaseURL, "/") + "/internal/trade/orders/renew/place-and-pay"
	var result PlaceOrderResult
	if err := a.doJSON(ctx, http.MethodPost, endpoint, req, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

func (a *adapter) GeneratePayURL(ctx context.Context, dealName string, opts *GeneratePayURLOptions) (*PayURLResult, error) {
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

	// opts 非 nil 时作为 body 透传；否则传 nil 兼容现有行为（trade 端点接受空 body）。
	var body interface{}
	if opts != nil && (opts.Platform != "" || opts.WxOpenID != "" || opts.WxAppID != "" ||
		opts.CancelURL != "" || opts.ReturnURL != "") {
		body = opts
	}

	var result PayURLResult
	if err := a.doJSON(ctx, http.MethodPost, endpoint, body, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// CompleteFlow 详见 Adapter.CompleteFlow 接口注释（trade-pass-isolate §10 Q22-I-E）。
func (a *adapter) CompleteFlow(ctx context.Context, flowID int64, result, message string) error {
	if a.config.BaseURL == "" {
		return fmt.Errorf("trade adapter: base_url not configured")
	}
	if flowID <= 0 {
		return fmt.Errorf("trade adapter: CompleteFlow: flowID must be > 0")
	}
	result = strings.TrimSpace(result)
	if result == "" {
		return fmt.Errorf("trade adapter: CompleteFlow: result is required")
	}

	endpoint := strings.TrimRight(a.config.BaseURL, "/") +
		fmt.Sprintf("/internal/trade/flows/%d/complete", flowID)

	body := &CompleteFlowRequest{
		Result:  result,
		Message: message,
	}
	// trade 侧返回空 body / { } 都可以接受；不解析 respBody。
	return a.doJSON(ctx, http.MethodPost, endpoint, body, nil)
}

// DeleteResource 详见 Adapter.DeleteResource 接口注释（trade-pass-destroy §3.5 / §4.5.3 / §11-A Q2 / Q26 / Q27）。
func (a *adapter) DeleteResource(ctx context.Context, resourceID string, req *DeleteResourceRequest) (*DeleteResourceResult, error) {
	if a.config.BaseURL == "" {
		return nil, fmt.Errorf("trade adapter: base_url not configured")
	}
	resourceID = strings.TrimSpace(resourceID)
	if resourceID == "" {
		return nil, fmt.Errorf("trade adapter: DeleteResource: resourceID is required")
	}
	if req == nil {
		return nil, fmt.Errorf("trade adapter: DeleteResource: request is nil")
	}

	// resourceID 走 path 段；jifei resource id 当前观测无特殊字符，仍做 PathEscape 防御
	// （与 GeneratePayURL 同范式）。
	endpoint := strings.TrimRight(a.config.BaseURL, "/") +
		"/internal/trade/resources/" + url.PathEscape(resourceID) + "/delete"

	var result DeleteResourceResult
	if err := a.doJSON(ctx, http.MethodPost, endpoint, req, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// RefundResource 详见 Adapter.RefundResource 接口注释（trade-pass-refund-design.md v0.5）。
//
// HTTP 调用骨架与 DeleteResource 完全对偶： path escape 同范式 / doJSON 同错误模型。
func (a *adapter) RefundResource(ctx context.Context, resourceID string, req *RefundResourceRequest) (*RefundResourceResult, error) {
	if a.config.BaseURL == "" {
		return nil, fmt.Errorf("trade adapter: base_url not configured")
	}
	resourceID = strings.TrimSpace(resourceID)
	if resourceID == "" {
		return nil, fmt.Errorf("trade adapter: RefundResource: resourceID is required")
	}
	if req == nil {
		return nil, fmt.Errorf("trade adapter: RefundResource: request is nil")
	}

	endpoint := strings.TrimRight(a.config.BaseURL, "/") +
		"/internal/trade/resources/" + url.PathEscape(resourceID) + "/refund"

	var result RefundResourceResult
	if err := a.doJSON(ctx, http.MethodPost, endpoint, req, &result); err != nil {
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
