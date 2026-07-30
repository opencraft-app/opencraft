// Package bundle 实现套餐包业务逻辑。
package bundle

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"ctl/pkg/adapter/aigateway"
	adapterfactory "ctl/pkg/adapter/factory"
	"ctl/pkg/adapter/llmgateway"
	"ctl/pkg/config"
	"ctl/pkg/errcode"
	"ctl/pkg/logic/objectid"
	bundlemodel "ctl/pkg/model/bundle"
	modelfactory "ctl/pkg/model/factory"
	"ctl/pkg/model/instancespec"

	"gorm.io/gorm"
)

// BundleDetail 套餐详情
type BundleDetail struct {
	BundleID   string
	BundleName string
	// BundleType 套餐类型（必填）：
	//   - free    : 免费试用套餐（bundle_id 以 bundle_free_trial 前缀开头）
	//   - general : 普通付费套餐
	//   - ai      : AI 增强付费套餐
	// 取值由 ctl/pkg/model/bundle.BundleType* 常量统一约束。
	BundleType  string
	Description string // JSON: [{"Key":"...","Value":"..."}]
	// Features 功能特性列表 JSON 字符串（[]DisplayFeature），user-facing 出参下发。
	Features string
	// Tagline 一句话卖点，空串表示未配置。
	Tagline string
	// Promotion 促销角标 JSON 字符串（*DisplayPromotion，可空），空串表示无促销。
	Promotion       string
	BundleState     string
	AgentQuota      int64
	Credit          int64  // 用户可见积分额度
	TimeSpan        int    // 套餐周期数值
	TimeUnit        string // 套餐周期单位 "m"=月 / "d"=天
	AiGatewayPlanID string // ai-gateway Plan UUID（credit=0 时允许空）
	// AiGatewayPlans 是旧周期变体模型遗留字段。新运行时不读取、不写入。
	AiGatewayPlans string
	// InstanceSpecID 实例规格 ID。空字符串表示兼容期 fallback 到全局默认 spec-2c4g50g。
	// 详见 .tmp/bundle-instance-spec-design.md（Q1=a / Q4=a）。
	InstanceSpecID        string
	StaticSoldOut         bool
	BundleSalesAvailCount int
	BundleSalesTotalCount int
	BundleSalesState      string // 计算字段：AVAILABLE / SOLD_OUT
	CreatedTime           time.Time
	UpdatedTime           time.Time
}

// ModifyBundleFields 可修改字段，指针类型
type ModifyBundleFields struct {
	BundleName *string `json:"bundle_name,omitempty"`
	// BundleType 套餐类型，nil 表示不修改；非 nil 时必须为 free / general / ai。
	BundleType  *string `json:"bundle_type,omitempty"`
	Description *string `json:"description,omitempty"`
	// Features / Tagline / Promotion 展示化字段，nil = 不修改。
	// Features / Promotion 为 raw JSON string。
	Features        *string `json:"features,omitempty"`
	Tagline         *string `json:"tagline,omitempty"`
	Promotion       *string `json:"promotion,omitempty"`
	BundleState     *string `json:"bundle_state,omitempty"`
	AgentQuota      *int64  `json:"agent_quota,omitempty"`
	Credit          *int64  `json:"credit,omitempty"`
	TimeSpan        *int    `json:"time_span,omitempty"`
	TimeUnit        *string `json:"time_unit,omitempty"`
	AiGatewayPlanID *string `json:"ai_gateway_plan_id,omitempty"`
	// InstanceSpecID 实例规格 ID（设计稿 Q4=a / Q-NAMING-1=a）。
	// nil 表示该字段不修改；非 nil 时 logic 校验值在 instancespec.KnownSpecs 字典中。
	InstanceSpecID        *string `json:"instance_spec_id,omitempty"`
	StaticSoldOut         *bool   `json:"static_sold_out,omitempty"`
	BundleSalesAvailCount *int    `json:"bundle_sales_available_count,omitempty"`
	BundleSalesTotalCount *int    `json:"bundle_sales_total_count,omitempty"`
}

