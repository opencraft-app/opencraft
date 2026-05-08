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
