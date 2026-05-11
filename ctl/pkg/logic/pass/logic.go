// Package pass 实现用户权益业务逻辑。
package pass

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"time"

	adapterfactory "ctl/pkg/adapter/factory"
	tradeadapter "ctl/pkg/adapter/trade"
	"ctl/pkg/config"
	"ctl/pkg/errcode"
	bundlelogic "ctl/pkg/logic/bundle"
	"ctl/pkg/logic/objectid"
	bundlemodel "ctl/pkg/model/bundle"
	modelfactory "ctl/pkg/model/factory"
	passmodel "ctl/pkg/model/pass"
	"ctl/pkg/resource"
	"ctl/pkg/transport"

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

	// CompletePass 由 trade 服务在 jifei createResource 回调后反向调用 ctl，完成付费 pass 发货
	//
	// v4 收敛（billing-integration B3 新增）：
	//   - 入参 time_span / time_unit 由 trade 透传（来源于下单时的 trade_order，而非 bundle 字段）
	//   - 入参 uin / app_id 由 trade 透传，写入 ctl_pass 表（取代 CreateTrialPass 中的 TODO=0）
	//   - 入参 deal_name 仅日志记录用于排障，ctl_pass 表不持久化（归 trade_order 反查）
	//   - renew_flag 本期 logic 内部写死 MANUAL_RENEW（不读 req.RenewFlag，待 AUTO_RENEW 放开后再切换）
	//   - 兜底防御：用户已有 active pass 直接报 ErrPassAlreadyExists（不做幂等，不依赖 pass_pending_order）
	CompletePass(req *transport.CompletePassRequest) (*PassDetail, error)

	// CreatePassOrder 创建付费 pass 订单（billing-integration B2 新增）
	//
	// 用途：用户选择付费 bundle 后调本接口，由 ctl 反查 shadow 拿到 uin/appID，
	// 然后调 trade.PlaceOrder 下一笔 jifei 订单 + 调 trade.GeneratePayURL
	// 拿到支付页 URL，最后透传给前端。**本接口不创建本地 pass**：
	// 实际 pass 发货发生在 jifei 计费回调链路：
	//
	//   jifei → trade.checkCreate → trade.createResource → ctl.CompletePass
	//
	// 失败兜底：当 trade 侧 GeneratePayURL 拿不到真实 URL 时（8B-1.5 阶段
	// jifei "生成支付url" SDK 还未接入），trade 返一个 mock URL，本接口透传即可。
	CreatePassOrder(userID string, req *transport.CreatePassOrderRequest) (*transport.CreatePassOrderResult, error)

	// CreatePassOrderAndPay 一体化创建付费 pass 订单 + 自动支付（billing-integration B2 新增）
	//
	// **仅用于联调测试 / 自动化 e2e，现网控制台禁止暴露给真实用户**。
	//
	// 与 CreatePassOrder 的差异：
	//   - CreatePassOrder：调 trade.PlaceOrder + trade.GeneratePayURL，返支付 URL，
	//     用户在浏览器付款后由 jifei 异步回调触发发货
	//   - CreatePassOrderAndPay：调 trade.PlaceOrderAndPay 一次完成 "下单 + 支付 +
	//     触发 createResource 回调"，跳过支付 URL；适合测试代金券充足的环境跑通
	//     trade ↔ jifei ↔ ctl.createResource 端到端链路，无需真人浏览器付款
	//
	// 与 CreatePassOrder 一致：**本接口不创建本地 pass**，pass 发货走相同的回调链路。
	CreatePassOrderAndPay(userID string, req *transport.CreatePassOrderRequest) (*transport.CreatePassOrderAndPayResult, error)

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
		Uin:         0, // TODO: 后续从 shadow binding 获取（试用 pass）
		AppID:       0, // TODO: 后续从 shadow binding 获取（试用 pass）
		ExpiredTime: expiredTime,
		RenewFlag:   passmodel.RenewFlagManual, // v4 收敛：试用 pass 默认手动续费
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

