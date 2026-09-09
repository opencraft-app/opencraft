package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/go-sql-driver/mysql"
)

type Store interface {
	GetProductByID(context.Context, string) (*CreditProduct, error)
	ListOnlineProducts(context.Context) ([]CreditProduct, error)
	CreatePackageWithUsage(context.Context, *CreditPackage, *CreditPackageUsage) error
	GetPackageByID(context.Context, string) (*CreditPackage, error)
	GetPackageByDealName(context.Context, string) (*CreditPackage, error)
	GetPackageBySubscriptionName(context.Context, string) (*CreditPackage, error)
	ListPackageAppIDs(context.Context, []string, int, int) ([]int64, int64, error)
	ListPackagesByOwner(context.Context, string, int64, []string, int, int) ([]*CreditPackage, int64, error)
	MovePackageToHistory(context.Context, string, time.Time, string, *time.Time) error
}

type MySQLStore struct {
	db *sql.DB
}

var _ Store = (*MySQLStore)(nil)

func NewMySQLStore(dsn string) (*MySQLStore, error) {
	cfg, err := mysql.ParseDSN(strings.TrimSpace(dsn))
	if err != nil {
		return nil, fmt.Errorf("parse mysql dsn: %w", err)
	}
	cfg.ParseTime = true
	cfg.Loc = time.UTC
	if cfg.Params == nil {
		cfg.Params = make(map[string]string)
	}
	cfg.Params["time_zone"] = "'+00:00'"
	db, err := sql.Open("mysql", cfg.FormatDSN())
	if err != nil {
		return nil, fmt.Errorf("open mysql: %w", err)
	}
	if err := db.Ping(); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("ping mysql: %w", err)
	}
	return &MySQLStore{db: db}, nil
}

func (s *MySQLStore) Close() error {
	if s == nil || s.db == nil {
		return nil
	}
	return s.db.Close()
}

// AllocatePackageAutoID atomically allocates one numeric ID per billing deal.
// LAST_INSERT_ID(id) makes duplicate callbacks return the existing allocation.
func (s *MySQLStore) AllocatePackageAutoID(ctx context.Context, dealName string) (int64, error) {
	if s == nil || s.db == nil {
		return 0, fmt.Errorf("credit store is nil")
	}
	dealName = strings.TrimSpace(dealName)
	if dealName == "" {
		return 0, fmt.Errorf("deal_name is required")
	}
	result, err := s.db.ExecContext(ctx, `
		INSERT INTO credit_package_id_allocation (deal_name, created_time)
		VALUES (?, ?)
		ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)
	`, dealName, time.Now().UTC())
	if err != nil {
		return 0, fmt.Errorf("allocate credit package id: %w", err)
	}
	autoID, err := result.LastInsertId()
	if err != nil {
		return 0, fmt.Errorf("read credit package auto id: %w", err)
	}
	if autoID <= 0 {
		return 0, fmt.Errorf("invalid credit package auto id: %d", autoID)
	}
	return autoID, nil
}

func (s *MySQLStore) GetProductByID(ctx context.Context, productID string) (*CreditProduct, error) {
	if s == nil || s.db == nil {
		return nil, fmt.Errorf("credit store is nil")
	}
	row := s.db.QueryRowContext(ctx, `
		SELECT id, product_id, product_name, llm_gateway_plan_id, state, created_time, updated_time
		  FROM credit_product
		 WHERE product_id = ?
	`, strings.TrimSpace(productID))
	product, err := scanProduct(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrProductNotFound
	}
	if err != nil {
		return nil, err
	}
	return &product, nil
}

