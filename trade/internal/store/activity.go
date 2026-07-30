package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

// ErrBundleActivityNotFound 是 trade_bundle_activity 查无记录的哨兵错误。
//
// 由 GetBundleActivityByBundleID 在 sql.ErrNoRows 时返回，让上层 ActivityResolver
// 据此区分"非活动 bundle"（直接 fallback 走 jifei）与"DB 错误"（5xx）。
var ErrBundleActivityNotFound = errors.New("trade_bundle_activity: not found")

// BundleActivity 是 trade_bundle_activity 表的领域对象（设计稿 §3.1）。
type BundleActivity struct {
	ID         int64
	BundleID   string
	ActivityID int64
	ActID      int64
	// SecretKey 为空表示该活动在点石后台未开鉴权，下单时不带 check_sum 字段。
	SecretKey string
	// Active 为 false 表示活动已下线（运营按需切换），Resolver 视为非活动 bundle。
	Active bool
	// TimeSpanUnit 是点石询价 / 下单 preference_param.timeSpanUnit 字面值（如 "7d"）。
	// 由运营在点石后台的实际配置决定，部署后手工 INSERT trade_bundle_activity 时填入。
	// 空字符串表示该 bundle 在点石侧未要求 timeSpanUnit（联调期 fallback；不同环境取值不同）。
	TimeSpanUnit string
	// OrderExpiredTime 是点石下单幂等复用窗口，单位小时，支持 0.5。
	// 默认 1 小时；仅 placeOrderDianshi 复用待支付订单时生效。
	OrderExpiredTime float64
}

// UserActivityParticipation 是 trade_user_activity_participation 表的领域对象（设计稿 §3.2）。
//
// 写入路径：仅 createResource 同事务（§5.6.1 step 4）。
// 读取路径：Resolver 仅做 (uin, activity_id) 是否存在判断、不消费具体字段值；
// 单测断言时偶尔需要拿到完整字段集做行为校验。
type UserActivityParticipation struct {
	ID             int64
	Uin            string
	AppID          string
	ExternalUserID string
	ActivityID     int64
	BundleID       string
	ActID          int64
	DealName       string
	BigDealNo      string
	CreatedTime    time.Time
}

// DianshiRecordFilter 是后台查询点石参与记录/订单时共用的过滤条件。
type DianshiRecordFilter struct {
	ExternalUserID string
	Uin            string
	ActivityID     int64
	BundleID       string
	DealName       string
	Limit          int
	Page           int
	PageSize       int
}

// ActivityStore 抽象点石活动相关的 DAO 接口，便于 logic/activity Resolver 单测 mock。
type ActivityStore interface {
	// GetBundleActivityByBundleID 反查 trade_bundle_activity 行；无记录返
	// ErrBundleActivityNotFound（业务语义"非活动 bundle"）。
	GetBundleActivityByBundleID(ctx context.Context, bundleID string) (*BundleActivity, error)

	// HasUserParticipated 判定 (uin, activity_id) 是否已存在参与记录。
	//
	// 返回值：
	//   - 已存在 → (true, nil)
	//   - 不存在 → (false, nil)
	//   - DB 错误 → (false, err)
	HasUserParticipated(ctx context.Context, uin string, activityID int64) (bool, error)

	// InsertUserParticipation 插入用户活动领取事实记录（§5.6 createResource 同事务调用）。
	//
	// 在事务中调用——调用方须传入 *sql.Tx（与 ctl.CompletePass 同事务），让 INSERT
	// 在 createResource 主事务里参与原子语义。
	//
	// 行为：
	//   - 成功插入 → (id, nil)
	//   - 唯一约束冲突 (uk_uin_activity) → (0, err)（调用方按 §6.2 / §11 Q6 处理）
	//   - 其他 DB 错误 → (0, err)
	InsertUserParticipation(
		ctx context.Context,
		tx *sql.Tx,
		row *UserActivityParticipation,
	) (int64, error)
}

// DianshiAdminStore 是后台管理点石订单和参与记录所需的 DAO 能力。
type DianshiAdminStore interface {
	ListDianshiOrders(ctx context.Context, filter DianshiRecordFilter) ([]*TradeOrder, error)
	DeleteDianshiOrder(ctx context.Context, dealName string) (int64, error)
	ListUserActivityParticipations(ctx context.Context, filter DianshiRecordFilter) ([]*UserActivityParticipation, int64, error)
	DeleteUserActivityParticipation(ctx context.Context, id int64) (int64, error)
}