// CompletePass v4 收敛：trade 反向调 ctl 完成付费 pass 发货。
//
// 与 CreateTrialPass 的差异：
//  1. 入参从 (userID, bundleID) 升级为完整 *transport.CompletePassRequest（透传 jifei 协议字段）
//  2. expired_time 计算用 req.TimeSpan/TimeUnit（trade 持有的下单参数），不再读 bundle.TimeSpan/TimeUnit
//  3. entity.Uin / AppID 从 req 透传写入（不再 TODO=0）
//  4. RenewFlag 强制写 MANUAL_RENEW（v4 收敛：本期不对外暴露，req.RenewFlag 仅协议预留）
//  5. deal_name 仅日志记录用于排障，pass 表不持久化
//
// 复用 CreateTrialPass 步骤 5-12 的核心逻辑（EnsureUser → DecrementAvailCount →
// GeneratePassID → ApplySubscription → CreatePassWithQuota）。
func (l *logic) CompletePass(req *transport.CompletePassRequest) (*PassDetail, error) {
	// 步骤 0：入参强校验（v4：trade 透传字段必须齐全，缺失即拒）
	if err := validateCompletePassRequest(req); err != nil {
		return nil, err
	}

	logger := resource.ZapLogger.With(
		zap.String("user_id", req.UserID),
		zap.String("bundle_id", req.BundleID),
		zap.String("deal_name", req.DealName),
		zap.Int64("uin", req.Uin),
		zap.Int64("app_id", req.AppID),
	)
	logger.Info("complete pass started")

	// 步骤 1：校验 Bundle 存在且 ONLINE
	bundle, err := l.bundleLogic.GetBundleByID(req.BundleID)
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

	// 步骤 3：用户唯一 Pass 兜底防御（v4 收敛：不做幂等，存在即拒）
	passDao := modelfactory.DefaultDaoFactory.PassDao(nil)
	existing, err := passDao.ListByUserID(req.UserID)
	if err != nil {
		return nil, fmt.Errorf("check existing pass: %w", err)
	}
	if len(existing) > 0 {
		// 等价于 v4 设计稿中的 USER_HAS_ACTIVE_PASS
		return nil, errcode.ErrPassAlreadyExists
	}

	// 步骤 4：配额校验
	quotaDao := modelfactory.DefaultDaoFactory.UserResourceQuotaDao(nil)
	quotaEntity, err := quotaDao.SelectQuota(req.UserID, "OPENCLAW_INSTANCE", "")
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
	logger.Info("complete pass ensure-user started")
	ensured, ensureErr := adapterfactory.DefaultAdapterFactory.AiGatewayAdapter().EnsureUser(ensureCtx, req.UserID, "")
	ensureCancel()
	if ensureErr != nil {
		logger.Warn("complete pass ensure-user failed", zap.Error(ensureErr))
		return nil, fmt.Errorf("ensure ai-gateway user: %w", ensureErr)
	}
	logger.Info("complete pass ensure-user succeeded",
		zap.Bool("created", ensured != nil && ensured.Result == "created"),
	)

	// 步骤 6：扣减 bundle 可售卖余量（原子操作，并发安全）
	bundleDao := modelfactory.DefaultDaoFactory.BundleDao(nil)
	ok, err := bundleDao.DecrementAvailCount(req.BundleID, 1)
	if err != nil {
		return nil, fmt.Errorf("decrement bundle avail count: %w", err)
	}
	if !ok {
		return nil, errcode.ErrBundleSalesQuotaEmpty
	}
	bundleQuotaDeducted := true
	defer func() {
		if bundleQuotaDeducted {
			_ = bundleDao.IncrementAvailCount(req.BundleID, 1)
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

	// 步骤 8：计算 expired_time（v4 收敛：用 req 透传的 TimeSpan/TimeUnit，trade_order 已持有）
	now := time.Now().UTC()
	expiredTime, err := CalcExpiredTime(now, req.TimeSpan, req.TimeUnit)
	if err != nil {
		return nil, fmt.Errorf("calc expired_time: %w", err)
	}

	// 步骤 9：AI Token 订阅联动（与 CreateTrialPass 一致，credit > 0 时调 ApplySubscription）
	if bundle.Credit > 0 {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		sub, subErr := adapterfactory.DefaultAdapterFactory.AiGatewayAdapter().
			ApplySubscription(ctx, req.UserID, bundle.AiGatewayPlanID)
		cancel()
		if subErr != nil {
			return nil, fmt.Errorf("apply ai-gateway subscription: %w", subErr)
		}
		if sub != nil {
			logger.Info("complete pass subscription applied",
				zap.String("pass_id", passID),
				zap.String("plan_id", bundle.AiGatewayPlanID),
				zap.String("subscription_id", sub.ID),
			)
		}
	}

	// 步骤 10：事务写入 pass + quota（v4 收敛：uin/app_id 从 req 透传，renew_flag 写死 MANUAL_RENEW）
	entity := &passmodel.Entity{
		PassID:      passID,
		UserID:      req.UserID,
		BundleID:    req.BundleID,
		Uin:         req.Uin,
		AppID:       req.AppID,
		ExpiredTime: expiredTime,
		RenewFlag:   passmodel.RenewFlagManual, // v4 收敛：本期不对外暴露，logic 写死
	}
	if err := passDao.CreatePassWithQuota(entity, req.UserID, agentQuota); err != nil {
		return nil, fmt.Errorf("create pass with quota: %w", err)
	}

	// 步骤 11：创建成功，取消回滚
	bundleQuotaDeducted = false

	// 步骤 12：读回返回
	saved, err := passDao.GetByPassID(passID)
	if err != nil {
		return nil, fmt.Errorf("read back pass: %w", err)
	}
	detail := entityToDetail(saved)
	detail.BundleName = bundle.BundleName
	detail.CreditTotal = bundle.Credit
	detail.CreditAvailable = bundle.Credit

	logger.Info("complete pass succeeded", zap.String("pass_id", passID))
	return detail, nil
}

// validateCompletePassRequest v4 收敛：CompletePass 入参强校验
//
// trade 反向调时所有字段必填，缺失即报 ErrPassInvalidParam（trade 侧应已校验，
// ctl 侧仅做防御性校验避免脏数据进入业务流程）。
func validateCompletePassRequest(req *transport.CompletePassRequest) error {
	if req == nil {
		return errcode.Wrap(errcode.ErrPassInvalidParam, "request is nil")
	}
	if req.UserID == "" {
		return errcode.Wrap(errcode.ErrPassInvalidParam, "user_id is required")
	}
	if req.BundleID == "" {
		return errcode.Wrap(errcode.ErrPassInvalidParam, "bundle_id is required")
	}
	if req.TimeSpan <= 0 {
		return errcode.Wrap(errcode.ErrPassInvalidParam, "time_span must be > 0")
	}
	if req.TimeUnit != bundlemodel.TimeUnitMonth && req.TimeUnit != bundlemodel.TimeUnitDay {
		return errcode.Wrap(errcode.ErrPassInvalidParam, "time_unit must be 'm' or 'd'")
	}
	if req.Uin <= 0 {
		return errcode.Wrap(errcode.ErrPassInvalidParam, "uin must be > 0")
	}
	if req.AppID <= 0 {
		return errcode.Wrap(errcode.ErrPassInvalidParam, "app_id must be > 0")
	}
	if req.DealName == "" {
		return errcode.Wrap(errcode.ErrPassInvalidParam, "deal_name is required")
	}
	return nil
}

// trade ↔ ctl 透传约束（与 trade-purchase-flow-design.md §4.2.1 对齐）：
//
//   - lighthousePassRegionID = 47   Lighthouse SaaS 兜底 RegionID（trade 内部 fixedRegionID 一致）
//   - lighthousePassPayMode  = 1    包年包月（PayMode=1）
//   - lighthousePassGoodsNum = 1    本期固定单件（Q41 拍板）
//
// 这些值都是 jifei 协议要求字段，ctl 侧从用户面看不到，由调用层兜底；
// trade 内部也按这套兜底自校验。
const (
	lighthousePassRegionID = 47
	lighthousePassPayMode  = 1
	lighthousePassGoodsNum = 1
)

// CreatePassOrder billing-integration B2：创建付费 pass 订单。
//
// 流程概览：
//
//  1. 入参强校验（userID / BundleID / Period / TimeUnit）
//  2. 校验 Bundle 存在且 ONLINE，且非售罄
//  3. 用户唯一 pass 兜底防御（与 CreateTrialPass / CompletePass 一致）
//  4. 反查 shadow Binding 拿 uin / appID（缺失即报 ErrPassShadowBindingNotFound）
//  5. 调 trade.PlaceOrder 创建 jifei 订单（trade 内部已透传 shadow binding，
//     这里同时显式传 uin / appID 作为冗余以兼容 trade 配置中 ShadowClient 缺失的兜底场景）
//  6. 调 trade.GeneratePayURL 拿支付 URL（8B-1.5 阶段未命中 SDK 时返 mock URL）
//  7. 返回 (DealName, PayURL) 给上层
//
// **不写本地 pass 表** — pass 发货由 jifei 回调链路触发 ctl.CompletePass 完成。
func (l *logic) CreatePassOrder(userID string, req *transport.CreatePassOrderRequest) (*transport.CreatePassOrderResult, error) {
	// 步骤 1 ~ 4：共享前置（参数校验 / bundle 校验 / 用户唯一性 / 反查 shadow / 构建 trade 入参）
	placeReq, logger, err := l.prepareCreatePassOrder(userID, req, "create_pass_order")
	if err != nil {
		return nil, err
	}

	// 步骤 5：调 trade.PlaceOrder
	placeCtx, placeCancel := context.WithTimeout(context.Background(), 15*time.Second)
	placeResp, placeErr := adapterfactory.DefaultAdapterFactory.TradeAdapter().PlaceOrder(placeCtx, placeReq)
	placeCancel()
	if placeErr != nil {
		logger.Warn("create pass order: trade.PlaceOrder failed", zap.Error(placeErr))
		return nil, fmt.Errorf("trade place order: %w", placeErr)
	}
	if placeResp == nil || placeResp.DealName == "" {
		return nil, fmt.Errorf("trade place order: empty deal_name")
	}
	logger.Info("create pass order: trade.PlaceOrder ok",
		zap.String("deal_name", placeResp.DealName),
		zap.String("big_order_id", placeResp.BigOrderID),
	)

	// 步骤 6：调 trade.GeneratePayURL（8B-1.5：未接入 SDK 时返 mock URL）
	urlCtx, urlCancel := context.WithTimeout(context.Background(), 10*time.Second)
	urlResp, urlErr := adapterfactory.DefaultAdapterFactory.TradeAdapter().GeneratePayURL(urlCtx, placeResp.DealName)
	urlCancel()
	if urlErr != nil {
		logger.Warn("create pass order: trade.GeneratePayURL failed",
			zap.String("deal_name", placeResp.DealName),
			zap.Error(urlErr),
		)
		return nil, fmt.Errorf("trade generate pay url: %w", urlErr)
	}
	if urlResp == nil || urlResp.PayURL == "" {
		return nil, fmt.Errorf("trade generate pay url: empty pay_url")
	}
	logger.Info("create pass order succeeded",
		zap.String("deal_name", placeResp.DealName),
	)

	// 步骤 7：返回（不写本地 pass）
	return &transport.CreatePassOrderResult{
		DealName: placeResp.DealName,
		PayURL:   urlResp.PayURL,
	}, nil
}

// CreatePassOrderAndPay billing-integration B2：一体化创建付费 pass 订单 + 自动支付。
//
// **仅用于联调测试 / 自动化 e2e，现网控制台禁止暴露给真实用户**。
//
// 流程概览（前 4 步与 CreatePassOrder 完全一致）：
//
//  1. 入参强校验
//  2. 校验 Bundle 存在且 ONLINE / 未售罄
//  3. 用户唯一 pass 兜底防御
//  4. 反查 shadow Binding 拿 uin / appID
//  5. 调 trade.PlaceOrderAndPay 一次完成 "下单 + 支付 + 触发 createResource 回调"，
//     **不再调 GeneratePayURL**（一体化接口跳过支付 URL 概念）
//  6. 返回 (DealName, BigOrderID) 给上层；测试方据此反查 jifei 控制台 / 等待
//     ctl.CompletePass 回调到达
//
// **不写本地 pass 表** — pass 发货由 jifei → trade.checkCreate → trade.createResource
// → ctl.CompletePass 链路触发，与 CreatePassOrder 一致。
func (l *logic) CreatePassOrderAndPay(userID string, req *transport.CreatePassOrderRequest) (*transport.CreatePassOrderAndPayResult, error) {
	// 步骤 1 ~ 4：共享前置
	placeReq, logger, err := l.prepareCreatePassOrder(userID, req, "create_pass_order_and_pay")
	if err != nil {
		return nil, err
	}

	// 步骤 5：调 trade.PlaceOrderAndPay（一次完成下单 + 支付）
	placeCtx, placeCancel := context.WithTimeout(context.Background(), 30*time.Second)
	placeResp, placeErr := adapterfactory.DefaultAdapterFactory.TradeAdapter().PlaceOrderAndPay(placeCtx, placeReq)
	placeCancel()
	if placeErr != nil {
		logger.Warn("create pass order and pay: trade.PlaceOrderAndPay failed", zap.Error(placeErr))
		return nil, fmt.Errorf("trade place order and pay: %w", placeErr)
	}
	if placeResp == nil || placeResp.DealName == "" {
		return nil, fmt.Errorf("trade place order and pay: empty deal_name")
	}
	logger.Info("create pass order and pay succeeded",
		zap.String("deal_name", placeResp.DealName),
		zap.String("big_order_id", placeResp.BigOrderID),
	)

	// 步骤 6：返回（不写本地 pass，PayURL 一体化接口下永远为空，不返）
	return &transport.CreatePassOrderAndPayResult{
		DealName:   placeResp.DealName,
		BigOrderID: placeResp.BigOrderID,
	}, nil
}

// prepareCreatePassOrder CreatePassOrder / CreatePassOrderAndPay 共享前置流程。
//
// 步骤覆盖：
//
//  1. 入参强校验（userID / BundleID / Period / TimeUnit）
//  2. 校验 Bundle 存在且 ONLINE 且非售罄
//  3. 用户唯一 pass 兜底防御
//  4. 反查 shadow Binding 拿 uin / appID
//  5. 构造 trade.PlaceOrder / PlaceOrderAndPay 入参
//
// 返回构造好的 *tradeadapter.PlaceOrderRequest 和带上下文字段的 logger，调用方仅需
// 接力调 trade 端点。
func (l *logic) prepareCreatePassOrder(
	userID string,
	req *transport.CreatePassOrderRequest,
	flow string,
) (*tradeadapter.PlaceOrderRequest, *zap.Logger, error) {
	// 步骤 1：入参强校验
	if userID == "" {
		return nil, nil, errcode.Wrap(errcode.ErrPassInvalidParam, "user_id is required")
	}
	if req == nil {
		return nil, nil, errcode.Wrap(errcode.ErrPassInvalidParam, "request is nil")
	}
	if req.BundleID == "" {
		return nil, nil, errcode.Wrap(errcode.ErrPassInvalidParam, "bundle_id is required")
	}
	if req.Period <= 0 {
		return nil, nil, errcode.Wrap(errcode.ErrPassInvalidParam, "period must be > 0")
	}
	if req.TimeUnit != bundlemodel.TimeUnitMonth && req.TimeUnit != bundlemodel.TimeUnitDay {
		return nil, nil, errcode.Wrap(errcode.ErrPassInvalidParam, "time_unit must be 'm' or 'd'")
	}

	logger := resource.ZapLogger.With(
		zap.String("flow", flow),
		zap.String("user_id", userID),
		zap.String("bundle_id", req.BundleID),
		zap.Int("period", req.Period),
		zap.String("time_unit", req.TimeUnit),
	)
	logger.Info("create pass order: prepare started")

	// 步骤 2：校验 Bundle 存在且 ONLINE / 未售罄
	bundle, err := l.bundleLogic.GetBundleByID(req.BundleID)
	if err != nil {
		return nil, logger, err
	}
	if bundle.BundleState != bundlemodel.StateOnline {
		return nil, logger, errcode.ErrPassBundleOffline
	}
	if bundle.StaticSoldOut {
		return nil, logger, errcode.ErrPassBundleSoldOut
	}

	// 步骤 3：用户唯一 pass 兜底防御（与 trade.checkCreate 互斥占用规则保持对齐）
	passDao := modelfactory.DefaultDaoFactory.PassDao(nil)
	existing, err := passDao.ListByUserID(userID)
	if err != nil {
		return nil, logger, fmt.Errorf("check existing pass: %w", err)
	}
	if len(existing) > 0 {
		return nil, logger, errcode.ErrPassAlreadyExists
	}

	// 步骤 4：反查 shadow Binding 拿 uin / appID
	binding, err := adapterfactory.DefaultAdapterFactory.ShadowAdapter().GetBindingByUserID(userID)
	if err != nil {
		return nil, logger, fmt.Errorf("get shadow binding: %w", err)
	}
	if binding == nil {
		return nil, logger, errcode.ErrPassShadowBindingNotFound
	}
	if binding.Uin <= 0 || binding.AppID <= 0 {
		return nil, logger, errcode.Wrap(errcode.ErrPassShadowBindingNotFound,
			"binding uin/app_id invalid: uin=%d app_id=%d", binding.Uin, binding.AppID)
	}

	// 步骤 5：构造 trade 入参
	return &tradeadapter.PlaceOrderRequest{
		ExternalUserID: userID,
		Uin:            strconv.FormatInt(binding.Uin, 10),
		AppID:          strconv.FormatInt(binding.AppID, 10),
		BundleID:       req.BundleID,
		Period:         req.Period,
		TimeUnit:       req.TimeUnit,
		GoodsNum:       lighthousePassGoodsNum,
		PayMode:        lighthousePassPayMode,
		RegionID:       lighthousePassRegionID,
	}, logger, nil
}
