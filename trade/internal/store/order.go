package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// ErrTradeOrderNotFound 是 trade_order 表查无记录的哨兵错误。
//
// 上层适配层（迭代 5 checkCreate handler）用 errors.Is 判定后转译为业务层错误码
// `TRADE_ORDER_NOT_FOUND`（设计稿 §5.2 #3/#4 协同）。jifei 在 checkCreate 阶段把
// trade 自己生成的 dealName 回传过来，trade 对账失败本身意味着 jifei / trade 状态
// 不一致 — 在 Q56 错误分类里属于 B 类（链路异常需重试 / 排障）而非 A 类退款。
var ErrTradeOrderNotFound = errors.New("trade_order: not found")

// OrderType 枚举（migration 0003 新增列；订单生命周期类型）：
//
//   - OrderTypeCreate = "create"  新购订单（兼容历史数据，DEFAULT 'create'）
//   - OrderTypeRenew  = "renew"   续费订单（R-A 新增）
//   - 预留 OrderTypeRefund = "refund"（本期暂不实现）
//
// 与 trade_flow.flow_type（jifei 协议长事务流水类型）维度不同：trade_order.order_type
// 描述订单生命周期，trade_flow.flow_type 描述 jifei 协议接口类型。详见
// .tmp/trade-pass-renew-design.md §4.2 字段维度对照表。
const (
	OrderTypeCreate = "create"
	OrderTypeRenew  = "renew"
)

// OrderSource 枚举（migration 000006 新增列；订单来源）：
//
//   - OrderSourceJifei   = "jifei"    jifei 计费链路（默认；与 DB DEFAULT 'jifei' 双层一致）
//   - OrderSourceDianshi = "dianshi"  点石活动链路（设计稿 .tmp/dianshi-activity-bundle-design.md §3.3）
//
// 由 trade.placeorder.Service.placeOrderDianshi 在落 trade_order 时显式写 'dianshi'；
// 其他写入路径（PlaceOrder / PlaceOrderAndPay / PlaceRenewOrder*）默认走 'jifei' 不传值，
// DAO 层在 in.Source=="" 时回填 OrderSourceJifei。
const (
	OrderSourceJifei   = "jifei"
	OrderSourceDianshi = "dianshi"
)

// trade_order.status 状态机常量（与 migration 0001 / 0005 注释对齐）。
//
// 状态机概览：
//
//	created / pending_pay  →  paid_pending_provision  →  provisioned  ✅终态
//	                                                  ↘  payment_failed     ✅终态（预留）
//	                                                  ↘  provision_failed   ✅终态（预留）
//	                                                  ↘  cancelled          ✅终态（v1.7.32 新增）
//
// 写入时机：
//   - OrderStatusCreated / OrderStatusPendingPay：PlaceOrder 入口（双步式新购，等待用户跳支付页）
//   - OrderStatusPaidPendingProvision：PlaceOrderAndPay 一体化下单+支付（迭代 8B-1.5）
//   - OrderStatusProvisioned：createResource 收尾 / 一体化 BUG-22/23 同步链路
//   - OrderStatusPaymentFailed / OrderStatusProvisionFailed：本期 jifei 协议未直接落，预留
//   - OrderStatusCancelled：orderstatus.QueryStatus 在 jifei 反查到 canceled / overdue / delete
//     时 CAS 推进（v1.7.32 引入，详见 .tmp/ctl-order-status-query-design.md §1 不变量 B2/B6）
//
// 终态判定：调用方用 IsOrderTerminalStatus 统一判定，不要硬编码字符串集合。
const (
	// OrderStatusCreated 已创建（兼容历史，与 OrderStatusPendingPay 等价中态）。
	OrderStatusCreated = "created"
	// OrderStatusPendingPay 待支付（中态；PlaceOrder 默认值）。
	OrderStatusPendingPay = "pending_pay"
	// OrderStatusPaidPendingProvision 已支付待发货（中态；PlaceOrderAndPay 入库值）。
	OrderStatusPaidPendingProvision = "paid_pending_provision"
	// OrderStatusProvisioned 已发货成功（终态）。
	OrderStatusProvisioned = "provisioned"
	// OrderStatusPaymentFailed 支付失败（终态，本期未直接写入；预留）。
	OrderStatusPaymentFailed = "payment_failed"
	// OrderStatusProvisionFailed 发货失败（终态，本期未直接写入；预留）。
	OrderStatusProvisionFailed = "provision_failed"
	// OrderStatusCancelled 已取消（终态，v1.7.32 引入）。
	OrderStatusCancelled = "cancelled"
)

