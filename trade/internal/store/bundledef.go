package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
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
//
// 协议层类型契约（Q71 拍板 2026-05-13，与 jifei 询价 PDF §4.1/§4.4 严格对齐）：
//   - Pid          int64    （PDF §4.4 line 26/34 示例 `"pid": 1000000`）
//   - SVList value int64    （PDF §4.4 line 30/38 `"sv_cvm_cpu_s1": 1`、§4.4.1.1.2 line 23 `"sv_cbs_memspace_premium": 60`）
//   - Category     int64    （PDF §4.1 line 14 `"goodsCategoryId": 100019`）
// trade 不再对这些字段做 stringify，5 处 buildGoodsDetail 直接透传 int64。
type BundleDefinition struct {
	ID             int64
	BundleID       string
	ProductCode    string
	SubProductCode string
	// Pid 是 jifei 协议层 pid。Q71 拍板：int 不是 string。
	Pid int64
	// CategoryIDs 是 [{"scene":"purchase","category":100059}, ...] 多场景列表（Q40 + Q71）。
	CategoryIDs []CategoryIDEntry
	// SVList 是 jifei 询价 / 下单时直接透传到 goodsDetail.sv_* 的 key/value map。
	// **key 必须已带 sv_ 前缀**（Q70 + 与 jifei 协议层 SV ID 一致）；
	// **value 是 int64**（Q71 + PDF §4.4 / §4.4.1.1.2 sv_* 字段示例为裸数字）。
	// 空对象 {} 合法 — 表示该 bundle 不需要 sv_* 字段（设计稿 §3.5.5 (4)）。
	SVList map[string]int64
	// ProductInfo 是直接透传到 jifei goodsDetail.productInfo 的 JSON 数组。
	ProductInfo []map[string]interface{}
}

// CategoryIDEntry 是 CategoryIDs 数组的单条记录（按场景 scene 区分新购/续费/变配）。
type CategoryIDEntry struct {
	Scene    string `json:"scene"`    // "purchase" / "renew" / "modify"
	Category int64  `json:"category"` // jifei goodsCategoryId（Q71 拍板：int 不是 string，PDF §4.1）
}

