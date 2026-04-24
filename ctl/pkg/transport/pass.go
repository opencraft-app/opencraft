package transport

import "time"

// === Pass Transport DTOs ===

// CreateTrialPassRequest 创建试用权益请求
// 有效期由 Bundle 的 time_span + time_unit 决定，调用方不指定
type CreateTrialPassRequest struct {
	UserID   string `json:"user_id,omitempty"` // 后台管理时指定；用户接口自动取当前登录用户
	BundleID string `json:"bundle_id"`
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