// IsOrderTerminalStatus 判定 trade_order.status 是否处于终态。
//
// 终态集合：provisioned / payment_failed / provision_failed / cancelled。
// orderstatus.QueryStatus 用本函数实现 B1 短路：本地终态时直接返本地结果，绝不调 jifei。
func IsOrderTerminalStatus(status string) bool {
	switch status {
	case OrderStatusProvisioned,
		OrderStatusPaymentFailed,
		OrderStatusProvisionFailed,
		OrderStatusCancelled:
		return true
	}
	return false
}

// TradeOrder 是 trade_order 表的领域对象（与 §7.3.4 / migration 0001 列对齐）。
//
// 本期使用范围（迭代 5 checkCreate）：
//   - 读端 GetOrderByDealName 返回完整领域对象用于 §5.2 #3/#4 对账；
//   - 写端（CreateOrder / UpdateStatus / WriteResourceID）属于迭代 8 范围（PlaceOrder
//     入口落库 + createResource 反向回填），本文件只承载读端方法，写端在同包内追加。
//
// JSON 字段 GoodsDetail 在 DAO 层从 raw JSON 反序列化为 map（业务层对账时按 key 查值，
// 无需强类型 — 不同 bundle 的 sv_* / productInfo 字段集动态变化，强类型反而过度耦合）。
//
// OrderType（migration 0003 新增列）：订单生命周期类型，取值 'create' / 'renew' / 预留 'refund'。
// 与 trade_flow.flow_type（jifei 协议长事务流水类型，create_resource/isolate_resource/renew_resource
// 带 _resource 后缀）是不同维度的两个独立字段，详见 .tmp/trade-pass-renew-design.md §4.2。
type TradeOrder struct {
	ID             int64
	BigOrderID     string
	DealName       string
	ExternalUserID string
	Uin            string
	AppID          string
	SubProductCode string
	BundleID       string
	OrderType      string // R-A 新增：'create' / 'renew' / 预留 'refund'（与 jifei flow_type 不同维度）
	Period         int
	TimeUnit       string
	GoodsNum       int
	RegionID       int
	PayMode        int
	// GoodsDetail 是 jifei 协议层 goodsDetail 字段透传快照（设计稿 Q54 5维对账依据：
	// pid / sv_* / timeSpan / timeUnit / goodsNum，其中后三维通常与 Period/TimeUnit/GoodsNum
	// 重复存在 — handler 层按 jifei 入参字段名做对账时统一从 GoodsDetail 取值）。
	// 可能为 nil（trade_order.goods_detail 列允许 NULL；实际下单链路始终写非空快照）。
	GoodsDetail  map[string]interface{}
	PayURL       string
	Status       string
	ResourceType string
	ResourceID   string
	// Source（migration 000006 新增列）：订单来源枚举，取值 "jifei" / "dianshi"。
	// createResource handler 按本字段判定是否需要 INSERT trade_user_activity_participation（设计稿 §5.6.1 step 4）。
	Source string
	// ActivityID / ActID（migration 000008 新增列）：点石订单落下单时使用的活动大 ID / 商品大 ID。
	// 非点石订单为 0；placeOrderDianshi 用这两个字段支持 user+activity+bundle 的有效订单复用。
	ActivityID int64
	ActID      int64
	// v1.7.28 BUG-12 修复 (2026-05-21)：删除 ExpireTime 字段（trade 业务层从未拥有
	// "订单何时失效"的真源，列从 schema 删了，见 migration 0004）。
	CreatedTime time.Time
	UpdatedTime time.Time
}

// OrderStore 抽象 trade_order DAO 的读端接口（写端在迭代 8 追加）。
//
// 抽象成 interface 主要服务于上层 handler（迭代 5/6）做 mock 单测；生产路径直接
// 注入 *MySQLStore 即可（编译期断言保证两者契约一致）。
type OrderStore interface {
	// GetOrderByDealName 按 jifei dealName 反查 trade_order。
	//
	// 返回：
	//   - 命中 → (*TradeOrder, nil)
	//   - 表无记录 → (nil, ErrTradeOrderNotFound)
	//   - JSON 反序列化失败 → (nil, 包含上下文的 wrap 错误)
	//   - 其他 SQL 错误 → (nil, raw error wrap)
	//
	// v1.7.28 BUG-22 修订（2026-05-21）：createResource handler 已经通过 jifei
	// goodsDetail 透传机制脱离 trade_order 反查依赖，本方法在 handler 层仅作为
	// "幂等回放"的可选检查路径（命中即直接返历史 resource_id）；ErrTradeOrderNotFound
	// 不再阻塞主链路。GeneratePayURL 等其它读路径仍正常使用本方法。
	GetOrderByDealName(ctx context.Context, dealName string) (*TradeOrder, error)
}