func (s *MySQLStore) ListOnlineProducts(ctx context.Context) ([]CreditProduct, error) {
	if s == nil || s.db == nil {
		return nil, fmt.Errorf("credit store is nil")
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, product_id, product_name, llm_gateway_plan_id, state, created_time, updated_time
		  FROM credit_product
		 WHERE state = ?
		 ORDER BY id ASC
	`, ProductStateOnline)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	products := make([]CreditProduct, 0)
	for rows.Next() {
		product, scanErr := scanProduct(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		products = append(products, product)
	}
	return products, rows.Err()
}

func (s *MySQLStore) CreatePackageWithUsage(ctx context.Context, pkg *CreditPackage, usage *CreditPackageUsage) error {
	if s == nil || s.db == nil {
		return fmt.Errorf("credit store is nil")
	}
	if pkg == nil {
		return fmt.Errorf("credit package is nil")
	}
	if usage == nil {
		return fmt.Errorf("credit package usage is nil")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `
		INSERT INTO credit_package (
			package_id, user_id, product_id, uin, app_id, deal_name, big_order_id,
			llm_gateway_plan_id, llm_subscription_id, llm_subscription_name,
			created_time, expired_time, isolated_time, status, updated_time
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, pkg.PackageID, pkg.UserID, pkg.ProductID, pkg.Uin, pkg.AppID, pkg.DealName, pkg.BigOrderID,
		pkg.LLMGatewayPlanID, pkg.LLMSubscriptionID, pkg.LLMSubscriptionName,
		pkg.CreatedTime.UTC(), pkg.ExpiredTime.UTC(), pkg.IsolatedTime, pkg.Status, pkg.UpdatedTime.UTC()); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `
		INSERT INTO credit_package_usage (
			package_id, user_id, product_id, deal_name, uin, app_id,
			usage_date, calc_date, package_expired_time,
			credit_total, credit_used_total, credit_used_day, credit_left,
			snapshot_time, push_status, push_attempts, next_retry_time, lease_owner,
			last_error, request_payload, response_payload, sent_time, created_time, updated_time
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, usage.PackageID, usage.UserID, usage.ProductID, usage.DealName, usage.Uin, usage.AppID,
		usage.UsageDate, usage.CalcDate, usage.PackageExpiredTime.UTC(),
		usage.CreditTotal, usage.CreditUsedTotal, usage.CreditUsedDay, usage.CreditLeft,
		usage.SnapshotTime.UTC(), usage.PushStatus, usage.PushAttempts, usage.NextRetryTime.UTC(), usage.LeaseOwner,
		usage.LastError, nullableJSON(usage.RequestPayload), nullableJSON(usage.ResponsePayload), usage.SentTime,
		usage.CreatedTime.UTC(), usage.UpdatedTime.UTC()); err != nil {
		return err
	}
	return tx.Commit()
}

func nullableJSON(value []byte) any {
	if len(value) == 0 {
		return nil
	}
	return value
}

func (s *MySQLStore) GetPackageByID(ctx context.Context, packageID string) (*CreditPackage, error) {
	if s == nil || s.db == nil {
		return nil, fmt.Errorf("credit store is nil")
	}
	row := s.db.QueryRowContext(ctx, packageSelectSQL()+` WHERE package_id = ?`, strings.TrimSpace(packageID))
	pkg, err := scanPackage(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrPackageNotFound
	}
	if err != nil {
		return nil, err
	}
	return &pkg, nil
}

func (s *MySQLStore) GetPackageByDealName(ctx context.Context, dealName string) (*CreditPackage, error) {
	if s == nil || s.db == nil {
		return nil, fmt.Errorf("credit store is nil")
	}
	row := s.db.QueryRowContext(ctx, packageSelectSQL()+` WHERE deal_name = ?`, strings.TrimSpace(dealName))
	pkg, err := scanPackage(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrPackageNotFound
	}
	if err != nil {
		return nil, err
	}
	return &pkg, nil
}

func (s *MySQLStore) GetPackageBySubscriptionName(ctx context.Context, subscriptionName string) (*CreditPackage, error) {
	if s == nil || s.db == nil {
		return nil, fmt.Errorf("credit store is nil")
	}
	row := s.db.QueryRowContext(ctx, packageSelectSQL()+` WHERE llm_subscription_name = ?`, strings.TrimSpace(subscriptionName))
	pkg, err := scanPackage(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrPackageNotFound
	}
	if err != nil {
		return nil, err
	}
	return &pkg, nil
}

func (s *MySQLStore) ListPackageAppIDs(ctx context.Context, productIDs []string, pageNo, pageSize int) ([]int64, int64, error) {
	if s == nil || s.db == nil {
		return nil, 0, fmt.Errorf("credit store is nil")
	}
	filter, args := productIDsFilter(productIDs)
	var total int64
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(DISTINCT app_id) FROM credit_package`+filter, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	queryArgs := append(append([]any{}, args...), pageSize, pageNo*pageSize)
	rows, err := s.db.QueryContext(ctx, `
		SELECT DISTINCT app_id
		  FROM credit_package`+filter+`
		 ORDER BY app_id ASC
		 LIMIT ? OFFSET ?
	`, queryArgs...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	appIDs := make([]int64, 0)
	for rows.Next() {
		var appID int64
		if err := rows.Scan(&appID); err != nil {
			return nil, 0, err
		}
		appIDs = append(appIDs, appID)
	}
	return appIDs, total, rows.Err()
}

func (s *MySQLStore) ListPackagesByOwner(
	ctx context.Context,
	uin string,
	appID int64,
	productIDs []string,
	pageNo, pageSize int,
) ([]*CreditPackage, int64, error) {
	if s == nil || s.db == nil {
		return nil, 0, fmt.Errorf("credit store is nil")
	}
	productFilter, productArgs := productIDsFilter(productIDs)
	filter := ` WHERE uin = ? AND app_id = ?`
	if productFilter != "" {
		filter += ` AND ` + strings.TrimPrefix(productFilter, ` WHERE `)
	}
	args := []any{strings.TrimSpace(uin), appID}
	args = append(args, productArgs...)
	var total int64
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM credit_package`+filter, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	queryArgs := append(append([]any{}, args...), pageSize, pageNo*pageSize)
	rows, err := s.db.QueryContext(ctx, packageSelectSQL()+filter+`
		 ORDER BY expired_time ASC, package_id ASC
		 LIMIT ? OFFSET ?
	`, queryArgs...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	packages := make([]*CreditPackage, 0)
	for rows.Next() {
		pkg, err := scanPackage(rows)
		if err != nil {
			return nil, 0, err
		}
		packages = append(packages, &pkg)
	}
	return packages, total, rows.Err()
}

func (s *MySQLStore) ListExpiredPackages(
	ctx context.Context,
	now time.Time,
	staleBefore time.Time,
	limit int,
) ([]*CreditPackage, error) {
	if s == nil || s.db == nil {
		return nil, fmt.Errorf("credit store is nil")
	}
	rows, err := s.db.QueryContext(ctx, packageSelectSQL()+`
		 WHERE expired_time <= ?
		   AND (status = ? OR (status = ? AND updated_time <= ?))
		 ORDER BY expired_time ASC, id ASC
		 LIMIT ?
	`, now.UTC(), PackageStatusActive, PackageStatusTerminating, staleBefore.UTC(), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	packages := make([]*CreditPackage, 0)
	for rows.Next() {
		pkg, err := scanPackage(rows)
		if err != nil {
			return nil, err
		}
		packages = append(packages, &pkg)
	}
	return packages, rows.Err()
}

func (s *MySQLStore) TryClaimExpiredPackage(
	ctx context.Context,
	packageID string,
	now time.Time,
	staleBefore time.Time,
) (bool, error) {
	if s == nil || s.db == nil {
		return false, fmt.Errorf("credit store is nil")
	}
	result, err := s.db.ExecContext(ctx, `
		UPDATE credit_package
		   SET status = ?, updated_time = ?
		 WHERE package_id = ?
		   AND expired_time <= ?
		   AND (status = ? OR (status = ? AND updated_time <= ?))
	`, PackageStatusTerminating, now.UTC(), strings.TrimSpace(packageID), now.UTC(),
		PackageStatusActive, PackageStatusTerminating, staleBefore.UTC())
	if err != nil {
		return false, err
	}
	affected, err := result.RowsAffected()
	return affected == 1, err
}

func (s *MySQLStore) ReleaseExpiredPackageClaim(ctx context.Context, packageID string, claimedAt time.Time) (bool, error) {
	if s == nil || s.db == nil {
		return false, fmt.Errorf("credit store is nil")
	}
	result, err := s.db.ExecContext(ctx, `
		UPDATE credit_package
		   SET status = ?, updated_time = ?
		 WHERE package_id = ? AND status = ? AND updated_time = ?
	`, PackageStatusActive, claimedAt.UTC(), strings.TrimSpace(packageID), PackageStatusTerminating, claimedAt.UTC())
	if err != nil {
		return false, err
	}
	affected, err := result.RowsAffected()
	return affected == 1, err
}

func productIDsFilter(productIDs []string) (string, []any) {
	values := make([]string, 0, len(productIDs))
	for _, productID := range productIDs {
		if value := strings.TrimSpace(productID); value != "" {
			values = append(values, value)
		}
	}
	if len(values) == 0 {
		return "", nil
	}
	placeholders := strings.TrimRight(strings.Repeat("?,", len(values)), ",")
	args := make([]any, 0, len(values))
	for _, value := range values {
		args = append(args, value)
	}
	return ` WHERE product_id IN (` + placeholders + `)`, args
}

func (s *MySQLStore) MovePackageToHistory(
	ctx context.Context,
	packageID string,
	deletedAt time.Time,
	reason string,
	isolatedAt *time.Time,
) error {
	if s == nil || s.db == nil {
		return fmt.Errorf("credit store is nil")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	pkg, err := scanPackage(tx.QueryRowContext(ctx, packageSelectSQL()+` WHERE package_id = ? FOR UPDATE`, strings.TrimSpace(packageID)))
	if errors.Is(err, sql.ErrNoRows) {
		var exists int
		if err := tx.QueryRowContext(ctx, `SELECT 1 FROM history_credit_package WHERE package_id = ?`, strings.TrimSpace(packageID)).Scan(&exists); err == nil {
			return tx.Commit()
		}
		return ErrPackageNotFound
	}
	if err != nil {
		return err
	}
	if isolatedAt != nil {
		value := isolatedAt.UTC()
		pkg.IsolatedTime = &value
	}
	pkg.Status = PackageStatusDeleted
	if _, err = tx.ExecContext(ctx, `
		INSERT INTO history_credit_package_usage (
			package_id, user_id, product_id, deal_name, uin, app_id,
			usage_date, calc_date, package_expired_time,
			credit_total, credit_used_total, credit_used_day, credit_left,
			snapshot_time, push_status, push_attempts, next_retry_time, lease_owner,
			last_error, request_payload, response_payload, sent_time, created_time, updated_time,
			archived_time, archive_reason
		)
		SELECT package_id, user_id, product_id, deal_name, uin, app_id,
		       usage_date, calc_date, package_expired_time,
		       credit_total, credit_used_total, credit_used_day, credit_left,
		       snapshot_time, push_status, push_attempts, next_retry_time, lease_owner,
		       last_error, request_payload, response_payload, sent_time, created_time, updated_time,
		       ?, ?
		  FROM credit_package_usage WHERE package_id = ?
		ON DUPLICATE KEY UPDATE archived_time = VALUES(archived_time), archive_reason = VALUES(archive_reason)
	`, deletedAt.UTC(), strings.TrimSpace(reason), pkg.PackageID); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `DELETE FROM credit_package_usage WHERE package_id = ?`, pkg.PackageID); err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `
		INSERT INTO history_credit_package (
			package_id, user_id, product_id, uin, app_id, deal_name, big_order_id,
			llm_gateway_plan_id, llm_subscription_id, llm_subscription_name,
			created_time, expired_time, isolated_time, deleted_time, destroy_reason, status
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON DUPLICATE KEY UPDATE deleted_time = VALUES(deleted_time)
	`, pkg.PackageID, pkg.UserID, pkg.ProductID, pkg.Uin, pkg.AppID, pkg.DealName, pkg.BigOrderID,
		pkg.LLMGatewayPlanID, pkg.LLMSubscriptionID, pkg.LLMSubscriptionName,
		pkg.CreatedTime.UTC(), pkg.ExpiredTime.UTC(), pkg.IsolatedTime, deletedAt.UTC(), reason, PackageStatusDeleted)
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM credit_package WHERE package_id = ?`, pkg.PackageID); err != nil {
		return err
	}
	return tx.Commit()
}

type scanner interface {
	Scan(dest ...any) error
}

func scanProduct(row scanner) (CreditProduct, error) {
	var product CreditProduct
	err := row.Scan(&product.ID, &product.ProductID, &product.ProductName,
		&product.LLMGatewayPlanID, &product.State, &product.CreatedTime, &product.UpdatedTime)
	return product, err
}

func packageSelectSQL() string {
	return `
		SELECT id, package_id, user_id, product_id, uin, app_id, deal_name, big_order_id,
		       llm_gateway_plan_id, llm_subscription_id, llm_subscription_name,
		       created_time, expired_time, isolated_time, status, updated_time
		  FROM credit_package
	`
}

func scanPackage(row scanner) (CreditPackage, error) {
	var pkg CreditPackage
	err := row.Scan(&pkg.ID, &pkg.PackageID, &pkg.UserID, &pkg.ProductID, &pkg.Uin, &pkg.AppID,
		&pkg.DealName, &pkg.BigOrderID, &pkg.LLMGatewayPlanID, &pkg.LLMSubscriptionID,
		&pkg.LLMSubscriptionName, &pkg.CreatedTime, &pkg.ExpiredTime,
		&pkg.IsolatedTime, &pkg.Status, &pkg.UpdatedTime)
	return pkg, err
}