var _ ActivityStore = (*MySQLStore)(nil)
var _ DianshiAdminStore = (*MySQLStore)(nil)

// GetBundleActivityByBundleID 实现 ActivityStore 接口。
//
// SQL：
//
//	SELECT id, bundle_id, activity_id, act_id, secret_key, active, time_span_unit, order_expired_time
//	  FROM trade_bundle_activity
//	 WHERE bundle_id = ?
func (s *MySQLStore) GetBundleActivityByBundleID(ctx context.Context, bundleID string) (*BundleActivity, error) {
	if s == nil || s.db == nil {
		return nil, fmt.Errorf("trade_bundle_activity: store is nil")
	}
	const q = `
		SELECT id, bundle_id, activity_id, act_id, secret_key, active, time_span_unit, order_expired_time
		  FROM trade_bundle_activity
		 WHERE bundle_id = ?
	`
	var (
		row       BundleActivity
		secretKey sql.NullString
		active    int
	)
	err := s.db.QueryRowContext(ctx, q, bundleID).Scan(
		&row.ID, &row.BundleID, &row.ActivityID, &row.ActID,
		&secretKey, &active, &row.TimeSpanUnit, &row.OrderExpiredTime,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrBundleActivityNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("trade_bundle_activity: query bundleID=%s: %w", bundleID, err)
	}
	if secretKey.Valid {
		row.SecretKey = secretKey.String
	}
	row.Active = active != 0
	return &row, nil
}

// HasUserParticipated 实现 ActivityStore 接口。
//
// SQL：
//
//	SELECT 1 FROM trade_user_activity_participation
//	 WHERE uin = ? AND activity_id = ? LIMIT 1
//
// 命中 uk_uin_activity (uin, activity_id) 唯一索引，O(1)。
func (s *MySQLStore) HasUserParticipated(ctx context.Context, uin string, activityID int64) (bool, error) {
	if s == nil || s.db == nil {
		return false, fmt.Errorf("trade_user_activity_participation: store is nil")
	}
	const q = `
		SELECT 1
		  FROM trade_user_activity_participation
		 WHERE uin = ? AND activity_id = ?
		 LIMIT 1
	`
	var dummy int
	err := s.db.QueryRowContext(ctx, q, uin, activityID).Scan(&dummy)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("trade_user_activity_participation: query uin=%s activityID=%d: %w",
			uin, activityID, err)
	}
	return true, nil
}

// InsertUserParticipation 实现 ActivityStore 接口（事务版）。
//
// SQL：
//
//	INSERT INTO trade_user_activity_participation
//	  (uin, app_id, external_user_id, activity_id, bundle_id, act_id,
//	   deal_name, big_deal_no, created_time)
//	VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(6))
//
// 唯一约束冲突 → MySQL 1062，调用方据此映射业务错（§11 Q6）。
func (s *MySQLStore) InsertUserParticipation(
	ctx context.Context,
	tx *sql.Tx,
	row *UserActivityParticipation,
) (int64, error) {
	if row == nil {
		return 0, fmt.Errorf("trade_user_activity_participation: nil row")
	}
	if tx == nil {
		return 0, fmt.Errorf("trade_user_activity_participation: nil tx (must be called within a transaction)")
	}
	const q = `
		INSERT INTO trade_user_activity_participation
		  (uin, app_id, external_user_id, activity_id, bundle_id, act_id,
		   deal_name, big_deal_no, created_time)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(6))
	`
	res, err := tx.ExecContext(ctx, q,
		row.Uin, row.AppID, row.ExternalUserID, row.ActivityID, row.BundleID, row.ActID,
		row.DealName, row.BigDealNo,
	)
	if err != nil {
		return 0, fmt.Errorf("trade_user_activity_participation: insert uin=%s activityID=%d: %w",
			row.Uin, row.ActivityID, err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		return 0, fmt.Errorf("trade_user_activity_participation: last insert id: %w", err)
	}
	return id, nil
}

// ListUserActivityParticipations 查询点石活动参与记录，用于后台管理排障和重试。
func (s *MySQLStore) ListUserActivityParticipations(ctx context.Context, filter DianshiRecordFilter) ([]*UserActivityParticipation, int64, error) {
	if s == nil || s.db == nil {
		return nil, 0, fmt.Errorf("trade_user_activity_participation: store is nil")
	}
	where, args := buildDianshiFilterWhere(filter, false)
	countArgs := append([]any(nil), args...)
	countQuery := `SELECT COUNT(*) FROM trade_user_activity_participation` + where
	var total int64
	if err := s.db.QueryRowContext(ctx, countQuery, countArgs...).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("trade_user_activity_participation: count: %w", err)
	}

	q := `
		SELECT id, uin, app_id, external_user_id, activity_id, bundle_id, act_id,
		       deal_name, big_deal_no, created_time
		  FROM trade_user_activity_participation
	` + where + `
		 ORDER BY created_time DESC, id DESC
		 LIMIT ? OFFSET ?
	`
	args = append(args, normalizedDianshiPageSize(filter), normalizedDianshiOffset(filter))
	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, 0, fmt.Errorf("trade_user_activity_participation: list: %w", err)
	}
	defer rows.Close()

	result := make([]*UserActivityParticipation, 0)
	for rows.Next() {
		var row UserActivityParticipation
		if err := rows.Scan(
			&row.ID, &row.Uin, &row.AppID, &row.ExternalUserID, &row.ActivityID,
			&row.BundleID, &row.ActID, &row.DealName, &row.BigDealNo, &row.CreatedTime,
		); err != nil {
			return nil, 0, fmt.Errorf("trade_user_activity_participation: scan: %w", err)
		}
		result = append(result, &row)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, fmt.Errorf("trade_user_activity_participation: rows: %w", err)
	}
	return result, total, nil
}