// ReusableDianshiOrderStore 是点石下单幂等所需的可选订单读能力。
//
// 不并入 OrderStore 基础接口，避免牵连 checkCreate/createResource/orderstatus 等只需要
// GetOrderByDealName 的调用方和测试替身。生产 *MySQLStore 实现本接口；placeorder 点石
// 分支通过类型断言要求该能力存在。
type ReusableDianshiOrderStore interface {
	// FindReusableDianshiOrder 查找同 user+activity+bundle 在有效期内的点石中态订单。
	//
	// 返回：
	//   - 命中 → (*TradeOrder, nil)
	//   - 无可复用订单 → (nil, ErrTradeOrderNotFound)
	//   - DB 错误 / JSON 解码错误 → (nil, err)
	FindReusableDianshiOrder(ctx context.Context, externalUserID string, activityID int64, bundleID string, createdAfter time.Time) (*TradeOrder, error)
}

// 编译期断言 *MySQLStore 实现 OrderStore 接口。
var _ OrderStore = (*MySQLStore)(nil)
var _ ReusableDianshiOrderStore = (*MySQLStore)(nil)

// GetOrderByDealName 实现 OrderStore 接口。
//
// SQL：
//
//	SELECT <trade_order columns> FROM trade_order WHERE deal_name = ?
//
// deal_name 列 UNIQUE，命中至多 1 行；无命中返 ErrTradeOrderNotFound。
//
// order_type（R-A 新增）：migration 0003 后 NOT NULL DEFAULT 'create'，存量行为 'create'。
//
// expire_time（v1.7.28 BUG-12 修复）：列已被 migration 0004 删除（业务无真源），SELECT 不再读。
func (s *MySQLStore) GetOrderByDealName(ctx context.Context, dealName string) (*TradeOrder, error) {
	if s == nil || s.db == nil {
		return nil, fmt.Errorf("trade_order: store is nil")
	}
	const q = selectTradeOrderColumns + ` WHERE deal_name = ?`
	order, err := scanTradeOrder(s.db.QueryRowContext(ctx, q, dealName))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrTradeOrderNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("trade_order: query dealName=%s: %w", dealName, err)
	}
	return order, nil
}

// FindReusableDianshiOrder 实现 ReusableDianshiOrderStore 接口。
func (s *MySQLStore) FindReusableDianshiOrder(
	ctx context.Context,
	externalUserID string,
	activityID int64,
	bundleID string,
	createdAfter time.Time,
) (*TradeOrder, error) {
	if s == nil || s.db == nil {
		return nil, fmt.Errorf("trade_order: store is nil")
	}
	const q = selectTradeOrderColumns + `
		 WHERE external_user_id = ?
		   AND activity_id = ?
		   AND bundle_id = ?
		   AND source = ?
		   AND resource_type = 'pass'
		   AND (resource_id IS NULL OR resource_id = '')
		   AND status IN (?, ?, ?)
		   AND created_time >= ?
		 ORDER BY created_time DESC
		 LIMIT 1
	`
	order, err := scanTradeOrder(s.db.QueryRowContext(ctx, q,
		externalUserID,
		activityID,
		bundleID,
		OrderSourceDianshi,
		OrderStatusCreated,
		OrderStatusPendingPay,
		OrderStatusPaidPendingProvision,
		createdAfter,
	))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrTradeOrderNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("trade_order: query reusable dianshi externalUserID=%s activityID=%d bundleID=%s: %w",
			externalUserID, activityID, bundleID, err)
	}
	return order, nil
}

// ListDianshiOrders 查询点石来源订单，用于后台管理排障和重试。
func (s *MySQLStore) ListDianshiOrders(ctx context.Context, filter DianshiRecordFilter) ([]*TradeOrder, error) {
	if s == nil || s.db == nil {
		return nil, fmt.Errorf("trade_order: store is nil")
	}
	where, args := buildDianshiFilterWhere(filter, true)
	q := selectTradeOrderColumns + where + `
		 ORDER BY created_time DESC, id DESC
		 LIMIT ?
	`
	args = append(args, normalizedDianshiLimit(filter.Limit))
	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("trade_order: list dianshi: %w", err)
	}
	defer rows.Close()

	result := make([]*TradeOrder, 0)
	for rows.Next() {
		order, err := scanTradeOrder(rows)
		if err != nil {
			return nil, fmt.Errorf("trade_order: scan dianshi: %w", err)
		}
		result = append(result, order)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("trade_order: rows dianshi: %w", err)
	}
	return result, nil
}

// DeleteDianshiOrder 删除点石来源订单。限定 source='dianshi'，避免误删计费订单。
func (s *MySQLStore) DeleteDianshiOrder(ctx context.Context, dealName string) (int64, error) {
	if s == nil || s.db == nil {
		return 0, fmt.Errorf("trade_order: store is nil")
	}
	res, err := s.db.ExecContext(ctx,
		`DELETE FROM trade_order WHERE deal_name = ? AND source = ?`,
		dealName, OrderSourceDianshi,
	)
	if err != nil {
		return 0, fmt.Errorf("trade_order: delete dianshi dealName=%s: %w", dealName, err)
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("trade_order: delete rows affected: %w", err)
	}
	return affected, nil
}

