package pass

import (
	"context"
	"errors"
	"testing"
	"time"

	adapterfactory "ctl/pkg/adapter/factory"
	tradeadapter "ctl/pkg/adapter/trade"
	bundlemodel "ctl/pkg/model/bundle"
	passmodel "ctl/pkg/model/pass"
	passmigrationmodel "ctl/pkg/model/passbillingmigration"
	"ctl/pkg/resource"
	"ctl/pkg/transport"
	"ctl/test/testutil"

	"gorm.io/gorm"
)

func TestTransferPassFromBillingUpdatesExistingFreePassOnlyOnCallback(t *testing.T) {
	originalDB := resource.GormDB
	t.Cleanup(func() { resource.GormDB = originalDB })
	testutil.NewSQLiteDB(t, &passmodel.Entity{}, &passmigrationmodel.Entity{})

	expired := time.Date(2026, time.August, 20, 9, 45, 16, 0, time.UTC)
	if err := passmodel.NewDao().Create(&passmodel.Entity{
		PassID:      "pass-transfer-1",
		UserID:      "usr-transfer-1",
		BundleID:    allowedFreeTrialBundleID,
		Uin:         0,
		AppID:       0,
		ExpiredTime: expired,
		RenewFlag:   passmodel.RenewFlagManual,
		Status:      passmodel.StatusActive,
	}); err != nil {
		t.Fatalf("seed pass: %v", err)
	}
	record := passmigrationmodel.New(
		"pass-transfer-1",
		"usr-transfer-1",
		allowedFreeTrialBundleID,
		billingMigrationTargetBundleID,
		330500000004,
		1447552654,
		passmigrationmodel.StatusPendingTransfer,
	)
	if err := passmigrationmodel.NewDao().Upsert(record); err != nil {
		t.Fatalf("seed migration: %v", err)
	}

	detail, err := NewLogic().TransferPassFromBilling(&transport.TransferPassRequest{
		PassID:         "pass-transfer-1",
		UserID:         "usr-transfer-1",
		SourceBundleID: allowedFreeTrialBundleID,
		TargetBundleID: billingMigrationTargetBundleID,
		OldUin:         0,
		OldAppID:       0,
		NewUin:         330500000004,
		NewAppID:       1447552654,
		DealName:       "deal-transfer-1",
		BigOrderID:     "big-transfer-1",
	})
	if err != nil {
		t.Fatalf("TransferPassFromBilling: %v", err)
	}
	if detail.PassID != "pass-transfer-1" || detail.BundleID != billingMigrationTargetBundleID ||
		detail.Uin != 330500000004 || detail.AppID != 1447552654 {
		t.Fatalf("unexpected detail: %+v", detail)
	}
	got, err := passmodel.NewDao().GetByPassID("pass-transfer-1")
	if err != nil {
		t.Fatalf("read pass: %v", err)
	}
	if !got.ExpiredTime.Equal(expired) {
		t.Fatalf("expired_time changed: got %s want %s", got.ExpiredTime, expired)
	}
	migration, err := passmigrationmodel.NewDao().GetByPassAndTarget("pass-transfer-1", billingMigrationTargetBundleID)
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	if migration.Status != passmigrationmodel.StatusCompleted {
		t.Fatalf("migration status=%s, want completed", migration.Status)
	}
}

func TestMigrateFreeTrialPassToBillingDoesNotOverwriteCompletedCallback(t *testing.T) {
	setupBillingMigrationTestDB(t)
	seedBillingMigrationBundle(t)
	seedBillingMigrationPass(t, "pass-race-1", "usr-race-1")

	originalFactory := adapterfactory.DefaultAdapterFactory
	t.Cleanup(func() { adapterfactory.DefaultAdapterFactory = originalFactory })
	adapterfactory.DefaultAdapterFactory = &allocationAdapterFactory{tradeAdapter: &moveInTradeStub{
		moveIn: func(ctx context.Context, req *tradeadapter.MoveInOrderRequest) (*tradeadapter.PlaceOrderResult, error) {
			if _, err := NewLogic().TransferPassFromBilling(&transport.TransferPassRequest{
				PassID:         req.ResourceID,
				UserID:         req.ExternalUserID,
				SourceBundleID: allowedFreeTrialBundleID,
				TargetBundleID: req.BundleID,
				OldUin:         0,
				OldAppID:       0,
				NewUin:         330500000004,
				NewAppID:       1447552654,
				DealName:       "deal-race-1",
				BigOrderID:     "big-race-1",
			}); err != nil {
				return nil, err
			}
			return &tradeadapter.PlaceOrderResult{DealName: "deal-race-1", BigOrderID: "big-race-1"}, nil
		},
	}}

	result, err := NewLogic().MigrateFreeTrialPassToBilling(&transport.PassBillingMigrationRequest{
		UserID: "usr-race-1",
		Uin:    330500000004,
		AppID:  1447552654,
	})
	if err != nil {
		t.Fatalf("MigrateFreeTrialPassToBilling: %v", err)
	}
	if result.Status != passmigrationmodel.StatusPendingTransfer || result.DealName != "deal-race-1" || result.BigOrderID != "big-race-1" {
		t.Fatalf("unexpected result: %+v", result)
	}

	migration, err := passmigrationmodel.NewDao().GetByPassAndTarget("pass-race-1", billingMigrationTargetBundleID)
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	if migration.Status != passmigrationmodel.StatusCompleted {
		t.Fatalf("migration status=%s, want completed", migration.Status)
	}
	if migration.DealName == nil || *migration.DealName != "deal-race-1" {
		t.Fatalf("migration deal_name=%v, want deal-race-1", migration.DealName)
	}
	if migration.BigOrderID == nil || *migration.BigOrderID != "big-race-1" {
		t.Fatalf("migration big_order_id=%v, want big-race-1", migration.BigOrderID)
	}
}

