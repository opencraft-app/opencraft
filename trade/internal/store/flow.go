package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// ErrFlowNotFound 是 trade_flow 表查无记录的哨兵错误。
//
// 上层（迭代 6 createResource handler / Sub-4 isolateResource handler / queryFlow handler）
// 在抢占式幂等的"输家"路径上用 errors.Is 判定。
var ErrFlowNotFound = errors.New("trade_flow: not found")

// Flow 状态枚举（设计稿 Q61 抢占式幂等三态状态机）：
//
//   - StatusInProgress：抢占已写入但主链路尚未完成；输家命中此状态时返 5xx 让 jifei 走 B 类重试
//   - StatusCompleted ：主链路成功完成；response_body 为 PDF framework 双层成功 JSON；输家命中时回放
//   - StatusFailed    ：主链路永久失败；response_body 通常是 Q56 退款响应（returnCode=352014）；输家命中时回放
const (
	FlowStatusInProgress = "in_progress"
	FlowStatusCompleted  = "completed"
	FlowStatusFailed     = "failed"
)

// FlowType 枚举：
//
//   - FlowTypeCreateResource = "create_resource"  jifei lightvela.pass.createResource
//   - FlowTypeIsolateResource = "isolate_resource" jifei lightvela.pass.isolateResource (Sub-4)
//   - FlowTypeRenewResource = "renew_resource"   jifei lightvela.pass.renewResource (R-A 续费)
//   - FlowTypeDestroyResource = "destroy_resource" jifei lightvela.pass.destroyResource (D-1 销毁)
//   - FlowTypeTransferResource = "transfer_resource" jifei lightvela.pass.transferResource (外部资源迁入)
//   - FlowTypeModifyResource = "modify_resource"   jifei lightvela.pass.modifyResource (同 SP 变配)
//
// checkCreate 不写本表（Q62），所以无对应 flow_type；queryFlow 是只读链路（按 ID 反查），
// 不写本表，也无对应 flow_type。
//
// 注意：trade_flow.flow_type（jifei 协议长事务流水类型，与 jifei 接口名 createResource/isolateResource/renewResource
// 对偶）是与 trade_order.order_type（订单生命周期类型，取值 create/renew/refund 短词）**不同维度的两个独立列**，
// 不要相互混淆。详见 .tmp/trade-pass-renew-design.md §4.2 字段维度对照表。
//
// 设计稿：.tmp/trade-pass-isolate-design.md §3.2 + .tmp/trade-pass-renew-design.md §4.2 + .tmp/trade-pass-destroy-design.md §3.4
const (
	FlowTypeCreateResource   = "create_resource"
	FlowTypeIsolateResource  = "isolate_resource"
	FlowTypeRenewResource    = "renew_resource"
	FlowTypeDestroyResource  = "destroy_resource"
	FlowTypeTransferResource = "transfer_resource"
	// FlowTypeModifyResource = "modify_resource"  jifei lightvela.pass.modifyResource（同 SP 变配，
	// TAPD 1010132091137784162 §7.1）。与 renew 同幂等范式：走 TryAcquireSlot 的
	// (deal_name, flow_type, app_id) 唯一键，因为变配必然有 dealName（不像 isolate/destroy 有
	// dealName 为 NULL 的生命周期分支）。
	FlowTypeModifyResource = "modify_resource"
)

