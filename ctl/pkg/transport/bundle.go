package transport

import "time"

// === Bundle Transport DTOs ===

// ImportBundleRequest 导入套餐请求（不存在则创建，存在则覆盖）
type ImportBundleRequest struct {
	BundleID        string           `json:"bundle_id"`
	BundleName      string           `json:"bundle_name"`
	Description     []BundleDescItem `json:"description"`
	AgentQuota      int64            `json:"agent_quota"`
	Credit          int64            `json:"credit"`
	TimeSpan        int              `json:"time_span"`
	TimeUnit        string           `json:"time_unit"`
	AiGatewayPlanID string           `json:"ai_gateway_plan_id"`
	// InstanceSpecID 实例规格 ID（设计稿 Q4=a / Q-NAMING-1=a）。
	// 空字符串 = 兼容期 fallback 到 spec-2c4g50g；非空需在 instancespec.KnownSpecs 字典中。
	InstanceSpecID        string `json:"instance_spec_id,omitempty"`
	StaticSoldOut         bool   `json:"static_sold_out"`
	BundleSalesAvailCount int    `json:"bundle_sales_available_count"`
	BundleSalesTotalCount int    `json:"bundle_sales_total_count"`
}

// BundleDescItem description JSON 中的单个 KV 条目
type BundleDescItem struct {
	Key   string `json:"Key"`
	Value string `json:"Value"`
}

// ModifyBundlesRequest 批量修改套餐请求
type ModifyBundlesRequest struct {
	BundleIDs       []string `json:"bundle_ids"`
	BundleName      *string  `json:"bundle_name,omitempty"`
	Description     *string  `json:"description,omitempty"` // raw JSON string
	BundleState     *string  `json:"bundle_state,omitempty"`
	AgentQuota      *int64   `json:"agent_quota,omitempty"`
	Credit          *int64   `json:"credit,omitempty"`
	TimeSpan        *int     `json:"time_span,omitempty"`
	TimeUnit        *string  `json:"time_unit,omitempty"`
	AiGatewayPlanID *string  `json:"ai_gateway_plan_id,omitempty"`
	// InstanceSpecID 实例规格 ID（设计稿 Q4=a / Q-NAMING-1=a）。
	// nil = 不修改；非 nil 时 logic 层校验值在 instancespec.KnownSpecs 字典中。
	InstanceSpecID        *string `json:"instance_spec_id,omitempty"`
	StaticSoldOut         *bool   `json:"static_sold_out,omitempty"`
	BundleSalesAvailCount *int    `json:"bundle_sales_available_count,omitempty"`
	BundleSalesTotalCount *int    `json:"bundle_sales_total_count,omitempty"`
}

// BundleResponse 单个 Bundle 响应（后台管理端，含所有字段）
type BundleResponse struct {
	BundleID        string      `json:"bundle_id"`
	BundleName      string      `json:"bundle_name"`
	Description     interface{} `json:"description"`
	BundleState     string      `json:"bundle_state"`
	AgentQuota      int64       `json:"agent_quota"`
	Credit          int64       `json:"credit"`
	TimeSpan        int         `json:"time_span"`
	TimeUnit        string      `json:"time_unit"`
	AiGatewayPlanID string      `json:"ai_gateway_plan_id,omitempty"`
	// === bundle-instance-spec 设计稿 Q5=b / Q-FRONT-1=b：admin-gateway 出参暴露完整规格 ===
	InstanceSpecID        string    `json:"instance_spec_id,omitempty"`
	InstanceSpecDisplay   string    `json:"instance_spec_display,omitempty"`
	CPU                   int       `json:"cpu,omitempty"`              // CPU 核数
	Memory                int       `json:"memory,omitempty"`           // 内存大小，单位 GB（与 spec-{cpu}c{memory_gb}g{disk}g 同源）
	SystemDiskSize        int       `json:"system_disk_size,omitempty"` // 系统盘大小，单位 GB
	StaticSoldOut         *bool     `json:"static_sold_out,omitempty"`
	BundleSalesAvailCount int       `json:"bundle_sales_available_count"`
	BundleSalesTotalCount int       `json:"bundle_sales_total_count"`
	BundleSalesState      string    `json:"bundle_sales_state"`
	CreatedTime           time.Time `json:"created_time"`
	UpdatedTime           time.Time `json:"updated_time"`
}

// ListBundlesResponse 查询套餐列表响应
type ListBundlesResponse struct {
	Bundles []*BundleResponse `json:"bundles"`
}

// ModifyBundlesResponse 批量修改套餐响应
type ModifyBundlesResponse struct {
	AffectedCount int64 `json:"affected_count"`
}