func TestMigrateFreeTrialPassToBillingDeletesMigrationRecordWhenMoveInFails(t *testing.T) {
	setupBillingMigrationTestDB(t)
	seedBillingMigrationBundle(t)
	seedBillingMigrationPass(t, "pass-fail-1", "usr-fail-1")

	originalFactory := adapterfactory.DefaultAdapterFactory
	t.Cleanup(func() { adapterfactory.DefaultAdapterFactory = originalFactory })
	adapterfactory.DefaultAdapterFactory = &allocationAdapterFactory{tradeAdapter: &moveInTradeStub{
		moveIn: func(context.Context, *tradeadapter.MoveInOrderRequest) (*tradeadapter.PlaceOrderResult, error) {
			return nil, errors.New("jifei unavailable")
		},
	}}

	result, err := NewLogic().MigrateFreeTrialPassToBilling(&transport.PassBillingMigrationRequest{
		UserID: "usr-fail-1",
		Uin:    330500000004,
		AppID:  1447552654,
	})
	if err != nil {
		t.Fatalf("MigrateFreeTrialPassToBilling: %v", err)
	}
	if result.Status != "failed" {
		t.Fatalf("result status=%s, want failed", result.Status)
	}
	_, err = passmigrationmodel.NewDao().GetByPassAndTarget("pass-fail-1", billingMigrationTargetBundleID)
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		t.Fatalf("migration err=%v, want record not found", err)
	}
}

type moveInTradeStub struct {
	tradeadapter.Adapter
	moveIn func(context.Context, *tradeadapter.MoveInOrderRequest) (*tradeadapter.PlaceOrderResult, error)
}

func (s *moveInTradeStub) MoveInOrderAndPay(ctx context.Context, req *tradeadapter.MoveInOrderRequest) (*tradeadapter.PlaceOrderResult, error) {
	return s.moveIn(ctx, req)
}

func setupBillingMigrationTestDB(t *testing.T) {
	t.Helper()
	originalDB := resource.GormDB
	t.Cleanup(func() { resource.GormDB = originalDB })
	testutil.NewSQLiteDB(t, &passmodel.Entity{}, &passmigrationmodel.Entity{}, &bundlemodel.Entity{})
}

func seedBillingMigrationBundle(t *testing.T) {
	t.Helper()
	if err := resource.GormDB.Table(bundlemodel.TableName).Create(&bundlemodel.Entity{
		BundleID:              billingMigrationTargetBundleID,
		BundleType:            bundlemodel.BundleTypeGeneral,
		BundleName:            "Launch 01",
		BundleState:           bundlemodel.StateOnline,
		TimeSpan:              1,
		TimeUnit:              bundlemodel.TimeUnitMonth,
		BundleSalesAvailCount: 1,
	}).Error; err != nil {
		t.Fatalf("seed bundle: %v", err)
	}
}

func seedBillingMigrationPass(t *testing.T, passID, userID string) {
	t.Helper()
	if err := passmodel.NewDao().Create(&passmodel.Entity{
		PassID:      passID,
		UserID:      userID,
		BundleID:    allowedFreeTrialBundleID,
		Uin:         0,
		AppID:       0,
		ExpiredTime: time.Date(2026, time.August, 20, 9, 45, 16, 0, time.UTC),
		RenewFlag:   passmodel.RenewFlagManual,
		Status:      passmodel.StatusActive,
	}); err != nil {
		t.Fatalf("seed pass: %v", err)
	}
}