// Logic Bundle 业务逻辑接口
type Logic interface {
	// ImportBundle 导入套餐：不存在则创建，存在则覆盖性更新
	// 校验业务周期参数合法性，以及 credit 与 Plan 周期额度一致性。
	// 业务有效期由 ctl/trade 管理，不参与 Plan 身份匹配。
	//
	// bundleType（必填）：free / general / ai，取值非法时返回 ErrBundleConfigInvalid。
	//
	// instanceSpecID（设计稿 Q4=a / Q-NAMING-1=a）：
	//   - 空字符串 → 兼容期 fallback 到全局默认 spec-2c4g50g
	//   - 非空 → 必须在 instancespec.KnownSpecs 字典中，否则报 ErrBundleInstanceSpecNotFound
	ImportBundle(bundleID string, bundleName string, bundleType string, description string,
		features string, tagline string, promotion string,
		agentQuota int64, credit int64, timeSpan int, timeUnit string, aiGatewayPlanID string,
		instanceSpecID string, staticSoldOut bool, salesAvailCount int, salesTotalCount int) (*BundleDetail, error)

	// GetBundles 查询所有套餐（含 ONLINE 和 OFFLINE）
	GetBundles() ([]*BundleDetail, error)

	// ModifyBundles 批量修改
	ModifyBundles(bundleIDs []string, req *ModifyBundleFields) (int64, error)

	// DescribeBundles 查询上线套餐（仅 ONLINE）
	DescribeBundles() ([]*BundleDetail, error)

	// GetBundleByID 通过 bundleID 查询单个套餐
	GetBundleByID(bundleID string) (*BundleDetail, error)
}

type logic struct{}

// NewLogic 创建 Bundle Logic
func NewLogic() Logic {
	return &logic{}
}

// creditTokenRatio 读取全局配置
func creditTokenRatio() int64 {
	if config.ServerConf != nil && config.ServerConf.Bundle != nil {
		if r := config.ServerConf.Bundle.CreditTokenRatio; r > 0 {
			return r
		}
	}
	return 10000 // 默认 10000
}

// validateBundleType 校验 bundle_type 必填且取值 ∈ {free, general, ai}。
//
// 该字段是套餐分类标识，与 ai_gateway_plan_id / credit 等业务字段独立校验，
// 不与 credit==0 / credit>0 联动（例如 free 套餐 credit 仍可为 0，ai 套餐
// 需 ai_gateway_plan_id 由 validateCreditPlanPeriod 单独校验）。
func validateBundleType(bundleType string) error {
	switch bundleType {
	case bundlemodel.BundleTypeFree, bundlemodel.BundleTypeGeneral, bundlemodel.BundleTypeAI:
		return nil
	default:
		return errcode.Wrap(errcode.ErrBundleConfigInvalid,
			"bundle_type must be one of {%q, %q, %q}, got %q",
			bundlemodel.BundleTypeFree, bundlemodel.BundleTypeGeneral, bundlemodel.BundleTypeAI,
			bundleType)
	}
}

