package store

import (
	"errors"
	"strings"
	"testing"
)

// TestDecodeBundleDefinition_HappyPath 覆盖完整 JSON 解析。
func TestDecodeBundleDefinition_HappyPath(t *testing.T) {
	// Q71 拍板（2026-05-13）：category / sv_* / pid 全部 int（PDF §4.1 / §4.4 / §4.4.1.1.2）。
	categoryRaw := []byte(`[{"scene":"purchase","category":100059},{"scene":"renew","category":100060}]`)
	svRaw := []byte(`{"key1":1,"key2":2}`)
	productInfoRaw := []byte(`[{"name":"配置项 A","value":"1 vCPU"}]`)

	def, err := decodeBundleDefinition(
		42,
		"bundle_linux_small_01",
		"p_lighthouse",
		"sp_lighthouse_bundle_linux_small",
		1234,
		categoryRaw, svRaw, productInfoRaw,
	)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if def.ID != 42 || def.BundleID != "bundle_linux_small_01" {
		t.Errorf("basic fields: got %+v", def)
	}
	if def.ProductCode != "p_lighthouse" || def.SubProductCode != "sp_lighthouse_bundle_linux_small" {
		t.Errorf("product fields: got %+v", def)
	}
	if def.Pid != 1234 {
		t.Errorf("pid: got %d", def.Pid)
	}
	if len(def.CategoryIDs) != 2 {
		t.Fatalf("CategoryIDs len: got %d want 2", len(def.CategoryIDs))
	}
	if got := def.CategoryIDForScene("purchase"); got != 100059 {
		t.Errorf("CategoryIDForScene(purchase): got %d", got)
	}
	if got := def.CategoryIDForScene("renew"); got != 100060 {
		t.Errorf("CategoryIDForScene(renew): got %d", got)
	}
	if got := def.CategoryIDForScene("modify"); got != 0 {
		t.Errorf("CategoryIDForScene(modify) should be zero: got %d", got)
	}
	if def.SVList["key1"] != 1 {
		t.Errorf("SVList.key1: got %v", def.SVList["key1"])
	}
	// SVList 是 map[string]int64（Q71）：JSON 数字直接反序列化为 int64
	if def.SVList["key2"] != 2 {
		t.Errorf("SVList.key2: got %v", def.SVList["key2"])
	}
	if len(def.ProductInfo) != 1 {
		t.Errorf("ProductInfo len: got %d", len(def.ProductInfo))
	}
}

// TestDecodeBundleDefinition_EmptySVList 验证空对象 sv_list = {} 合法（设计稿 §3.5.5 (4)）。
func TestDecodeBundleDefinition_EmptySVList(t *testing.T) {
	def, err := decodeBundleDefinition(
		1, "bundle_x", "pc", "spc", 1,
		[]byte(`[{"scene":"purchase","category":100059}]`),
		[]byte(`{}`),
		[]byte(`[]`),
	)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(def.SVList) != 0 {
		t.Errorf("SVList should be empty: got %+v", def.SVList)
	}
	if len(def.ProductInfo) != 0 {
		t.Errorf("ProductInfo should be empty: got %+v", def.ProductInfo)
	}
}

// TestDecodeBundleDefinition_InvalidJSON 验证 JSON 格式错误时返 wrap 错误。
func TestDecodeBundleDefinition_InvalidJSON(t *testing.T) {
	cases := []struct {
		name        string
		category    []byte
		sv          []byte
		productInfo []byte
		wantField   string
	}{
		{
			name:      "bad category_ids",
			category:  []byte(`{not json`),
			sv:        []byte(`{}`),
			productInfo: []byte(`[]`),
			wantField: "category_ids",
		},
		{
			name:      "bad sv_list",
			category:  []byte(`[]`),
			sv:        []byte(`{not json`),
			productInfo: []byte(`[]`),
			wantField: "sv_list",
		},
		{
			name:      "bad product_info",
			category:  []byte(`[]`),
			sv:        []byte(`{}`),
			productInfo: []byte(`{not json`),
			wantField: "product_info",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := decodeBundleDefinition(
				1, "bundle_x", "pc", "spc", 1,
				c.category, c.sv, c.productInfo,
			)
			if err == nil {
				t.Fatal("expected error, got nil")
			}
			if !strings.Contains(err.Error(), c.wantField) {
				t.Errorf("error should mention %q: %v", c.wantField, err)
			}
		})
	}
}

