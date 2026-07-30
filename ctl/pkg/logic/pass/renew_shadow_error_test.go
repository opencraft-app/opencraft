package pass

import (
	"errors"
	"fmt"
	"testing"

	tradeadapter "ctl/pkg/adapter/trade"
	"ctl/pkg/errcode"
)

func TestIsTradeShadowBindingNotFound(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want bool
	}{
		{
			name: "binding_not_found",
			err: &tradeadapter.Error{
				Status:   422,
				Code:     "BindingNotFound",
				Message:  "shadow binding not found",
				Endpoint: "/internal/trade/inquiry/renew",
			},
			want: true,
		},
		{
			name: "wrapped_binding_not_found",
			err: fmt.Errorf("trade inquiry renew: %w", &tradeadapter.Error{
				Status:   422,
				Code:     "BindingNotFound",
				Message:  "shadow binding not found",
				Endpoint: "/internal/trade/orders/renew",
			}),
			want: true,
		},
		{
			name: "other_trade_error",
			err: &tradeadapter.Error{
				Status:   500,
				Code:     "UpstreamError",
				Message:  "upstream failed",
				Endpoint: "/internal/trade/orders/renew",
			},
			want: false,
		},
		{
			name: "business_error",
			err:  errcode.ErrPassNotFound,
			want: false,
		},
		{
			name: "nil",
			err:  nil,
			want: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := isTradeShadowBindingNotFound(tt.err)
			if got != tt.want {
				t.Fatalf("isTradeShadowBindingNotFound() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestTradeShadowBindingNotFoundErrorReturnsCreatePassRealnameCode(t *testing.T) {
	err := tradeShadowBindingNotFoundError(&tradeadapter.Error{
		Status:   422,
		Code:     "BindingNotFound",
		Message:  "shadow binding not found",
		Endpoint: "/internal/trade/orders/renew",
	})
	if !errors.Is(err, errcode.ErrPassShadowBindingRequired) {
		t.Fatalf("tradeShadowBindingNotFoundError() = %v, want ErrPassShadowBindingRequired", err)
	}
	if got := errcode.ErrPassShadowBindingRequired.HTTPStatus; got != 403 {
		t.Fatalf("ErrPassShadowBindingRequired HTTPStatus = %d, want 403", got)
	}

	if err := tradeShadowBindingNotFoundError(&tradeadapter.Error{
		Status:   500,
		Code:     "UpstreamError",
		Message:  "upstream failed",
		Endpoint: "/internal/trade/orders/renew",
	}); err != nil {
		t.Fatalf("tradeShadowBindingNotFoundError(other error) = %v, want nil", err)
	}
}
