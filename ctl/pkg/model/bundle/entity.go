package bundle

import "ctl/pkg/model"

const (
	TableName = "bundle"

	ColumnBundleID              = "bundle_id"
	ColumnBundleName            = "bundle_name"
	ColumnDescription           = "description"
	ColumnBundleState           = "bundle_state"
	ColumnAgentQuota            = "agent_quota"
	ColumnCredit                = "credit"
	ColumnTimeSpan              = "time_span"
	ColumnTimeUnit              = "time_unit"
	ColumnAiGatewayPlanID       = "ai_gateway_plan_id"
	ColumnAiGatewayPlans        = "ai_gateway_plans"
	ColumnInstanceSpecID        = "instance_spec_id"
	ColumnStaticSoldOut         = "static_sold_out"
	ColumnBundleSalesAvailCount = "bundle_sales_available_count"
	ColumnBundleSalesTotalCount = "bundle_sales_total_count"

	StateOnline  = "ONLINE"
	StateOffline = "OFFLINE"

	SalesStateAvailable = "AVAILABLE"
	SalesStateSoldOut   = "SOLD_OUT"

	// 套餐周期单位
	TimeUnitMonth = "m"
	TimeUnitDay   = "d"
	// TimeUnitYear 包年单位（trade-pass-renew §12 Q19=b 落地，2026-05-15 v3.8）：
	// 续费链路引入 'y' 后，新购侧理论同步可接（包年 bundle 治理上架立即可用）；
	// CalcExpiredTime 在 ctl/pkg/logic/pass/logic.go 已扩展 case TimeUnitYear → start.AddDate(timeSpan, 0, 0)。
	// 跨服务待办：ai-gateway plan.period_unit 是否支持 "years" 待用户拍板，详见 .tmp/trade-pass-renew-design.md §13 F-3。
	TimeUnitYear = "y"
)

// DescriptionItem description JSON 中的单个 KV 条目
type DescriptionItem struct {
	Key   string `json:"Key"`
	Value string `json:"Value"`
}

// Entity 套餐包实体
type Entity struct {
	model.BaseEntity

	BundleID        string `gorm:"column:bundle_id;uniqueIndex:uk_bundle_id"`
	BundleName      string `gorm:"column:bundle_name"`
	Description     string `gorm:"column:description;type:text"` // JSON: [{"Key":"...","Value":"..."}]
	BundleState     string `gorm:"column:bundle_state;index:idx_bundle_state"`
	AgentQuota      int64  `gorm:"column:agent_quota"`
	Credit          int64  `gorm:"column:credit"`             // 用户可见积分额度（对应 credit × credit_token_ratio 个 Token）
	TimeSpan        int    `gorm:"column:time_span"`          // 套餐周期数值
	TimeUnit        string `gorm:"column:time_unit"`          // 套餐周期单位 "m"=月 / "d"=天
	AiGatewayPlanID string `gorm:"column:ai_gateway_plan_id"` // ai-gateway Plan UUID（credit=0 时允许空）
	// AiGatewayPlans 多对多 plan 列表（JSON），DB 内部字段，唯一消费方 ctl/pass.CompletePaidPassFromJifei
	// 格式：[{"plan_id":"plan-xxx","quota_per_period":1000000}, ...]
	// trade 不感知；ctl user-facing / internal-facing 出参一律不暴露（Q37/Q38 拍板，2026-05-08 trade 子需求 C）
	AiGatewayPlans string `gorm:"column:ai_gateway_plans;type:json"`
	// InstanceSpecID 实例规格 ID（DB 内部字段，唯一消费方 ctl/instance.RunCreateInstanceTask
	// 反查 bundle 选 per-spec 候选池）。NULL 时兼容期 fallback 到全局默认 spec-2c4g50g。
	// user-facing / internal-facing / admin 出参通过 instancespec.SpecDefinition 字典展开为
	// cpu / memory / system_disk_size 三个量化字段。详见 .tmp/bundle-instance-spec-design.md。
	InstanceSpecID        string `gorm:"column:instance_spec_id"`
	StaticSoldOut         bool   `gorm:"column:static_sold_out"` // 静态售罄标记
	BundleSalesAvailCount int    `gorm:"column:bundle_sales_available_count"`
	BundleSalesTotalCount int    `gorm:"column:bundle_sales_total_count"`
}

func (Entity) TableName() string {
	return TableName
}

// SalesState 计算售卖状态：static_sold_out=true 或 available_count<=0 时返回 SOLD_OUT
func (e *Entity) SalesState() string {
	if e.StaticSoldOut || e.BundleSalesAvailCount <= 0 {
		return SalesStateSoldOut
	}
	return SalesStateAvailable
}
