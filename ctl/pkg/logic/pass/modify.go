package pass

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	pctx "ctl/pkg/context"
	"ctl/pkg/errcode"
	instanceasync "ctl/pkg/instance"
	bundlemodel "ctl/pkg/model/bundle"
	modelfactory "ctl/pkg/model/factory"
	modelinstance "ctl/pkg/model/instance"
	passmodel "ctl/pkg/model/pass"
	taskmodel "ctl/pkg/model/task"
	taskcommon "ctl/pkg/taskruntime/common"
	"ctl/pkg/transport"

	"go.uber.org/zap"
	"gorm.io/gorm"
)

// 同 SP 变配（升配）的 CTL 入口。需求：TAPD 1010132091137784162 §5.2 / §6
//
// 两个入口共用同一套前置校验，这是刻意的：checkModify 在下单前跑一次，modifyResource
// 在发货前再跑一次，中间隔着用户支付的时间窗，期间 pass 可能被续费、隔离甚至销毁。
// 两次用同一份校验逻辑才能保证"询价时说能升，发货时就一定还能升"，否则会出现
// 已扣款但资源发不出去的账不平。
//
// deadline 一致性容忍到秒：expired_time 在 DB 是 DATETIME，jifei 的 curDeadline 走
// 字符串协议，两边亚秒精度本来就对不齐，比到秒是这条链路上唯一有意义的粒度。
const modifyDeadlineTolerance = time.Second

// 变配父 task 的重试节奏。
//
// 父 task max=1<<30「永不放弃」：系统盘扩容不可逆，中途放弃只会留下"权益还是启航但
// 机器已经是巡游"的半升配状态，没有任何自动出路。与 renew 父 task 同范式。
// 子 task 60s × 60 = 1h：单台机器停机→改规格→扩盘→开机在腾讯云侧可达十几分钟。
const (
	modifyPassParentExecuteIntervalSeconds = int64(30)
	modifyPassParentMaxExecuteCount        = 1 << 30
)

// CheckPassModify 详见 Logic 接口注释
func (l *logic) CheckPassModify(passID string, req *transport.CheckPassModifyRequest) error {
	if req == nil {
		return errcode.Wrap(errcode.ErrPassInvalidParam, "request is required")
	}
	_, _, err := resolveModifyTarget(passID, req)
	return err
}

// AcceptPassModify 详见 Logic 接口注释
func (l *logic) AcceptPassModify(passID string, req *transport.PassModifyRequest) (string, error) {
	if req == nil {
		return "", errcode.Wrap(errcode.ErrPassInvalidParam, "request is required")
	}
	if req.TradeFlowID <= 0 {
		// flow id 是 pass 上区分"同一单重投"和"别的单插队"的唯一依据，缺了它
		// 幂等就无从判断，只能在入口拒掉。
		return "", errcode.Wrap(errcode.ErrPassInvalidParam, "trade_flow_id must be > 0")
	}
	if taskID, found, receiptErr := completedModifyReceipt(passID, req); found || receiptErr != nil {
		return taskID, receiptErr
	}

	logger := modifyLogger().With(
		zap.String("pass_id", passID),
		zap.Int64("trade_flow_id", req.TradeFlowID),
		zap.String("deal_name", req.DealName),
		zap.String("target_bundle_id", req.TargetBundleID),
	)

	entity, targetBundle, err := resolveModifyTarget(passID, &req.CheckPassModifyRequest)
	if err != nil {
		if taskID, found, receiptErr := completedModifyReceipt(passID, req); found || receiptErr != nil {
			return taskID, receiptErr
		}
		// 已在 modifying 的情况要先区分是不是同一笔单重投，再决定是拒绝还是复用。
		if errors.Is(err, errcode.ErrPassModifying) {
			return l.resumeModifyForSameFlow(passID, req, logger)
		}
		return "", err
	}

	passDao := modelfactory.DefaultDaoFactory.PassDao(nil)
	acquired, err := passDao.TryAcquireSlotForModify(entity.PassID, req.TradeFlowID, entity.BundleID, targetBundle.BundleID)
	if err != nil {
		return "", errcode.Wrap(errcode.ErrInternalServer, "TryAcquireSlotForModify: %v", err)
	}
	if !acquired {
		// 校验通过之后被并发抢走：重读一次决定是复用原 flow 还是报当前状态。
		return l.resumeModifyForSameFlow(passID, req, logger)
	}
	logger.Info("pass status flipped to modifying")

	taskID, err := instanceasync.EnqueueModifyPassTask(
		pctx.NewContext(nil),
		entity.PassID,
		entity.UserID,
		entity.BundleID,
		targetBundle.BundleID,
		req.TradeFlowID,
		req.DealName,
		modifyPassParentExecuteIntervalSeconds,
		modifyPassParentMaxExecuteCount,
	)
	if err != nil {
		// 派发失败不回滚 modifying：pass 上已记着这笔 flow，计费重投会命中
		// resumeModifyForSameFlow 重新派发，实例创建也已被 guard 拦住。
		logger.Error("enqueue modify parent task failed, pass remains in modifying", zap.Error(err))
		return "", errcode.Wrap(errcode.ErrInternalServer, "enqueue modify parent task: %v", err)
	}
	logger.Info("modify parent task enqueued", zap.String("task_id", taskID))
	return taskID, nil
}

