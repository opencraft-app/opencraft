// Package bundle 实现套餐包业务逻辑。
package bundle

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	adapterfactory "ctl/pkg/adapter/factory"
	"ctl/pkg/adapter/aigateway"
	"ctl/pkg/config"
	"ctl/pkg/errcode"
	"ctl/pkg/logic/objectid"
	bundlemodel "ctl/pkg/model/bundle"
	modelfactory "ctl/pkg/model/factory"

	"gorm.io/gorm"
)

// BundleDetail 套餐详情
type BundleDetail struct {
	BundleID              string
	BundleName            string
	Description           string // JSON: [{"Key":"...","Value":"..."}]
	BundleState           string
	AgentQuota            int64
	Credit                int64  // 用户可见积分额度
	TimeSpan              int    // 套餐周期数值
	TimeUnit              string // 套餐周期单位 "m"=月 / "d"=天
	AiGatewayPlanID       string // ai-gateway Plan UUID（credit=0 时允许空）
	StaticSoldOut         bool
	BundleSalesAvailCount int
	BundleSalesTotalCount int
	BundleSalesState      string // 计算字段：AVAILABLE / SOLD_OUT
	CreatedTime           time.Time
	UpdatedTime           time.Time
}

// ModifyBundleFields 可修改字段，指针类型
type ModifyBundleFields struct {
	BundleName            *string `json:"bundle_name,omitempty"`
	Description           *string `json:"description,omitempty"`
	BundleState           *string `json:"bundle_state,omitempty"`
	AgentQuota            *int64  `json:"agent_quota,omitempty"`
	Credit                *int64  `json:"credit,omitempty"`
	TimeSpan              *int    `json:"time_span,omitempty"`
	TimeUnit              *string `json:"time_unit,omitempty"`
	AiGatewayPlanID       *string `json:"ai_gateway_plan_id,omitempty"`
	StaticSoldOut         *bool   `json:"static_sold_out,omitempty"`
	BundleSalesAvailCount *int    `json:"bundle_sales_available_count,omitempty"`
	BundleSalesTotalCount *int    `json:"bundle_sales_total_count,omitempty"`
}

// Logic Bundle 业务逻辑接口
type Logic interface {
	// ImportBundle 导入套餐：不存在则创建，存在则覆盖性更新
	// 执行三项强一致性校验（credit / plan / period），校验不通过直接返回错误
	ImportBundle(bundleID string, bundleName string, description string, agentQuota int64,
		credit int64, timeSpan int, timeUnit string, aiGatewayPlanID string,
		staticSoldOut bool, salesAvailCount int, salesTotalCount int) (*BundleDetail, error)

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

// mapTimeUnitToPlanPeriodUnit 将 bundle.time_unit 映射到 ai-gateway Plan.period_unit
func mapTimeUnitToPlanPeriodUnit(timeUnit string) string {
	switch timeUnit {
	case bundlemodel.TimeUnitMonth:
		return "months"
	case bundlemodel.TimeUnitDay:
		return "days"
	default:
		return ""
	}
}

// validateCreditPlanPeriod 执行 credit/plan/period 三项一致性校验
// 规则：
//  1. time_unit ∈ {"m", "d"}，time_span > 0
//  2. credit == 0 → ai_gateway_plan_id 必须为空
//  3. credit > 0  → ai_gateway_plan_id 必须非空，且 Plan 的 monthly_tokens/period 与 bundle 字段对齐
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

	// 调用 ai-gateway 校验 Plan 一致性
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	plan, err := adapterfactory.DefaultAdapterFactory.AiGatewayAdapter().GetPlan(ctx, aiGatewayPlanID)
	if err != nil {
		if errors.Is(err, aigateway.ErrAiGatewayPlanNotFound) {
			return errcode.Wrap(errcode.ErrBundlePlanNotFound, "plan %s not found in ai-gateway", aiGatewayPlanID)
		}
		return errcode.Wrap(errcode.ErrBundleAiGatewayUnavailable, "%v", err)
	}

	expectedTokens := credit * creditTokenRatio()
	if plan.MonthlyTokens != expectedTokens {
		return errcode.Wrap(errcode.ErrBundleCreditTokenMismatch,
			"plan.monthly_tokens=%d, expected=%d (credit=%d × ratio=%d)",
			plan.MonthlyTokens, expectedTokens, credit, creditTokenRatio())
	}
	if plan.PeriodValue != timeSpan {
		return errcode.Wrap(errcode.ErrBundlePeriodMismatch,
			"plan.period_value=%d, bundle.time_span=%d", plan.PeriodValue, timeSpan)
	}
	expectedUnit := mapTimeUnitToPlanPeriodUnit(timeUnit)
	if plan.PeriodUnit != expectedUnit {
		return errcode.Wrap(errcode.ErrBundlePeriodMismatch,
			"plan.period_unit=%q, expected=%q (bundle.time_unit=%q)",
			plan.PeriodUnit, expectedUnit, timeUnit)
	}
	return nil
}

func (l *logic) ImportBundle(bundleID string, bundleName string, description string, agentQuota int64,
	credit int64, timeSpan int, timeUnit string, aiGatewayPlanID string,
	staticSoldOut bool, salesAvailCount int, salesTotalCount int) (*BundleDetail, error) {

	if bundleID == "" {
		return nil, errcode.ErrBundleConfigInvalid
	}
	if agentQuota < 0 {
		return nil, errcode.Wrap(errcode.ErrBundleConfigInvalid, "agent_quota must be >= 0")
	}
	if salesAvailCount < 0 || salesTotalCount < 0 {
		return nil, errcode.Wrap(errcode.ErrBundleConfigInvalid, "sales count must be >= 0")
	}

	// 三项一致性校验
	if err := validateCreditPlanPeriod(credit, timeSpan, timeUnit, aiGatewayPlanID); err != nil {
		return nil, err
	}

	// 如果没有提供 bundleID，生成一个
	if bundleID == "" {
		bundleID = objectid.NewLogic().GenerateBundleId()
	}

	entity := &bundlemodel.Entity{
		BundleID:              bundleID,
		BundleName:            bundleName,
		Description:           description,
		BundleState:           bundlemodel.StateOffline, // 导入默认 OFFLINE
		AgentQuota:            agentQuota,
		Credit:                credit,
		TimeSpan:              timeSpan,
		TimeUnit:              timeUnit,
		AiGatewayPlanID:       aiGatewayPlanID,
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
	if req.Description != nil {
		if !json.Valid([]byte(*req.Description)) {
			return 0, errcode.Wrap(errcode.ErrBundleConfigInvalid, "description must be valid JSON")
		}
		updates[bundlemodel.ColumnDescription] = *req.Description
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
		if *req.TimeUnit != bundlemodel.TimeUnitMonth && *req.TimeUnit != bundlemodel.TimeUnitDay {
			return 0, errcode.Wrap(errcode.ErrBundleConfigInvalid, "time_unit must be 'm' or 'd'")
		}
		updates[bundlemodel.ColumnTimeUnit] = *req.TimeUnit
	}
	if req.AiGatewayPlanID != nil {
		updates[bundlemodel.ColumnAiGatewayPlanID] = *req.AiGatewayPlanID
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
		Description:           e.Description,
		BundleState:           e.BundleState,
		AgentQuota:            e.AgentQuota,
		Credit:                e.Credit,
		TimeSpan:              e.TimeSpan,
		TimeUnit:              e.TimeUnit,
		AiGatewayPlanID:       e.AiGatewayPlanID,
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
