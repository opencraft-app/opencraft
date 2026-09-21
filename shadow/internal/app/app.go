package app

import (
	"context"
	"errors"
	"net/http"

	"shadow/internal/billing"
	"shadow/internal/billingapi"
	"shadow/internal/config"
	"shadow/internal/httpapi"
	"shadow/internal/platform"
	"shadow/internal/shadow"
	"shadow/internal/storage"
	storagesqlite "shadow/internal/storage/sqlite"
	"shadow/internal/telemetry"
	"shadow/internal/trade"
	"shadow/internal/wallet"
)

type App struct {
	handler http.Handler
	closers []func() error
}

func New(cfg config.Config) (*App, error) {
	if cfg.PackageProductsErr != nil {
		return nil, cfg.PackageProductsErr
	}
	telemetryClose, err := telemetry.Init(telemetry.Options{
		ServiceName: "shadowd",
		Platform:    cfg.ShadowPlatform,
		Provider:    cfg.Provider,
	})
	if err != nil {
		return nil, err
	}
	cleanupTelemetry := true
	defer func() {
		if cleanupTelemetry {
			_ = telemetryClose()
		}
	}()

	store, err := newStore(cfg)
	if err != nil {
		return nil, err
	}
	closers := []func() error{store.Close}

	var cloud platform.CloudProvider
	switch cfg.Provider {
	case "fake":
		cloud = platform.NewFakeCloudProvider()
	case "mock":
		provider, err := platform.NewMockHTTPProvider(platform.TencentCloudOptions{
			Region:          cfg.Region,
			Platform:        cfg.ShadowPlatform,
			AccountEndpoint: cfg.AccountEndpoint,
			CAMEndpoint:     cfg.CAMEndpoint,
			STSEndpoint:     cfg.STSEndpoint,
			RequestTimeout:  cfg.RequestTimeout,
		})
		if err != nil {
			return nil, err
		}
		cloud = provider
	case "tencent":
		provider, err := platform.NewTencentCloudProvider(platform.TencentCloudOptions{
			Region:          cfg.Region,
			Platform:        cfg.ShadowPlatform,
			AccountEndpoint: cfg.AccountEndpoint,
			CAMEndpoint:     cfg.CAMEndpoint,
			STSEndpoint:     cfg.STSEndpoint,
			SecretID:        cfg.SecretID,
			SecretKey:       cfg.SecretKey,
			CloudLadder:     cfg.CloudLadder,
			RequestTimeout:  cfg.RequestTimeout,
		})
		if err != nil {
			return nil, err
		}
		cloud = provider
	default:
		return nil, errors.New("unsupported provider")
	}

	var billingProvider billing.Provider
	switch cfg.BillingMode {
	case "fake", "":
		billingProvider = billing.NewFakeProvider()
	case "http":
		provider, err := billing.NewHTTPProvider(billing.HTTPOptions{
			Platform:            cfg.ShadowPlatform,
			DianshiEndpoint:     cfg.DianshiEndpoint,
			BillingEndpoint:     cfg.BillingEndpoint,
			RecoveryEndpoint:    cfg.RecoveryEndpoint,
			FreeTrialActivityID: cfg.FreeTrialActivityID,
			FreeTrialActID:      cfg.FreeTrialActID,
			SubProductCode:      cfg.SubProductCode,
			RequestTimeout:      cfg.RequestTimeout,
		}, store)
		if err != nil {
			return nil, err
		}
		billingProvider = provider
	default:
		return nil, errors.New("unsupported billing mode")
	}

	service := shadow.NewService(store, cloud, billingProvider, cfg.AuthCodeTTL, cfg.ShadowPlatform)
	if err := seedPackageProducts(store, cfg.PackageProducts); err != nil {
		return nil, err
	}

	var tradeService *trade.Service
	walletService := wallet.NewService(store)
	if cfg.BillingAPIEndpoint != "" && cfg.BillingSecretID != "" && cfg.BillingSecretKey != "" {
		billingAPIClient, err := billingapi.NewTencentClient(billingapi.Options{
			Endpoint:       cfg.BillingAPIEndpoint,
			Region:         cfg.BillingAPIRegion,
			SecretID:       cfg.BillingSecretID,
			SecretKey:      cfg.BillingSecretKey,
			CloudLadder:    cfg.CloudLadder,
			RequestTimeout: cfg.RequestTimeout,
		})
		if err != nil {
			return nil, err
		}
		tradeService = trade.NewService(store, billingAPIClient, walletService)
	}

	api := httpapi.NewWithOptions(service, httpapi.Options{
		CallbackToken:       cfg.CallbackToken,
		PaymentConfirmToken: cfg.PaymentConfirmToken,
		TradeService:        tradeService,
		WalletService:       walletService,
	})
	closers = append(closers, telemetryClose)
	cleanupTelemetry = false
	return &App{handler: api.Handler(), closers: closers}, nil
}

func (a *App) Handler() http.Handler {
	return a.handler
}

func (a *App) Close() error {
	for _, closer := range a.closers {
		if closer == nil {
			continue
		}
		if err := closer(); err != nil {
			return err
		}
	}
	return nil
}

func newStore(cfg config.Config) (storage.Store, error) {
	switch cfg.StorageDriver {
	case "", "sqlite":
		return storagesqlite.NewStore(cfg.StorageDSN)
	default:
		return nil, errors.New("unsupported storage driver")
	}
}

func seedPackageProducts(store storage.Store, products []config.PackageProductConfig) error {
	for _, product := range products {
		if product.Code == "" {
			continue
		}
		if err := store.UpsertPackageProduct(context.Background(), storage.PackageProduct{
			Code:                     product.Code,
			DisplayName:              product.DisplayName,
			CreditAmount:             product.CreditAmount,
			Currency:                 product.Currency,
			BillingGoodsCategoryID:   product.BillingGoodsCategoryID,
			BillingRegion:            product.BillingRegion,
			BillingZone:              product.BillingZone,
			BillingPayMode:           product.BillingPayMode,
			ProductCode:              product.ProductCode,
			SubProductCode:           product.SubProductCode,
			BillingItemTypeCode:      product.BillingItemTypeCode,
			BillingItemCode:          product.BillingItemCode,
			BillingPID:               product.BillingPID,
			BillingTimeUnit:          product.BillingTimeUnit,
			BillingTimeSpan:          product.BillingTimeSpan,
			BillingAction:            product.BillingAction,
			BillingExtraParamsJSON:   product.BillingExtraParamsJSON,
			BillingGoodsDetailJSON:   product.BillingGoodsDetailJSON,
			RequiresStandardRealname: product.RequiresStandardRealname,
			Enabled:                  product.Enabled,
			MetadataJSON:             product.MetadataJSON,
		}); err != nil {
			return err
		}
	}
	return nil
}
