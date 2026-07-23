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
	DealName  string `json:"deal_name"`            // jifei 订单号（必填，用于生成 ai-gateway 订阅幂等键；pass 表不持久化）
	RenewFlag string `json:"renew_flag,omitempty"` // 续费标记，v4 收敛：协议层预留字段，本期 logic 内部写死 MANUAL_RENEW，trade 透传值暂不生效
}

// PassBillingMigrationRequest 通知 ctl 尝试把存量免费 pass 迁移到计费资源。
//
// auth 只传影子账号绑定结果，不传目标套餐；source/target bundle 由 ctl 业务策略决定。
type PassBillingMigrationRequest struct {
	UserID string `json:"user_id"`
	Uin    int64  `json:"uin"`
	AppID  int64  `json:"app_id"`
}

type PassBillingMigrationResult struct {
	Status     string `json:"status"`
	PassID     string `json:"pass_id,omitempty"`
	BundleID   string `json:"bundle_id,omitempty"`
	DealName   string `json:"deal_name,omitempty"`
	BigOrderID string `json:"big_order_id,omitempty"`
	Message    string `json:"message,omitempty"`
}

// TransferPassRequest 是 trade 在 jifei transferResource 回调后反向调用 ctl 的请求。
//
// 本接口只迁移既有免费 pass 的计费归属，不创建 pass、不改 quota/subscription。
type TransferPassRequest struct {
	PassID         string `json:"pass_id"`
	UserID         string `json:"user_id,omitempty"`
	SourceBundleID string `json:"source_bundle_id,omitempty"`
	TargetBundleID string `json:"target_bundle_id"`
	OldUin         int64  `json:"old_uin"`
	OldAppID       int64  `json:"old_app_id"`
	NewUin         int64  `json:"new_uin"`
	NewAppID       int64  `json:"new_app_id"`
	DealName       string `json:"deal_name"`
	BigOrderID     string `json:"big_order_id,omitempty"`
}

// ModifyPassRequest 修改权益请求
type ModifyPassRequest struct {
	PassID      string     `json:"pass_id"`
	BundleID    *string    `json:"bundle_id,omitempty"`
	ExpiredTime *time.Time `json:"expired_time,omitempty"`
}

// PassResponse 单个 Pass 响应（admin / internal 接口使用）
//
// **不要直接用于用户面 /v1/passes**：
// uin / app_id / deleted_time / renew_flag 是 lightclaw / 腾讯云内部概念，用户面应使用
// UserPassResponse（v1.7.23 B18 引入）。
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

	// Status pass 状态机字段（trade-pass-isolate 引入；与 ctl_pass.status 同源）。
	// 值域：active / isolating / isolated / deleting。前端展示 + trade 反查 + jifei
	// 隔离状态联动用。
	Status string `json:"status"`

	// Credit 字段（CTL 运行时填充）
	CreditTotal         int64 `json:"credit_total"`
	CreditAvailable     int64 `json:"credit_available"`
	FreeCreditTotal     int64 `json:"free_credit_total"`
	FreeCreditAvailable int64 `json:"free_credit_available"`

	// AgentQuota 字段（v1.7.23 B18 新增, v1.7.24 B19 修订；CTL 运行时填充，DB 不持久化）
	//   - AgentQuotaTotal     = user_resource_quota.total
	//   - AgentQuotaAvailable = user_resource_quota.available
	AgentQuotaTotal     int64 `json:"agent_quota_total"`
	AgentQuotaAvailable int64 `json:"agent_quota_available"`

	// RenewFlag 续费标记（billing-integration B11A 新增；§11 Q10 拍板 2026-05-11）
	//   - "MANUAL_RENEW"（手动续费，默认）
	//   - "AUTO_RENEW"（自动续费，本期未启用）
	// 反查侧透传 pass.renew_flag 真值，trade 端按映射规则转换为 jifei renewFlag (0/1)
	RenewFlag string `json:"renew_flag"`
}

// ListPassesResponse 查询 Pass 列表响应（admin / internal 接口使用）
type ListPassesResponse struct {
	Passes   []*PassResponse `json:"passes"`
	Total    int64           `json:"total,omitempty"`
	Page     int             `json:"page,omitempty"`
	PageSize int             `json:"page_size,omitempty"`
}