// UserBundleResponse 面向用户的 Bundle 响应（仅暴露用户可见字段）
type UserBundleResponse struct {
	BundleID         string      `json:"bundle_id"`
	BundleName       string      `json:"bundle_name"`
	Description      interface{} `json:"description"`
	BundleState      string      `json:"bundle_state"`
	AgentQuota       int64       `json:"agent_quota"`
	Credit           int64       `json:"credit"`
	BundleSalesState string      `json:"bundle_sales_state"`

	// === bundle-instance-spec 设计稿 Q-FRONT-1=b：user-facing 结构化暴露 3 个量化字段 ===
	// 不暴露 instance_spec_id（ctl 内部抽象 ID，前端不该按 ID 字符串映射文案）
	// 字段名不带单位后缀（v9 拍板）；memory 与 system_disk_size 单位统一为 GB。
	CPU            int `json:"cpu"`              // CPU 核数
	Memory         int `json:"memory"`           // 内存大小，单位 GB
	SystemDiskSize int `json:"system_disk_size"` // 系统盘大小，单位 GB

	// Price trade 询价回填字段，瞬时挂载不落 ctl DB（Q22 / Q30 / Q50 拍板，2026-05-08 trade 子需求 C）。
	// 本期 ctl 侧不调用 trade 询价，Price 始终为 nil（前端按"暂无报价"展示）；
	// trade 子需求 C 联调期接入后，由 describeBundles handler 调 trade 询价 RPC 回填。
	Price *BundlePrice `json:"price,omitempty"`
}

// BundlePrice trade 询价回填结构（user-facing 精简版，Q40~Q48 / Q50 拍板）。
// 字段命名 snake_case 与 ctl 整体风格对齐；CGW 原始 camelCase 响应由 trade 适配层转换 +
// 把 CGW policyDetail.total 拍平为顶级 discount 字段。
// CGW 内部 / 审计字段（high_precision_price / policy / partDetail / pid /
// productCode / subProductCode / policyDetail.user / policyDetail.common 等）由 trade 侧
// 落 ELK 日志兜底，不在 ctl user-facing 透传范围内。
type BundlePrice struct {
	Price         float64 `json:"price"`           // CGW data[].price，标价
	TotalCost     float64 `json:"total_cost"`      // CGW totalCost，成本价
	RealTotalCost float64 `json:"real_total_cost"` // CGW realTotalCost，实付价
	Currency      string  `json:"currency"`        // 币种，如 CNY
	Discount      float64 `json:"discount"`        // 总折扣率，来自 CGW policyDetail.total（拍平）；1.0 = 无折扣
}

// InternalBundleDetail 内部 RPC 出参子集，供 trade.checkCreate 阶段调
// GET /internal/ctl/bundles/{bundleId} 拿到 bundle 业务规格做 state / sales_state 自校验。
//
// 严格精简（Q33 / Q25 / Q37 拍板，2026-05-08 v3 校正）：
//   - 不含 ai_gateway_plans / ai_gateway_plan_id：DB 内部字段，唯一消费方 ctl/pass，trade 不感知；
//   - 不含 sub_product_code：归 trade 库 trade_bundle_definition，ctl 完全不感知；
//   - 不含 time_span / time_unit：时长由 CreatePass 入参 (period, timeUnit) 决定，trade checkCreate 不需要时长。
//
// 例外（bundle-instance-spec-design.md v9 / Q-FRONT-1 补充拍板）：
//   - 含 cpu / memory / system_disk_size 三个量化字段：user-facing / internal-facing / admin
//     三处出参一律暴露这 3 字段；不含 instance_spec_id（ctl 内部抽象 ID 不外露）。
type InternalBundleDetail struct {
	BundleID              string `json:"bundle_id"`
	BundleName            string `json:"bundle_name"`
	BundleState           string `json:"bundle_state"` // ONLINE / OFFLINE
	AgentQuota            int64  `json:"agent_quota"`  // 设备配额
	Credit                int64  `json:"credit"`       // 用户可见积分额度
	BundleSalesAvailCount int    `json:"bundle_sales_available_count"`
	BundleSalesTotalCount int    `json:"bundle_sales_total_count"`
	BundleSalesState      string `json:"bundle_sales_state"` // 计算字段 AVAILABLE / SOLD_OUT

	// === bundle-instance-spec 设计稿 v9 / Q-FRONT-1 补充：三处都暴露 ===
	CPU            int `json:"cpu"`              // CPU 核数
	Memory         int `json:"memory"`           // 内存大小，单位 GB
	SystemDiskSize int `json:"system_disk_size"` // 系统盘大小，单位 GB
}

// DescribeBundlesResponse 面向用户的套餐列表响应
type DescribeBundlesResponse struct {
	Bundles []*UserBundleResponse `json:"bundles"`
}

// === Instance Spec Transport DTOs（设计稿 §10 Q8=a）===

// InstanceSpecResponse 单条实例规格定义响应（admin only-read 接口）。
//
// memory / system_disk_size 单位统一为 GB（与 spec-{cpu}c{memory_gb}g{disk}g 同源）。
type InstanceSpecResponse struct {
	SpecID         string `json:"spec_id"`
	DisplayName    string `json:"display_name"`
	CPU            int    `json:"cpu"`              // CPU 核数
	Memory         int    `json:"memory"`           // 内存大小，单位 GB
	SystemDiskSize int    `json:"system_disk_size"` // 系统盘大小，单位 GB
}

// ListInstanceSpecsResponse 实例规格列表响应（GET /admin/api/ctl/instance-specs）。
type ListInstanceSpecsResponse struct {
	Specs []*InstanceSpecResponse `json:"specs"`
}