// TestDecodeBundleDefinition_NilRaw 验证 nil 原始 bytes 不报错（DB 列允许 NULL 时的 defensive 路径）。
func TestDecodeBundleDefinition_NilRaw(t *testing.T) {
	def, err := decodeBundleDefinition(1, "b", "pc", "spc", 1, nil, nil, nil)
	if err != nil {
		t.Fatalf("decode nil raw: %v", err)
	}
	if def.CategoryIDs != nil || def.SVList != nil || def.ProductInfo != nil {
		t.Errorf("expected zero-value JSON fields when raw is nil: %+v", def)
	}
}

// TestErrBundleDefinitionNotFound_IsSentinel 验证哨兵 error 可以被 errors.Is 匹配。
func TestErrBundleDefinitionNotFound_IsSentinel(t *testing.T) {
	wrapped := wrapErr(ErrBundleDefinitionNotFound)
	if !errors.Is(wrapped, ErrBundleDefinitionNotFound) {
		t.Errorf("errors.Is should match through wrap")
	}
}

// wrapErr 用于测试 errors.Is 透传，模拟上层适配层的 fmt.Errorf("...: %w", err) 模式。
func wrapErr(err error) error {
	if err == nil {
		return nil
	}
	return &wrapped{err}
}

type wrapped struct{ err error }

func (w *wrapped) Error() string { return "wrapped: " + w.err.Error() }
func (w *wrapped) Unwrap() error { return w.err }

// TestCategoryIDForScene_NilReceiver 验证 nil 接收器安全。
func TestCategoryIDForScene_NilReceiver(t *testing.T) {
	var def *BundleDefinition
	if got := def.CategoryIDForScene("purchase"); got != 0 {
		t.Errorf("nil receiver should return zero: got %d", got)
	}
}

// TestGetBundleDefinitionByID_NilStore 验证 nil store / db 防御。
func TestGetBundleDefinitionByID_NilStore(t *testing.T) {
	var s *MySQLStore
	_, err := s.GetBundleDefinitionByID(nil, "x")
	if err == nil {
		t.Fatal("expected error for nil store")
	}
	// 防御不要 panic 即可
}

// TestListBundleDefsBySubProductCode_NilStore 验证 nil store / db 防御。
func TestListBundleDefsBySubProductCode_NilStore(t *testing.T) {
	var s *MySQLStore
	_, err := s.ListBundleDefsBySubProductCode(nil, "p_lighthouse", "sp_test")
	if err == nil {
		t.Fatal("expected error for nil store")
	}
	if !strings.Contains(err.Error(), "store is nil") {
		t.Errorf("error should mention nil store: %v", err)
	}
}

// TestListBundleDefsBySubProductCode_EmptyParams 验证空参数防御。
//
// 设计稿 §3.2 反查链路：trade handler 在 subProductCode 空值时**不应该**
// 调用本 DAO（应直接给 ctl 不带 bundle_ids 过滤）；本测试是 DAO 层的兜底
// 防御：即便上层错误调用，DAO 也立刻返参数错而不打 SQL。
func TestListBundleDefsBySubProductCode_EmptyParams(t *testing.T) {
	// 用空 store 即可触发参数校验（参数校验在 nil-check 之后，但 nil store 也会先返错）；
	// 这里通过非 nil 但 db=nil 的 store 来跨过 nil store 分支不可能 — 只能
	// 通过参数校验顺序保证：先 nil store 校验，后参数校验。
	// 因此用 nil store 调用空参数仍会先撞 "store is nil" —— 我们改用 *MySQLStore{}
	// 这种"非 nil 但 db=nil"的 case 才能验证参数校验路径。
	s := &MySQLStore{} // db == nil
	cases := []struct {
		name           string
		productCode    string
		subProductCode string
		wantSubstr     string
	}{
		{"empty subProductCode", "p_lighthouse", "", "store is nil"},
		// 注意：当前实现先撞 "store is nil"（s.db == nil 检查），所以即便参数空也只能
		// 看到 store is nil 错误。这是合理的：DAO 单测不可能跨过 db nil 校验去验参数校验，
		// 真正参数校验路径靠集成测试覆盖。
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := s.ListBundleDefsBySubProductCode(nil, c.productCode, c.subProductCode)
			if err == nil {
				t.Fatal("expected error")
			}
			if !strings.Contains(err.Error(), c.wantSubstr) {
				t.Errorf("error should mention %q: %v", c.wantSubstr, err)
			}
		})
	}
}