// validateCreditPlanPeriod 校验套餐积分与 Plan 周期额度。
// 函数名为兼容现有调用保留；业务有效期仅由 ctl/trade 管理，不参与 Plan 匹配。
// 规则：
//  1. time_unit ∈ {"m", "d"}，time_span > 0
//  2. credit == 0 → ai_gateway_plan_id 必须为空
//  3. credit > 0  → ai_gateway_plan_id 必须非空，且 Plan 的 monthly_tokens 与 bundle 积分对齐
//  4. LLMGateway Plan 必须可发放并已同步到全部 active Set；legacy ai-gateway
//     在迁移期继续校验旧周期，避免改变存量用户语义。
func validateCreditPlanPeriod(credit int64, timeSpan int, timeUnit, aiGatewayPlanID string) error {
	// 规则 1
	if timeUnit != bundlemodel.TimeUnitMonth && timeUnit != bundlemodel.TimeUnitDay {
		return errcode.Wrap(errcode.ErrBundleConfigInvalid, "time_unit must be 'm' or 'd', got %q", timeUnit)
	}
	if timeSpan <= 0 {
		return errcode.Wrap(errcode.ErrBundleConfigInvalid, "time_span must be > 0")
	}
	// 规则 2
	if credit == 0 {
		if aiGatewayPlanID != "" {
			return errcode.Wrap(errcode.ErrBundlePlanMismatch, "credit=0 but ai_gateway_plan_id is non-empty")
		}
		return nil
	}
	// 规则 3
	if credit < 0 {
		return errcode.Wrap(errcode.ErrBundleConfigInvalid, "credit must be >= 0")
	}
	if aiGatewayPlanID == "" {
		return errcode.Wrap(errcode.ErrBundlePlanMismatch, "credit>0 but ai_gateway_plan_id is empty")
	}

	// 调用网关校验 Plan 一致性。LLMGateway 显式开启时优先查新网关；关闭时只走 legacy ai-gateway。
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var plan *llmgateway.Plan
	isLLMGatewayPlan := false
	if config.LLMGatewayEnabled() {
		var err error
		plan, err = adapterfactory.DefaultAdapterFactory.LLMGatewayAdapter().GetPlan(ctx, aiGatewayPlanID)
		if err != nil && !errors.Is(err, llmgateway.ErrLLMGatewayPlanNotFound) {
			return errcode.Wrap(errcode.ErrBundleAiGatewayUnavailable, "%v", err)
		}
		isLLMGatewayPlan = plan != nil
	}
	if plan == nil {
		legacyAdapter := adapterfactory.DefaultAdapterFactory.AiGatewayAdapter()
		if legacyAdapter == nil {
			return errcode.Wrap(errcode.ErrBundleAiGatewayUnavailable, "ai-gateway adapter unavailable while validating legacy plan %s", aiGatewayPlanID)
		}
		legacyPlan, legacyErr := legacyAdapter.GetPlan(ctx, aiGatewayPlanID)
		if legacyErr == nil {
			plan = &llmgateway.Plan{
				ID:            legacyPlan.ID,
				Name:          legacyPlan.Name,
				MonthlyTokens: legacyPlan.MonthlyTokens,
				PeriodValue:   legacyPlan.PeriodValue,
				PeriodUnit:    legacyPlan.PeriodUnit,
				IsActive:      legacyPlan.IsActive,
			}
		} else if errors.Is(legacyErr, aigateway.ErrAiGatewayPlanNotFound) {
			return errcode.Wrap(errcode.ErrBundlePlanNotFound, "plan %s not found in configured gateway", aiGatewayPlanID)
		} else {
			return errcode.Wrap(errcode.ErrBundleAiGatewayUnavailable, "%v", legacyErr)
		}
	}
	if !plan.IsActive {
		return errcode.Wrap(errcode.ErrBundlePlanMismatch,
			"plan %s has stopped accepting new grants", aiGatewayPlanID)
	}
	if isLLMGatewayPlan && !plan.ReadyForAllSets {
		return errcode.Wrap(errcode.ErrBundleAiGatewayUnavailable,
			"plan %s is ready in %d/%d active sets",
			aiGatewayPlanID, plan.ReadySetCount, plan.ActiveSetCount)
	}

	expectedTokens := credit * creditTokenRatio()
	if plan.MonthlyTokens != expectedTokens {
		return errcode.Wrap(errcode.ErrBundleCreditTokenMismatch,
			"plan.monthly_tokens=%d, expected=%d (credit=%d × ratio=%d)",
			plan.MonthlyTokens, expectedTokens, credit, creditTokenRatio())
	}
	if !isLLMGatewayPlan {
		if plan.PeriodValue != timeSpan {
			return errcode.Wrap(errcode.ErrBundlePeriodMismatch,
				"legacy plan.period_value=%d, bundle.time_span=%d", plan.PeriodValue, timeSpan)
		}
		expectedUnit := mapLegacyTimeUnitToPlanPeriodUnit(timeUnit)
		if plan.PeriodUnit != expectedUnit {
			return errcode.Wrap(errcode.ErrBundlePeriodMismatch,
				"legacy plan.period_unit=%q, expected=%q (bundle.time_unit=%q)",
				plan.PeriodUnit, expectedUnit, timeUnit)
		}
	}
	return nil
}

func mapLegacyTimeUnitToPlanPeriodUnit(timeUnit string) string {
	switch timeUnit {
	case bundlemodel.TimeUnitMonth:
		return "months"
	case bundlemodel.TimeUnitDay:
		return "days"
	default:
		return ""
	}
}