// UserPassResponse 是用户面 GET /v1/passes / POST /v1/passes 响应单条 pass（v1.7.23 B18）。
//
// 字段集是 PassResponse 的子集 — 删除 lightclaw / 腾讯云内部概念字段：
//   - uin / app_id：腾讯云主账号 / 应用 ID，用户不感知（lightclaw 内部 SaaS 用户与
//     腾讯云账号的映射只在服务端审计 / jifei 反查链路中使用）
//   - deleted_time：DB 字段后期会删除（pass 销毁后会迁到 history_pass 表）
//   - renew_flag：本期未启用自动续费（§11 Q5 拍板，待支持自动续费时再加回）
//
// 保留：pass_id / user_id / bundle_id / bundle_name / 时间字段（除 deleted_time）/
// agent_quota_total / agent_quota_available / credit_total / credit_available
type UserPassResponse struct {
	PassID       string     `json:"pass_id"`
	UserID       string     `json:"user_id"`
	BundleID     string     `json:"bundle_id"`
	BundleName   string     `json:"bundle_name"`
	CreatedTime  time.Time  `json:"created_time"`
	ExpiredTime  time.Time  `json:"expired_time"`
	IsolatedTime *time.Time `json:"isolated_time"`
	UpdatedTime  time.Time  `json:"updated_time"`

	// Status pass 状态机字段（trade-pass-isolate 引入；与 ctl_pass.status 同源）。
	// 值域：active / isolating / isolated / deleting。供用户面前端展示当前 pass
	// 是否处于隔离 / 销毁中状态。
	Status string `json:"status"`

	// AgentQuota 配额（v1.7.23 B18）
	AgentQuotaTotal     int64 `json:"agent_quota_total"`
	AgentQuotaAvailable int64 `json:"agent_quota_available"`

	// Credit 积分
	CreditTotal         int64 `json:"credit_total"`
	CreditAvailable     int64 `json:"credit_available"`
	FreeCreditTotal     int64 `json:"free_credit_total"`
	FreeCreditAvailable int64 `json:"free_credit_available"`
}

// ListUserPassesResponse 用户面查询 Pass 列表响应（v1.7.23 B18，对偶 ListPassesResponse）
type ListUserPassesResponse struct {
	Passes []*UserPassResponse `json:"passes"`
}

// GrantFreeCreditRequest 后台给用户发放免费/额外积分。
//
// CTL 只负责业务命名和过期时间绑定；LLMGateway 只看到一条普通 named subscription。
type GrantFreeCreditRequest struct {
	UserID         string `json:"user_id"`
	PlanID         string `json:"plan_id"`
	Source         string `json:"source,omitempty"`
	IdempotencyKey string `json:"idempotency_key"`
}

type GrantFreeCreditResponse struct {
	UserID           string    `json:"user_id"`
	PlanID           string    `json:"plan_id"`
	SubscriptionID   string    `json:"subscription_id"`
	SubscriptionName string    `json:"subscription_name"`
	PeriodEnd        time.Time `json:"period_end"`
}

// === jifei 反查接口三件套 transport DTOs（billing-integration B11A 新增）===
// 设计稿：.tmp/trade-resource-query-design.md §4.1

// ListPassAppIDsResponse 反查 app_id 列表响应（jifei.getAllAppIds）
//
// 用途：trade.getAllAppIds 反查使用；ctl 按 bundle_ids（可空） + 分页返回去重 app_id 列表
type ListPassAppIDsResponse struct {
	AppIDs []int64 `json:"app_ids"`
	Total  int64   `json:"total"`
}

// ListPassesWithTotalResponse 带 total 的 pass 列表响应
//
// 用途：trade.getUserResources / trade.queryResource 反查使用
//
// 与 ListPassesResponse 的差异：附加 Total 字段，便于 trade 端拼装 jifei 协议的
// `pageInfo.total` 字段（jifei 要求按总数 + 分页约束做客户端二次校验）。
type ListPassesWithTotalResponse struct {
	Passes []*PassResponse `json:"passes"`
	Total  int64           `json:"total"`
}

