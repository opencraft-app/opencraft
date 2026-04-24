package trade

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	otellog "go.opentelemetry.io/otel/log"

	"shadow/internal/billingapi"
	"shadow/internal/storage"
	"shadow/internal/telemetry"
	"shadow/internal/wallet"
)

type Service struct {
	store     storage.Store
	billing   billingapi.Client
	walletSvc *wallet.Service
}

func NewService(store storage.Store, billingClient billingapi.Client, walletSvc *wallet.Service) *Service {
	if store == nil || billingClient == nil || walletSvc == nil {
		return nil
	}
	return &Service{store: store, billing: billingClient, walletSvc: walletSvc}
}

type CreatePackageOrderInput struct {
	UserID      string
	PackageCode string
	Platform    string
	ReturnURL   string
	CancelURL   string
	PayScene    string
	Application string
}

type CreatePackageOrderOutput struct {
	Order storage.PackageOrder `json:"order"`
}

type ConfirmPackageOrderOutput struct {
	Order  storage.PackageOrder  `json:"order"`
	Wallet storage.WalletAccount `json:"wallet"`
}

func (s *Service) ListProducts(ctx context.Context) ([]storage.PackageProduct, error) {
	return s.store.ListPackageProducts(ctx)
}

func (s *Service) CreatePackageOrder(ctx context.Context, in CreatePackageOrderInput) (CreatePackageOrderOutput, error) {
	logger := telemetry.Logger("shadow/internal/trade")
	if _, err := s.store.GetUserByID(ctx, in.UserID); err != nil {
		return CreatePackageOrderOutput{}, err
	}
	if _, err := s.store.GetBindingByUserID(ctx, in.UserID); err != nil {
		return CreatePackageOrderOutput{}, fmt.Errorf("shadow binding is required: %w", err)
	}
	product, err := s.store.GetPackageProductByCode(ctx, in.PackageCode)
	if err != nil {
		return CreatePackageOrderOutput{}, err
	}
	if !product.Enabled {
		return CreatePackageOrderOutput{}, errors.New("package product is disabled")
	}
	user, err := s.store.GetUserByID(ctx, in.UserID)
	if err != nil {
		return CreatePackageOrderOutput{}, err
	}
	if product.RequiresStandardRealname && !user.IsStandardRealnameAuth {
		return CreatePackageOrderOutput{}, errors.New("standard realname authentication is required")
	}

	now := time.Now().UTC()
	order := storage.PackageOrder{
		ID:                     "pkgord_" + uuid.NewString(),
		UserID:                 in.UserID,
		ProductCode:            product.Code,
		Amount:                 product.CreditAmount,
		Currency:               product.Currency,
		Status:                 storage.PackageOrderStatusCreated,
		ClientToken:            "shadow-" + uuid.NewString(),
		PaymentConfirmationKey: "pkgconfirm_" + uuid.NewString(),
		CreatedAt:              now,
		UpdatedAt:              now,
	}
	if err := s.store.CreatePackageOrder(ctx, order); err != nil {
		return CreatePackageOrderOutput{}, err
	}
	telemetry.Info(ctx, logger, "trade package order created",
		otellog.String("order_id", order.ID),
		otellog.String("user_id", order.UserID),
		otellog.String("product_code", order.ProductCode),
		otellog.Int64("amount", order.Amount),
		otellog.String("currency", order.Currency),
	)

	createOrdersReq := billingapi.CreateOrdersRequest{
		Goods: []billingapi.GoodsInfo{{
			GoodsCategoryID: product.BillingGoodsCategoryID,
			Zone:            product.BillingZone,
			GoodsNum:        1,
			ProjectID:       0,
			Region:          product.BillingRegion,
			PayMode:         product.BillingPayMode,
			GoodsDetail:     buildGoodsDetailJSON(product),
		}},
		AutoVoucher: true,
		ClientToken: order.ClientToken,
	}
	createOrdersResp, err := s.billing.CreateOrders(ctx, createOrdersReq)
	if err != nil {
		return CreatePackageOrderOutput{}, err
	}

	createPayReq := billingapi.CreatePayURLRequest{
		OrderIds:    createOrdersResp.OrderIds,
		Platform:    defaultString(in.Platform, "mobile"),
		CancelUrl:   in.CancelURL,
		ReturnUrl:   in.ReturnURL,
		PayScene:    in.PayScene,
		Application: in.Application,
	}
	createPayResp, err := s.billing.CreatePayURL(ctx, createPayReq)
	if err != nil {
		return CreatePackageOrderOutput{}, err
	}

	requestJSON, _ := json.Marshal(map[string]any{
		"create_orders": createOrdersReq,
		"create_pay":    createPayReq,
	})
	responseJSON, _ := json.Marshal(map[string]any{
		"create_orders": createOrdersResp,
		"create_pay":    createPayResp,
	})
	status := storage.PackageOrderStatusPayURLReady
	if createPayResp.NeedCharge != 0 {
		status = storage.PackageOrderStatusPaymentPending
	}
	if err := s.store.UpdatePackageOrderLaunch(
		ctx,
		order.ID,
		status,
		createOrdersResp.BigOrderId,
		createOrdersResp.OrderIds,
		createPayResp.Url,
		createPayResp.NeedCharge != 0,
		string(requestJSON),
		string(responseJSON),
	); err != nil {
		return CreatePackageOrderOutput{}, err
	}
	updated, err := s.store.GetPackageOrderByID(ctx, order.ID)
	if err != nil {
		return CreatePackageOrderOutput{}, err
	}
	telemetry.Info(ctx, logger, "trade package order payment launched",
		otellog.String("order_id", updated.ID),
		otellog.String("billing_big_order_id", updated.BillingBigOrderID),
		otellog.String("status", string(updated.Status)),
		otellog.Bool("need_charge", updated.NeedCharge),
	)
	return CreatePackageOrderOutput{Order: updated}, nil
}

