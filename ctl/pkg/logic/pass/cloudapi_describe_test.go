package pass

import (
	"testing"
	"time"

	"ctl/pkg/model"
	passmodel "ctl/pkg/model/pass"
	"ctl/pkg/resource"
	"ctl/test/testutil"
)

func TestDescribePassByCloudAccountAllowsEmptyPassID(t *testing.T) {
	originalDB := resource.GormDB
	t.Cleanup(func() { resource.GormDB = originalDB })
	testutil.NewSQLiteDB(t, &passmodel.Entity{})

	expired := time.Date(2026, time.September, 7, 9, 52, 15, 0, time.UTC)
	if err := passmodel.NewDao().Create(&passmodel.Entity{
		PassID:      "pass-cloudapi-empty-passid",
		UserID:      "usr-cloudapi-empty-passid",
		BundleID:    "bundle_launch_01",
		Uin:         330500000012,
		AppID:       1451613645,
		ExpiredTime: expired,
		RenewFlag:   passmodel.RenewFlagManual,
		Status:      passmodel.StatusActive,
	}); err != nil {
		t.Fatalf("seed pass: %v", err)
	}

	detail, err := NewLogic().DescribePassByCloudAccount(330500000012, 1451613645, "")
	if err != nil {
		t.Fatalf("DescribePassByCloudAccount: %v", err)
	}
	if detail.PassID != "pass-cloudapi-empty-passid" || detail.Uin != 330500000012 || detail.AppID != 1451613645 {
		t.Fatalf("unexpected pass detail: %+v", detail)
	}
}

func TestDescribePassByCloudAccountAllowsEmptyAppID(t *testing.T) {
	originalDB := resource.GormDB
	t.Cleanup(func() { resource.GormDB = originalDB })
	testutil.NewSQLiteDB(t, &passmodel.Entity{})

	older := time.Date(2026, time.September, 7, 9, 0, 0, 0, time.UTC)
	newer := older.Add(time.Hour)
	for _, entity := range []*passmodel.Entity{
		{
			BaseEntity:  model.BaseEntity{CreatedTime: &older},
			PassID:      "pass-cloudapi-older",
			UserID:      "usr-cloudapi-by-uin",
			BundleID:    "bundle_launch_01",
			Uin:         330500000013,
			AppID:       1451613645,
			ExpiredTime: newer.Add(24 * time.Hour),
			RenewFlag:   passmodel.RenewFlagManual,
			Status:      passmodel.StatusActive,
		},
		{
			BaseEntity:  model.BaseEntity{CreatedTime: &newer},
			PassID:      "pass-cloudapi-newer",
			UserID:      "usr-cloudapi-by-uin",
			BundleID:    "bundle_launch_01",
			Uin:         330500000013,
			AppID:       1451613646,
			ExpiredTime: newer.Add(24 * time.Hour),
			RenewFlag:   passmodel.RenewFlagManual,
			Status:      passmodel.StatusActive,
		},
	} {
		if err := passmodel.NewDao().Create(entity); err != nil {
			t.Fatalf("seed pass %s: %v", entity.PassID, err)
		}
	}

	detail, err := NewLogic().DescribePassByCloudAccount(330500000013, 0, "")
	if err != nil {
		t.Fatalf("DescribePassByCloudAccount: %v", err)
	}
	if detail.PassID != "pass-cloudapi-newer" || detail.AppID != 1451613646 {
		t.Fatalf("expected latest pass for Uin, got %+v", detail)
	}
}
