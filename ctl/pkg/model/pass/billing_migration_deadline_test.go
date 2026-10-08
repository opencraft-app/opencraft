package pass_test

import (
	"testing"
	"time"

	pass "ctl/pkg/model/pass"
	"ctl/test/testutil"
)

func TestExtendExpiredTimeForBillingMigrationOnlyUpdatesExpiredActiveFreePass(t *testing.T) {
	testutil.NewSQLiteDB(t, &pass.Entity{})
	dao := pass.NewDao()
	now := time.Now().UTC().Truncate(time.Second)
	target := now.Add(24 * time.Hour)
	for _, tc := range []struct {
		id      string
		bundle  string
		status  string
		expires time.Time
		want    bool
	}{
		{"expired-free", "bundle_free_trial_01", pass.StatusActive, now.Add(-45 * 24 * time.Hour), true},
		{"future-free", "bundle_free_trial_01", pass.StatusActive, now.Add(24 * time.Hour), false},
		{"isolated-free", "bundle_free_trial_01", pass.StatusIsolated, now.Add(-45 * 24 * time.Hour), false},
		{"expired-paid", "bundle_launch_01", pass.StatusActive, now.Add(-45 * 24 * time.Hour), false},
	} {
		if err := dao.Create(&pass.Entity{
			PassID: tc.id, UserID: "user-" + tc.id, BundleID: tc.bundle,
			Status: tc.status, ExpiredTime: tc.expires,
		}); err != nil {
			t.Fatalf("seed %s: %v", tc.id, err)
		}
		updated, err := dao.ExtendExpiredTimeForBillingMigration(tc.id, "bundle_free_trial_01", now, target)
		if err != nil || updated != tc.want {
			t.Fatalf("extend %s: updated=%v err=%v want=%v", tc.id, updated, err, tc.want)
		}
		stored, err := dao.GetByPassID(tc.id)
		if err != nil {
			t.Fatalf("read %s: %v", tc.id, err)
		}
		wantExpiry := tc.expires
		if tc.want {
			wantExpiry = target
		}
		if !stored.ExpiredTime.Equal(wantExpiry) || stored.Status != tc.status {
			t.Fatalf("pass %s changed unexpectedly: %+v", tc.id, stored)
		}
	}
}
