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

// TradeOrder 是 trade_order 表的领域对象（与 §7.3.4 / migration 0001 列对齐）。
//
// 本期使用范围（迭代 5 checkCreate）：
//   - 读端 GetOrderByDealName 返回完整领域对象用于 §5.2 #3/#4 对账；
//   - 写端（CreateOrder / UpdateStatus / WriteResourceID）属于迭代 8 范围（PlaceOrder
//     入口落库 + createResource 反向回填），本文件只承载读端方法，写端在同包内追加。
//
// JSON 字段 GoodsDetail 在 DAO 层从 raw JSON 反序列化为 map（业务层对账时按 key 查值，
// 无需强类型 — 不同 bundle 的 sv_* / productInfo 字段集动态变化，强类型反而过度耦合）。
type TradeOrder struct {
	ID             int64
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
	// GoodsDetail 是 jifei 协议层 goodsDetail 字段透传快照（设计稿 Q54 5维对账依据：
	// pid / sv_* / timeSpan / timeUnit / goodsNum，其中后三维通常与 Period/TimeUnit/GoodsNum
	// 重复存在 — handler 层按 jifei 入参字段名做对账时统一从 GoodsDetail 取值）。
	// 可能为 nil（trade_order.goods_detail 列允许 NULL；实际下单链路始终写非空快照）。
	GoodsDetail map[string]interface{}
	PayURL      string
	Status      string
	ResourceType string
	ResourceID   string
	ExpireTime   time.Time
	CreatedTime  time.Time
	UpdatedTime  time.Time
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
	GetOrderByDealName(ctx context.Context, dealName string) (*TradeOrder, error)
}

// 编译期断言 *MySQLStore 实现 OrderStore 接口。
var _ OrderStore = (*MySQLStore)(nil)

// GetOrderByDealName 实现 OrderStore 接口。
//
// SQL：
//
//	SELECT id, big_order_id, deal_name, external_user_id, uin, app_id,
//	       sub_product_code, bundle_id, period, time_unit, goods_num,
//	       region_id, pay_mode, goods_detail, pay_url, status,
//	       resource_type, resource_id, expire_time, created_time, updated_time
//	  FROM trade_order
//	 WHERE deal_name = ?
//
// deal_name 列 UNIQUE，命中至多 1 行；无命中返 ErrTradeOrderNotFound。
func (s *MySQLStore) GetOrderByDealName(ctx context.Context, dealName string) (*TradeOrder, error) {
	if s == nil || s.db == nil {
		return nil, fmt.Errorf("trade_order: store is nil")
	}
	const q = `
		SELECT id, big_order_id, deal_name, external_user_id, uin, app_id,
		       sub_product_code, bundle_id, period, time_unit, goods_num,
		       region_id, pay_mode, goods_detail, pay_url, status,
		       resource_type, resource_id, expire_time, created_time, updated_time
		  FROM trade_order
		 WHERE deal_name = ?
	`
	var (
		id          int64
		bigOrderID  string
		dn          string
		extUID      string
		uin         string
		appID       string
		subProd     string
		bundleID    string
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
		expireTime  time.Time
		createdTime time.Time
		updatedTime time.Time
	)
	err := s.db.QueryRowContext(ctx, q, dealName).Scan(
		&id, &bigOrderID, &dn, &extUID, &uin, &appID,
		&subProd, &bundleID, &period, &timeUnit, &goodsNum,
		&regionID, &payMode, &goodsRaw, &payURL, &status,
		&resType, &resID, &expireTime, &createdTime, &updatedTime,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrTradeOrderNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("trade_order: query dealName=%s: %w", dealName, err)
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
		ExpireTime:     expireTime,
		CreatedTime:    createdTime,
		UpdatedTime:    updatedTime,
	})
	if err != nil {
		return nil, fmt.Errorf("trade_order: decode dealName=%s: %w", dealName, err)
	}
	return order, nil
}

// decodeArgs 是 decodeTradeOrder 的纯入参集合。
//
// 抽出独立 struct 让 decodeTradeOrder 测试不需要起 MySQL 实例（直接构造 decodeArgs
// 即可覆盖 JSON 反序列化的所有正反路径）。
type decodeArgs struct {
	ID                                                                 int64
	BigOrderID, DealName, ExternalUserID, Uin, AppID                   string
	SubProductCode, BundleID                                           string
	Period                                                             int
	TimeUnit                                                           string
	GoodsNum, RegionID, PayMode                                        int
	GoodsDetailRaw                                                     sql.NullString
	PayURL                                                             sql.NullString
	Status, ResourceType                                               string
	ResourceID                                                         sql.NullString
	ExpireTime, CreatedTime, UpdatedTime                               time.Time
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
		Period:         a.Period,
		TimeUnit:       a.TimeUnit,
		GoodsNum:       a.GoodsNum,
		RegionID:       a.RegionID,
		PayMode:        a.PayMode,
		Status:         a.Status,
		ResourceType:   a.ResourceType,
		ExpireTime:     a.ExpireTime,
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