// Flow 是 trade_flow 表的领域对象（与 §7.3.5 / migration 0001 + 0002 列对齐）。
//
// 字段语义：
//   - DealName：jifei dealName。
//   - createResource 链路必填且非空；DB 层 NOT NULL（migration 0001）已在 0002 改 NULL，
//     但业务层仍保证非空（同一 dealName + flow_type + app_id 触发 uk_deal_flow_app 唯一约束）。
//   - isolateResource 链路必为空字符串（业务层契约）；store 层 INSERT 时显式写 NULL（Sub-4 §11 Q14=a 强约束：
//     严禁空串等占位符），SELECT 时 NULL → 空字符串回填到本字段。
//   - ResourceID：jifei resourceId（= ctl pass_id）。
//   - isolateResource 链路必填非 nil；createResource 链路 nil。
//   - Sub-4 抢占式幂等的核心反查键：(resource_id, flow_type, status) → idx_resource_isolate
//   - Uin：jifei uin。
//   - isolateResource 链路必填非空；createResource 链路本字段空字符串（DB NULL）。
//   - 与 trade_order.uin VARCHAR(32) 同型（设计稿 §11 Q17=d 类型边界统一 string）。
//   - FlowType / AppID：与 DealName 共同构成 uk_deal_flow_app（仅 createResource 链路有效）；
//     isolate 链路因 deal_name=NULL 不参与 uk_deal_flow_app 约束。
//   - Status：三态状态机
//   - RequestBody：jifei 回调原始请求 PDF framework 双层 JSON（用于排障 / reconcile 反查上下文）
//   - ResponseBody：completed 时存出参 framework JSON / failed 时存退款响应 / in_progress 时为 nil
type Flow struct {
	ID           int64
	DealName     string  // createResource 链路非空；isolate 链路空字符串（DB NULL）
	ResourceID   *string // isolate 链路非 nil；createResource 链路 nil
	Uin          string  // isolate 链路非空；createResource 链路空字符串（DB NULL）
	FlowType     string
	AppID        string
	Status       string
	RequestBody  []byte // raw JSON；nil 表示未存
	ResponseBody []byte // raw JSON；nil 表示未存（in_progress 状态）
	CreatedTime  time.Time
	UpdatedTime  time.Time
}

