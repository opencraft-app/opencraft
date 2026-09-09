package store

import (
	"context"
	"regexp"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
)

func TestAllocatePackageAutoIDReusesDealAllocation(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	query := regexp.QuoteMeta(`
		INSERT INTO credit_package_id_allocation (deal_name, created_time)
		VALUES (?, ?)
		ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)
	`)
	for range 2 {
		mock.ExpectExec(query).
			WithArgs("deal-1", sqlmock.AnyArg()).
			WillReturnResult(sqlmock.NewResult(17, 1))
	}

	st := &MySQLStore{db: db}
	for i := range 2 {
		got, err := st.AllocatePackageAutoID(context.Background(), "deal-1")
		if err != nil {
			t.Fatalf("allocation %d: %v", i+1, err)
		}
		if got != 17 {
			t.Fatalf("allocation %d = %d, want 17", i+1, got)
		}
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("SQL expectations: %v", err)
	}
}

func TestAllocatePackageAutoIDRejectsEmptyDealName(t *testing.T) {
	st := &MySQLStore{}
	if _, err := st.AllocatePackageAutoID(context.Background(), "  "); err == nil {
		t.Fatal("empty deal name must fail")
	}
}

func TestTryClaimExpiredPackageClaimsActiveOrStaleTerminatingRow(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()
	now := time.Date(2026, 9, 8, 10, 0, 0, 0, time.UTC)
	staleBefore := now.Add(-30 * time.Second)
	mock.ExpectExec(regexp.QuoteMeta(`
		UPDATE credit_package
		   SET status = ?, updated_time = ?
		 WHERE package_id = ?
		   AND expired_time <= ?
		   AND (status = ? OR (status = ? AND updated_time <= ?))
	`)).WithArgs(
		PackageStatusTerminating, now, "cpkg-expired", now,
		PackageStatusActive, PackageStatusTerminating, staleBefore,
	).WillReturnResult(sqlmock.NewResult(0, 1))

	claimed, err := (&MySQLStore{db: db}).TryClaimExpiredPackage(context.Background(), "cpkg-expired", now, staleBefore)
	if err != nil || !claimed {
		t.Fatalf("TryClaimExpiredPackage() claimed=%v err=%v", claimed, err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("SQL expectations: %v", err)
	}
}

func TestReleaseExpiredPackageClaimReturnsPackageToActive(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()
	claimedAt := time.Date(2026, 9, 8, 10, 0, 0, 0, time.UTC)
	mock.ExpectExec(regexp.QuoteMeta(`
		UPDATE credit_package
		   SET status = ?, updated_time = ?
		 WHERE package_id = ? AND status = ? AND updated_time = ?
	`)).WithArgs(
		PackageStatusActive, claimedAt, "cpkg-expired", PackageStatusTerminating, claimedAt,
	).WillReturnResult(sqlmock.NewResult(0, 1))

	released, err := (&MySQLStore{db: db}).ReleaseExpiredPackageClaim(context.Background(), "cpkg-expired", claimedAt)
	if err != nil || !released {
		t.Fatalf("ReleaseExpiredPackageClaim() released=%v err=%v", released, err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("SQL expectations: %v", err)
	}
}

func TestMovePackageToHistoryArchivesUsageInSameTransaction(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()
	now := time.Date(2026, 9, 8, 10, 0, 0, 0, time.UTC)
	columns := []string{
		"id", "package_id", "user_id", "product_id", "uin", "app_id", "deal_name", "big_order_id",
		"llm_gateway_plan_id", "llm_subscription_id", "llm_subscription_name", "created_time", "expired_time",
		"isolated_time", "status", "updated_time",
	}
	rows := sqlmock.NewRows(columns).AddRow(
		1, "cpkg-expired", "usr_1", "credit_100", "700000164995", 1300000001, "deal-1", "big-1",
		"plan-1", "sub-1", "credit-package:cpkg-expired", now.Add(-time.Hour), now, nil,
		PackageStatusTerminating, now,
	)
	mock.ExpectBegin()
	mock.ExpectQuery(regexp.QuoteMeta(packageSelectSQL() + ` WHERE package_id = ? FOR UPDATE`)).
		WithArgs("cpkg-expired").WillReturnRows(rows)
	mock.ExpectExec("INSERT INTO history_credit_package_usage").
		WithArgs(now, "expired", "cpkg-expired").WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectExec(regexp.QuoteMeta(`DELETE FROM credit_package_usage WHERE package_id = ?`)).
		WithArgs("cpkg-expired").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec("INSERT INTO history_credit_package").WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectExec(regexp.QuoteMeta(`DELETE FROM credit_package WHERE package_id = ?`)).
		WithArgs("cpkg-expired").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()

	err = (&MySQLStore{db: db}).MovePackageToHistory(context.Background(), "cpkg-expired", now, "expired", nil)
	if err != nil {
		t.Fatalf("MovePackageToHistory(): %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("SQL expectations: %v", err)
	}
}