// completedModifyReceipt handles the window where CTL finalized the resource
// before Trade persisted acceptance. Never infer acceptance from the target
// bundle alone: the durable task must match the exact flow, order and owner.
func completedModifyReceipt(passID string, req *transport.PassModifyRequest) (string, bool, error) {
	p, err := modelfactory.DefaultDaoFactory.PassDao(nil).GetByPassID(passID)
	if err != nil {
		if errors.Is(err, errcode.ErrPassNotFound) || errors.Is(err, gorm.ErrRecordNotFound) {
			return "", false, nil
		}
		return "", false, errcode.Wrap(errcode.ErrInternalServer, "read pass for modify receipt: %v", err)
	}
	if req.Uin <= 0 || req.AppID <= 0 || p.Uin != req.Uin || p.AppID != req.AppID {
		return "", false, nil
	}
	id := instanceasync.ModifyPassTaskID(p.PassID, req.TradeFlowID)
	var task taskmodel.Entity
	if err := taskmodel.NewDao().SelectByKeyColumn(id, &task); err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return "", false, nil
		}
		return "", false, errcode.Wrap(errcode.ErrInternalServer, "read modify acceptance receipt: %v", err)
	}
	var receipt taskcommon.ModifyPassTaskPayload
	if err := json.Unmarshal([]byte(task.TaskParams), &receipt); err != nil {
		return "", false, errcode.Wrap(errcode.ErrInternalServer, "decode modify acceptance receipt: %v", err)
	}
	if task.TaskName != taskcommon.TaskNameModifyPass || task.UserID != p.UserID ||
		receipt.PassID != p.PassID || receipt.UserID != p.UserID || receipt.TradeFlowID != req.TradeFlowID ||
		receipt.DealName != req.DealName || receipt.SourceBundleID != req.SourceBundleID || receipt.TargetBundleID != req.TargetBundleID {
		return "", false, nil
	}
	if !receipt.EntitlementsFinalized && (p.Status != passmodel.StatusActive || p.BundleID != req.TargetBundleID) {
		return "", false, nil
	}
	switch task.TaskState {
	case taskmodel.StateCreated, taskmodel.StateRunning, taskmodel.StateSuccess:
		// The original parent continues its completion callback retries. Do not
		// enqueue a second task or apply entitlements again.
		return id, true, nil
	default:
		return "", false, errcode.Wrap(errcode.ErrInternalServer, "accepted modify task requires reconciliation: %s", task.TaskState)
	}
}

