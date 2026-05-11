package store

import (
	"database/sql"
	"errors"
	"testing"
	"time"
)

// TestDecodeTradeOrder_HappyPath 覆盖完整字段（含 JSON goods_detail）解码正确。
func TestDecodeTradeOrder_HappyPath(t *testing.T) {
	now := time.Date(2026, 5, 9, 11, 0, 0, 0, time.UTC)
	args := decodeArgs{
		ID:             123,
		BigOrderID:     "big-001",
		DealName:       "deal-001",
		ExternalUserID: "user-001",
		Uin:            "100012345678",
		AppID:          "12345678",
		SubProductCode: "sp_lighthouse_bundle_linux_small",
		BundleID:       "bundle_linux_small_01",
		Period:         1,
		TimeUnit:       "m",
		GoodsNum:       1,
		RegionID:       47,
		PayMode:        1,
		GoodsDetailRaw: sql.NullString{
			String: `{"pid":"40000","timeSpan":1,"timeUnit":"m","goodsNum":1,"sv_cpu":"2","sv_mem":"4G"}`,
			Valid:  true,
		},
		PayURL:       sql.NullString{String: "https://buy.example/pay/abc", Valid: true},
		Status:       "pending_pay",
		ResourceType: "pass",
		ResourceID:   sql.NullString{Valid: false},
		ExpireTime:   now.Add(30 * time.Minute),
		CreatedTime:  now,
		UpdatedTime:  now,
	}
	got, err := decodeTradeOrder(args)
	if err != nil {
		t.Fatalf("decodeTradeOrder error: %v", err)
	}
	if got.ID != 123 || got.DealName != "deal-001" || got.PayMode != 1 || got.Period != 1 || got.TimeUnit != "m" {
		t.Fatalf("scalar fields mismatch: %+v", got)
	}
	if got.PayURL != "https://buy.example/pay/abc" {
		t.Fatalf("expected PayURL filled, got %q", got.PayURL)
	}
	if got.ResourceID != "" {
		t.Fatalf("expected empty ResourceID for null column, got %q", got.ResourceID)
	}
	if got.GoodsDetail["pid"] != "40000" {
		t.Fatalf("goods_detail pid mismatch: %+v", got.GoodsDetail)
	}
	if got.GoodsDetail["sv_cpu"] != "2" {
		t.Fatalf("goods_detail sv_cpu mismatch: %+v", got.GoodsDetail)
	}
	// timeSpan / goodsNum 在 JSON 里是 number，反序列化到 interface{} 是 float64
	if v, ok := got.GoodsDetail["goodsNum"].(float64); !ok || v != 1 {
		t.Fatalf("goods_detail goodsNum mismatch: %+v", got.GoodsDetail)
	}
}

// TestDecodeTradeOrder_NullGoodsDetail 覆盖 goods_detail 列为 NULL（不写入快照）。
//
// 设计稿允许 goods_detail 列 DEFAULT NULL；实际下单流程在迭代 8 入表时一定会写非空，
// 但读端 DAO 必须能容错 NULL 列（避免历史脏数据 / 手工修复时阻塞读路径）。
func TestDecodeTradeOrder_NullGoodsDetail(t *testing.T) {
	args := decodeArgs{
		DealName:       "deal-002",
		GoodsDetailRaw: sql.NullString{Valid: false},
		Status:         "created",
	}
	got, err := decodeTradeOrder(args)
	if err != nil {
		t.Fatalf("decodeTradeOrder error: %v", err)
	}
	if got.GoodsDetail != nil {
		t.Fatalf("expected nil GoodsDetail for NULL column, got %+v", got.GoodsDetail)
	}
}

// TestDecodeTradeOrder_EmptyStringGoodsDetail 覆盖 goods_detail 列是空字符串（不是 NULL）。
//
// 与 NULL 行为一致：不解码、不报错、保留 nil GoodsDetail。
func TestDecodeTradeOrder_EmptyStringGoodsDetail(t *testing.T) {
	args := decodeArgs{
		DealName:       "deal-003",
		GoodsDetailRaw: sql.NullString{String: "", Valid: true},
	}
	got, err := decodeTradeOrder(args)
	if err != nil {
		t.Fatalf("decodeTradeOrder error: %v", err)
	}
	if got.GoodsDetail != nil {
		t.Fatalf("expected nil GoodsDetail for empty string, got %+v", got.GoodsDetail)
	}
}

// TestDecodeTradeOrder_InvalidJSON 覆盖 goods_detail 列是非法 JSON 时报错。
func TestDecodeTradeOrder_InvalidJSON(t *testing.T) {
	args := decodeArgs{
		DealName:       "deal-004",
		GoodsDetailRaw: sql.NullString{String: `{not-a-json`, Valid: true},
	}
	_, err := decodeTradeOrder(args)
	if err == nil {
		t.Fatalf("expected error for invalid JSON, got nil")
	}
}

// TestErrTradeOrderNotFound_Sentinel 验证哨兵错误可被 errors.Is 识别。
//
// 上层（迭代 5 handler）必须能用 errors.Is 区分 not_found vs 其他 SQL 错，
// 这是 DAO 契约的关键 — 哨兵不能被未来重构改成其它形状。
func TestErrTradeOrderNotFound_Sentinel(t *testing.T) {
	wrapped := errors.Join(ErrTradeOrderNotFound, errors.New("inner"))
	if !errors.Is(wrapped, ErrTradeOrderNotFound) {
		t.Fatalf("errors.Is must recognize ErrTradeOrderNotFound through errors.Join")
	}
}
