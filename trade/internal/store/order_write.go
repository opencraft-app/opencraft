package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// trade_order 写端 DAO（迭代 8）。
//
// 写端职责覆盖：
//   - PlaceOrder 入口：CreateOrder（落地 status='created' 或 'pending_pay' 初始流水）
//   - createResource 链路收尾（迭代 6 OrderProvisionUpdater 真实实现）：
//     MarkOrderProvisioned（resource_id 反向回填 + status='provisioned'）
//
// 设计稿对齐（§4.2.1 / §6.2 / Q41~Q50）：
//   - status 状态机：created → pending_pay → paid_pending_provision → provisioned
//     （payment_failed / provision_failed 是分支终态，本期不实现状态降级 SQL）
//   - resource_id 列允许 NULL；只有 createResource 收尾才写非空值
//   - JSON 字段 goods_detail 在 DAO 层序列化为 raw JSON 落库，业务层不感知

// CreateOrderInput 是 CreateOrder 的入参。
//
// 字段语义见 trade_order 表注释（migration 0001）。
// goods_detail 字段：业务层传 map[string]interface{}（jifei 协议层 goodsDetail 透传快照），
// DAO 层负责序列化为 JSON 字符串落库；空 map 落 NULL。
type CreateOrderInput struct {
	BigOrderID     string
	DealName       string
	ExternalUserID string
	Uin            string
	AppID          string
	SubProductCode string
	BundleID       string
	Period         int
	TimeUnit       string
	GoodsNum       int
	RegionID       int
	PayMode        int
	GoodsDetail    map[string]interface{}
	PayURL         string
	Status         string // 通常为 "created" 或 "pending_pay"
	ResourceType   string // 默认 "pass"
	ExpireTime     time.Time
}

// ErrTradeOrderDuplicate 是按 deal_name UNIQUE 约束冲突的哨兵错误。
//
// 上层 placeorder logic 依此判定 dealName 已被占用，转译为业务层冲突错误。
var ErrTradeOrderDuplicate = errors.New("trade_order: deal_name duplicate")

// OrderWriter 抽象 trade_order 写端 DAO，便于上层 placeorder / createresource logic mock。
//
// 注意刻意把读端（OrderStore）和写端（OrderWriter）拆成两个 interface：
//   - 读端只允许 logic/checkcreate / logic/createresource 注入（这两个 handler 不应反向写订单）
//   - 写端只允许 logic/placeorder（PlaceOrder 入口）+ logic/createresource（OrderProvisionUpdater
//     收尾反向回填）注入
//
// 这种分裂避免误用："checkCreate handler 不慎拿到 OrderWriter" 这种代码会编译失败。
type OrderWriter interface {
	// CreateOrder 插入一条新的 trade_order 记录。
	//
	// 错误：
	//   - deal_name UNIQUE 冲突 → wrap ErrTradeOrderDuplicate（上层判定 dealName 已被占用）
	//   - 其他基础设施错 → raw error wrap
	//
	// 注意：传入的 status 字段不做校验（业务层语义，DAO 不收纳 enum 检查）；
	// 调用方应只传"created" / "pending_pay" 等 PlaceOrder 入口允许的初始状态。
	CreateOrder(ctx context.Context, in CreateOrderInput) error

	// MarkOrderProvisioned 用 (deal_name) 定位记录，把 resource_id 写入 + status 升级为 "provisioned"。
	//
	// SQL 语义（与 createResource 收尾的幂等需求对齐）：
	//
	//   UPDATE trade_order
	//      SET resource_id = ?, status = 'provisioned', updated_time = NOW()
	//    WHERE deal_name = ?
	//      AND (resource_id IS NULL OR resource_id = '' OR resource_id = ?)
	//
	// 第 3 个 WHERE 条件是为了"幂等重放安全"：
	//   - resource_id 列原本为空（首次回填）→ 命中
	//   - resource_id 已与传入值相同（jifei 重复回调）→ 命中（idempotent，no-op-ish）
	//   - resource_id 已与传入值不同（异常：被另一个 pass 占用）→ 不命中，返 ErrTradeOrderResourceIDConflict
	//
	// 不命中时返 ErrTradeOrderNotFound 或 ErrTradeOrderResourceIDConflict（按情况）；
	// trade_order 不存在的情况理论上不应发生（createResource 触发条件是 jifei 已扣款 + jifei
	// 入参 dealName 是 trade 自己生成的），但为防御兜底返 NotFound 让上层走 B 类返 jifei 重试。
	MarkOrderProvisioned(ctx context.Context, dealName, resourceID string) error

	// UpdatePayURL 用 deal_name 定位记录，把 jifei getMidasEarmarking 返回的支付 URL 写回缓存。
	//
	// SQL 语义（与 GeneratePayURL 命中即返的快路径协同 — Q-PAY-2）：
	//
	//   UPDATE trade_order SET pay_url = ?, updated_time = NOW() WHERE deal_name = ?
	//
	// 不更新 status 字段（Q-PAY-3：getMidasEarmarking 不改变订单状态机；status 仍由 PlaceOrder
	// 入口写 'pending_pay'，由 createResource 收尾推进到 'provisioned'）。
	//
	// 错误：
	//   - deal_name 不存在（rows affected = 0）→ wrap ErrTradeOrderNotFound
	//   - 其他基础设施错 → raw error wrap
	//
	// 幂等性：jifei "getMidasEarmarking" 在同一 dealName 上多次调用应返回同一 URL，
	// 重复写库为 no-op-ish（payURL 字段不变，updated_time 刷新）。
	UpdatePayURL(ctx context.Context, dealName, payURL string) error
}