// DeleteUserActivityParticipation 删除点石活动参与记录，使用户可重新走点石活动下单。
func (s *MySQLStore) DeleteUserActivityParticipation(ctx context.Context, id int64) (int64, error) {
	if s == nil || s.db == nil {
		return 0, fmt.Errorf("trade_user_activity_participation: store is nil")
	}
	res, err := s.db.ExecContext(ctx, `DELETE FROM trade_user_activity_participation WHERE id = ?`, id)
	if err != nil {
		return 0, fmt.Errorf("trade_user_activity_participation: delete id=%d: %w", id, err)
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("trade_user_activity_participation: delete rows affected: %w", err)
	}
	return affected, nil
}

func buildDianshiFilterWhere(filter DianshiRecordFilter, includeSource bool) (string, []any) {
	clauses := make([]string, 0, 6)
	args := make([]any, 0, 6)
	if includeSource {
		clauses = append(clauses, "source = ?")
		args = append(args, OrderSourceDianshi)
	}
	if v := strings.TrimSpace(filter.ExternalUserID); v != "" {
		clauses = append(clauses, "external_user_id = ?")
		args = append(args, v)
	}
	if v := strings.TrimSpace(filter.Uin); v != "" {
		clauses = append(clauses, "uin = ?")
		args = append(args, v)
	}
	if filter.ActivityID > 0 {
		clauses = append(clauses, "activity_id = ?")
		args = append(args, filter.ActivityID)
	}
	if v := strings.TrimSpace(filter.BundleID); v != "" {
		clauses = append(clauses, "bundle_id = ?")
		args = append(args, v)
	}
	if v := strings.TrimSpace(filter.DealName); v != "" {
		clauses = append(clauses, "deal_name = ?")
		args = append(args, v)
	}
	if len(clauses) == 0 {
		return "", args
	}
	return " WHERE " + strings.Join(clauses, " AND "), args
}

func normalizedDianshiLimit(limit int) int {
	if limit <= 0 {
		return 50
	}
	if limit > 200 {
		return 200
	}
	return limit
}

func normalizedDianshiPageSize(filter DianshiRecordFilter) int {
	if filter.PageSize > 0 {
		if filter.PageSize > 200 {
			return 200
		}
		return filter.PageSize
	}
	return normalizedDianshiLimit(filter.Limit)
}

func normalizedDianshiPage(filter DianshiRecordFilter) int {
	if filter.Page <= 0 {
		return 1
	}
	return filter.Page
}

func normalizedDianshiOffset(filter DianshiRecordFilter) int {
	return (normalizedDianshiPage(filter) - 1) * normalizedDianshiPageSize(filter)
}