// FlowStore 抽象 trade_flow DAO，便于上层 handler 单元测试 mock。
//
// 编译期断言 *MySQLStore 实现本接口（见文件末尾）；生产路径直接注入 mysqlStore 即可。
type FlowStore interface {
	// TryAcquireSlot 尝试抢占式占位（Q61 拍板核心方法，createResource 链路）。
	//
	// 行为（同一事务内）：
	//   1. 执行 `INSERT INTO trade_flow (deal_name, flow_type, app_id, status, request_body, ...)
	//      VALUES (?, ?, ?, 'in_progress', ?, ...) ON DUPLICATE KEY UPDATE id=id`
	//   2. 拿到 RowsAffected：== 1 → 抢到占位（acquired=true）；== 0 → 已存在记录（acquired=false）
	//
	// 注意：MySQL ON DUPLICATE KEY UPDATE 命中已有行时 RowsAffected：未变更 → 0；变更 → 2。
	// 我们用 `id=id` 故意触发"未变更"路径，保证 acquired 严格按 0 / 1 判定。
	TryAcquireSlot(ctx context.Context, dealName, flowType, appID string, requestBody []byte) (acquired bool, existing *Flow, err error)

	// TryAcquireSlotForIsolate 尝试抢占式占位（Sub-4 isolateResource 链路）。
	//
	// 设计稿：.tmp/trade-pass-isolate-design.md §11 Q19 修订版
	//
	// 与 TryAcquireSlot 的差异（isolate 生命周期链路不绑 dealName；isolate 退费链路则带 dealName）：
	//   - 抢占键：(resource_id, flow_type, status) — 通过 idx_resource_isolate 索引 + SELECT FOR UPDATE
	//   - INSERT 时 deal_name 可为 NULL（生命周期隔离）或非空字符串（退费隔离），**不复用 uk_deal_flow_app**
	//   - 同一 pass 生命周期内可重复隔离（如续费后再到期），所以不能用 UNIQUE KEY，必须用 SELECT FOR UPDATE
	//
	// dealName 语义（v1.7.30 退费隔离后拓展）：
	//   - nil → 生命周期隔离，INSERT deal_name = NULL
	//   - 非 nil 且非空字符串 → 退费隔离，INSERT deal_name = *dealName（会检查不能空串，遵守
	//     v1.7.28 BUG-12 修复后的 "NULL / 非空字符串 / 不可改" 三态强约束，避免 空串占位污染）
	//
	// 行为（事务内）：
	//   1. BEGIN
	//   2. SELECT id FROM trade_flow WHERE resource_id=? AND flow_type=? AND status='in_progress' FOR UPDATE
	//      - 命中 → acquired=false，回查整行 existing 返回（输家路径；dealName 由调用方自行用日志接住）
	//      - 未命中 → INSERT trade_flow (... resource_id, uin, flow_type, app_id, status, request_body, deal_name=NULL或*dealName ...) →
	//        acquired=true，existing.ID 回填 LastInsertId，其余字段由调用方持有的入参回填（赢家路径）
	//   3. COMMIT
	//
	// 返回：
	//   - acquired = true：本次调用是赢家，走主链路；existing 含本次 INSERT 的 id（其它字段调用方按入参补齐）
	//   - acquired = false：抢占失败；existing 含 DB 现存记录（含 status / response_body 供回放分支决策）
	//   - err：基础设施错误
	TryAcquireSlotForIsolate(
		ctx context.Context,
		resourceID, flowType, appID, uin string,
		requestBody []byte,
		dealName *string,
	) (acquired bool, existing *Flow, err error)

	// MarkCompleted 把 in_progress → completed（赢家成功收尾路径，createResource 链路）。
	//
	// 仅当当前 status == 'in_progress' 时才更新（防御并发：reconcile worker 也可能改 status）；
	// 实际未更新（如已被 reconcile 改成 completed）不返错，由调用方按业务判定。
	MarkCompleted(ctx context.Context, dealName, flowType, appID string, responseBody []byte) error

	// MarkCompletedWithResourceID 把 in_progress → completed 同时回填 resource_id
	// （v1.7.28 BUG-18 新增；createResource 链路赢家成功收尾专用）。
	//
	// 与 MarkCompleted 的差异：
	//   - SET 子句额外写 resource_id = ?（即 ctl 返回的 pass_id）
	//   - resource_id 入参非空时才写；空字符串视作"不写"（保留 NULL 兼容老路径）
	//   - 设计稿：.tmp/trade-purchase-flow-design.md §6.2 Step T5（v1.7.28 用户拍板修订）
	//
	// 用户拍板（2026-05-21）：createResource 链路成功后 trade_flow.resource_id 必须有值，
	// 与 isolate / renew / destroy 链路保持对称（这些链路 resource_id 在 TryAcquireSlotForIsolate
	// 阶段就已经写入），便于运维 / reconcile worker 直接用 resource_id 反查 trade_flow。
	//
	// 仅当当前 status == 'in_progress' 时才更新；实际未更新不返错。
	MarkCompletedWithResourceID(
		ctx context.Context,
		dealName, flowType, appID, resourceID string,
		responseBody []byte,
	) error

	// MarkFailed 把 in_progress → failed（赢家永久失败收尾路径，createResource 链路）。
	MarkFailed(ctx context.Context, dealName, flowType, appID string, responseBody []byte) error

	// MarkCompletedByID 按 trade_flow.id 反查标记完成（Sub-4 isolateResource 链路 + ctl callback 行级幂等用）。
	//
	// 仅当 status == 'in_progress' 时才更新；其他 status 不返错，由调用方判定。
	MarkCompletedByID(ctx context.Context, id int64, responseBody []byte) error

	// MarkFailedByID 按 trade_flow.id 反查标记失败（Sub-4 isolateResource 链路 + ctl callback 失败用）。
	//
	// 仅当 status == 'in_progress' 时才更新。
	MarkFailedByID(ctx context.Context, id int64, responseBody []byte) error

	// DeleteByID 按 trade_flow.id 删除（Sub-4 isolateResource 链路 ctl 调用失败回滚释放 slot）。
	//
	// 设计稿：.tmp/trade-pass-isolate-design.md §11 Q21=a1
	//
	// 兜底约束：仅删除 status='in_progress' 行（防御已经被 reconcile/callback 推进的行被误删）。
	// 实际未删除（status 已变）不返错，由调用方判定（通常意味着另一路径已收尾）。
	DeleteByID(ctx context.Context, id int64) error

	// GetFlow 按 (dealName, flowType, appID) 反查（createResource 链路 + reconcile worker 用）。
	//
	// 命中 → (*Flow, nil)
	// 无记录 → (nil, ErrFlowNotFound)
	GetFlow(ctx context.Context, dealName, flowType, appID string) (*Flow, error)

	// GetByID 按 trade_flow.id 反查（Sub-4 queryFlow handler + ctl callback 用）。
	//
	// 命中 → (*Flow, nil)；无记录 → (nil, ErrFlowNotFound)。
	GetByID(ctx context.Context, id int64) (*Flow, error)

	// ListInProgressBefore 列举 status='in_progress' AND created_time < cutoff 的记录。
	//
	// 用于 reconcile worker（cutoff 通常 = NOW()-30min）。
	ListInProgressBefore(ctx context.Context, cutoff time.Time, limit int) ([]*Flow, error)
}