// ErrTradeOrderResourceIDConflict 表示 trade_order 已被另一个不同 resource_id 占用。
//
// 这是数据不一致信号（同一 deal_name 不应被两个不同 pass 占用）；上层 createresource handler
// 命中时按 Q56 A 类（永久失败）→ 返退款响应。
var ErrTradeOrderResourceIDConflict = errors.New("trade_order: resource_id conflict")

// 编译期断言 *MySQLStore 实现 OrderWriter 接口。
var _ OrderWriter = (*MySQLStore)(nil)

// CreateOrder 实现 OrderWriter。
func (s *MySQLStore) CreateOrder(ctx context.Context, in CreateOrderInput) error {
	if s == nil || s.db == nil {
		return fmt.Errorf("trade_order: store is nil")
	}
	if in.DealName == "" {
		return fmt.Errorf("trade_order: deal_name is required")
	}
	if in.Status == "" {
		return fmt.Errorf("trade_order: status is required")
	}
	if in.ResourceType == "" {
		in.ResourceType = "pass"
	}
	if in.GoodsNum == 0 {
		in.GoodsNum = 1
	}

	var goodsDetailArg interface{}
	if len(in.GoodsDetail) > 0 {
		raw, err := json.Marshal(in.GoodsDetail)
		if err != nil {
			return fmt.Errorf("trade_order: marshal goods_detail: %w", err)
		}
		goodsDetailArg = string(raw)
	}

	const q = `
		INSERT INTO trade_order (
			big_order_id, deal_name, external_user_id, uin, app_id,
			sub_product_code, bundle_id, period, time_unit, goods_num,
			region_id, pay_mode, goods_detail, pay_url, status,
			resource_type, expire_time, created_time, updated_time
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
	`
	var payURLArg interface{}
	if in.PayURL != "" {
		payURLArg = in.PayURL
	}

	if _, err := s.db.ExecContext(ctx, q,
		in.BigOrderID, in.DealName, in.ExternalUserID, in.Uin, in.AppID,
		in.SubProductCode, in.BundleID, in.Period, in.TimeUnit, in.GoodsNum,
		in.RegionID, in.PayMode, goodsDetailArg, payURLArg, in.Status,
		in.ResourceType, in.ExpireTime,
	); err != nil {
		// MySQL UNIQUE 冲突 errno=1062；驱动层不暴露常量，按 message 子串匹配兜底
		if isMySQLDuplicateError(err) {
			return fmt.Errorf("%w: dealName=%s: %v", ErrTradeOrderDuplicate, in.DealName, err)
		}
		return fmt.Errorf("trade_order: insert dealName=%s: %w", in.DealName, err)
	}
	return nil
}

