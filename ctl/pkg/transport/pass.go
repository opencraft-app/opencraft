package transport

import "time"

// === Pass Transport DTOs ===

// CreateTrialPassRequest 创建试用权益请求
// 有效期由 Bundle 的 time_span + time_unit 决定，调用方不指定
type CreateTrialPassRequest struct {
	UserID   string `json:"user_id,omitempty"` // 后台管理时指定；用户接口自动取当前登录用户
	BundleID string `json:"bundle_id"`
}

// CompletePassRequest trade 反向回调 ctl 完成付费 pass 发货请求（v4 收敛：B3 新增）
//
// 调用方：trade 服务在收到 jifei createResource 回调后透传字段调用
//
//	POST /internal/ctl/passes/complete（鉴权：CTL_INTERNAL_TOKEN）
//
// 字段来源：jifei 协议层 createResource 入参 + trade_order 已落库字段
type CompletePassRequest struct {
	UserID    string `json:"user_id"`              // jifei externalUserId（必填）
	BundleID  string `json:"bundle_id"`            // 套餐 ID（必填）
	TimeSpan  int    `json:"time_span"`            // 时长数值（必填，>0）
	TimeUnit  string `json:"time_unit"`            // 时长单位 "m"（月）/ "d"（天）（必填）
	Uin       int64  `json:"uin"`                  // 腾讯云主账号 uin（必填）
	AppID     int64  `json:"app_id"`               // 腾讯云 appId（必填）
	DealName  string `json:"deal_name"`            // jifei 订单号（必填，仅记日志，pass 表不持久化）
	RenewFlag string `json:"renew_flag,omitempty"` // 续费标记，v4 收敛：协议层预留字段，本期 logic 内部写死 MANUAL_RENEW，trade 透传值暂不生效
}

// ModifyPassRequest 修改权益请求
type ModifyPassRequest struct {
	PassID      string     `json:"pass_id"`
	BundleID    *string    `json:"bundle_id,omitempty"`
	ExpiredTime *time.Time `json:"expired_time,omitempty"`
}

// PassResponse 单个 Pass 响应
type PassResponse struct {
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

	// Credit 字段（CTL 运行时填充）
	CreditTotal     int64 `json:"credit_total"`
	CreditAvailable int64 `json:"credit_available"`
}

// ListPassesResponse 查询 Pass 列表响应
type ListPassesResponse struct {
	Passes []*PassResponse `json:"passes"`
}

// CreatePassOrderRequest 创建付费 pass 订单请求（billing-integration B2 新增）
//
// 用途：用户在控制台选择付费 bundle 后，由前端 / 控制台调本接口下一笔 jifei 订单
// 并返回支付页 URL。本接口**不创建本地 pass**，pass 的最终发货发生在 jifei
// 计费回调链路：jifei → trade.checkCreate → trade.createResource → ctl.CompletePass。
//
// 与 CreateTrialPassRequest 的差异：
//   - CreateTrial：试用 bundle，无需走 jifei，直接生成 pass
//   - CreatePassOrder：付费 bundle，需要先下单 + 拿支付 URL，发货在回调链路
//
// 字段语义：
//   - BundleID：必填，付费 bundle 的标识
//   - Period / TimeUnit：用户选择的购买时长（如 1 个月、3 个月）；trade 持有此参数
//     用于回调时透传到 ctl.CompletePass 计算 expired_time
type CreatePassOrderRequest struct {
	BundleID string `json:"bundle_id"`
	Period   int    `json:"period"`
	TimeUnit string `json:"time_unit"` // "m"（月）/ "d"（天）
}

// CreatePassOrderResult 创建付费 pass 订单响应（billing-integration B2 新增）
//
// 字段语义：
//   - DealName：jifei 订单号，调用方记录用于客服排障
//   - PayURL：支付页 URL；调用方应跳转此 URL 完成支付。8B-1.5 阶段：
//     trade 侧 GeneratePayURL 在 jifei SDK 接入前会返一个 mock URL，
//     真实的可点击支付 URL 待 jifei "生成支付url" SDK 接入完成后切换。
type CreatePassOrderResult struct {
	DealName string `json:"deal_name"`
	PayURL   string `json:"pay_url"`
}

// CreatePassOrderAndPayResult 一体化创建付费 pass 订单 + 支付的响应（billing-integration B2 新增）
//
// **仅用于联调测试 / 自动化 e2e**，现网控制台禁止暴露此入口给真实用户。
//
// 与 CreatePassOrderResult 的差异：
//   - 不返 PayURL：trade.PlaceOrderAndPay 调 jifei `qcloud.Deal.generateDealsAndPay`
//     一次完成 "下单 + 支付 + 触发 createResource 回调"，跳过支付 URL 概念
//   - 新增 BigOrderID：方便测试时反查 jifei 控制台
//
// 复用 CreatePassOrderRequest 作为入参（字段集完全相同：bundle_id / period / time_unit）。
type CreatePassOrderAndPayResult struct {
	DealName   string `json:"deal_name"`
	BigOrderID string `json:"big_order_id"`
}