// ListPassesByResourceIDsRequest 按 pass_id 集合反查请求
//
// 用途：jifei.queryResource 反查链路；trade → ctl POST /internal/ctl/passes/by-resource-ids
//
// 校验规则（与 jifei PDF "至少支持 100" 对齐）：
//   - app_id > 0
//   - len(pass_ids) >= 1 && <= 100
type ListPassesByResourceIDsRequest struct {
	AppID   int64    `json:"app_id"`
	PassIDs []string `json:"pass_ids"`
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

// CreatePassOrderResult 创建付费 pass 订单响应（v1.7.31 接口拆分：仅返 deal_names）
//
// 字段语义：
//   - DealNames：jifei 订单号列表；当前单订单场景固定 1 元素，为后续多订单可扩展预留
//   - AuthCode：v1.7.32 新增，一次性鉴权 ticket（UUID v4 字符串），由 ctl 签发后
//     写到二维码里，供中转页（无 Bearer）调 order-url 时反查 user_id；签发失败时返
//     空字符串走容错降级（设计稿 .tmp/ctl-authcode-codebuddy-design.md A8 不变量）
type CreatePassOrderResult struct {
	DealNames []string `json:"deal_names"`
	AuthCode  string   `json:"auth_code,omitempty"`
}

// CreatePassOrderUrlRequest 拉取支付 URL 请求（v1.7.31 接口拆分新增）
//
// 用途：前端拿到 deal_names 后，调本接口获取支付页 URL。
//
// 字段语义：
//   - DealNames：必填，来自 CreatePassOrder 返回的订单号列表
//   - Platform：可选，默认 "pc"；可选值 "pc" / "mobile"（透传给 jifei getMidasEarmarking.platform）
//   - WxOpenID：可选，微信公众号/小程序场景必填（透传给 jifei getMidasEarmarking.wxOpenId）
//   - AuthCode：v1.7.32 新增，可选；中转页（无 Bearer）必填，由 ctl 解析后反查
//     user_id 进行鉴权；PC 端 Bearer 链路忽略此字段。详见设计稿
//     .tmp/ctl-authcode-codebuddy-design.md A2 / A5 不变量
type CreatePassOrderUrlRequest struct {
	DealNames []string `json:"deal_names"`
	Platform  string   `json:"platform,omitempty"`
	WxOpenID  string   `json:"wx_open_id,omitempty"`
	AuthCode  string   `json:"auth_code,omitempty"`
}

// CreatePassOrderUrlResult 拉取支付 URL 响应（v1.7.31 接口拆分新增）
//
// 字段语义（与拆分前 CreatePassOrderResult 字段集一致）：
//   - DealName：jifei 订单号，调用方记录用于客服排障
//   - PayURL：支付页 URL；调用方应跳转此 URL 完成支付
//   - TokenID：米大师支付 token；前端跳 Midas SDK 用（D3 兜底：jifei 未返时为 nil/null）
//   - OrderID：米大师订单号（= jifei outTradeNo / billId，与 DealName 不同源）；同上 D3 兜底
//   - MidasAppID：米大师商户 appid（同上 D3 兜底）；前端跳 SDK 时透传给米大师
//   - NeedCharge：1 = 需跳支付 / 0 = 零元单已成功
//   - Uin / AppID：用户腾讯云 uin / appId（来自 trade_order，**不是米大师商户号**）
type CreatePassOrderUrlResult struct {
	DealName   string  `json:"deal_name"`
	PayURL     string  `json:"pay_url"`
	TokenID    *string `json:"token_id,omitempty"`
	OrderID    *string `json:"order_id,omitempty"`
	MidasAppID *string `json:"midas_app_id,omitempty"`
	NeedCharge int     `json:"need_charge"`
	Uin        string  `json:"uin,omitempty"`
	AppID      string  `json:"app_id,omitempty"`
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

// === trade-pass-renew transport DTO（设计稿 §3.3 / §4.4 / R-D-5）===
//
// 入口：POST /internal/ctl/passes/{pass_id}/renew/order-url
//
// 用途：用户点击"续费"按钮后，前端调本接口拿到支付页 URL；用户在浏览器付款完成后，
// jifei 异步回调 trade.checkRenew + trade.renewResource → ctl.RenewPass 推进续费。
//
// 与 CreatePassOrderRequest 的对偶关系：
//   - CreatePassOrder：新购，不需要 pass_id（pass 还不存在）
//   - RenewPassOrderUrl：续费，pass_id 来自 path param（控制台已知用户当前的 pass）
//   - 复用 Period / TimeUnit 字段（语义相同）；不复用 BundleID（续费不能换 bundle，由 ctl 内部从 pass 取）

// RenewPassOrderRequest 续费下单请求（v1.7.31 接口拆分：从 RenewPassOrderUrl 拆出下单部分）
//
// 字段说明：
//   - Period / TimeUnit：续费时长；与 CreatePassOrderRequest 同语义
//
// 关键约束（用户 2026-05-20 拍板）：
//   - **不允许传 bundle_id**（v1.7.22 B17 删除字段）：续费不能换 bundle，bundle_id 由 ctl
//     内部从 passEntity.BundleID 取值。前端如有"切换 bundle"诉求请走变配（modify）链路而非续费。
//   - pass_id 走 path param，不在 body 中（与 IsolatePass 的 path param 设计一致）
//   - CurDeadline 由 ctl 内部从 passEntity.ExpiredTime 拼字符串透传给 trade，前端不感知
type RenewPassOrderRequest struct {
	Period   int    `json:"period"`
	TimeUnit string `json:"time_unit"` // "m" / "d" / "y"（§12 Q19=b 全链路放开）
}

// RenewPassOrderResult 续费下单响应（v1.7.31 接口拆分：仅返 deal_names）
//
// 字段语义：
//   - DealNames：jifei 续费订单号列表；当前单订单场景固定 1 元素，为后续多订单可扩展预留
//   - AuthCode：v1.7.32 新增，一次性鉴权 ticket（UUID v4 字符串），与新购同范式；
//     续费签发的 ticket 额外绑定 pass_id（A3 不变量），跨 pass 撞 ticket 返 403
type RenewPassOrderResult struct {
	DealNames []string `json:"deal_names"`
	AuthCode  string   `json:"auth_code,omitempty"`
}

// RenewPassOrderUrlRequest 拉取续费支付 URL 请求（v1.7.31 接口拆分改造）
//
// 字段说明：
//   - DealNames：必填，来自 RenewPassOrder 返回的订单号列表
//   - Platform：可选，默认 "pc"；可选值 "pc" / "mobile"（透传给 jifei getMidasEarmarking.platform）
//   - WxOpenID：可选，微信公众号/小程序场景必填（透传给 jifei getMidasEarmarking.wxOpenId）
//
// 关键约束：
//   - pass_id 走 path param，不在 body 中（与 IsolatePass 的 path param 设计一致）
//   - 需校验 pass 持有人匹配（deal_name 本身不含 pass 归属信息）
//
// AuthCode 字段（v1.7.32 新增）：与 CreatePassOrderUrlRequest 同范式；中转页
// 续费链路凭 ticket 反查 user_id；ticket 必须额外匹配 path param 的 pass_id
// （A3 不变量），否则返 403。
type RenewPassOrderUrlRequest struct {
	DealNames []string `json:"deal_names"`
	Platform  string   `json:"platform,omitempty"`
	WxOpenID  string   `json:"wx_open_id,omitempty"`
	AuthCode  string   `json:"auth_code,omitempty"`
}

// RenewPassOrderUrlResult 续费下单+拉支付 URL 响应（R-D-5）
//
// 字段语义：
//   - DealName：jifei 续费订单号，调用方记录用于客服排障
//   - PayURL：支付页 URL；调用方应跳转此 URL 完成支付（与新购 PayURL 同语义，
//     8B-1.6 阶段已支持真实 jifei SDK 拉 midas earmarking URL）
//
// RenewPassOrderUrlResult 续费下单+拉支付 URL 响应（R-D-5，v1.7.30 扩字段）
//
// 与 CreatePassOrderResult 字段集完全一致（跳转付费体验同语义）；调用方可平滑共用展示逻辑。
// 各字段语义详 CreatePassOrderResult 文档。
type RenewPassOrderUrlResult struct {
	DealName   string  `json:"deal_name"`
	PayURL     string  `json:"pay_url"`
	TokenID    *string `json:"token_id,omitempty"`
	OrderID    *string `json:"order_id,omitempty"`
	MidasAppID *string `json:"midas_app_id,omitempty"`
	NeedCharge int     `json:"need_charge"`
	Uin        string  `json:"uin,omitempty"`
	AppID      string  `json:"app_id,omitempty"`
}

// === trade-pass-renew transport DTO 一体化变体（设计稿 §3.3 / §4.4 / R-D-7）===
//
// 入口：POST /v1/passes/{pass_id}/renew/order-and-pay         前端 e2e
//       POST /admin/api/ctl/passes/{pass_id}/renew/order-and-pay 后台 e2e
//
// **仅用于联调测试 / 自动化 e2e，现网控制台禁止暴露此入口给真实用户。**
//
// 与 RenewPassOrderUrl 的差异（与 CreatePassOrderAndPay vs CreatePassOrder 同范式）：
//   - RenewPassOrderUrl     → trade.PlaceRenewOrder      + trade.GeneratePayURL
//     双段调用，返支付 URL；用户在浏览器付款后 jifei 异步回调 trade.checkRenew/renewResource
//   - RenewPassOrderAndPay  → trade.PlaceRenewOrderAndPay
//     一次调用完成"下单 + 支付 + 触发 checkRenew/renewResource 回调"，跳过支付 URL；
//     适合测试代金券充足的环境跑通 trade ↔ jifei ↔ ctl.RenewPass 端到端链路
//
// 复用 RenewPassOrderRequest 作为入参（字段集完全相同：period / time_unit；
// pass_id 仍走 path param）。

// RenewPassOrderAndPayResult 一体化续费下单 + 支付的响应（R-D-7）
//
// 与 RenewPassOrderUrlResult 的差异（与 CreatePassOrderAndPayResult vs CreatePassOrderResult 同范式）：
//   - 不返 PayURL：trade.PlaceRenewOrderAndPay 调 jifei `qcloud.Deal.generateDealsAndPay`
//     一次完成 "下单 + 支付 + 触发 renewResource 回调"，跳过支付 URL 概念
//   - 新增 BigOrderID：方便测试时反查 jifei 控制台
type RenewPassOrderAndPayResult struct {
	DealName   string `json:"deal_name"`
	BigOrderID string `json:"big_order_id"`
}

// === trade-pass-renew RenewPassPrice transport DTO（v1.7.21 B16 / R-C-4 续费询价）===
//
// 入口：POST /v1/passes/{pass_id}/renew/price
// 鉴权：X-User-Id（与 RenewPassOrderUrl 同范式）
//
// 设计稿：.tmp/trade-pass-renew-design.md §3.5 / §14；
// codesign/ctl-frontend-billing-api.md §3 续费询价小节。

// RenewPassPriceRequest 续费询价请求（v1.7.21 B16 / R-C-4）
//
// 字段说明：
//   - Period / TimeUnit：续费时长；与 RenewPassOrderUrlRequest 同语义
//
// 关键约束（用户 2026-05-20 拍板 b）：
//   - **不允许传 bundle_id**：续费不能换 bundle，bundle_id 由 ctl 内部从 passEntity.BundleID 取值
//   - pass_id 走 path param，与 RenewPassOrderUrlRequest 同范式
//   - CurDeadline 由 ctl 内部从 passEntity.ExpiredTime 拼字符串透传给 trade，前端不感知
type RenewPassPriceRequest struct {
	Period   int    `json:"period"`
	TimeUnit string `json:"time_unit"` // "m" / "d" / "y"（§12 Q19=b 全链路放开）
}

// RenewPassPriceResult 续费询价响应（v1.7.21 B16 / R-C-4 / v1.7.28 BUG-04 C 路径精简）
//
// **字段集精简（v1.7.28 拍板）**：与新购询价 transport.BundlePrice 字段集严格对齐 — 前端
// UI 续费询价 / 新购询价共用同一价格展示组件，只需要价格 5 字段 + bundle_id 即可。
//
// 删除的字段（jifei 协议层死字段，ctl 不应感知）：
//   - bundle_name：续费时前端已有 pass，可从 pass.bundle_id → bundle 拿名称
//   - time_span / time_unit / goods_num：前端入参就有 period / time_unit，goods_num=1 是约定，回显冗余
//   - product_code / sub_product_code / pid：jifei 协议字段，前端排障应看后端日志而不是 response body
//
// 价格字段类型与 BundlePrice 对齐 (string → float64)：避免前端两个组件字段类型不一致。
type RenewPassPriceResult struct {
	BundleID      string  `json:"bundle_id"`
	Price         float64 `json:"price"`           // CGW data[].price，标价（单位分）
	TotalCost     float64 `json:"total_cost"`      // CGW totalCost，成本价（单位分）
	RealTotalCost float64 `json:"real_total_cost"` // CGW realTotalCost，实付价（单位分）
	Currency      string  `json:"currency"`        // 币种，如 CNY
	Discount      float64 `json:"discount"`        // 总折扣率，policyDetail.total 拍平；100 = 无折扣
}

// === trade-pass-isolate transport DTO（设计稿 §10 Q22-I-E / Q14）===
//
// 入口：POST /internal/ctl/passes/{pass_id}/isolate
// 鉴权：requireInternalBearer（CTL_INTERNAL_TOKEN，与其它 internal 路由一致）
//
// 调用方：trade dispatcher 接到 jifei `isolateResource` / `unsubscribePayDeals` 类回调后反向调本接口
// 返回：父 task 的 task_id，trade 侧写入 trade_flow.task_ref 用于后续轮询查询。

// IsolatePassRequest body 字段（设计稿 §10 Q22-I-E + 端到端闭环 2026-05-15）
//
// TradeFlowID 是 trade 侧 trade_flow.id 主键（BIGINT AUTO_INCREMENT），ctl 必须在父 task IsolatePass
// 完成 instance pause + pass.status → isolated 后，best-effort 反向调 trade
// `POST /internal/trade/flows/{trade_flow_id}/complete` callback 把 trade_flow.status 从 in_progress
// 推进到 completed。
//
// 兼容性：trade 旧版本未透传 / dev/test 直接 curl 等场景下 TradeFlowID == 0，ctl 侧跳过 callback，
// 仅完成本地隔离（trade_flow 由 reconcile worker + jifei queryFlow 兜底推进）。
type IsolatePassRequest struct {
	// TradeFlowID = trade_flow.id PK；0 时表示无 trade callback 链路（dev/test 兼容）。
	TradeFlowID int64 `json:"trade_flow_id,omitempty"`

	// NewDeadline 是 jifei 退费场景下的"新到期时间"（v1.7.30 BUG-35）。
	//
	// 三态语义（与 trade ctlclient.IsolatePassRequest.NewDeadline 镜像）：
	//   - nil           → 生命周期隔离场景；父 task 终态仅 CAS isolating→isolated，
	//                     **不动** pass.expired_time（不要把 expired_time 写成零值）。
	//   - 非 nil time.Time → 退费隔离场景；父 task 终态在同一事务里
	//                     CAS isolating→isolated + 写 pass.expired_time = *NewDeadline。
	//
	// 校验：NewDeadline != nil 时必须严格 < 当前 pass.expired_time（退费只能压缩时长）。
	// 时区：trade 侧已把 jifei 北京时间字面值解析为绝对时刻 UTC time.Time，wire 走 RFC3339，
	// ctl 拿到后无需再做时区转换；与 ctl 全栈 UTC 规范一致。
	NewDeadline *time.Time `json:"new_deadline,omitempty"`

	// DealName 是 jifei 退费场景下的子订单号（v1.7.30 BUG-35）。
	//
	// trade 侧已存入 trade_flow.deal_name 列做审计；透传到 ctl 仅用作日志（不参与状态机）。
	// 空字符串 = 生命周期场景或老调用链路。
	DealName string `json:"deal_name,omitempty"`

	// 预留：reason / operator_uin 等运营元数据可在未来加上
}

// IsolatePassResponse 内部接口返回 task_id，让 trade 串联 trade_flow.task_ref
type IsolatePassResponse struct {
	PassID string `json:"pass_id"`
	TaskID string `json:"task_id"`
}

// === trade-pass-destroy transport DTO（设计稿 §3.5 / §4.5.2 / §4.5.3 / §10 / §11-A Q1 / Q24）===
//
// 入口：POST /internal/ctl/passes/{pass_id}/destroy
// 鉴权：requireInternalBearer（CTL_INTERNAL_TOKEN，与其它 internal 路由一致）
//
// 调用方：trade dispatcher 接到 jifei `destroyResource` 回调后反向调本接口（与 IsolatePass 同范式）。
// 返回：父 task 的 task_id，trade 侧写入 trade_flow.task_ref 用于后续轮询查询。

// DestroyPassRequest body 字段
//
// TradeFlowID 与 IsolatePassRequest.TradeFlowID 同语义：
//   - > 0 时父 task 收尾步 5c best-effort 反向调 trade
//     `POST /internal/trade/flows/{trade_flow_id}/complete` callback 推进 trade_flow.status 到 completed
//   - 0 时跳过 callback（dev/test 兼容；trade 侧 reconcile worker 兜底）
//
// DestroyReason 镜像 jifei `para.source` 原值（Q24 ✅ 拍板）：
//   - jifei 协议规定为 biz / qn / other 三种枚举值之一；空串视为合法 tombstone（用户控制台
//     DeletePass 入口未经 jifei 二次回标的兜底场景）
//   - 父 task 收尾步 5b 调 dao.MoveToHistory(passID, deletedTime, DestroyReason)，
//     写入 history_pass.destroy_reason 列，便于审计/统计
type DestroyPassRequest struct {
	// TradeFlowID = trade_flow.id PK；0 表示无 trade callback 链路。
	TradeFlowID int64 `json:"trade_flow_id,omitempty"`

	// DestroyReason = jifei `para.source` 透传值（biz/qn/other/空串）。
	DestroyReason string `json:"destroy_reason,omitempty"`
}

// DestroyPassResponse 内部接口返回 task_id，让 trade 串联 trade_flow.task_ref。
type DestroyPassResponse struct {
	PassID string `json:"pass_id"`
	TaskID string `json:"task_id"`
}

// === trade-pass-renew transport DTO（设计稿 §4.7 / §5.5 / R-D-2 反向回调入口）===
//
// 入口：POST /internal/ctl/passes/{pass_id}/renew
// 鉴权：requireInternalBearer（CTL_INTERNAL_TOKEN，与其它 internal 路由一致）
//
// 调用方：trade dispatcher 接到 jifei `renewResource` 回调后反向调本接口（与 IsolatePass / DestroyPass 同范式）。
// 返回：父 task 的 task_id（仅异步分支 B），同步分支 A（pass.status=active 提前续费）返空 task_id。
//
// 路径范式校准（v3.9 修订）：设计稿 §4.7 / §5.5 早期写的是单段 `/internal/ctl/passes/renew`，
// 实际落地与 isolate / destroy 既有惯例对齐为双段 `/internal/ctl/passes/{pass_id}/{action}`，
// pass_id 走 URL path 段，附加字段走 body。trade ctlclient 已按此双段范式实现。

// RenewPassRequest body 字段（设计稿 §4.7 / R-D-2 + §12 Q5/v3.6 拍板）
//
// 字段语义：
//   - TimeSpan / TimeUnit：jifei 续费协议透传（goodsDetail.timeSpan / goodsDetail.timeUnit），
//     与 trade_order 落库列同型；TimeUnit ∈ {y, m, d}（§12 Q12=a 拒收 'p'，§12 Q19=b 全链路放开 'y'）。
//   - DealName：jifei 协议层 dealName（trade_order.deal_name），仅 ctl 端 audit log 留痕，
//     ctl logic.RenewPass 不消费此字段（§12 Q5/v3.6 拍板：本期 ctl 不持有 dealName 业务语义，
//     仅 trade 侧 trade_flow / trade_order 留档已满足审计需求）。
//   - TradeFlowID：trade 侧 trade_flow.id 主键（BIGINT AUTO_INCREMENT），ctl 必须在父 task RenewPass
//     完成 instance start + pass.status → active CAS 后，best-effort 反向调 trade
//     `POST /internal/trade/flows/{trade_flow_id}/complete` callback 把 trade_flow.status 从
//     in_progress 推进到 completed（与 IsolatePass.TradeFlowID 同语义；0 时跳过 callback）。
//
// 兼容性：trade 旧版本未透传 / dev/test 直接 curl 等场景下 TradeFlowID == 0，ctl 侧跳过 callback，
// 仅完成本地续费状态切换（trade_flow 由 reconcile worker + jifei queryFlow 兜底推进）。
type RenewPassRequest struct {
	TimeSpan int    `json:"time_span"`
	TimeUnit string `json:"time_unit"`
	// DealName 仅 audit log 留痕，ctl logic 不消费（§12 Q5 拍板）。
	DealName string `json:"deal_name,omitempty"`
	// TradeFlowID = trade_flow.id PK；0 时表示无 trade callback 链路（dev/test 兼容）。
	TradeFlowID int64 `json:"trade_flow_id,omitempty"`
}

// RenewPassResponse 内部接口返回 task_id，让 trade 串联 trade_flow.task_ref。
//
// 字段：
//   - PassID：回显请求路径里的 pass_id，便于排障（与 IsolatePassResponse / DestroyPassResponse 同范式）
//   - TaskID：ctl 派发的 RenewPass 父 task 的 task_id；仅异步分支 B 非空，
//     同步分支 A（pass.status=active 提前续费 logic 直接同步完成）返空 task_id。
//     trade 侧调用方按字面值透传到 trade_flow.response_body 留档，不做强校验。
type RenewPassResponse struct {
	PassID string `json:"pass_id"`
	TaskID string `json:"task_id"`
}

// DeletePassUserResponse 是用户面 POST /v1/passes/{pass_id}/delete 响应。
//
// **语义**：仅表示同步调用成功 — pass.status 已 CAS isolated → deleting +
// trade.DeleteResource 已同步触发. pass **实际是否被销毁**（从列表消失迁到 history_pass）
// 是异步链路（jifei.destroyResource 回调 → ctl 后台 task → snapshot/cleanup 一般 1~3min），
// 前端需轮询 GET /v1/passes 检测 pass 从列表消失.
//
// 字段 `deleted: true` 仅是"同步调用成功"信号, 不代表 pass 实体已物理删除.
type DeletePassUserResponse struct {
	Deleted bool `json:"deleted"`
}

// RefundPassRequest 是后台 POST /admin/api/ctl/passes/{pass_id}/refund 入参
// （trade-pass-refund-design.md v0.5 §3.3）。
//
// 字段说明（Q1=a / Q4=a 拍板）：
//   - OperatorUin：操作人 uin，仅作 zap 日志留痕用，不写 DB（Q4=a 不建审计表）
//   - Reason：运营记录用文本，仅日志透传（如"客户投诉 #12345"等）
//
// 后台路径无 user_id 字段 — 设计稿 Q1=a 拍板：admin 直接以 pass_id 为粒度操作，
// 不强制要求传 user_id（与销毁链路 admin 入口要求 user_id 的语义不同，因为退款
// 链路完全不动 pass.status，越权风险由 admin 路由所在的 admin 鉴权层兜底）。
type RefundPassRequest struct {
	OperatorUin int64  `json:"operator_uin,omitempty"`
	Reason      string `json:"reason,omitempty"`
}

// RefundPassResponse 是后台 POST /admin/api/ctl/passes/{pass_id}/refund 响应
// （trade-pass-refund-design.md v0.5 §3.2）。
//
// **语义**：jifei OnlineRefund 同步返成功后立即返回此响应；pass.status 此刻仍是 `active`
// （v0.5 §10.2 联调 SOP step 4 关键不变量），最终状态由 jifei 异步回 isolateResource
// 后通过 IsolatePass 路径推进到 isolated + 写 expired_time = newDeadline。
//
// 字段：
//   - PassID：退款对应 pass_id（透传入参）
//   - DealName：jifei 退款小订单号（透传给 admin 面板供审计追账）
//   - BigDealID：jifei 退款大订单号
//   - SubmittedAt：ctl 收 trade 成功响应的时间（UTC ISO8601 文本）
type RefundPassResponse struct {
	PassID      string    `json:"pass_id"`
	DealName    string    `json:"deal_name"`
	BigDealID   string    `json:"big_deal_id"`
	SubmittedAt time.Time `json:"submitted_at"`
}