// MarkOrderProvisioned 实现 OrderWriter。
//
// 状态机过渡：current_status → "provisioned"，其中 current_status 期望是
// "paid_pending_provision"（付款完成等待发货）。但本期不强约束 current_status —
// 只要 deal_name 命中、resource_id 不冲突就升级 — 因为 trade_order 写端流转
// 期间可能因 jifei 多次回调造成状态不严格线性，强校验反而引入毛刺。
func (s *MySQLStore) MarkOrderProvisioned(ctx context.Context, dealName, resourceID string) error {
	if s == nil || s.db == nil {
		return fmt.Errorf("trade_order: store is nil")
	}
	if dealName == "" {
		return fmt.Errorf("trade_order: deal_name is required")
	}
	if resourceID == "" {
		return fmt.Errorf("trade_order: resource_id is required")
	}

	// 先检查 resource_id 冲突（避免误覆盖另一个 pass）
	const checkQ = `SELECT resource_id FROM trade_order WHERE deal_name = ?`
	var existing sql.NullString
	if err := s.db.QueryRowContext(ctx, checkQ, dealName).Scan(&existing); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("%w: dealName=%s", ErrTradeOrderNotFound, dealName)
		}
		return fmt.Errorf("trade_order: check existing resource_id dealName=%s: %w", dealName, err)
	}
	if existing.Valid && existing.String != "" && existing.String != resourceID {
		return fmt.Errorf("%w: dealName=%s existing=%s incoming=%s",
			ErrTradeOrderResourceIDConflict, dealName, existing.String, resourceID)
	}

	const q = `
		UPDATE trade_order
		   SET resource_id = ?, status = 'provisioned', updated_time = NOW()
		 WHERE deal_name = ?
	`
	res, err := s.db.ExecContext(ctx, q, resourceID, dealName)
	if err != nil {
		return fmt.Errorf("trade_order: mark provisioned dealName=%s: %w", dealName, err)
	}
	rowsAffected, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("trade_order: rows affected: %w", err)
	}
	if rowsAffected == 0 {
		// 理论不会触发：上一步 SELECT 已确认存在；保留兜底返 NotFound
		return fmt.Errorf("%w: dealName=%s (update affected 0 rows)", ErrTradeOrderNotFound, dealName)
	}
	return nil
}

// UpdatePayURL 实现 OrderWriter（jifei getMidasEarmarking 返回的支付 URL 写回 trade_order.pay_url）。
//
// 见 OrderWriter.UpdatePayURL 注释（Q-PAY-2 / Q-PAY-3）。
func (s *MySQLStore) UpdatePayURL(ctx context.Context, dealName, payURL string) error {
	if s == nil || s.db == nil {
		return fmt.Errorf("trade_order: store is nil")
	}
	if dealName == "" {
		return fmt.Errorf("trade_order: deal_name is required")
	}
	if payURL == "" {
		return fmt.Errorf("trade_order: pay_url is required")
	}

	const q = `
		UPDATE trade_order
		   SET pay_url = ?, updated_time = NOW()
		 WHERE deal_name = ?
	`
	res, err := s.db.ExecContext(ctx, q, payURL, dealName)
	if err != nil {
		return fmt.Errorf("trade_order: update pay_url dealName=%s: %w", dealName, err)
	}
	rowsAffected, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("trade_order: rows affected: %w", err)
	}
	if rowsAffected == 0 {
		return fmt.Errorf("%w: dealName=%s (update pay_url affected 0 rows)",
			ErrTradeOrderNotFound, dealName)
	}
	return nil
}

// isMySQLDuplicateError 判断 error 是否是 MySQL 1062 duplicate key 错误。
//
// 不直接 import go-sql-driver/mysql 是为了让 store 层只依赖 database/sql 抽象；
// 错误消息子串匹配是 MySQL 驱动稳定输出（"Error 1062" / "Duplicate entry"），
// 跨驱动版本兼容性可接受。
func isMySQLDuplicateError(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "Error 1062") || strings.Contains(msg, "Duplicate entry")
}