// resumeModifyForSameFlow 处理 pass 已处于 modifying 的受理请求。
//
// 计费在超时或失败后会一直重投 modifyResource，所以"同一笔单再来一次"是常态而不是异常：
// 此时必须返回成功并补派父 task（原父 task 可能因为 MQ 抖动没真正入队），否则计费会
// 一直重试到判定发货失败去退款。反过来，另一笔 flow 想插队则必须拒绝——两笔单并发
// 改同一台机器的规格，结果无法收敛。
func (l *logic) resumeModifyForSameFlow(passID string, req *transport.PassModifyRequest, logger *zap.Logger) (string, error) {
	passDao := modelfactory.DefaultDaoFactory.PassDao(nil)
	latest, err := passDao.GetByPassID(passID)
	if err != nil {
		return "", errcode.Wrap(errcode.ErrPassNotFound, "re-read pass: %v", err)
	}
	if latest.Status != passmodel.StatusModifying {
		if taskID, found, receiptErr := completedModifyReceipt(passID, req); found || receiptErr != nil {
			return taskID, receiptErr
		}
		return "", classifyModifyStatusError(latest.Status)
	}
	if latest.ModifyFlowID != req.TradeFlowID {
		logger.Warn("another modify flow is in flight, reject",
			zap.Int64("in_flight_flow_id", latest.ModifyFlowID),
		)
		return "", errcode.ErrPassModifying
	}
	if latest.ModifyTargetBundleID != req.TargetBundleID {
		// 同一 flow 换了目标套餐：说明计费侧的单和 CTL 记的对不上，继续发货会账不平。
		return "", errcode.Wrap(errcode.ErrPassModifyConfigMismatch,
			"in-flight flow %d targets %q, request targets %q",
			latest.ModifyFlowID, latest.ModifyTargetBundleID, req.TargetBundleID)
	}

	taskID, err := instanceasync.EnqueueModifyPassTask(
		pctx.NewContext(nil),
		latest.PassID,
		latest.UserID,
		req.SourceBundleID,
		latest.ModifyTargetBundleID,
		req.TradeFlowID,
		req.DealName,
		modifyPassParentExecuteIntervalSeconds,
		modifyPassParentMaxExecuteCount,
	)
	if err != nil {
		return "", errcode.Wrap(errcode.ErrInternalServer, "re-enqueue modify parent task: %v", err)
	}
	logger.Info("modify already in flight for the same flow, parent task ensured",
		zap.String("task_id", taskID))
	return taskID, nil
}

// resolveModifyTarget 是 checkModify / modifyResource 共用的前置校验，成功时返回
// 当前 pass 和已解析的目标 bundle。需求 §6 前置校验清单逐条落在这里。
//
// 不校验的部分：oldConfig / newConfig 的 SV 集合、PID、SP、地域、币种。这些定义在
// trade 的 BundleDefinition 里，CTL 的 bundle 表没有对应列——让 CTL 去猜等于在两个
// 服务里各存一份计费真相。trade 对着自己的 BundleDefinition 校验这些，CTL 负责
// pass 状态、套餐关系、到期时间和实例现状。
func resolveModifyTarget(passID string, req *transport.CheckPassModifyRequest) (*passmodel.Entity, *bundlemodel.Entity, error) {
	passID = strings.TrimSpace(passID)
	if passID == "" {
		return nil, nil, errcode.Wrap(errcode.ErrPassInvalidParam, "pass_id is required")
	}
	targetBundleID := strings.TrimSpace(req.TargetBundleID)
	if targetBundleID == "" {
		return nil, nil, errcode.Wrap(errcode.ErrPassInvalidParam, "target_bundle_id is required")
	}

	entity, err := modelfactory.DefaultDaoFactory.PassDao(nil).GetByPassID(passID)
	if err != nil {
		if errors.Is(err, errcode.ErrPassNotFound) {
			return nil, nil, errcode.ErrPassNotFound
		}
		return nil, nil, errcode.Wrap(errcode.ErrPassNotFound, "get pass: %v", err)
	}

	// 归属校验。计费传的 uin/appId 是资源 owner 的腾讯云身份，与 pass 行不一致
	// 意味着 resourceId 被错投到别人的资源上，绝不能继续。
	if req.Uin != 0 && entity.Uin != req.Uin {
		return nil, nil, errcode.Wrap(errcode.ErrPassModifyConfigMismatch,
			"uin mismatch: pass has %d, request has %d", entity.Uin, req.Uin)
	}
	if req.AppID != 0 && entity.AppID != req.AppID {
		return nil, nil, errcode.Wrap(errcode.ErrPassModifyConfigMismatch,
			"app_id mismatch: pass has %d, request has %d", entity.AppID, req.AppID)
	}

	if entity.Status != passmodel.StatusActive {
		return nil, nil, classifyModifyStatusError(entity.Status)
	}

	// source 一致性：计费用询价那一刻的套餐下单，如果 pass 已经变成别的套餐
	// （被另一笔变配抢先完成），继续发货会把用户升到错误的档位。
	if sourceBundleID := strings.TrimSpace(req.SourceBundleID); sourceBundleID != "" && sourceBundleID != entity.BundleID {
		return nil, nil, errcode.Wrap(errcode.ErrPassModifyConfigMismatch,
			"source bundle mismatch: pass has %q, request has %q", entity.BundleID, sourceBundleID)
	}
	if !ModifyAllowed(entity.BundleID, targetBundleID) {
		return nil, nil, errcode.Wrap(errcode.ErrPassModifyTargetNotAllowed,
			"modify from %q to %q is not allowed", entity.BundleID, targetBundleID)
	}

	// curDeadline 一致性：这是询价基线，漂移说明用户在支付窗口里又续费了，
	// 差价算的不是当前时长，必须让计费重新询价。
	if req.CurDeadline != nil && !req.CurDeadline.IsZero() {
		if drift := entity.ExpiredTime.Sub(*req.CurDeadline); drift > modifyDeadlineTolerance || drift < -modifyDeadlineTolerance {
			return nil, nil, errcode.Wrap(errcode.ErrPassModifyConfigMismatch,
				"cur_deadline mismatch: pass expires at %s, request has %s",
				entity.ExpiredTime.UTC().Format(time.RFC3339), req.CurDeadline.UTC().Format(time.RFC3339))
		}
	}

	targetBundle, err := modelfactory.DefaultDaoFactory.BundleDao(nil).GetByBundleID(targetBundleID)
	if err != nil {
		return nil, nil, errcode.Wrap(errcode.ErrPassModifyTargetNotAllowed, "get target bundle: %v", err)
	}
	if targetBundle.BundleState == bundlemodel.StateOffline {
		return nil, nil, errcode.Wrap(errcode.ErrPassModifyTargetNotAllowed,
			"target bundle %q is offline", targetBundleID)
	}
	if strings.TrimSpace(targetBundle.InstanceSpecID) == "" {
		// 目标套餐没有 instance_spec_id 就解析不出目标 SKU/Pool，实例步骤无从执行。
		return nil, nil, errcode.Wrap(errcode.ErrPassModifyTargetNotAllowed,
			"target bundle %q has no instance_spec_id", targetBundleID)
	}

	if err := assertInstancesModifiable(entity.UserID); err != nil {
		return nil, nil, err
	}
	return entity, targetBundle, nil
}

