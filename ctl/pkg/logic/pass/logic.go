// Package pass 实现用户权益业务逻辑。
package pass

import (
	"context"
	"errors"
	"fmt"
	"time"

	adapterfactory "ctl/pkg/adapter/factory"
	"ctl/pkg/config"
	"ctl/pkg/errcode"
	bundlelogic "ctl/pkg/logic/bundle"
	"ctl/pkg/logic/objectid"
	bundlemodel "ctl/pkg/model/bundle"
	modelfactory "ctl/pkg/model/factory"
	passmodel "ctl/pkg/model/pass"
	"ctl/pkg/resource"

	"go.uber.org/zap"
	"gorm.io/gorm"
)

// PassDetail 权益详情
type PassDetail struct {
	PassID       string
	UserID       string
	BundleID     string
	Uin          int64
	AppID        int64
	CreatedTime  time.Time
	ExpiredTime  time.Time
	IsolatedTime *time.Time
	DeletedTime  *time.Time
	UpdatedTime  time.Time

	// 以下字段运行时从 Bundle / ai-gateway 拉取填充，不持久化
	BundleName      string // 套餐名称（= bundle.bundle_name）
	CreditTotal     int64  // 积分总量（= bundle.credit）
	CreditAvailable int64  // 积分余量（= token_balance / credit_token_ratio）
}

// ModifyPassFields 可修改字段
type ModifyPassFields struct {
	BundleID    *string    `json:"bundle_id,omitempty"`
	ExpiredTime *time.Time `json:"expired_time,omitempty"`
}

// Logic Pass 业务逻辑接口
type Logic interface {
	// CreateTrialPass 为用户创建试用权益
	// 有效期由 Bundle 的 time_span + time_unit 决定，调用方不指定
	CreateTrialPass(userID string, bundleID string) (*PassDetail, error)

	// GetPasses 查询所有 Pass（后台管理用）
	GetPasses(userID *string, bundleID *string) ([]*PassDetail, error)

	// ModifyPass 修改 Pass（如延期、换绑套餐）
	ModifyPass(passID string, req *ModifyPassFields) (*PassDetail, error)

	// DescribePasses 查询当前用户的 Pass 列表
	DescribePasses(userID string) ([]*PassDetail, error)
}

type logic struct {
	bundleLogic bundlelogic.Logic
}

// NewLogic 创建 Pass Logic
func NewLogic() Logic {
	return &logic{
		bundleLogic: bundlelogic.NewLogic(),
	}
}