var _ FlowStore = (*MySQLStore)(nil)

// TryAcquireSlot 实现 FlowStore；详见接口注释 Q61 抢占式幂等语义。
func (s *MySQLStore) TryAcquireSlot(
	ctx context.Context,
	dealName, flowType, appID string,
	requestBody []byte,
) (bool, *Flow, error) {
	if s == nil || s.db == nil {
		return false, nil, fmt.Errorf("trade_flow: store is nil")
	}
	const q = `
		INSERT INTO trade_flow (deal_name, flow_type, app_id, status, request_body, created_time, updated_time)
		VALUES (?, ?, ?, ?, ?, NOW(6), NOW(6))
		ON DUPLICATE KEY UPDATE id = id
	`
	var bodyArg interface{}
	if len(requestBody) > 0 {
		bodyArg = string(requestBody)
	} else {
		bodyArg = nil
	}
	res, err := s.db.ExecContext(ctx, q, dealName, flowType, appID, FlowStatusInProgress, bodyArg)
	if err != nil {
		return false, nil, fmt.Errorf("trade_flow: try acquire slot dealName=%s: %w", dealName, err)
	}
	rowsAffected, err := res.RowsAffected()
	if err != nil {
		return false, nil, fmt.Errorf("trade_flow: rows affected: %w", err)
	}
	if rowsAffected == 1 {
		// 抢到占位（赢家），不需要回查 existing
		return true, nil, nil
	}

	// rowsAffected == 0 → 已有记录，回查 existing 让调用方按 status 三分支处理
	existing, err := s.GetFlow(ctx, dealName, flowType, appID)
	if err != nil {
		return false, nil, fmt.Errorf("trade_flow: re-select existing dealName=%s: %w", dealName, err)
	}
	return false, existing, nil
}