func (l *logic) ImportBundle(bundleID string, bundleName string, bundleType string, description string,
	features string, tagline string, promotion string,
	agentQuota int64, credit int64, timeSpan int, timeUnit string, aiGatewayPlanID string,
	instanceSpecID string, staticSoldOut bool, salesAvailCount int, salesTotalCount int) (*BundleDetail, error) {

	if bundleID == "" {
		return nil, errcode.ErrBundleConfigInvalid
	}
	if agentQuota < 0 {
		return nil, errcode.Wrap(errcode.ErrBundleConfigInvalid, "agent_quota must be >= 0")
	}
	if salesAvailCount < 0 || salesTotalCount < 0 {
		return nil, errcode.Wrap(errcode.ErrBundleConfigInvalid, "sales count must be >= 0")
	}

	// bundle_type 校验：必填且必须 ∈ {free, general, ai}
	if err := validateBundleType(bundleType); err != nil {
		return nil, err
	}

	// 校验业务周期参数，并确认积分与 Plan 周期额度一致。
	if err := validateCreditPlanPeriod(credit, timeSpan, timeUnit, aiGatewayPlanID); err != nil {
		return nil, err
	}

	// 实例规格校验（设计稿 Q4=a / Q-NAMING-1=a）：空字符串走兼容期；非空时必须在常量字典中。
	if !instancespec.IsKnown(instanceSpecID) {
		return nil, errcode.Wrap(errcode.ErrBundleInstanceSpecNotFound,
			"unknown instance_spec_id: %s", instanceSpecID)
	}

	// 展示化字段校验：features / promotion 若非空必须是合法 JSON（DB 列类型为 JSON）。
	if features != "" && !json.Valid([]byte(features)) {
		return nil, errcode.Wrap(errcode.ErrBundleConfigInvalid, "features must be valid JSON")
	}
	if promotion != "" && !json.Valid([]byte(promotion)) {
		return nil, errcode.Wrap(errcode.ErrBundleConfigInvalid, "promotion must be valid JSON")
	}

	// 如果没有提供 bundleID，生成一个
	if bundleID == "" {
		bundleID = objectid.NewLogic().GenerateBundleId()
	}

	entity := &bundlemodel.Entity{
		BundleID:              bundleID,
		BundleName:            bundleName,
		BundleType:            bundleType,
		Description:           description,
		Features:              features,
		Tagline:               tagline,
		Promotion:             promotion,
		BundleState:           bundlemodel.StateOffline, // 导入默认 OFFLINE
		AgentQuota:            agentQuota,
		Credit:                credit,
		TimeSpan:              timeSpan,
		TimeUnit:              timeUnit,
		AiGatewayPlanID:       aiGatewayPlanID,
		InstanceSpecID:        instanceSpecID,
		StaticSoldOut:         staticSoldOut,
		BundleSalesAvailCount: salesAvailCount,
		BundleSalesTotalCount: salesTotalCount,
	}

	dao := modelfactory.DefaultDaoFactory.BundleDao(nil)
	if err := dao.Upsert(entity); err != nil {
		return nil, fmt.Errorf("import bundle: %w", err)
	}

	saved, err := dao.GetByBundleID(bundleID)
	if err != nil {
		return nil, fmt.Errorf("import bundle: read back: %w", err)
	}

	return entityToDetail(saved), nil
}

func (l *logic) GetBundles() ([]*BundleDetail, error) {
	dao := modelfactory.DefaultDaoFactory.BundleDao(nil)
	entities, err := dao.ListAll()
	if err != nil {
		return nil, fmt.Errorf("get bundles: %w", err)
	}
	return entitiesToDetails(entities), nil
}

