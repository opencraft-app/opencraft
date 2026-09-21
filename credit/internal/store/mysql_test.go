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

func TestListAdminPackagesFiltersAndReturnsUsage(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	filter := AdminPackageFilter{
		UserID: "usr_1", PackageID: "cpkg-1", ProductID: "credit_1000",
		Status: PackageStatusActive, Page: 2, PageSize: 50,
	}
	mock.ExpectQuery(regexp.QuoteMeta(
		"SELECT COUNT(*) FROM credit_package cp WHERE cp.user_id = ? AND cp.package_id = ? AND cp.product_id = ? AND cp.status = ?",
	)).WithArgs("usr_1", "cpkg-1", "credit_1000", PackageStatusActive).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(1))

	now := time.Date(2026, 9, 18, 8, 0, 0, 0, time.UTC)
	columns := []string{
		"id", "package_id", "user_id", "product_id", "uin", "app_id", "deal_name", "big_order_id",
		"llm_gateway_plan_id", "llm_subscription_id", "llm_subscription_name", "created_time", "expired_time",
		"isolated_time", "status", "updated_time", "product_name", "credit_total", "credit_used_total", "credit_left",
	}
	rows := sqlmock.NewRows(columns).AddRow(
		1, "cpkg-1", "usr_1", "credit_1000", "330500000005", 260203940, "deal-1", "big-1",
		"plan-1", "sub-1", "credit-package:cpkg-1", now, now.Add(30*24*time.Hour), nil,
		PackageStatusActive, now, "1000积分", "1000.0000", "125.5000", "874.5000",
	)
	mock.ExpectQuery(`(?s)FROM credit_package cp.*LEFT JOIN credit_product p.*LEFT JOIN credit_package_usage u.*WHERE cp.user_id = \? AND cp.package_id = \? AND cp.product_id = \? AND cp.status = \?.*LIMIT \? OFFSET \?`).
		WithArgs("usr_1", "cpkg-1", "credit_1000", PackageStatusActive, 50, 50).
		WillReturnRows(rows)

	items, total, err := (&MySQLStore{db: db}).ListAdminPackages(context.Background(), filter)
	if err != nil {
		t.Fatalf("ListAdminPackages(): %v", err)
	}
	if total != 1 || len(items) != 1 {
		t.Fatalf("total=%d items=%d", total, len(items))
	}
	if items[0].ProductName != "1000积分" || items[0].CreditUsedTotal.String() != "125.5000" || items[0].CreditLeft.String() != "874.5000" {
		t.Fatalf("item=%+v", items[0])
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("SQL expectations: %v", err)
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