// TryAcquireSlotForIsolate 实现 FlowStore；Sub-4 isolateResource 链路抢占式幂等。
//
// 设计稿：.tmp/trade-pass-isolate-design.md §11 Q19 修订版 + v1.7.30 退费隔离拓展
//
// 关键 SQL：
//  1. SELECT id FROM trade_flow WHERE resource_id=? AND flow_type=? AND status='in_progress' FOR UPDATE
//  2. 命中 → 回查整行返回（输家）；未命中 → INSERT (deal_name=NULL或*dealName, resource_id, uin, ...) 返回 LastInsertId（赢家）
//
// 🔒 强约束：INSERT 时 deal_name 取 NULL（生命周期）或非空字符串（退费），**严禁空串占位**
// （业务侧依赖 NULL/非空字符串 二选一区分 isolate 生命周期 vs createResource vs isolate 退费）。
func (s *MySQLStore) TryAcquireSlotForIsolate(
	ctx context.Context,
	resourceID, flowType, appID, uin string,
	requestBody []byte,
	dealName *string,
) (bool, *Flow, error) {
	if s == nil || s.db == nil {
		return false, nil, fmt.Errorf("trade_flow: store is nil")
	}
	if resourceID == "" {
		return false, nil, fmt.Errorf("trade_flow: TryAcquireSlotForIsolate resourceID is required")
	}
	// dealName 三态强约束（v1.7.28 BUG-12 遗产）：nil 或 非空字符串，严禁空串占位。
	if dealName != nil && *dealName == "" {
		return false, nil, fmt.Errorf("trade_flow: TryAcquireSlotForIsolate dealName must be NULL or non-empty string, got empty string placeholder")
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, nil, fmt.Errorf("trade_flow: begin tx: %w", err)
	}
	defer func() {
		// 兜底回滚（已 Commit 时 tx.Rollback 返 ErrTxDone，不影响）
		_ = tx.Rollback()
	}()

	// Step 1: SELECT FOR UPDATE 反查
	const selQ = `
		SELECT id
		  FROM trade_flow
		 WHERE resource_id = ? AND flow_type = ? AND status = ?
		 FOR UPDATE
	`
	var existingID int64
	err = tx.QueryRowContext(ctx, selQ, resourceID, flowType, FlowStatusInProgress).Scan(&existingID)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		// 未命中 → 走赢家 INSERT 分支
	case err != nil:
		return false, nil, fmt.Errorf("trade_flow: select for update resourceID=%s: %w", resourceID, err)
	default:
		// 命中 → 走输家分支：回查整行返回
		// 注意：必须在同一 tx 内 SELECT 整行（避免读到刚被其他 tx 改过的版本）
		existing, getErr := s.getByIDTx(ctx, tx, existingID)
		if getErr != nil {
			return false, nil, fmt.Errorf("trade_flow: re-select existing id=%d: %w", existingID, getErr)
		}
		if commitErr := tx.Commit(); commitErr != nil {
			return false, nil, fmt.Errorf("trade_flow: commit loser tx: %w", commitErr)
		}
		return false, existing, nil
	}

	// Step 2: 赢家 INSERT
	//
	// 🔒 deal_name 语义：
	//   - dealName == nil  → INSERT deal_name = NULL（生命周期隔离）
	//   - dealName != nil  → INSERT deal_name = *dealName（退费隔离，已在函数入口拒绝空串）
	// resource_id / uin 必填非空；flow_type / app_id 透传调用方。
	// updated_time / created_time 走 DB DEFAULT CURRENT_TIMESTAMP(6)。
	const insQ = `
		INSERT INTO trade_flow
			(deal_name, resource_id, uin, flow_type, app_id, status, request_body, created_time, updated_time)
		VALUES
			(?, ?, ?, ?, ?, ?, ?, NOW(6), NOW(6))
	`
	var bodyArg interface{}
	if len(requestBody) > 0 {
		bodyArg = string(requestBody)
	} else {
		bodyArg = nil
	}
	var dealNameArg interface{}
	if dealName != nil {
		dealNameArg = *dealName
	} else {
		dealNameArg = nil
	}
	res, err := tx.ExecContext(ctx, insQ, dealNameArg, resourceID, uin, flowType, appID, FlowStatusInProgress, bodyArg)
	if err != nil {
		return false, nil, fmt.Errorf("trade_flow: insert isolate resourceID=%s: %w", resourceID, err)
	}
	newID, err := res.LastInsertId()
	if err != nil {
		return false, nil, fmt.Errorf("trade_flow: last insert id: %w", err)
	}
	if commitErr := tx.Commit(); commitErr != nil {
		return false, nil, fmt.Errorf("trade_flow: commit winner tx: %w", commitErr)
	}

	// 赢家路径：用入参 + 新生成 ID 构造 Flow（调用方持有完整入参，无需再 SELECT）
	rid := resourceID
	dealNameStr := ""
	if dealName != nil {
		dealNameStr = *dealName
	}
	flow := &Flow{
		ID:          newID,
		DealName:    dealNameStr, // isolate 生命周期：DB NULL ↔ struct 空字符串；isolate 退费：DB 非空 ↔ struct 非空
		ResourceID:  &rid,
		Uin:         uin,
		FlowType:    flowType,
		AppID:       appID,
		Status:      FlowStatusInProgress,
		RequestBody: requestBody,
	}
	return true, flow, nil
}

// MarkCompleted 实现 FlowStore；UPDATE 仅在 status='in_progress' 时生效。
func (s *MySQLStore) MarkCompleted(
	ctx context.Context,
	dealName, flowType, appID string,
	responseBody []byte,
) error {
	return s.markStatus(ctx, dealName, flowType, appID, FlowStatusCompleted, responseBody)
}

