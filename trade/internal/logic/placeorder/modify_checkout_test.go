package placeorder

import (
	"context"
	"errors"
	"testing"

	"git.woa.com/wisp/mono/trade/internal/jifeiclient"
	"git.woa.com/wisp/mono/trade/internal/store"
)

func TestModifyCheckoutBindsOrderBeforeCachedURL(t *testing.T) {
	for _, field := range []string{"user", "pass", "type", "target", "missing"} {
		t.Run(field, func(t *testing.T) {
			d := newStdDeps()
			order := &store.TradeOrder{ExternalUserID: "user", ResourceID: "pass", OrderType: store.OrderTypeModify, BundleID: "target", PayURL: "https://pay.example/cached"}
			opts := &GeneratePayURLOptions{ExternalUserID: "user", ResourceID: "pass", OrderType: store.OrderTypeModify, AllowedBundleIDs: []string{"target"}}
			switch field {
			case "user":
				order.ExternalUserID = "other"
			case "pass":
				order.ResourceID = "other"
			case "type":
				order.OrderType = store.OrderTypeRenew
			case "target":
				order.BundleID = "other"
			case "missing":
				opts = nil
			}
			d.store.getOrderByDealNameFn = func(context.Context, string) (*store.TradeOrder, error) { return order, nil }
			_, err := d.service.GeneratePayURL(context.Background(), "deal", opts)
			if !errors.Is(err, store.ErrTradeOrderNotFound) {
				t.Fatalf("expected hidden not found, got %v", err)
			}
		})
	}
}

func TestModifyCheckoutNeverReusesPlatformBlindCache(t *testing.T) {
	d := newStdDeps()
	d.store.getOrderByDealNameFn = func(context.Context, string) (*store.TradeOrder, error) {
		return &store.TradeOrder{ExternalUserID: "user", ResourceID: "pass", OrderType: store.OrderTypeModify, BundleID: "target", Status: store.OrderStatusPendingPay, Uin: "uin", PayURL: "https://pay.example/pc"}, nil
	}
	calls := 0
	d.jifei.getMidasEarmarkingFn = func(_ context.Context, req *jifeiclient.GetMidasEarmarkingRequest) (*jifeiclient.GetMidasEarmarkingResponse, error) {
		calls++
		if req.Platform != "mobile" || req.WxOpenID != "openid" {
			t.Fatal("lost mobile identity")
		}
		return &jifeiclient.GetMidasEarmarkingResponse{URL: "https://pay.example/mobile", NeedCharge: 1}, nil
	}
	for i := 0; i < 2; i++ {
		result, err := d.service.GeneratePayURL(context.Background(), "deal", &GeneratePayURLOptions{ExternalUserID: "user", ResourceID: "pass", OrderType: store.OrderTypeModify, AllowedBundleIDs: []string{"target"}, Platform: "mobile", WxOpenID: "openid"})
		if err != nil || result.PayURL != "https://pay.example/mobile" {
			t.Fatalf("result=%+v err=%v", result, err)
		}
	}
	if calls != 2 {
		t.Fatalf("calls=%d", calls)
	}
}

func TestModifyCheckoutAuthorizationOnlyDoesNotGenerateURL(t *testing.T) {
	d := newStdDeps()
	d.store.getOrderByDealNameFn = func(context.Context, string) (*store.TradeOrder, error) {
		return &store.TradeOrder{ExternalUserID: "user", ResourceID: "pass", OrderType: store.OrderTypeModify, BundleID: "target", Status: store.OrderStatusPendingPay}, nil
	}
	d.jifei.getMidasEarmarkingFn = func(context.Context, *jifeiclient.GetMidasEarmarkingRequest) (*jifeiclient.GetMidasEarmarkingResponse, error) {
		t.Fatal("authorization must not generate payment URL")
		return nil, nil
	}
	_, err := d.service.GeneratePayURL(context.Background(), "deal", &GeneratePayURLOptions{ExternalUserID: "user", ResourceID: "pass", OrderType: store.OrderTypeModify, AllowedBundleIDs: []string{"target"}, AuthorizationOnly: true})
	if err != nil {
		t.Fatal(err)
	}
}

func TestModifyCheckoutRejectsEveryNonPendingState(t *testing.T) {
	for _, status := range []string{"", "created", "paid_pending_provision", "provisioned", "cancelled", "payment_failed", "provision_failed", "unknown"} {
		for _, authorizationOnly := range []bool{false, true} {
			t.Run(status+"/"+map[bool]string{false: "pay-url", true: "authorization"}[authorizationOnly], func(t *testing.T) {
				d := newStdDeps()
				d.store.getOrderByDealNameFn = func(context.Context, string) (*store.TradeOrder, error) {
					return &store.TradeOrder{ExternalUserID: "user", ResourceID: "pass", OrderType: store.OrderTypeModify, BundleID: "target", Status: status}, nil
				}
				d.jifei.getMidasEarmarkingFn = func(context.Context, *jifeiclient.GetMidasEarmarkingRequest) (*jifeiclient.GetMidasEarmarkingResponse, error) {
					t.Fatal("nonpending order reached provider")
					return nil, nil
				}
				_, err := d.service.GeneratePayURL(context.Background(), "deal", &GeneratePayURLOptions{ExternalUserID: "user", ResourceID: "pass", OrderType: store.OrderTypeModify, AllowedBundleIDs: []string{"target"}, AuthorizationOnly: authorizationOnly})
				if !errors.Is(err, ErrModifyOrderNotPayable) {
					t.Fatalf("expected nonpayable state error, got %v", err)
				}
			})
		}
	}
}