const selectTradeOrderColumns = `
		SELECT id, big_order_id, deal_name, external_user_id, uin, app_id,
		       sub_product_code, bundle_id, order_type, period, time_unit, goods_num,
		       region_id, pay_mode, goods_detail, pay_url, status,
		       resource_type, resource_id, source, activity_id, act_id, created_time, updated_time
		  FROM trade_order
`

type rowScanner interface {
	Scan(dest ...interface{}) error
}

func scanTradeOrder(row rowScanner) (*TradeOrder, error) {
	var (
		id          int64
		bigOrderID  string
		dn          string
		extUID      string
		uin         string
		appID       string
		subProd     string
		bundleID    string
		orderType   string
		period      int
		timeUnit    string
		goodsNum    int
		regionID    int
		payMode     int
		goodsRaw    sql.NullString
		payURL      sql.NullString
		status      string
		resType     string
		resID       sql.NullString
		source      string
		activityID  int64
		actID       int64
		createdTime time.Time
		updatedTime time.Time
	)
	err := row.Scan(
		&id, &bigOrderID, &dn, &extUID, &uin, &appID,
		&subProd, &bundleID, &orderType, &period, &timeUnit, &goodsNum,
		&regionID, &payMode, &goodsRaw, &payURL, &status,
		&resType, &resID, &source, &activityID, &actID, &createdTime, &updatedTime,
	)
	if err != nil {
		return nil, err
	}

	order, err := decodeTradeOrder(decodeArgs{
		ID:             id,
		BigOrderID:     bigOrderID,
		DealName:       dn,
		ExternalUserID: extUID,
		Uin:            uin,
		AppID:          appID,
		SubProductCode: subProd,
		BundleID:       bundleID,
		OrderType:      orderType,
		Period:         period,
		TimeUnit:       timeUnit,
		GoodsNum:       goodsNum,
		RegionID:       regionID,
		PayMode:        payMode,
		GoodsDetailRaw: goodsRaw,
		PayURL:         payURL,
		Status:         status,
		ResourceType:   resType,
		ResourceID:     resID,
		Source:         source,
		ActivityID:     activityID,
		ActID:          actID,
		CreatedTime:    createdTime,
		UpdatedTime:    updatedTime,
	})
	if err != nil {
		return nil, err
	}
	return order, nil
}

// decodeArgs 是 decodeTradeOrder 的纯入参集合。
//
// 抽出独立 struct 让 decodeTradeOrder 测试不需要起 MySQL 实例（直接构造 decodeArgs
// 即可覆盖 JSON 反序列化的所有正反路径）。
type decodeArgs struct {
	ID                                               int64
	BigOrderID, DealName, ExternalUserID, Uin, AppID string
	SubProductCode, BundleID                         string
	OrderType                                        string
	Period                                           int
	TimeUnit                                         string
	GoodsNum, RegionID, PayMode                      int
	GoodsDetailRaw                                   sql.NullString
	PayURL                                           sql.NullString
	Status, ResourceType                             string
	ResourceID                                       sql.NullString
	Source                                           string
	ActivityID, ActID                                int64
	CreatedTime, UpdatedTime                         time.Time
}

// decodeTradeOrder 把 SQL 行扫描出来的字段装配成强类型 *TradeOrder。
func decodeTradeOrder(a decodeArgs) (*TradeOrder, error) {
	order := &TradeOrder{
		ID:             a.ID,
		BigOrderID:     a.BigOrderID,
		DealName:       a.DealName,
		ExternalUserID: a.ExternalUserID,
		Uin:            a.Uin,
		AppID:          a.AppID,
		SubProductCode: a.SubProductCode,
		BundleID:       a.BundleID,
		OrderType:      a.OrderType,
		Period:         a.Period,
		TimeUnit:       a.TimeUnit,
		GoodsNum:       a.GoodsNum,
		RegionID:       a.RegionID,
		PayMode:        a.PayMode,
		Status:         a.Status,
		ResourceType:   a.ResourceType,
		Source:         a.Source,
		ActivityID:     a.ActivityID,
		ActID:          a.ActID,
		CreatedTime:    a.CreatedTime,
		UpdatedTime:    a.UpdatedTime,
	}
	if a.GoodsDetailRaw.Valid && a.GoodsDetailRaw.String != "" {
		if err := json.Unmarshal([]byte(a.GoodsDetailRaw.String), &order.GoodsDetail); err != nil {
			return nil, fmt.Errorf("goods_detail unmarshal: %w", err)
		}
	}
	if a.PayURL.Valid {
		order.PayURL = a.PayURL.String
	}
	if a.ResourceID.Valid {
		order.ResourceID = a.ResourceID.String
	}
	return order, nil
}
