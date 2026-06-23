package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
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
// 字段语义见 trade_order 表注释（migration 0001 / 0003）。
// goods_detail 字段：业务层传 map[string]interface{}（jifei 协议层 goodsDetail 透传快照），
// DAO 层负责序列化为 JSON 字符串落库；空 map 落 NULL。
//
// OrderType（migration 0003 新增列；R-A 落地）：订单生命周期类型。
//   - 取值集：OrderTypeCreate("create") / OrderTypeRenew("renew") / 预留 "refund"
//   - 入参为空字符串 → DAO 默认填 OrderTypeCreate（兼容历史 PlaceOrder / PlaceOrderAndPay 调用方
//     不需修改即可继续工作；DB schema 也是 NOT NULL DEFAULT 'create'，双层默认）
//   - PlaceRenewOrder（R-C 续费下单入口）必须显式传 OrderTypeRenew，否则会被默认覆盖为 'create'
type CreateOrderInput struct {
	BigOrderID     string
	DealName       string
	ExternalUserID string
	Uin            string
	AppID          string
	SubProductCode string
	BundleID       string
	OrderType      string // R-C 新增：'create' / 'renew' / 预留 'refund'；空 → 默认 OrderTypeCreate
	Period         int
	TimeUnit       string
	GoodsNum       int
	RegionID       int
	PayMode        int
	GoodsDetail    map[string]interface{}
	PayURL         string
	Status         string // 通常为 "created" 或 "pending_pay"
	ResourceType   string // 默认 "pass"
	// Source（设计稿 §3.3）：订单来源。取值集 "jifei" / "dianshi"；空字符串 → DAO 默认
	// 填 "jifei"，与 migration 000006 DB DEFAULT 双层一致。在 PlaceOrder / PlaceOrderAndPay 走
	// jifei 路径时不需显式传值；placeOrderDianshi 须显式传 "dianshi"。
	Source string
	// ResourceID（R-C-5 续费场景必填；新购 INSERT 时留空，由 createResource 收尾 MarkOrderProvisioned 反向回填）：
	//   - OrderType='create'：留空字符串 → INSERT 落 NULL（与 trade_order.resource_id DEFAULT NULL 一致）
	//   - OrderType='renew'：必填 = pass_id；renewresource handler 的 trade_order 维度交叉校验依赖此字段
	//     （参见 trade/internal/logic/renewresource/handler.go § ResourceID 漂移检测：
	//      jifei 回调入参 resourceId 与 trade_order.resource_id 不一致时 A 类退款）
	ResourceID string
	// v1.7.28 BUG-12 修复 (2026-05-21)：删除 ExpireTime 字段（trade 业务层从未拥有
	// "订单何时失效"的真源；列从 schema 删了，见 migration 0004）。
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

	// MarkOrderCancelled 把 trade_order 由中态推进到 cancelled 终态（v1.7.32 引入）。
	//
	// 调用场景：orderstatus.QueryStatus 反查 jifei.getDealsByKeyIndex 发现订单状态为
	// canceled / overdue / delete 时，同进程同事务调本方法抨进本地状态。
	//
	// SQL 语义（CAS WHERE 限定中态）：
	//
	//   UPDATE trade_order
	//      SET status = 'cancelled', updated_time = NOW()
	//    WHERE deal_name = ?
	//      AND status IN ('created', 'pending_pay', 'paid_pending_provision')
	//
	// 幂等 / 状态机不可逆语义（B6 不变量）：
	//   - rows affected == 0 是合法路径（已是本地终态 / 记录不存在）→ 返 nil、不报错
	//   - 仅在底层 SQL execution error 时 → wrap raw error
	//
	// 设计理据：B6 保证本地终态不可覆盖（已 provisioned 的订单不会被 jifei 后势反查抨回 cancelled）；
	// 记录不存在是调用方与本方法的间接并发事件（请求 A 查不到他请求 B 后中途被 DELETE），统一返成功
	// 避免调用方错误重试。
	MarkOrderCancelled(ctx context.Context, dealName string) error
}

// ErrTradeOrderResourceIDConflict 表示 trade_order 已被另一个不同 resource_id 占用。
//
// 这是数据不一致信号（同一 deal_name 不应被两个不同 pass 占用）；上层 createresource handler
// 命中时按 Q56 A 类（永久失败）→ 返退款响应。
var ErrTradeOrderResourceIDConflict = errors.New("trade_order: resource_id conflict")

// 编译期断言 *MySQLStore 实现 OrderWriter 接口。
var _ OrderWriter = (*MySQLStore)(nil)