// assertInstancesModifiable 要求 pass 下的非终态实例全部为 Running。
//
// 零实例是正常场景（用户买了套餐还没开机），直接放行只升套餐级权益。
// Paused 说明 pass 已被隔离，Creating/Resuming/Deleting 说明有别的操作在跑——
// 升配要停机改规格，插进去会和在跑的操作互相打断，所以整体拒绝而不是跳过这几台。
func assertInstancesModifiable(userID string) error {
	instances, err := modelfactory.DefaultDaoFactory.InstanceDao(nil).ListAllByUserIDForIsolate(userID)
	if err != nil {
		return errcode.Wrap(errcode.ErrInternalServer, "list user instances: %v", err)
	}
	for _, inst := range instances {
		if inst == nil {
			continue
		}
		if inst.Status != modelinstance.InstanceStatusRunning {
			return errcode.Wrap(errcode.ErrPassModifyInstanceNotReady,
				"instance %s is in status %s", inst.InstanceId, inst.Status)
		}
	}
	return nil
}

// classifyModifyStatusError 把 pass.status 映射到对应错误码。
// modifying 单独成码，因为受理入口要据此判断是否走"同一 flow 复用"分支。
func classifyModifyStatusError(status string) error {
	if status == passmodel.StatusModifying {
		return errcode.ErrPassModifying
	}
	return errcode.Wrap(errcode.ErrPassNotModifiable, "pass status not modifiable: %s", status)
}

func modifyLogger() *zap.Logger {
	return renewLogger()
}

// ResolveModifyTargetSpec 供变配父 task 解析目标套餐的实例规格。
// 单独导出是为了让 worker 不必重复一遍 bundle 读取和 offline 判断。
func ResolveModifyTargetSpec(targetBundleID string) (*bundlemodel.Entity, error) {
	bundle, err := modelfactory.DefaultDaoFactory.BundleDao(nil).GetByBundleID(targetBundleID)
	if err != nil {
		return nil, fmt.Errorf("get target bundle %q: %w", targetBundleID, err)
	}
	if strings.TrimSpace(bundle.InstanceSpecID) == "" {
		return nil, fmt.Errorf("target bundle %q has no instance_spec_id", targetBundleID)
	}
	return bundle, nil
}