func (l *logic) CreateTrialPass(userID string, bundleID string) (*PassDetail, error) {
	if userID == "" || bundleID == "" {
		return nil, errcode.ErrPassInvalidParam
	}

	// 步骤 1：校验 Bundle 存在且 ONLINE
	bundle, err := l.bundleLogic.GetBundleByID(bundleID)
	if err != nil {
		return nil, err
	}
	if bundle.BundleState != bundlemodel.StateOnline {
		return nil, errcode.ErrPassBundleOffline
	}

	// 步骤 2：静态售罄校验
	if bundle.StaticSoldOut {
		return nil, errcode.ErrPassBundleSoldOut
	}

	agentQuota := bundle.AgentQuota

	// 步骤 3：用户唯一 Pass 校验
	passDao := modelfactory.DefaultDaoFactory.PassDao(nil)
	existing, err := passDao.ListByUserID(userID)
	if err != nil {
		return nil, fmt.Errorf("check existing pass: %w", err)
	}
	if len(existing) > 0 {
		return nil, errcode.ErrPassAlreadyExists
	}

	// 步骤 4：配额校验
	quotaDao := modelfactory.DefaultDaoFactory.UserResourceQuotaDao(nil)
	quotaEntity, err := quotaDao.SelectQuota(userID, "OPENCLAW_INSTANCE", "")
	if err != nil {
		return nil, fmt.Errorf("check quota: %w", err)
	}
	if quotaEntity != nil {
		consumed := quotaEntity.ResourceQuotaTotal - quotaEntity.ResourceQuotaAvailable
		if consumed > agentQuota {
			return nil, errcode.ErrPassQuotaExceeded
		}
	}

	// 步骤 5：确保 ai-gateway 里的业务用户存在
	ensureCtx, ensureCancel := context.WithTimeout(context.Background(), 10*time.Second)
	resource.ZapLogger.Info("pass ensure-user started",
		zap.String("user_id", userID),
		zap.String("bundle_id", bundleID),
	)
	ensured, ensureErr := adapterfactory.DefaultAdapterFactory.AiGatewayAdapter().EnsureUser(ensureCtx, userID, "")
	ensureCancel()
	if ensureErr != nil {
		resource.ZapLogger.Warn("pass ensure-user failed",
			zap.String("user_id", userID),
			zap.String("bundle_id", bundleID),
			zap.Error(ensureErr),
		)
		return nil, fmt.Errorf("ensure ai-gateway user: %w", ensureErr)
	}
	resource.ZapLogger.Info("pass ensure-user succeeded",
		zap.String("user_id", userID),
		zap.String("bundle_id", bundleID),
		zap.Bool("created", ensured != nil && ensured.Result == "created"),
	)

	// 步骤 6：扣减 bundle 可售卖余量（原子操作，并发安全）
	bundleDao := modelfactory.DefaultDaoFactory.BundleDao(nil)
	ok, err := bundleDao.DecrementAvailCount(bundleID, 1)
	if err != nil {
		return nil, fmt.Errorf("decrement bundle avail count: %w", err)
	}
	if !ok {
		return nil, errcode.ErrBundleSalesQuotaEmpty
	}
	// 后续流程失败时回滚 available_count
	bundleQuotaDeducted := true
	defer func() {
		if bundleQuotaDeducted {
			_ = bundleDao.IncrementAvailCount(bundleID, 1)
		}
	}()

	// 步骤 7：生成 pass_id
	idGenDao := modelfactory.DefaultDaoFactory.IdGenDao(nil)
	autoID, err := idGenDao.GenId("pass")
	if err != nil {
		return nil, fmt.Errorf("generate pass auto id: %w", err)
	}
	password := "passmon" + config.ServerConf.MiscConfig.ObjectIdPasswordSuffix
	region := config.ServerConf.MiscConfig.Region
	passID, err := objectid.GeneratePassID(autoID, password, region)
	if err != nil {
		return nil, fmt.Errorf("generate pass id: %w", err)
	}

	// 步骤 8：计算 expired_time（由 bundle.time_span + time_unit 决定）
	now := time.Now().UTC()
	expiredTime, err := CalcExpiredTime(now, bundle.TimeSpan, bundle.TimeUnit)
	if err != nil {
		return nil, fmt.Errorf("calc expired_time: %w", err)
	}

	// 步骤 9：AI Token 订阅联动（严格一致）
	// credit > 0 时调 ai-gateway ApplySubscription；credit == 0 时跳过
	if bundle.Credit > 0 {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		sub, subErr := adapterfactory.DefaultAdapterFactory.AiGatewayAdapter().
			ApplySubscription(ctx, userID, bundle.AiGatewayPlanID)
		cancel()
		if subErr != nil {
			return nil, fmt.Errorf("apply ai-gateway subscription: %w", subErr)
		}
		if sub != nil {
			resource.ZapLogger.Info("pass subscription applied",
				zap.String("pass_id", passID),
				zap.String("user_id", userID),
				zap.String("plan_id", bundle.AiGatewayPlanID),
				zap.String("subscription_id", sub.ID),
			)
		}
	}

	// 步骤 10：事务写入 pass + quota
	entity := &passmodel.Entity{
		PassID:      passID,
		UserID:      userID,
		BundleID:    bundleID,
		Uin:         0, // TODO: 后续从 shadow binding 获取
		AppID:       0, // TODO: 后续从 shadow binding 获取
		ExpiredTime: expiredTime,
	}

	if err := passDao.CreatePassWithQuota(entity, userID, agentQuota); err != nil {
		return nil, fmt.Errorf("create pass with quota: %w", err)
	}

	// 步骤 11：创建成功，取消回滚
	bundleQuotaDeducted = false

	// 步骤 12：返回（首次创建，credit_available = credit_total）
	saved, err := passDao.GetByPassID(passID)
	if err != nil {
		return nil, fmt.Errorf("read back pass: %w", err)
	}
	detail := entityToDetail(saved)
	detail.BundleName = bundle.BundleName
	detail.CreditTotal = bundle.Credit
	detail.CreditAvailable = bundle.Credit
	return detail, nil
}

func (l *logic) GetPasses(userID *string, bundleID *string) ([]*PassDetail, error) {
	dao := modelfactory.DefaultDaoFactory.PassDao(nil)
	entities, err := dao.ListByFilters(userID, bundleID)
	if err != nil {
		return nil, fmt.Errorf("get passes: %w", err)
	}
	details := entitiesToDetails(entities)
	l.fillCredits(details)
	return details, nil
}

func (l *logic) ModifyPass(passID string, req *ModifyPassFields) (*PassDetail, error) {
	if passID == "" {
		return nil, errcode.ErrPassInvalidParam
	}
	if req == nil {
		return nil, errcode.ErrPassNoFieldToUpdate
	}

	updates := make(map[string]interface{})
	if req.BundleID != nil {
		updates[passmodel.ColumnBundleID] = *req.BundleID
	}
	if req.ExpiredTime != nil {
		updates[passmodel.ColumnExpiredTime] = *req.ExpiredTime
	}
	if len(updates) == 0 {
		return nil, errcode.ErrPassNoFieldToUpdate
	}

	dao := modelfactory.DefaultDaoFactory.PassDao(nil)

	_, err := dao.GetByPassID(passID)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, errcode.ErrPassNotFound
		}
		return nil, fmt.Errorf("modify pass: %w", err)
	}

	if err := dao.UpdateByPassID(passID, updates); err != nil {
		return nil, fmt.Errorf("modify pass: %w", err)
	}

	saved, err := dao.GetByPassID(passID)
	if err != nil {
		return nil, fmt.Errorf("modify pass: read back: %w", err)
	}
	detail := entityToDetail(saved)
	l.fillCredit(detail)
	return detail, nil
}

