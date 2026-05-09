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
// 上层（迭代 6 createResource handler）在抢占式幂等的"输家"路径上用
// errors.Is 判定：理论上 INSERT ON DUPLICATE KEY UPDATE 后 GetFlow 一定能查到，
// 真正命中 ErrFlowNotFound 说明 DB 状态异常，按 B 类（链路异常需重试）处理。
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

// FlowTypeCreateResource 是 Q62 收敛后 trade_flow.flow_type 的唯一值。
//
// checkCreate 不写本表（Q62），所以本期不需要其它 flow_type 枚举；
// 后续迭代如新增续费 / 隔离 / 销毁回调，再扩此常量集合。
const FlowTypeCreateResource = "create_resource"

// Flow 是 trade_flow 表的领域对象（与 §7.3.5 / migration 0001 列对齐）。
//
// 字段语义：
//   - DealName / FlowType / AppID 三元组：UNIQUE KEY uk_deal_flow_app（Q61 抢占式幂等核心约束）
//   - Status：三态状态机
//   - RequestBody：jifei 回调原始请求 PDF framework 双层 JSON（用于排障 / reconcile 反查上下文）
//   - ResponseBody：completed 时存出参 framework JSON / failed 时存退款响应 / in_progress 时为 nil
type Flow struct {
	ID            int64
	DealName      string
	FlowType      string
	AppID         string
	Status        string
	RequestBody   []byte // raw JSON；nil 表示未存
	ResponseBody  []byte // raw JSON；nil 表示未存（in_progress 状态）
	CreatedTime   time.Time
	UpdatedTime   time.Time
}

