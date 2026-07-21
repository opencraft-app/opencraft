package pass

import (
	"testing"
	"time"

	passmodel "ctl/pkg/model/pass"
	passmigrationmodel "ctl/pkg/model/passbillingmigration"
	"ctl/pkg/resource"
	"ctl/pkg/transport"
	"ctl/test/testutil"
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