func (l *logic) DescribePasses(userID string) ([]*PassDetail, error) {
	if userID == "" {
		return nil, errcode.ErrPassInvalidParam
	}
	dao := modelfactory.DefaultDaoFactory.PassDao(nil)
	entities, err := dao.ListByUserID(userID)
	if err != nil {
		return nil, fmt.Errorf("describe passes: %w", err)
	}
	details := entitiesToDetails(entities)
	l.fillCredits(details)
	return details, nil
}

// fillCredits 批量为 PassDetail 填充 credit_total / credit_available
func (l *logic) fillCredits(details []*PassDetail) {
	for _, d := range details {
		l.fillCredit(d)
	}
}

// fillCredit 为单个 PassDetail 填充 bundle 相关字段
//   - bundle_name 从 bundle 读取
//   - credit_total 从 bundle.credit 读取
//   - credit_available 实时调 ai-gateway 查 subscription 换算；失败时返回 0 + 日志告警
func (l *logic) fillCredit(d *PassDetail) {
	if d == nil {
		return
	}
	bundle, err := l.bundleLogic.GetBundleByID(d.BundleID)
	if err != nil {
		resource.ZapLogger.Warn("fill credit: get bundle failed",
			zap.String("pass_id", d.PassID),
			zap.String("bundle_id", d.BundleID),
			zap.Error(err),
		)
		return
	}
	d.BundleName = bundle.BundleName
	d.CreditTotal = bundle.Credit

	// credit == 0 的 bundle 不需要查 ai-gateway
	if bundle.Credit == 0 {
		d.CreditAvailable = 0
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	sub, err := adapterfactory.DefaultAdapterFactory.AiGatewayAdapter().GetActiveSubscription(ctx, d.UserID)
	if err != nil {
		resource.ZapLogger.Warn("fill credit: get ai-gateway active subscription failed",
			zap.String("pass_id", d.PassID),
			zap.String("user_id", d.UserID),
			zap.Error(err),
		)
		d.CreditAvailable = 0
		return
	}
	if sub == nil {
		// 无订阅（可能尚未开通或已取消）
		d.CreditAvailable = 0
		return
	}
	d.CreditAvailable = bundlelogic.TokensToCredit(sub.TokenBalance)
}

// CalcExpiredTime 按 Bundle 的 time_span + time_unit 计算 Pass 到期时间
//   - time_unit="m" → 按自然月累加（月末溢出：3月31 + 1月 = 4月30）
//   - time_unit="d" → 按自然天累加
func CalcExpiredTime(start time.Time, timeSpan int, timeUnit string) (time.Time, error) {
	if timeSpan <= 0 {
		return time.Time{}, fmt.Errorf("invalid time_span: %d", timeSpan)
	}
	switch timeUnit {
	case bundlemodel.TimeUnitMonth:
		return addMonthsNatural(start, timeSpan), nil
	case bundlemodel.TimeUnitDay:
		return start.AddDate(0, 0, timeSpan), nil
	default:
		return time.Time{}, fmt.Errorf("invalid time_unit: %q", timeUnit)
	}
}

// addMonthsNatural 按自然月累加，目标月无对应日期时取该月最后一天
func addMonthsNatural(start time.Time, months int) time.Time {
	y, m, d := start.Date()
	targetYear, targetMonth := y, m+time.Month(months)
	for targetMonth > 12 {
		targetMonth -= 12
		targetYear++
	}
	maxDay := daysInMonth(targetYear, targetMonth)
	if d > maxDay {
		d = maxDay
	}
	return time.Date(targetYear, targetMonth, d,
		start.Hour(), start.Minute(), start.Second(), start.Nanosecond(), start.Location())
}

func daysInMonth(year int, month time.Month) int {
	return time.Date(year, month+1, 0, 0, 0, 0, 0, time.UTC).Day()
}

func entityToDetail(e *passmodel.Entity) *PassDetail {
	detail := &PassDetail{
		PassID:       e.PassID,
		UserID:       e.UserID,
		BundleID:     e.BundleID,
		Uin:          e.Uin,
		AppID:        e.AppID,
		ExpiredTime:  e.ExpiredTime,
		IsolatedTime: e.IsolatedTime,
		DeletedTime:  e.DeletedTime,
	}
	if e.CreatedTime != nil {
		detail.CreatedTime = *e.CreatedTime
	}
	if e.UpdatedTime != nil {
		detail.UpdatedTime = *e.UpdatedTime
	}
	return detail
}

func entitiesToDetails(entities []*passmodel.Entity) []*PassDetail {
	details := make([]*PassDetail, 0, len(entities))
	for _, e := range entities {
		details = append(details, entityToDetail(e))
	}
	return details
}
