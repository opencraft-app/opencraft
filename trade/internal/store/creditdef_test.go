package store

import (
	"errors"
	"strings"
	"testing"
)

func TestDecodeCreditDefinitionHappyPath(t *testing.T) {
	def, err := decodeCreditDefinition(
		42,
		"credit_small",
		"p_lightvela_credit",
		"sp_lightvela_credit",
		1234,
		[]byte(`[{"scene":"purchase","category":2026001},{"scene":"refund","category":2026002}]`),
		[]byte(`{"sv_credit_count":100}`),
		[]byte(`[{"name":"积分","value":"100"}]`),
	)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if def.ID != 42 || def.ProductID != "credit_small" {
		t.Fatalf("unexpected identity: %+v", def)
	}
	if def.ProductCode != "p_lightvela_credit" || def.SubProductCode != "sp_lightvela_credit" || def.Pid != 1234 {
		t.Fatalf("unexpected billing metadata: %+v", def)
	}
	if got := def.CategoryIDForScene("purchase"); got != 2026001 {
		t.Fatalf("purchase category=%d", got)
	}
	if got := def.SVList["sv_credit_count"]; got != 100 {
		t.Fatalf("sv_credit_count=%d", got)
	}
	if len(def.ProductInfo) != 1 {
		t.Fatalf("product_info=%+v", def.ProductInfo)
	}
}

func TestDecodeCreditDefinitionInvalidJSON(t *testing.T) {
	_, err := decodeCreditDefinition(1, "credit", "pc", "sp", 1, []byte(`{bad`), []byte(`{}`), []byte(`[]`))
	if err == nil || !strings.Contains(err.Error(), "category_ids") {
		t.Fatalf("expected category_ids decode error, got %v", err)
	}
}

func TestErrCreditDefinitionNotFoundIsSentinel(t *testing.T) {
	if !errors.Is(wrapErr(ErrCreditDefinitionNotFound), ErrCreditDefinitionNotFound) {
		t.Fatal("errors.Is should match ErrCreditDefinitionNotFound")
	}
}