// CategoryIDForScene 返回 CategoryIDs 中匹配 scene 的 Category int；不存在返 0。
//
// 适配层在询价 / 下单时按 scene = "purchase" 取 — 本期只用 purchase 场景，与 Q49
// （续费 / 变配 / 退款 推迟到生命周期子需求）协同。
//
// Q71 拍板（2026-05-13）：返回类型从 string 改 int64，与 jifei 协议层 PDF §4.1 一致。
// 调用方需要展示用 string 时自行 strconv.FormatInt 转换；判断"未配置"用 == 0 取代原 == ""。
func (d *BundleDefinition) CategoryIDForScene(scene string) int64 {
	if d == nil {
		return 0
	}
	for _, e := range d.CategoryIDs {
		if e.Scene == scene {
			return e.Category
		}
	}
	return 0
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

	// ListBundleDefsBySubProductCode 按 (productCode, subProductCode) 反查
	// trade_bundle_definition 列表（trade-resource-query-design §3.2 / §4 / §11 Q2 拍板）。
	//
	// 用途：jifei 资源反查链路 getAllAppIds / getUserResources 在 subProductCode
	// 非空时，把 subProductCode 解析为同 sub 维度下的 bundle_ids 列表，
	// 转交 ctl 做 pass 反查（设计稿 §3.2 反查链路 step 3）。
	//
	// 入参：
	//   - productCode：trade 域内固定 "p_lighthouse"（§11 Q1）。SQL 用作复合条件防御，
	//     避免运营误录其他 product_code 的 bundle 被错查；调用方负责校验非空。
	//   - subProductCode：必填，非空；对应表 idx_sub_product 索引。
	//
	// 返回：
	//   - 命中 → ([]*BundleDefinition, nil)，按 bundle_id ASC 稳定排序
	//   - 无记录 → ([]*BundleDefinition{}, nil)（**不返 ErrBundleDefinitionNotFound**，
	//     与 GetBundleDefinitionByID 不同 —— 列表查询"空"是合法业务语义，
	//     trade handler 应据此返回 jifei 响应的空 appIds / 空 resources，而非报错）
	//   - JSON 反序列化失败 → (nil, 包含上下文的 wrap 错误)
	//   - 其他 SQL 错误 → (nil, raw error wrap)
	//
	// 性能：命中 idx_sub_product (sub_product_code) 索引；
	// 当前预期同 sub 下 bundle 数量级 < 100，不做分页。
	ListBundleDefsBySubProductCode(
		ctx context.Context,
		productCode, subProductCode string,
	) ([]*BundleDefinition, error)

	// GetBundleDefinitionsByIDs 按 bundle_id 集合批量反查 trade_bundle_definition 表。
	//
	// 用途：trade 资源反查链路（设计稿 §3.2）的 getUserResources / queryResource
	// handler 在 page 内拿到一批 pass 后，需要对每条 pass.BundleID 反查
	// BundleDefinition 拼装 goodsDetail。当前 page_size 默认 1000，单条 GetBundleDefinitionByID
	// 会触发 N+1；本方法改为一条 `WHERE bundle_id IN (?,...)` SQL 批量返回。
	//
	// 入参：
	//   - bundleIDs：去重后的 bundle_id 列表；调用方应在 helper 层 dedup 避免 IN(...) 含重复值。
	//
	// 行为：
	//   - 入参 nil 或空切片 → (map[string]*BundleDefinition{}, nil)，不打 SQL。
	//   - 入参非空 → 一条 SQL 批量查；返回 map[bundleID]*BundleDefinition 强类型结果。
	//   - **bundle 不存在** → 不在结果 map 中（调用方据 `m[id] == nil` 走 graceful-degrade
	//     退化逻辑，与单条 GetBundleDefinitionByID 返回 ErrBundleDefinitionNotFound
	//     的语义等价；批量场景"部分缺失"是合法业务输入，不再用哨兵 error）。
	//   - DB 错误 / JSON 反序列化失败 → (nil, wrap error)，整批失败让上层判定上游不可用。
	GetBundleDefinitionsByIDs(
		ctx context.Context,
		bundleIDs []string,
	) (map[string]*BundleDefinition, error)
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
		bID, prodCode, subProdCode            string
		pid                                   int64
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
//
// Q71 拍板（2026-05-13）：pid 类型从 string 改 int64（DB 列 BIGINT，与 jifei PDF §4.4 一致）。
func decodeBundleDefinition(
	id int64,
	bID, prodCode, subProdCode string,
	pid int64,
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

// ListBundleDefsBySubProductCode 实现 BundleDefinitionStore 接口。
//
// SQL：
//
//	SELECT id, bundle_id, product_code, sub_product_code, pid,
//	       category_ids, sv_list, product_info
//	  FROM trade_bundle_definition
//	 WHERE sub_product_code = ?
//	   AND product_code     = ?
//	 ORDER BY bundle_id ASC
//
// 索引：命中 KEY idx_sub_product (sub_product_code)；product_code
// 在 WHERE 中作为复合过滤条件，但**不放在 ORDER BY 前**避免索引使用不当。
//
// 排序：按 bundle_id ASC 稳定排序，使分页 / 反查 / 单测断言行为可预测。
func (s *MySQLStore) ListBundleDefsBySubProductCode(
	ctx context.Context,
	productCode, subProductCode string,
) ([]*BundleDefinition, error) {
	if s == nil || s.db == nil {
		return nil, fmt.Errorf("trade_bundle_definition: store is nil")
	}
	if subProductCode == "" {
		return nil, fmt.Errorf("trade_bundle_definition: subProductCode is required")
	}
	if productCode == "" {
		return nil, fmt.Errorf("trade_bundle_definition: productCode is required")
	}

	const q = `
		SELECT id, bundle_id, product_code, sub_product_code, pid,
		       category_ids, sv_list, product_info
		  FROM trade_bundle_definition
		 WHERE sub_product_code = ?
		   AND product_code     = ?
		 ORDER BY bundle_id ASC
	`
	rows, err := s.db.QueryContext(ctx, q, subProductCode, productCode)
	if err != nil {
		return nil, fmt.Errorf(
			"trade_bundle_definition: query subProductCode=%s productCode=%s: %w",
			subProductCode, productCode, err,
		)
	}
	defer rows.Close()

	defs := make([]*BundleDefinition, 0)
	for rows.Next() {
		var (
			id                                 int64
			bID, prodCode, subProdCode         string
			pid                                int64
			categoryRaw, svRaw, productInfoRaw []byte
		)
		if err := rows.Scan(
			&id, &bID, &prodCode, &subProdCode, &pid,
			&categoryRaw, &svRaw, &productInfoRaw,
		); err != nil {
			return nil, fmt.Errorf(
				"trade_bundle_definition: scan row subProductCode=%s: %w",
				subProductCode, err,
			)
		}
		def, err := decodeBundleDefinition(id, bID, prodCode, subProdCode, pid, categoryRaw, svRaw, productInfoRaw)
		if err != nil {
			return nil, fmt.Errorf(
				"trade_bundle_definition: decode bundleID=%s subProductCode=%s: %w",
				bID, subProductCode, err,
			)
		}
		defs = append(defs, def)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf(
			"trade_bundle_definition: iterate rows subProductCode=%s: %w",
			subProductCode, err,
		)
	}
	return defs, nil
}

// GetBundleDefinitionsByIDs 实现 BundleDefinitionStore 接口（批量反查）。
//
// SQL：
//
//	SELECT id, bundle_id, product_code, sub_product_code, pid,
//	       category_ids, sv_list, product_info
//	  FROM trade_bundle_definition
//	 WHERE bundle_id IN (?,?,...)
//
// 安全性：占位符 `?` 由代码按 len(bundleIDs) 拼出 `?,?,?` 串，真实 bundleID 值通过
// args... 走标准库 database/sql 参数化绑定，0 SQL 注入风险（符合 security_rules
// "Handling Dynamic Table/Column Names" 类外的常规参数化模式）。
//
// 性能：命中 PRIMARY KEY (bundle_id)；page 内去重后 bundleID 通常 1-10 个，
// 一条 IN 查询替代原 N 次单条 RPC。
//
// 返回 map：
//   - 命中 → m[bundleID] = *BundleDefinition
//   - 缺失 → key 不在 map 中（调用方按 m[id]==nil 走 graceful-degrade）
func (s *MySQLStore) GetBundleDefinitionsByIDs(
	ctx context.Context,
	bundleIDs []string,
) (map[string]*BundleDefinition, error) {
	if s == nil || s.db == nil {
		return nil, fmt.Errorf("trade_bundle_definition: store is nil")
	}
	if len(bundleIDs) == 0 {
		return map[string]*BundleDefinition{}, nil
	}

	// 拼占位符 "?,?,?"（数量 = len(bundleIDs)）
	placeholders := strings.Repeat("?,", len(bundleIDs))
	placeholders = placeholders[:len(placeholders)-1]

	// 真值通过 args 参数化绑定
	args := make([]any, len(bundleIDs))
	for i, id := range bundleIDs {
		args[i] = id
	}

	q := fmt.Sprintf(`
		SELECT id, bundle_id, product_code, sub_product_code, pid,
		       category_ids, sv_list, product_info
		  FROM trade_bundle_definition
		 WHERE bundle_id IN (%s)
	`, placeholders)

	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf(
			"trade_bundle_definition: batch query bundleIDs len=%d: %w",
			len(bundleIDs), err,
		)
	}
	defer rows.Close()

	result := make(map[string]*BundleDefinition, len(bundleIDs))
	for rows.Next() {
		var (
			id                                 int64
			bID, prodCode, subProdCode         string
			pid                                int64
			categoryRaw, svRaw, productInfoRaw []byte
		)
		if err := rows.Scan(
			&id, &bID, &prodCode, &subProdCode, &pid,
			&categoryRaw, &svRaw, &productInfoRaw,
		); err != nil {
			return nil, fmt.Errorf(
				"trade_bundle_definition: scan row in batch: %w", err,
			)
		}
		def, err := decodeBundleDefinition(id, bID, prodCode, subProdCode, pid, categoryRaw, svRaw, productInfoRaw)
		if err != nil {
			return nil, fmt.Errorf(
				"trade_bundle_definition: decode bundleID=%s in batch: %w",
				bID, err,
			)
		}
		result[bID] = def
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf(
			"trade_bundle_definition: iterate rows in batch: %w", err,
		)
	}
	return result, nil
}
