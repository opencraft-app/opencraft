package store

import (
	"errors"
	"strings"
	"testing"
)

// TestDecodeBundleDefinition_HappyPath 覆盖完整 JSON 解析。
func TestDecodeBundleDefinition_HappyPath(t *testing.T) {
	categoryRaw := []byte(`[{"scene":"purchase","category":"100059"},{"scene":"renew","category":"100060"}]`)
	svRaw := []byte(`{"key1":"v1","key2":2}`)
	productInfoRaw := []byte(`[{"name":"配置项 A","value":"1 vCPU"}]`)

	def, err := decodeBundleDefinition(
		42,
		"bundle_linux_small_01",
		"p_lighthouse",
		"sp_lighthouse_bundle_linux_small",
		"1234",
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
	if def.Pid != "1234" {
		t.Errorf("pid: got %q", def.Pid)
	}
	if len(def.CategoryIDs) != 2 {
		t.Fatalf("CategoryIDs len: got %d want 2", len(def.CategoryIDs))
	}
	if got := def.CategoryIDForScene("purchase"); got != "100059" {
		t.Errorf("CategoryIDForScene(purchase): got %q", got)
	}
	if got := def.CategoryIDForScene("renew"); got != "100060" {
		t.Errorf("CategoryIDForScene(renew): got %q", got)
	}
	if got := def.CategoryIDForScene("modify"); got != "" {
		t.Errorf("CategoryIDForScene(modify) should be empty: got %q", got)
	}
	if def.SVList["key1"] != "v1" {
		t.Errorf("SVList.key1: got %v", def.SVList["key1"])
	}
	// JSON number 默认 float64
	if def.SVList["key2"].(float64) != 2.0 {
		t.Errorf("SVList.key2: got %v", def.SVList["key2"])
	}
	if len(def.ProductInfo) != 1 {
		t.Errorf("ProductInfo len: got %d", len(def.ProductInfo))
	}
}

// TestDecodeBundleDefinition_EmptySVList 验证空对象 sv_list = {} 合法（设计稿 §3.5.5 (4)）。
func TestDecodeBundleDefinition_EmptySVList(t *testing.T) {
	def, err := decodeBundleDefinition(
		1, "bundle_x", "pc", "spc", "p",
		[]byte(`[{"scene":"purchase","category":"100059"}]`),
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
				1, "bundle_x", "pc", "spc", "p",
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
	def, err := decodeBundleDefinition(1, "b", "pc", "spc", "p", nil, nil, nil)
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
	if got := def.CategoryIDForScene("purchase"); got != "" {
		t.Errorf("nil receiver should return empty: got %q", got)
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