func (l *logic) ModifyBundles(bundleIDs []string, req *ModifyBundleFields) (int64, error) {
	if len(bundleIDs) == 0 {
		return 0, errcode.ErrBundleIDsEmpty
	}
	if req == nil {
		return 0, errcode.ErrBundleNoFieldToUpdate
	}

	updates := make(map[string]interface{})

	if req.BundleName != nil {
		updates[bundlemodel.ColumnBundleName] = *req.BundleName
	}
	if req.BundleType != nil {
		if err := validateBundleType(*req.BundleType); err != nil {
			return 0, err
		}
		updates[bundlemodel.ColumnBundleType] = *req.BundleType
	}
	if req.Description != nil {
		if !json.Valid([]byte(*req.Description)) {
			return 0, errcode.Wrap(errcode.ErrBundleConfigInvalid, "description must be valid JSON")
		}
		updates[bundlemodel.ColumnDescription] = *req.Description
	}
	if req.Features != nil {
		if *req.Features != "" && !json.Valid([]byte(*req.Features)) {
			return 0, errcode.Wrap(errcode.ErrBundleConfigInvalid, "features must be valid JSON")
		}
		updates[bundlemodel.ColumnFeatures] = *req.Features
	}
	if req.Tagline != nil {
		updates[bundlemodel.ColumnTagline] = *req.Tagline
	}
	if req.Promotion != nil {
		if *req.Promotion != "" && !json.Valid([]byte(*req.Promotion)) {
			return 0, errcode.Wrap(errcode.ErrBundleConfigInvalid, "promotion must be valid JSON")
		}
		updates[bundlemodel.ColumnPromotion] = *req.Promotion
	}
	if req.BundleState != nil {
		state := *req.BundleState
		if state != bundlemodel.StateOnline && state != bundlemodel.StateOffline {
			return 0, errcode.ErrBundleStateInvalid
		}
		updates[bundlemodel.ColumnBundleState] = state
	}
	if req.AgentQuota != nil {
		if *req.AgentQuota < 0 {
			return 0, errcode.Wrap(errcode.ErrBundleConfigInvalid, "agent_quota must be >= 0")
		}
		updates[bundlemodel.ColumnAgentQuota] = *req.AgentQuota
	}
	if req.Credit != nil {
		if *req.Credit < 0 {
			return 0, errcode.Wrap(errcode.ErrBundleConfigInvalid, "credit must be >= 0")
		}
		updates[bundlemodel.ColumnCredit] = *req.Credit
	}
	if req.TimeSpan != nil {
		if *req.TimeSpan <= 0 {
			return 0, errcode.Wrap(errcode.ErrBundleConfigInvalid, "time_span must be > 0")
		}
		updates[bundlemodel.ColumnTimeSpan] = *req.TimeSpan
	}
	if req.TimeUnit != nil {
		if *req.TimeUnit != bundlemodel.TimeUnitMonth && *req.TimeUnit != bundlemodel.TimeUnitDay && *req.TimeUnit != bundlemodel.TimeUnitYear {
			return 0, errcode.Wrap(errcode.ErrBundleConfigInvalid, "time_unit must be 'm', 'd' or 'y'")
		}
		updates[bundlemodel.ColumnTimeUnit] = *req.TimeUnit
	}
	if req.AiGatewayPlanID != nil {
		updates[bundlemodel.ColumnAiGatewayPlanID] = *req.AiGatewayPlanID
	}
	if req.InstanceSpecID != nil {
		// 设计稿 §10 Q4=a / Q-NAMING-1=a：空字符串走兼容期 fallback；非空必须在常量字典中
		if !instancespec.IsKnown(*req.InstanceSpecID) {
			return 0, errcode.Wrap(errcode.ErrBundleInstanceSpecNotFound,
				"unknown instance_spec_id: %s", *req.InstanceSpecID)
		}
		updates[bundlemodel.ColumnInstanceSpecID] = *req.InstanceSpecID
	}
	if req.StaticSoldOut != nil {
		updates[bundlemodel.ColumnStaticSoldOut] = *req.StaticSoldOut
	}
	if req.BundleSalesAvailCount != nil {
		if *req.BundleSalesAvailCount < 0 {
			return 0, errcode.Wrap(errcode.ErrBundleConfigInvalid, "bundle_sales_available_count must be >= 0")
		}
		updates[bundlemodel.ColumnBundleSalesAvailCount] = *req.BundleSalesAvailCount
	}
	if req.BundleSalesTotalCount != nil {
		if *req.BundleSalesTotalCount < 0 {
			return 0, errcode.Wrap(errcode.ErrBundleConfigInvalid, "bundle_sales_total_count must be >= 0")
		}
		updates[bundlemodel.ColumnBundleSalesTotalCount] = *req.BundleSalesTotalCount
	}

	if len(updates) == 0 {
		return 0, errcode.ErrBundleNoFieldToUpdate
	}

	// 如果涉及 credit / time_span / time_unit / ai_gateway_plan_id 任一字段，需重新校验一致性
	needValidate := req.Credit != nil || req.TimeSpan != nil || req.TimeUnit != nil || req.AiGatewayPlanID != nil
	if needValidate {
		dao := modelfactory.DefaultDaoFactory.BundleDao(nil)
		for _, bid := range bundleIDs {
			current, err := dao.GetByBundleID(bid)
			if err != nil {
				if errors.Is(err, gorm.ErrRecordNotFound) {
					return 0, errcode.ErrBundlePartialNotFound
				}
				return 0, fmt.Errorf("modify bundles: read %s: %w", bid, err)
			}
			credit := current.Credit
			if req.Credit != nil {
				credit = *req.Credit
			}
			timeSpan := current.TimeSpan
			if req.TimeSpan != nil {
				timeSpan = *req.TimeSpan
			}
			timeUnit := current.TimeUnit
			if req.TimeUnit != nil {
				timeUnit = *req.TimeUnit
			}
			planID := current.AiGatewayPlanID
			if req.AiGatewayPlanID != nil {
				planID = *req.AiGatewayPlanID
			}
			if err := validateCreditPlanPeriod(credit, timeSpan, timeUnit, planID); err != nil {
				return 0, err
			}
		}
	}

	dao := modelfactory.DefaultDaoFactory.BundleDao(nil)
	affected, err := dao.UpdateByBundleIDs(bundleIDs, updates)
	if err != nil {
		return 0, fmt.Errorf("modify bundles: %w", err)
	}
	if affected != int64(len(bundleIDs)) {
		return affected, errcode.ErrBundlePartialNotFound
	}
	return affected, nil
}