// MarkCompletedWithResourceID 实现 FlowStore（v1.7.28 BUG-18 新增）；
// 在 markStatus 基础上额外回填 resource_id 列（createResource 链路成功收尾用）。
func (s *MySQLStore) MarkCompletedWithResourceID(
	ctx context.Context,
	dealName, flowType, appID, resourceID string,
	responseBody []byte,
) error {
	if s == nil || s.db == nil {
		return fmt.Errorf("trade_flow: store is nil")
	}
	const q = `
		UPDATE trade_flow
		   SET status = ?, response_body = ?, resource_id = ?, updated_time = NOW(6)
		 WHERE deal_name = ? AND flow_type = ? AND app_id = ? AND status = ?
	`
	var bodyArg interface{}
	if len(responseBody) > 0 {
		bodyArg = string(responseBody)
	} else {
		bodyArg = nil
	}
	// resource_id 空字符串 → SQL NULL（与 MarkCompleted 老路径保持兼容；调用方按业务判断）。
	var ridArg interface{}
	if resourceID != "" {
		ridArg = resourceID
	} else {
		ridArg = nil
	}
	if _, err := s.db.ExecContext(ctx, q,
		FlowStatusCompleted, bodyArg, ridArg, dealName, flowType, appID, FlowStatusInProgress,
	); err != nil {
		return fmt.Errorf("trade_flow: mark completed with resource_id dealName=%s resourceID=%s: %w",
			dealName, resourceID, err)
	}
	return nil
}

// RecordAcceptedByID records the successful asynchronous acceptance response
// without advancing the flow to completed. modifyResource uses this after CTL
// has accepted the work; the CTL parent task remains the only component that
// may advance the flow to its completed terminal state.
//
// Keeping the response body while status is still in_progress serves two
// purposes: duplicate modifyResource callbacks can replay the original
// acceptance response, and the later /flows/{id}/complete callback can retain
// that framework response for post-completion replay.
func (s *MySQLStore) RecordAcceptedByID(
	ctx context.Context,
	id int64,
	resourceID string,
	responseBody []byte,
) error {
	if s == nil || s.db == nil {
		return fmt.Errorf("trade_flow: store is nil")
	}
	if id <= 0 {
		return fmt.Errorf("trade_flow: id must be positive")
	}
	if resourceID == "" {
		return fmt.Errorf("trade_flow: resource_id is required")
	}
	if len(responseBody) == 0 {
		return fmt.Errorf("trade_flow: accepted response_body is required")
	}

	const q = `
		UPDATE trade_flow
		   SET resource_id = ?, response_body = ?, updated_time = NOW(6)
		 WHERE id = ? AND status = ?
		   AND (resource_id IS NULL OR resource_id = '' OR resource_id = ?)
	`
	res, err := s.db.ExecContext(ctx, q,
		resourceID, string(responseBody), id, FlowStatusInProgress, resourceID,
	)
	if err != nil {
		return fmt.Errorf("trade_flow: record accepted id=%d resourceID=%s: %w", id, resourceID, err)
	}
	rowsAffected, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("trade_flow: record accepted rows affected id=%d: %w", id, err)
	}
	if rowsAffected == 0 {
		return fmt.Errorf("trade_flow: record accepted id=%d affected 0 rows", id)
	}
	return nil
}

// MarkFailed 实现 FlowStore。
func (s *MySQLStore) MarkFailed(
	ctx context.Context,
	dealName, flowType, appID string,
	responseBody []byte,
) error {
	return s.markStatus(ctx, dealName, flowType, appID, FlowStatusFailed, responseBody)
}

// MarkCompletedByID 实现 FlowStore；Sub-4 isolate / callback 用按 ID 反查标记完成。
func (s *MySQLStore) MarkCompletedByID(ctx context.Context, id int64, responseBody []byte) error {
	return s.markStatusByID(ctx, id, FlowStatusCompleted, responseBody)
}

// MarkFailedByID 实现 FlowStore。
func (s *MySQLStore) MarkFailedByID(ctx context.Context, id int64, responseBody []byte) error {
	return s.markStatusByID(ctx, id, FlowStatusFailed, responseBody)
}

