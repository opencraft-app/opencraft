package pass

import (
	"context"
	"errors"
	"testing"
	"time"

	adapterfactory "ctl/pkg/adapter/factory"
	tradeadapter "ctl/pkg/adapter/trade"
	"ctl/pkg/config"
	bundlemodel "ctl/pkg/model/bundle"
	"ctl/pkg/model/eventoutbox"
	passmodel "ctl/pkg/model/pass"
	passmigrationmodel "ctl/pkg/model/passbillingmigration"
	"ctl/pkg/resource"
	"ctl/pkg/transport"
	"ctl/test/testutil"

	"gorm.io/gorm"
)

func TestTransferPassFromBillingUpdatesExistingFreePassOnlyOnCallback(t *testing.T) {
	t.Setenv("REFERRAL_ENABLED", "true")
	originalDB := resource.GormDB
	t.Cleanup(func() { resource.GormDB = originalDB })
	testutil.NewSQLiteDB(t, &passmodel.Entity{}, &passmigrationmodel.Entity{}, &eventoutbox.Entity{})

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
	assertFirstPaidOutboxEvent(t, "pass-transfer-1")
}

func TestMigrateFreeTrialPassToBillingDoesNotOverwriteCompletedCallback(t *testing.T) {
	t.Setenv("REFERRAL_ENABLED", "true")
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

func TestMigrateFreeTrialPassToBillingExtendsExpiredActivePassBeforeOrder(t *testing.T) {
	setupBillingMigrationTestDB(t)
	seedBillingMigrationBundle(t)
	seedBillingMigrationPass(t, "pass-expired-1", "usr-expired-1")
	setBillingMigrationRegion(t, "ap-beijing")

	originalFactory := adapterfactory.DefaultAdapterFactory
	t.Cleanup(func() { adapterfactory.DefaultAdapterFactory = originalFactory })
	adapterfactory.DefaultAdapterFactory = &allocationAdapterFactory{tradeAdapter: &moveInTradeStub{
		moveIn: func(_ context.Context, req *tradeadapter.MoveInOrderRequest) (*tradeadapter.PlaceOrderResult, error) {
			stored, err := passmodel.NewDao().GetByPassID(req.ResourceID)
			if err != nil {
				t.Fatalf("read pass before trade call: %v", err)
			}
			if !stored.ExpiredTime.After(time.Now().UTC().Add(23*time.Hour)) || stored.Status != passmodel.StatusActive {
				t.Fatalf("pass not extended before trade call: %+v", stored)
			}
			if req.CurDeadline != formatCurDeadlineForJifei(stored.ExpiredTime) {
				t.Fatalf("curDeadline=%q, want %q", req.CurDeadline, formatCurDeadlineForJifei(stored.ExpiredTime))
			}
			return &tradeadapter.PlaceOrderResult{DealName: "deal-expired-1", BigOrderID: "big-expired-1"}, nil
		},
	}}

	result, err := NewLogic().MigrateFreeTrialPassToBilling(&transport.PassBillingMigrationRequest{
		UserID: "usr-expired-1", Uin: 330500000004, AppID: 1447552654,
	})
	if err != nil || result.Status != passmigrationmodel.StatusPendingTransfer {
		t.Fatalf("migration result=%+v err=%v", result, err)
	}
}

func TestMigrateFreeTrialPassToBillingRetryUsesExistingExtendedDeadline(t *testing.T) {
	setupBillingMigrationTestDB(t)
	seedBillingMigrationBundle(t)
	seedBillingMigrationPass(t, "pass-retry-1", "usr-retry-1")
	setBillingMigrationRegion(t, "ap-beijing")

	var deadlines []string
	originalFactory := adapterfactory.DefaultAdapterFactory
	t.Cleanup(func() { adapterfactory.DefaultAdapterFactory = originalFactory })
	adapterfactory.DefaultAdapterFactory = &allocationAdapterFactory{tradeAdapter: &moveInTradeStub{
		moveIn: func(_ context.Context, req *tradeadapter.MoveInOrderRequest) (*tradeadapter.PlaceOrderResult, error) {
			deadlines = append(deadlines, req.CurDeadline)
			if len(deadlines) == 1 {
				return nil, errors.New("temporary trade error")
			}
			return &tradeadapter.PlaceOrderResult{DealName: "deal-retry-1", BigOrderID: "big-retry-1"}, nil
		},
	}}

	req := &transport.PassBillingMigrationRequest{UserID: "usr-retry-1", Uin: 330500000004, AppID: 1447552654}
	first, err := NewLogic().MigrateFreeTrialPassToBilling(req)
	if err != nil || first.Status != "failed" {
		t.Fatalf("first migration result=%+v err=%v", first, err)
	}
	second, err := NewLogic().MigrateFreeTrialPassToBilling(req)
	if err != nil || second.Status != passmigrationmodel.StatusPendingTransfer {
		t.Fatalf("retry migration result=%+v err=%v", second, err)
	}
	if len(deadlines) != 2 || deadlines[0] != deadlines[1] {
		t.Fatalf("retry changed deadline: %v", deadlines)
	}
}

func TestMigrateFreeTrialPassToBillingKeepsUnexpiredActivePassDeadline(t *testing.T) {
	setupBillingMigrationTestDB(t)
	seedBillingMigrationBundle(t)
	seedBillingMigrationPass(t, "pass-future-1", "usr-future-1")
	setBillingMigrationRegion(t, "ap-beijing")
	future := time.Now().UTC().Add(10 * 24 * time.Hour).Truncate(time.Second)
	if err := passmodel.NewDao().UpdateByPassID("pass-future-1", map[string]interface{}{passmodel.ColumnExpiredTime: future}); err != nil {
		t.Fatalf("set future deadline: %v", err)
	}

	originalFactory := adapterfactory.DefaultAdapterFactory
	t.Cleanup(func() { adapterfactory.DefaultAdapterFactory = originalFactory })
	adapterfactory.DefaultAdapterFactory = &allocationAdapterFactory{tradeAdapter: &moveInTradeStub{
		moveIn: func(_ context.Context, req *tradeadapter.MoveInOrderRequest) (*tradeadapter.PlaceOrderResult, error) {
			if req.CurDeadline != formatCurDeadlineForJifei(future) {
				t.Fatalf("curDeadline=%q, want unchanged %q", req.CurDeadline, formatCurDeadlineForJifei(future))
			}
			return &tradeadapter.PlaceOrderResult{DealName: "deal-future-1", BigOrderID: "big-future-1"}, nil
		},
	}}

	if _, err := NewLogic().MigrateFreeTrialPassToBilling(&transport.PassBillingMigrationRequest{
		UserID: "usr-future-1", Uin: 330500000004, AppID: 1447552654,
	}); err != nil {
		t.Fatalf("migration: %v", err)
	}
	stored, err := passmodel.NewDao().GetByPassID("pass-future-1")
	if err != nil || !stored.ExpiredTime.Equal(future) {
		t.Fatalf("deadline changed: pass=%+v err=%v", stored, err)
	}
}

func TestMigrateFreeTrialPassToBillingSkipsIsolatedPass(t *testing.T) {
	setupBillingMigrationTestDB(t)
	seedBillingMigrationPass(t, "pass-isolated-1", "usr-isolated-1")
	setBillingMigrationRegion(t, "ap-beijing")
	if err := passmodel.NewDao().UpdateByPassID("pass-isolated-1", map[string]interface{}{passmodel.ColumnStatus: passmodel.StatusIsolated}); err != nil {
		t.Fatalf("isolate pass: %v", err)
	}

	result, err := NewLogic().MigrateFreeTrialPassToBilling(&transport.PassBillingMigrationRequest{
		UserID: "usr-isolated-1", Uin: 330500000004, AppID: 1447552654,
	})
	if err != nil || result.Status != "skipped_no_active_free_pass" {
		t.Fatalf("migration result=%+v err=%v", result, err)
	}
	stored, err := passmodel.NewDao().GetByPassID("pass-isolated-1")
	if err != nil || stored.Status != passmodel.StatusIsolated || stored.ExpiredTime.After(time.Now().UTC()) {
		t.Fatalf("isolated pass changed: pass=%+v err=%v", stored, err)
	}
}

func TestMigrateFreeTrialPassToBillingSkipsInternationalRegion(t *testing.T) {
	for _, region := range []string{"ap-singapore", "ap-seoul"} {
		t.Run(region, func(t *testing.T) {
			setupBillingMigrationTestDB(t)
			seedBillingMigrationPass(t, "pass-intl-1", "usr-intl-1")
			setBillingMigrationRegion(t, region)

			result, err := NewLogic().MigrateFreeTrialPassToBilling(&transport.PassBillingMigrationRequest{
				UserID: "usr-intl-1", Uin: 330500000004, AppID: 1447552654,
			})
			if err != nil || result.Status != "skipped_international" {
				t.Fatalf("migration result=%+v err=%v", result, err)
			}
			stored, err := passmodel.NewDao().GetByPassID("pass-intl-1")
			if err != nil || stored.ExpiredTime.After(time.Now().UTC()) {
				t.Fatalf("international pass changed: pass=%+v err=%v", stored, err)
			}
		})
	}
}

func setBillingMigrationRegion(t *testing.T, region string) {
	t.Helper()
	original := config.ServerConf
	t.Cleanup(func() { config.ServerConf = original })
	config.ServerConf = &config.GlobalConfig{}
	config.ServerConf.MiscConfig.Region = region
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
	setBillingMigrationRegion(t, "ap-beijing")
	originalDB := resource.GormDB
	t.Cleanup(func() { resource.GormDB = originalDB })
	testutil.NewSQLiteDB(t, &passmodel.Entity{}, &passmigrationmodel.Entity{}, &bundlemodel.Entity{}, &eventoutbox.Entity{})
}

func assertFirstPaidOutboxEvent(t *testing.T, passID string) {
	t.Helper()
	var event eventoutbox.Entity
	if err := resource.GormDB.Where("event_id = ?", "pass.first_paid:"+passID).First(&event).Error; err != nil {
		t.Fatalf("read first-paid outbox event: %v", err)
	}
	if event.EventType != "pass.first_paid.v1" || event.AggregateID != passID || event.Status != "pending" {
		t.Fatalf("unexpected first-paid outbox event: %+v", event)
	}
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
