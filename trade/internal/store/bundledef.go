package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
)

// ErrBundleDefinitionNotFound 是 trade_bundle_definition 表查无记录的哨兵错误。
//
// 用于上层适配层 errors.Is 判定后转译为业务层 4xx `BUNDLE_DEFINITION_NOT_FOUND`
// （设计稿 §4.2.1 `Step T2.5` / §3.5.5 (3)）。
var ErrBundleDefinitionNotFound = errors.New("trade_bundle_definition: not found")

// BundleDefinition 是 trade_bundle_definition 表的领域对象（与 §7.3.6 / migration 0001 列对齐）。
//
// JSON 字段（CategoryIDs / SVList / ProductInfo）在 DAO 层从 raw JSON 反序列化，业务层
// 直接拿到强类型形式。
type BundleDefinition struct {
	ID             int64
	BundleID       string
	ProductCode    string
	SubProductCode string
	Pid            string
	// CategoryIDs 是 [{"scene":"purchase","category":"100059"}, ...] 多场景列表（Q40）。
	CategoryIDs []CategoryIDEntry
	// SVList 是 jifei 询价 / 下单时展平为 goodsDetail.sv_* 的 key/value map（运营录入 key 不带 sv_ 前缀）。
	// 空对象 {} 合法 — 表示该 bundle 不需要 sv_* 字段（设计稿 §3.5.5 (4)）。
	SVList map[string]interface{}
	// ProductInfo 是直接透传到 jifei goodsDetail.productInfo 的 JSON 数组。
	ProductInfo []map[string]interface{}
}

// CategoryIDEntry 是 CategoryIDs 数组的单条记录（按场景 scene 区分新购/续费/变配）。
type CategoryIDEntry struct {
	Scene    string `json:"scene"`    // "purchase" / "renew" / "modify"
	Category string `json:"category"` // jifei goodsCategoryId
}

// CategoryIDForScene 返回 CategoryIDs 中匹配 scene 的 Category 字符串；不存在返 ""。
//
// 适配层在询价 / 下单时按 scene = "purchase" 取 — 本期只用 purchase 场景，与 Q49
// （续费 / 变配 / 退款 推迟到生命周期子需求）协同。
func (d *BundleDefinition) CategoryIDForScene(scene string) string {
	if d == nil {
		return ""
	}
	for _, e := range d.CategoryIDs {
		if e.Scene == scene {
			return e.Category
		}
	}
	return ""
}

// BundleDefinitionStore 抽象 bundledef DAO 接口，便于适配层 mock。
type BundleDefinitionStore interface {
	// GetBundleDefinitionByID 反查 trade_bundle_definition 表。
	//
	// 返回：
	//   - 命中 → (*BundleDefinition, nil)
	//   - 表无记录 → (nil, ErrBundleDefinitionNotFound)
	//   - JSON 反序列化失败 → (nil, 包含上下文的 wrap 错误)
	//   - 其他 SQL 错误 → (nil, raw error wrap)
	GetBundleDefinitionByID(ctx context.Context, bundleID string) (*BundleDefinition, error)
}

// 编译期断言 *MySQLStore 实现 BundleDefinitionStore 接口。
var _ BundleDefinitionStore = (*MySQLStore)(nil)

// GetBundleDefinitionByID 实现 BundleDefinitionStore 接口。
//
// SQL：
//
//	SELECT id, bundle_id, product_code, sub_product_code, pid,
//	       category_ids, sv_list, product_info
//	  FROM trade_bundle_definition
//	 WHERE bundle_id = ?
func (s *MySQLStore) GetBundleDefinitionByID(ctx context.Context, bundleID string) (*BundleDefinition, error) {
	if s == nil || s.db == nil {
		return nil, fmt.Errorf("trade_bundle_definition: store is nil")
	}
	const q = `
		SELECT id, bundle_id, product_code, sub_product_code, pid,
		       category_ids, sv_list, product_info
		  FROM trade_bundle_definition
		 WHERE bundle_id = ?
	`
	var (
		id                                    int64
		bID, prodCode, subProdCode, pid       string
		categoryRaw, svRaw, productInfoRaw    []byte
	)
	err := s.db.QueryRowContext(ctx, q, bundleID).Scan(
		&id, &bID, &prodCode, &subProdCode, &pid,
		&categoryRaw, &svRaw, &productInfoRaw,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrBundleDefinitionNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("trade_bundle_definition: query bundleID=%s: %w", bundleID, err)
	}

	def, err := decodeBundleDefinition(id, bID, prodCode, subProdCode, pid, categoryRaw, svRaw, productInfoRaw)
	if err != nil {
		return nil, fmt.Errorf("trade_bundle_definition: decode bundleID=%s: %w", bundleID, err)
	}
	return def, nil
}

// decodeBundleDefinition 把 SQL 行扫描出来的字段反序列化成强类型 *BundleDefinition。
//
// 抽出独立函数便于测试（不需要起 MySQL 实例）。
func decodeBundleDefinition(
	id int64,
	bID, prodCode, subProdCode, pid string,
	categoryRaw, svRaw, productInfoRaw []byte,
) (*BundleDefinition, error) {
	def := &BundleDefinition{
		ID:             id,
		BundleID:       bID,
		ProductCode:    prodCode,
		SubProductCode: subProdCode,
		Pid:            pid,
	}
	if len(categoryRaw) > 0 {
		if err := json.Unmarshal(categoryRaw, &def.CategoryIDs); err != nil {
			return nil, fmt.Errorf("category_ids unmarshal: %w", err)
		}
	}
	if len(svRaw) > 0 {
		if err := json.Unmarshal(svRaw, &def.SVList); err != nil {
			return nil, fmt.Errorf("sv_list unmarshal: %w", err)
		}
	}
	if len(productInfoRaw) > 0 {
		if err := json.Unmarshal(productInfoRaw, &def.ProductInfo); err != nil {
			return nil, fmt.Errorf("product_info unmarshal: %w", err)
		}
	}
	return def, nil
}
