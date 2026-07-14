package pass

import (
	"errors"
	"net/http"
	"testing"

	tradeadapter "ctl/pkg/adapter/trade"
	"ctl/pkg/errcode"
)

func TestMapTradePlaceOrderErrorBindingNotFound(t *testing.T) {
	err := mapTradePlaceOrderError(&tradeadapter.Error{
		Status:  http.StatusUnprocessableEntity,
		Code:    "BindingNotFound",
		Message: "binding not found",
	})
	if !errors.Is(err, errcode.ErrPassShadowBindingRequired) {
		t.Fatalf("expected PASS_SHADOW_BINDING_REQUIRED, got %v", err)
	}
}

func TestMapTradePlaceOrderErrorKeepsOtherErrors(t *testing.T) {
	err := mapTradePlaceOrderError(&tradeadapter.Error{
		Status:  http.StatusBadGateway,
		Code:    "UpstreamError",
		Message: "upstream failed",
	})
	if err != nil {
		t.Fatalf("expected nil for unrelated trade error, got %v", err)
	}
}