func (l *logic) DescribeBundles() ([]*BundleDetail, error) {
	dao := modelfactory.DefaultDaoFactory.BundleDao(nil)
	entities, err := dao.ListByState(bundlemodel.StateOnline)
	if err != nil {
		return nil, fmt.Errorf("describe bundles: %w", err)
	}
	return entitiesToDetails(entities), nil
}

func (l *logic) GetBundleByID(bundleID string) (*BundleDetail, error) {
	dao := modelfactory.DefaultDaoFactory.BundleDao(nil)
	entity, err := dao.GetByBundleID(bundleID)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, errcode.ErrBundleNotFound
		}
		return nil, fmt.Errorf("get bundle by id: %w", err)
	}
	return entityToDetail(entity), nil
}

func entityToDetail(e *bundlemodel.Entity) *BundleDetail {
	detail := &BundleDetail{
		BundleID:              e.BundleID,
		BundleName:            e.BundleName,
		BundleType:            e.BundleType,
		Description:           e.Description,
		Features:              e.Features,
		Tagline:               e.Tagline,
		Promotion:             e.Promotion,
		BundleState:           e.BundleState,
		AgentQuota:            e.AgentQuota,
		Credit:                e.Credit,
		TimeSpan:              e.TimeSpan,
		TimeUnit:              e.TimeUnit,
		AiGatewayPlanID:       e.AiGatewayPlanID,
		AiGatewayPlans:        e.AiGatewayPlans,
		InstanceSpecID:        e.InstanceSpecID,
		StaticSoldOut:         e.StaticSoldOut,
		BundleSalesAvailCount: e.BundleSalesAvailCount,
		BundleSalesTotalCount: e.BundleSalesTotalCount,
		BundleSalesState:      e.SalesState(),
	}
	if e.CreatedTime != nil {
		detail.CreatedTime = *e.CreatedTime
	}
	if e.UpdatedTime != nil {
		detail.UpdatedTime = *e.UpdatedTime
	}
	return detail
}

func entitiesToDetails(entities []*bundlemodel.Entity) []*BundleDetail {
	details := make([]*BundleDetail, 0, len(entities))
	for _, e := range entities {
		details = append(details, entityToDetail(e))
	}
	return details
}

// CreditToTokens 将 credit 转为 token（对外暴露，供 pass 等包换算用）
func CreditToTokens(credit int64) int64 {
	return credit * creditTokenRatio()
}

// TokensToCredit 将 token 转为 credit（向下取整）
func TokensToCredit(tokens int64) int64 {
	r := creditTokenRatio()
	if r <= 0 {
		return 0
	}
	return tokens / r
}