// DeleteByID 实现 FlowStore；仅删 status='in_progress' 行（兜底防御）。
func (s *MySQLStore) DeleteByID(ctx context.Context, id int64) error {
	if s == nil || s.db == nil {
		return fmt.Errorf("trade_flow: store is nil")
	}
	const q = `DELETE FROM trade_flow WHERE id = ? AND status = ?`
	if _, err := s.db.ExecContext(ctx, q, id, FlowStatusInProgress); err != nil {
		return fmt.Errorf("trade_flow: delete by id=%d: %w", id, err)
	}
	return nil
}

// markStatus 是 MarkCompleted / MarkFailed 共享的实现（按 dealName 三元组）。
func (s *MySQLStore) markStatus(
	ctx context.Context,
	dealName, flowType, appID string,
	newStatus string,
	responseBody []byte,
) error {
	if s == nil || s.db == nil {
		return fmt.Errorf("trade_flow: store is nil")
	}
	const q = `
		UPDATE trade_flow
		   SET status = ?, response_body = ?, updated_time = NOW(6)
		 WHERE deal_name = ? AND flow_type = ? AND app_id = ? AND status = ?
	`
	var bodyArg interface{}
	if len(responseBody) > 0 {
		bodyArg = string(responseBody)
	} else {
		bodyArg = nil
	}
	if _, err := s.db.ExecContext(ctx, q, newStatus, bodyArg, dealName, flowType, appID, FlowStatusInProgress); err != nil {
		return fmt.Errorf("trade_flow: mark %s dealName=%s: %w", newStatus, dealName, err)
	}
	return nil
}

// markStatusByID 是 MarkCompletedByID / MarkFailedByID 共享的实现（按 id）。
func (s *MySQLStore) markStatusByID(
	ctx context.Context,
	id int64,
	newStatus string,
	responseBody []byte,
) error {
	if s == nil || s.db == nil {
		return fmt.Errorf("trade_flow: store is nil")
	}
	const q = `
		UPDATE trade_flow
		   SET status = ?, response_body = ?, updated_time = NOW(6)
		 WHERE id = ? AND status = ?
	`
	var bodyArg interface{}
	if len(responseBody) > 0 {
		bodyArg = string(responseBody)
	} else {
		bodyArg = nil
	}
	if _, err := s.db.ExecContext(ctx, q, newStatus, bodyArg, id, FlowStatusInProgress); err != nil {
		return fmt.Errorf("trade_flow: mark %s id=%d: %w", newStatus, id, err)
	}
	return nil
}

// GetFlow 实现 FlowStore（按 dealName 三元组）。
func (s *MySQLStore) GetFlow(ctx context.Context, dealName, flowType, appID string) (*Flow, error) {
	if s == nil || s.db == nil {
		return nil, fmt.Errorf("trade_flow: store is nil")
	}
	const q = `
		SELECT id, deal_name, resource_id, uin, flow_type, app_id, status, request_body, response_body, created_time, updated_time
		  FROM trade_flow
		 WHERE deal_name = ? AND flow_type = ? AND app_id = ?
	`
	row := s.db.QueryRowContext(ctx, q, dealName, flowType, appID)
	flow, err := scanFlowRow(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrFlowNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("trade_flow: get dealName=%s: %w", dealName, err)
	}
	return flow, nil
}

// GetByID 实现 FlowStore（按 trade_flow.id 反查）。
func (s *MySQLStore) GetByID(ctx context.Context, id int64) (*Flow, error) {
	if s == nil || s.db == nil {
		return nil, fmt.Errorf("trade_flow: store is nil")
	}
	const q = `
		SELECT id, deal_name, resource_id, uin, flow_type, app_id, status, request_body, response_body, created_time, updated_time
		  FROM trade_flow
		 WHERE id = ?
	`
	row := s.db.QueryRowContext(ctx, q, id)
	flow, err := scanFlowRow(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrFlowNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("trade_flow: get id=%d: %w", id, err)
	}
	return flow, nil
}