func (s *Service) GetPackageOrder(ctx context.Context, orderID string) (storage.PackageOrder, error) {
	return s.store.GetPackageOrderByID(ctx, orderID)
}

func (s *Service) ConfirmPackageOrder(ctx context.Context, orderID string) (ConfirmPackageOrderOutput, error) {
	logger := telemetry.Logger("shadow/internal/trade")
	order, err := s.store.GetPackageOrderByID(ctx, orderID)
	if err != nil {
		return ConfirmPackageOrderOutput{}, err
	}
	if order.Status == storage.PackageOrderStatusCreditApplied {
		walletAccount, err := s.walletSvc.GetAccount(ctx, order.UserID)
		if err != nil {
			return ConfirmPackageOrderOutput{}, err
		}
		return ConfirmPackageOrderOutput{Order: order, Wallet: walletAccount}, nil
	}

	start := order.CreatedAt.Add(-1 * time.Hour).Format("2006-01-02 15:04:05")
	end := time.Now().UTC().Add(1 * time.Hour).Format("2006-01-02 15:04:05")
	queryResp, err := s.billing.DescribeDealsByCond(ctx, billingapi.DescribeDealsByCondRequest{
		StartTime: start,
		EndTime:   end,
		Limit:     20,
		BigDealId: order.BillingBigOrderID,
	})
	if err != nil {
		return ConfirmPackageOrderOutput{}, err
	}
	if !hasPaidDeal(queryResp.Deals) {
		return ConfirmPackageOrderOutput{}, errors.New("payment is not confirmed")
	}
	telemetry.Info(ctx, logger, "trade package order payment confirmed",
		otellog.String("order_id", order.ID),
		otellog.String("billing_big_order_id", order.BillingBigOrderID),
	)
	externalRefsJSON, _ := json.Marshal(map[string]any{
		"big_order_id":  order.BillingBigOrderID,
		"billing_deals": queryResp.Deals,
	})
	credit, err := s.walletSvc.ApplyOrderCredit(ctx, order.ID, time.Now().UTC(), string(externalRefsJSON), order.Amount, "package_order_credit")
	if err != nil {
		return ConfirmPackageOrderOutput{}, err
	}
	telemetry.Info(ctx, logger, "trade package order wallet credited",
		otellog.String("order_id", credit.Order.ID),
		otellog.String("user_id", credit.Wallet.UserID),
		otellog.Int64("available_amount", credit.Wallet.AvailableAmount),
	)
	return ConfirmPackageOrderOutput{Order: credit.Order, Wallet: credit.Wallet}, nil
}

func hasPaidDeal(deals []billingapi.Deal) bool {
	for _, deal := range deals {
		if deal.Status == 2 || deal.Status == 3 || deal.Status == 4 {
			return true
		}
	}
	return false
}

func defaultString(v, fallback string) string {
	if v != "" {
		return v
	}
	return fallback
}

func buildGoodsDetailJSON(product storage.PackageProduct) string {
	if product.BillingGoodsDetailJSON != "" {
		return product.BillingGoodsDetailJSON
	}

	payload := map[string]any{
		"productCode":    product.ProductCode,
		"subProductCode": product.SubProductCode,
		"action":         defaultString(product.BillingAction, "purchase"),
	}
	if product.BillingPID > 0 {
		payload["pid"] = product.BillingPID
	}
	if product.BillingTimeUnit != "" {
		payload["timeUnit"] = product.BillingTimeUnit
	}
	if product.BillingTimeSpan > 0 {
		payload["timeSpan"] = product.BillingTimeSpan
	}
	if product.BillingItemTypeCode != "" {
		payload["vCode"] = product.BillingItemTypeCode
	}
	if product.BillingItemCode != "" {
		payload["svCode"] = product.BillingItemCode
	}
	if product.BillingExtraParamsJSON != "" {
		var extra map[string]any
		if err := json.Unmarshal([]byte(product.BillingExtraParamsJSON), &extra); err == nil {
			for k, v := range extra {
				payload[k] = v
			}
		}
	}
	raw, _ := json.Marshal(payload)
	return string(raw)
}
