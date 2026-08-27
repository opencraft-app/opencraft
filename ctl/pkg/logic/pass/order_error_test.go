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

func TestMapTradePlaceOrderErrorBillingAccountOpenFailed(t *testing.T) {
	err := mapTradePlaceOrderError(&tradeadapter.Error{
		Status:  http.StatusConflict,
		Code:    "BillingAccountOpenFailed",
		Message: "billing account open failed",
	})
	if !errors.Is(err, errcode.ErrPassBillingAccountOpenFailed) {
		t.Fatalf("expected PASS_BILLING_ACCOUNT_OPEN_FAILED, got %v", err)
	}
}

func TestMapTradePlaceOrderErrorDianshiActivityRequired(t *testing.T) {
	err := mapTradePlaceOrderError(&tradeadapter.Error{
		Status:  http.StatusUnprocessableEntity,
		Code:    "DianshiActivityRequired",
		Message: "bundle is not eligible for the Dianshi activity",
	})
	if !errors.Is(err, errcode.ErrPassInvalidParam) {
		t.Fatalf("expected PASS_INVALID_PARAM, got %v", err)
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