// getByIDTx 是 TryAcquireSlotForIsolate 输家路径在 tx 内 SELECT 整行的辅助方法。
func (s *MySQLStore) getByIDTx(ctx context.Context, tx *sql.Tx, id int64) (*Flow, error) {
	const q = `
		SELECT id, deal_name, resource_id, uin, flow_type, app_id, status, request_body, response_body, created_time, updated_time
		  FROM trade_flow
		 WHERE id = ?
	`
	row := tx.QueryRowContext(ctx, q, id)
	return scanFlowRow(row)
}

// scanFlowRow 把一行 trade_flow 反序列化为 *Flow。
//
// NULL 列处理：
//   - deal_name NULL → DealName = ""（业务层语义"isolate 链路"）
//   - resource_id NULL → ResourceID = nil（业务层语义"createResource 链路"）
//   - uin NULL → Uin = ""
//   - request_body / response_body NULL → 对应 []byte = nil
func scanFlowRow(row *sql.Row) (*Flow, error) {
	var (
		id          int64
		dealName    sql.NullString
		resourceID  sql.NullString
		uin         sql.NullString
		flowType    string
		appID       string
		status      string
		reqBody     sql.NullString
		respBody    sql.NullString
		createdTime time.Time
		updatedTime time.Time
	)
	if err := row.Scan(
		&id, &dealName, &resourceID, &uin, &flowType, &appID, &status,
		&reqBody, &respBody, &createdTime, &updatedTime,
	); err != nil {
		return nil, err
	}
	flow := &Flow{
		ID:          id,
		FlowType:    flowType,
		AppID:       appID,
		Status:      status,
		CreatedTime: createdTime,
		UpdatedTime: updatedTime,
	}
	if dealName.Valid {
		flow.DealName = dealName.String
	}
	if resourceID.Valid {
		rid := resourceID.String
		flow.ResourceID = &rid
	}
	if uin.Valid {
		flow.Uin = uin.String
	}
	if reqBody.Valid {
		flow.RequestBody = []byte(reqBody.String)
	}
	if respBody.Valid {
		flow.ResponseBody = []byte(respBody.String)
	}
	return flow, nil
}

// ListInProgressBefore 实现 FlowStore（reconcile worker 用）。
func (s *MySQLStore) ListInProgressBefore(ctx context.Context, cutoff time.Time, limit int) ([]*Flow, error) {
	if s == nil || s.db == nil {
		return nil, fmt.Errorf("trade_flow: store is nil")
	}
	if limit <= 0 {
		limit = 100
	}
	const q = `
		SELECT id, deal_name, resource_id, uin, flow_type, app_id, status, request_body, response_body, created_time, updated_time
		  FROM trade_flow
		 WHERE status = ? AND created_time < ?
		 ORDER BY created_time ASC
		 LIMIT ?
	`
	rows, err := s.db.QueryContext(ctx, q, FlowStatusInProgress, cutoff, limit)
	if err != nil {
		return nil, fmt.Errorf("trade_flow: list in_progress before %v: %w", cutoff, err)
	}
	defer rows.Close()

	var out []*Flow
	for rows.Next() {
		var (
			id          int64
			dealName    sql.NullString
			resourceID  sql.NullString
			uin         sql.NullString
			flowType    string
			appID       string
			status      string
			reqBody     sql.NullString
			respBody    sql.NullString
			createdTime time.Time
			updatedTime time.Time
		)
		if err := rows.Scan(
			&id, &dealName, &resourceID, &uin, &flowType, &appID, &status,
			&reqBody, &respBody, &createdTime, &updatedTime,
		); err != nil {
			return nil, fmt.Errorf("trade_flow: scan: %w", err)
		}
		flow := &Flow{
			ID:          id,
			FlowType:    flowType,
			AppID:       appID,
			Status:      status,
			CreatedTime: createdTime,
			UpdatedTime: updatedTime,
		}
		if dealName.Valid {
			flow.DealName = dealName.String
		}
		if resourceID.Valid {
			rid := resourceID.String
			flow.ResourceID = &rid
		}
		if uin.Valid {
			flow.Uin = uin.String
		}
		if reqBody.Valid {
			flow.RequestBody = []byte(reqBody.String)
		}
		if respBody.Valid {
			flow.ResponseBody = []byte(respBody.String)
		}
		out = append(out, flow)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("trade_flow: rows err: %w", err)
	}
	return out, nil
}