// CreateOrder 实现 OrderWriter。
//
// v1.7.28 BUG-22 修订（2026-05-21）：去掉原 R-C Q15=a "deal_name 三态强约束" 的
// `panic`。新设计下 PlaceOrderAndPay 在调用 jifei generateDealsAndPay 成功**之后**
// 才 INSERT trade_order（同步链路 + 一次到位 dealName/bigOrderId/status='paid_pending_provision'），
// trade_order 退化为"订单流水记录"用途，不在发货关键路径上。createResource handler
// 已通过 jifei goodsDetail 透传机制（externalUserId / bundleId）完全脱离 trade_order
// 反查依赖。
//
// 本期 deal_name 在 INSERT 路径上仍然非空（PlaceOrderAndPay 拿到 jifei 响应后才插），
// 但保留 in.DealName 空字符串 → 落 NULL 的 DAO 兼容（历史 panic 改为接受），让未来
// 其它写入路径有空间扩展（如 reconcile worker 兜底插占位行）。
func (s *MySQLStore) CreateOrder(ctx context.Context, in CreateOrderInput) error {
	if s == nil || s.db == nil {
		return fmt.Errorf("trade_order: store is nil")
	}
	if in.Status == "" {
		return fmt.Errorf("trade_order: status is required")
	}
	if in.ResourceType == "" {
		in.ResourceType = "pass"
	}
	if in.OrderType == "" {
		// R-C Q7=a：order_type 默认 'create'，与 migration 0003 DB DEFAULT 双层一致；
		// PlaceRenewOrder 必须显式传 OrderTypeRenew 才能写入续费订单。
		in.OrderType = OrderTypeCreate
	}
	if in.Source == "" {
		// 设计稿 §3.3：source 默认 'jifei'，与 migration 000006 DB DEFAULT 双层一致。
		in.Source = OrderSourceJifei
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

	// R-C Q7=a：INSERT 列清单显式包含 order_type；migration 0003 已在 bundle_id 后插列，
	// 这里 SQL 顺序与 GetOrderByDealName SELECT 子句保持一致。
	// R-C-5 (2026-05-15)：INSERT 列加 resource_id（续费订单 INSERT 时必填 = pass_id；
	//   新购订单留空字符串 → INSERT 时绑定 nil 落 NULL，与 trade_order.resource_id DEFAULT NULL 一致；
	//   createResource 收尾仍走 MarkOrderProvisioned UPDATE 写回）。
	const q = `
		INSERT INTO trade_order (
			big_order_id, deal_name, external_user_id, uin, app_id,
			sub_product_code, bundle_id, order_type, period, time_unit, goods_num,
			region_id, pay_mode, goods_detail, pay_url, status,
			resource_type, resource_id, source, created_time, updated_time
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
	`
	var payURLArg interface{}
	if in.PayURL != "" {
		payURLArg = in.PayURL
	}
	// resource_id：续费订单 INSERT 时必填 pass_id；新购订单留空字符串 → 绑定 nil 让列落 NULL，
	// 不要绑定空字符串（会导致 idx_resource (resource_type, resource_id) 索引出现假命中）。
	var resourceIDArg interface{}
	if in.ResourceID != "" {
		resourceIDArg = in.ResourceID
	}

	if _, err := s.db.ExecContext(ctx, q,
		in.BigOrderID, in.DealName, in.ExternalUserID, in.Uin, in.AppID,
		in.SubProductCode, in.BundleID, in.OrderType, in.Period, in.TimeUnit, in.GoodsNum,
		in.RegionID, in.PayMode, goodsDetailArg, payURLArg, in.Status,
		in.ResourceType, resourceIDArg, in.Source,
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

// MarkOrderCancelled 实现 OrderWriter（v1.7.32 引入）。
//
// 设计稿：.tmp/ctl-order-status-query-design.md §1 不变量 B2 + B6 与 §5.3。
//
// SQL CAS 语义（WHERE 限定中态、只让状态机单向进入 cancelled）：
//
//	UPDATE trade_order
//	   SET status = 'cancelled', updated_time = NOW()
//	 WHERE deal_name = ?
//	   AND status IN ('created', 'pending_pay', 'paid_pending_provision')
//
// 幂等 / 状态机不可逆：
//   - rows affected == 0：合法路径（记录不存在 或 已是 provisioned/payment_failed/provision_failed/cancelled 本地终态）→ 返 nil
//   - 仅在底层 SQL execution 错误时返 wrap error
//
// 与 MarkOrderProvisioned 不同：后者会返 ErrTradeOrderNotFound / ErrTradeOrderResourceIDConflict 让上层
// 走 B 类重试；本函数是“仅中态可推进”语义，完全幂等，不区分“不存在”与“已终态”。
func (s *MySQLStore) MarkOrderCancelled(ctx context.Context, dealName string) error {
	if s == nil || s.db == nil {
		return fmt.Errorf("trade_order: store is nil")
	}
	if dealName == "" {
		return fmt.Errorf("trade_order: deal_name is required")
	}

	const q = `
		UPDATE trade_order
		   SET status = 'cancelled', updated_time = NOW()
		 WHERE deal_name = ?
		   AND status IN ('created', 'pending_pay', 'paid_pending_provision')
	`
	if _, err := s.db.ExecContext(ctx, q, dealName); err != nil {
		return fmt.Errorf("trade_order: mark cancelled dealName=%s: %w", dealName, err)
	}
	// rows affected == 0 不报错：记录不存在 / 已是本地终态 都是幂等路径。
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