// FlowStore 抽象 trade_flow DAO，便于上层 handler 单元测试 mock。
//
// 编译期断言 *MySQLStore 实现本接口（见文件末尾）；生产路径直接注入 mysqlStore 即可。
type FlowStore interface {
	// TryAcquireSlot 尝试抢占式占位（Q61 拍板核心方法）。
	//
	// 行为（同一事务内）：
	//   1. 执行 `INSERT INTO trade_flow (deal_name, flow_type, app_id, status, request_body, ...)
	//      VALUES (?, ?, ?, 'in_progress', ?, ...) ON DUPLICATE KEY UPDATE id=id`
	//   2. 拿到 RowsAffected：
	//      - == 1 → 抢到占位（acquired=true），调用方走主链路
	//      - == 0 → 已存在记录（acquired=false），调用方需第二步 SELECT 查 status 决定回放逻辑
	//
	// 注意：MySQL 在 ON DUPLICATE KEY UPDATE 命中已有行时 RowsAffected 行为：
	//   - 实际未变更字段 → 0
	//   - 实际变更了字段 → 2（INSERT + UPDATE 各算一次）
	// 我们用 `id=id` 故意触发"未变更"路径，保证 acquired 严格按 0 / 1 判定。
	//
	// 返回：
	//   - acquired：true 表示本次调用是赢家，需走主链路 + 后续 MarkCompleted/MarkFailed
	//   - existing：当 acquired==false 时，返回数据库里现存的那条记录（含 status / response_body
	//                供调用方分支决策）；acquired==true 时为 nil
	//   - err：基础设施错误
	TryAcquireSlot(ctx context.Context, dealName, flowType, appID string, requestBody []byte) (acquired bool, existing *Flow, err error)

	// MarkCompleted 把 in_progress → completed 并写入 responseBody（赢家成功收尾路径）。
	//
	// 仅当当前 status == 'in_progress' 时才更新（防御并发：reconcile worker 也可能改 status）；
	// 实际未更新（如已被 reconcile 改成 completed）不返错，由调用方按业务判定。
	MarkCompleted(ctx context.Context, dealName, flowType, appID string, responseBody []byte) error

	// MarkFailed 把 in_progress → failed 并写入退款响应 body（赢家永久失败收尾路径）。
	//
	// 与 MarkCompleted 对称；仅 in_progress → failed 转移。
	MarkFailed(ctx context.Context, dealName, flowType, appID string, responseBody []byte) error

	// GetFlow 按 (dealName, flowType, appID) 反查（迭代 7 reconcile worker 也会用）。
	//
	// 命中 → (*Flow, nil)
	// 无记录 → (nil, ErrFlowNotFound)
	GetFlow(ctx context.Context, dealName, flowType, appID string) (*Flow, error)

	// ListInProgressBefore 列举 status='in_progress' AND created_time < cutoff 的记录。
	//
	// 用于迭代 7 reconcile worker（cutoff 通常 = NOW()-30min）。
	// 本迭代（6）暂不直接调用，但接口先就位避免迭代 7 再改 FlowStore。
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

// MarkCompleted 实现 FlowStore；UPDATE 仅在 status='in_progress' 时生效。
func (s *MySQLStore) MarkCompleted(
	ctx context.Context,
	dealName, flowType, appID string,
	responseBody []byte,
) error {
	return s.markStatus(ctx, dealName, flowType, appID, FlowStatusCompleted, responseBody)
}

// MarkFailed 实现 FlowStore。
func (s *MySQLStore) MarkFailed(
	ctx context.Context,
	dealName, flowType, appID string,
	responseBody []byte,
) error {
	return s.markStatus(ctx, dealName, flowType, appID, FlowStatusFailed, responseBody)
}

// markStatus 是 MarkCompleted / MarkFailed 共享的实现。
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

// GetFlow 实现 FlowStore。
func (s *MySQLStore) GetFlow(ctx context.Context, dealName, flowType, appID string) (*Flow, error) {
	if s == nil || s.db == nil {
		return nil, fmt.Errorf("trade_flow: store is nil")
	}
	const q = `
		SELECT id, deal_name, flow_type, app_id, status, request_body, response_body, created_time, updated_time
		  FROM trade_flow
		 WHERE deal_name = ? AND flow_type = ? AND app_id = ?
	`
	var (
		id           int64
		dn           string
		ft           string
		ai           string
		status       string
		reqBody      sql.NullString
		respBody     sql.NullString
		createdTime  time.Time
		updatedTime  time.Time
	)
	err := s.db.QueryRowContext(ctx, q, dealName, flowType, appID).Scan(
		&id, &dn, &ft, &ai, &status, &reqBody, &respBody, &createdTime, &updatedTime,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrFlowNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("trade_flow: get dealName=%s: %w", dealName, err)
	}
	flow := &Flow{
		ID:          id,
		DealName:    dn,
		FlowType:    ft,
		AppID:       ai,
		Status:      status,
		CreatedTime: createdTime,
		UpdatedTime: updatedTime,
	}
	if reqBody.Valid {
		flow.RequestBody = []byte(reqBody.String)
	}
	if respBody.Valid {
		flow.ResponseBody = []byte(respBody.String)
	}
	return flow, nil
}

// ListInProgressBefore 实现 FlowStore（迭代 7 reconcile worker 主用）。
func (s *MySQLStore) ListInProgressBefore(ctx context.Context, cutoff time.Time, limit int) ([]*Flow, error) {
	if s == nil || s.db == nil {
		return nil, fmt.Errorf("trade_flow: store is nil")
	}
	if limit <= 0 {
		limit = 100
	}
	const q = `
		SELECT id, deal_name, flow_type, app_id, status, request_body, response_body, created_time, updated_time
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
			dn, ft, ai  string
			status      string
			reqBody     sql.NullString
			respBody    sql.NullString
			createdTime time.Time
			updatedTime time.Time
		)
		if err := rows.Scan(&id, &dn, &ft, &ai, &status, &reqBody, &respBody, &createdTime, &updatedTime); err != nil {
			return nil, fmt.Errorf("trade_flow: scan: %w", err)
		}
		flow := &Flow{
			ID:          id,
			DealName:    dn,
			FlowType:    ft,
			AppID:       ai,
			Status:      status,
			CreatedTime: createdTime,
			UpdatedTime: updatedTime,
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
