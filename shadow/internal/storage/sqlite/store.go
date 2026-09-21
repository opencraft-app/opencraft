package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"

	_ "modernc.org/sqlite"

	"shadow/internal/storage"
)

type Store struct {
	db *sql.DB
}

func NewStore(dsn string) (*Store, error) {
	if dsn == "" {
		return nil, errors.New("sqlite dsn is required")
	}
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	store := &Store{db: db}
	if err := store.init(context.Background()); err != nil {
		_ = db.Close()
		return nil, err
	}
	return store, nil
}

func (s *Store) init(ctx context.Context) error {
	stmts := []string{
		`PRAGMA journal_mode = WAL;`,
		// Keep the legacy org_id columns for SQLite compatibility with older local databases.
		// The standalone shadow service no longer models org_id in its business API.
		`CREATE TABLE IF NOT EXISTS users (
				id TEXT PRIMARY KEY,
				country_code TEXT NOT NULL,
				phone_number TEXT NOT NULL,
				is_register_shadow_account INTEGER NOT NULL DEFAULT 0,
				is_shadow_account_basic_auth INTEGER NOT NULL DEFAULT 0,
				is_standard_realname_auth INTEGER NOT NULL DEFAULT 0,
				created_at_ns INTEGER NOT NULL,
				UNIQUE(country_code, phone_number)
			);`,
		`CREATE TABLE IF NOT EXISTS bindings (
			user_id TEXT PRIMARY KEY,
			shadow_user_name TEXT NOT NULL UNIQUE,
			uin INTEGER NOT NULL,
			owner_uin INTEGER NOT NULL,
			app_id INTEGER NOT NULL,
			org_id TEXT NOT NULL DEFAULT '',
			instance_id TEXT NOT NULL,
			country_code TEXT NOT NULL,
			phone_number TEXT NOT NULL,
			created_at_ns INTEGER NOT NULL
		);`,
		`CREATE TABLE IF NOT EXISTS auth_codes (
				code TEXT PRIMARY KEY,
				user_id TEXT NOT NULL,
				expires_at_ns INTEGER NOT NULL
			);`,
		`CREATE TABLE IF NOT EXISTS free_trial_order_checkpoints (
				user_id TEXT PRIMARY KEY,
				big_deal_id TEXT NOT NULL,
				deal_name TEXT NOT NULL,
				instance_id TEXT NOT NULL,
				org_id TEXT NOT NULL DEFAULT '',
				app_id INTEGER NOT NULL,
				created_at_ns INTEGER NOT NULL
			);`,
		`CREATE TABLE IF NOT EXISTS pending_free_trial_orders (
				owner_uin INTEGER PRIMARY KEY,
				user_id TEXT NOT NULL,
				app_id INTEGER NOT NULL,
				big_deal_id TEXT NOT NULL,
				deal_name TEXT NOT NULL DEFAULT '',
				instance_id TEXT NOT NULL DEFAULT '',
				org_id TEXT NOT NULL DEFAULT '',
				status TEXT NOT NULL,
				created_at_ns INTEGER NOT NULL,
				updated_at_ns INTEGER NOT NULL
			);`,
		`CREATE TABLE IF NOT EXISTS appid_phone_bindings (
				app_id INTEGER PRIMARY KEY,
				country_code TEXT NOT NULL,
				phone_number TEXT NOT NULL,
				updated_at_ns INTEGER NOT NULL
			);`,
		`CREATE TABLE IF NOT EXISTS package_products (
				code TEXT PRIMARY KEY,
				display_name TEXT NOT NULL,
				credit_amount INTEGER NOT NULL,
				currency TEXT NOT NULL,
				billing_goods_category_id INTEGER NOT NULL,
				billing_region TEXT NOT NULL,
				billing_zone TEXT NOT NULL,
				billing_pay_mode TEXT NOT NULL,
				product_code TEXT NOT NULL DEFAULT '',
				sub_product_code TEXT NOT NULL DEFAULT '',
				billing_item_type_code TEXT NOT NULL DEFAULT '',
				billing_item_code TEXT NOT NULL DEFAULT '',
				billing_pid INTEGER NOT NULL DEFAULT 0,
				billing_time_unit TEXT NOT NULL DEFAULT 'm',
				billing_time_span INTEGER NOT NULL DEFAULT 1,
				billing_action TEXT NOT NULL DEFAULT 'purchase',
				billing_extra_params_json TEXT NOT NULL DEFAULT '',
				billing_goods_detail_json TEXT NOT NULL,
				requires_standard_realname INTEGER NOT NULL DEFAULT 0,
				enabled INTEGER NOT NULL,
				metadata_json TEXT NOT NULL DEFAULT '',
				created_at_ns INTEGER NOT NULL,
				updated_at_ns INTEGER NOT NULL
			);`,
		`CREATE TABLE IF NOT EXISTS package_orders (
				id TEXT PRIMARY KEY,
				user_id TEXT NOT NULL,
				product_code TEXT NOT NULL,
				amount INTEGER NOT NULL,
				currency TEXT NOT NULL,
				status TEXT NOT NULL,
				billing_big_order_id TEXT NOT NULL DEFAULT '',
				billing_order_ids_json TEXT NOT NULL DEFAULT '[]',
				pay_url TEXT NOT NULL DEFAULT '',
				need_charge INTEGER NOT NULL DEFAULT 0,
				client_token TEXT NOT NULL,
				payment_confirmation_key TEXT NOT NULL,
				billing_request_json TEXT NOT NULL DEFAULT '',
				billing_response_json TEXT NOT NULL DEFAULT '',
				paid_at_ns INTEGER NOT NULL DEFAULT 0,
				cancelled_at_ns INTEGER NOT NULL DEFAULT 0,
				created_at_ns INTEGER NOT NULL,
				updated_at_ns INTEGER NOT NULL
			);`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_package_orders_client_token ON package_orders (client_token);`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_package_orders_confirmation_key ON package_orders (payment_confirmation_key);`,
		`CREATE TABLE IF NOT EXISTS wallet_accounts (
				user_id TEXT PRIMARY KEY,
				available_amount INTEGER NOT NULL,
				frozen_amount INTEGER NOT NULL,
				currency TEXT NOT NULL,
				version INTEGER NOT NULL,
				created_at_ns INTEGER NOT NULL,
				updated_at_ns INTEGER NOT NULL
			);`,
		`CREATE TABLE IF NOT EXISTS wallet_ledger_entries (
				id TEXT PRIMARY KEY,
				user_id TEXT NOT NULL,
				order_id TEXT NOT NULL,
				type TEXT NOT NULL,
				amount_delta INTEGER NOT NULL,
				before_balance INTEGER NOT NULL,
				after_balance INTEGER NOT NULL,
				reason TEXT NOT NULL,
				external_refs_json TEXT NOT NULL DEFAULT '',
				idempotency_key TEXT NOT NULL UNIQUE,
				created_at_ns INTEGER NOT NULL
			);`,
	}
	for _, stmt := range stmts {
		if _, err := s.db.ExecContext(ctx, stmt); err != nil {
			return err
		}
	}
	if err := ensureColumn(ctx, s.db, "users", "is_register_shadow_account", "INTEGER NOT NULL DEFAULT 0"); err != nil {
		return err
	}
	if err := ensureColumn(ctx, s.db, "users", "is_shadow_account_basic_auth", "INTEGER NOT NULL DEFAULT 0"); err != nil {
		return err
	}
	if err := ensureColumn(ctx, s.db, "users", "is_standard_realname_auth", "INTEGER NOT NULL DEFAULT 0"); err != nil {
		return err
	}
	if err := ensureColumn(ctx, s.db, "package_products", "product_code", "TEXT NOT NULL DEFAULT ''"); err != nil {
		return err
	}
	if err := ensureColumn(ctx, s.db, "package_products", "sub_product_code", "TEXT NOT NULL DEFAULT ''"); err != nil {
		return err
	}
	if err := ensureColumn(ctx, s.db, "package_products", "billing_item_type_code", "TEXT NOT NULL DEFAULT ''"); err != nil {
		return err
	}
	if err := ensureColumn(ctx, s.db, "package_products", "billing_item_code", "TEXT NOT NULL DEFAULT ''"); err != nil {
		return err
	}
	if err := ensureColumn(ctx, s.db, "package_products", "billing_pid", "INTEGER NOT NULL DEFAULT 0"); err != nil {
		return err
	}
	if err := ensureColumn(ctx, s.db, "package_products", "billing_time_unit", "TEXT NOT NULL DEFAULT 'm'"); err != nil {
		return err
	}
	if err := ensureColumn(ctx, s.db, "package_products", "billing_time_span", "INTEGER NOT NULL DEFAULT 1"); err != nil {
		return err
	}
	if err := ensureColumn(ctx, s.db, "package_products", "billing_action", "TEXT NOT NULL DEFAULT 'purchase'"); err != nil {
		return err
	}
	if err := ensureColumn(ctx, s.db, "package_products", "billing_extra_params_json", "TEXT NOT NULL DEFAULT ''"); err != nil {
		return err
	}
	if err := ensureColumn(ctx, s.db, "package_products", "requires_standard_realname", "INTEGER NOT NULL DEFAULT 0"); err != nil {
		return err
	}
	return nil
}

func (s *Store) EnsureUser(ctx context.Context, userID, countryCode, phoneNumber string) (storage.User, bool, error) {
	user, err := s.GetUserByID(ctx, userID)
	if err == nil {
		if user.CountryCode != countryCode || user.PhoneNumber != phoneNumber {
			if err := s.UpdateUserPhone(ctx, userID, countryCode, phoneNumber); err != nil {
				return storage.User{}, false, err
			}
			user.CountryCode = countryCode
			user.PhoneNumber = phoneNumber
		}
		return user, false, nil
	}
	if !errors.Is(err, storage.ErrNotFound) {
		return storage.User{}, false, err
	}

	now := time.Now().UTC()
	_, err = s.db.ExecContext(ctx, `
		INSERT INTO users (id, country_code, phone_number, created_at_ns)
		VALUES (?, ?, ?, ?)`,
		userID, countryCode, phoneNumber, now.UnixNano(),
	)
	if err != nil {
		if isUniqueConstraint(err) {
			return storage.User{}, false, storage.ErrConflict
		}
		return storage.User{}, false, err
	}

	row := s.db.QueryRowContext(ctx, `
		SELECT id, country_code, phone_number, is_register_shadow_account, is_shadow_account_basic_auth, is_standard_realname_auth, created_at_ns
		FROM users
		WHERE id = ?
		LIMIT 1`,
		userID,
	)
	var createdUser storage.User
	var createdAtNS int64
	var isRegistered, isBasicAuth, isStandardRealname int64
	if err := row.Scan(&createdUser.ID, &createdUser.CountryCode, &createdUser.PhoneNumber, &isRegistered, &isBasicAuth, &isStandardRealname, &createdAtNS); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return storage.User{}, false, storage.ErrNotFound
		}
		return storage.User{}, false, err
	}
	createdUser.IsRegisterShadowAccount = isRegistered == 1
	createdUser.IsShadowAccountBasicAuth = isBasicAuth == 1
	createdUser.IsStandardRealnameAuth = isStandardRealname == 1
	createdUser.CreatedAt = time.Unix(0, createdAtNS).UTC()
	return createdUser, true, nil
}

func (s *Store) GetUserByID(ctx context.Context, id string) (storage.User, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT id, country_code, phone_number, is_register_shadow_account, is_shadow_account_basic_auth, is_standard_realname_auth, created_at_ns
		FROM users
		WHERE id = ?
		LIMIT 1`,
		id,
	)
	var user storage.User
	var createdAtNS int64
	var isRegistered, isBasicAuth, isStandardRealname int64
	if err := row.Scan(&user.ID, &user.CountryCode, &user.PhoneNumber, &isRegistered, &isBasicAuth, &isStandardRealname, &createdAtNS); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return storage.User{}, storage.ErrNotFound
		}
		return storage.User{}, err
	}
	user.IsRegisterShadowAccount = isRegistered == 1
	user.IsShadowAccountBasicAuth = isBasicAuth == 1
	user.IsStandardRealnameAuth = isStandardRealname == 1
	user.CreatedAt = time.Unix(0, createdAtNS).UTC()
	return user, nil
}

func (s *Store) MarkShadowAccountRegistered(ctx context.Context, userID string) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE users
		SET is_register_shadow_account = 1
		WHERE id = ?`,
		userID,
	)
	return err
}

func (s *Store) MarkShadowAccountBasicAuth(ctx context.Context, userID string) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE users
		SET is_shadow_account_basic_auth = 1
		WHERE id = ?`,
		userID,
	)
	return err
}

func (s *Store) MarkStandardRealnameAuth(ctx context.Context, userID string) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE users
		SET is_standard_realname_auth = 1
		WHERE id = ?`,
		userID,
	)
	return err
}

func (s *Store) UpdateUserPhone(ctx context.Context, userID, countryCode, phoneNumber string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() {
		_ = tx.Rollback()
	}()

	if _, err := tx.ExecContext(ctx, `
		UPDATE users
		SET country_code = ?, phone_number = ?
		WHERE id = ?`,
		countryCode, phoneNumber, userID,
	); err != nil {
		if isUniqueConstraint(err) {
			return storage.ErrConflict
		}
		return err
	}
	now := time.Now().UTC().UnixNano()
	if _, err := tx.ExecContext(ctx, `
		UPDATE bindings
		SET country_code = ?, phone_number = ?
		WHERE user_id = ?`,
		countryCode, phoneNumber, userID,
	); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO appid_phone_bindings (app_id, country_code, phone_number, updated_at_ns)
		SELECT app_id, ?, ?, ?
		FROM bindings
		WHERE user_id = ?
		ON CONFLICT(app_id) DO UPDATE SET
			country_code = excluded.country_code,
			phone_number = excluded.phone_number,
			updated_at_ns = excluded.updated_at_ns`,
		countryCode, phoneNumber, now, userID,
	); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) SaveBinding(ctx context.Context, binding storage.Binding) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO bindings (
			user_id, shadow_user_name, uin, owner_uin, app_id, org_id, instance_id,
			country_code, phone_number, created_at_ns
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(user_id) DO UPDATE SET
			shadow_user_name=excluded.shadow_user_name,
			uin=excluded.uin,
			owner_uin=excluded.owner_uin,
			app_id=excluded.app_id,
			org_id=excluded.org_id,
			instance_id=excluded.instance_id,
			country_code=excluded.country_code,
			phone_number=excluded.phone_number,
			created_at_ns=excluded.created_at_ns`,
		binding.UserID, binding.ShadowUserName, binding.Uin, binding.OwnerUin, binding.AppID,
		"", binding.InstanceID, binding.CountryCode, binding.PhoneNumber, binding.CreatedAt.UnixNano(),
	)
	return err
}

func (s *Store) SaveAppPhoneBinding(ctx context.Context, appID int64, countryCode, phoneNumber string) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO appid_phone_bindings (app_id, country_code, phone_number, updated_at_ns)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(app_id) DO UPDATE SET
			country_code = excluded.country_code,
			phone_number = excluded.phone_number,
			updated_at_ns = excluded.updated_at_ns`,
		appID, countryCode, phoneNumber, time.Now().UTC().UnixNano(),
	)
	return err
}

func (s *Store) GetBindingByUserID(ctx context.Context, userID string) (storage.Binding, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT user_id, shadow_user_name, uin, owner_uin, app_id, instance_id,
		       country_code, phone_number, created_at_ns
		FROM bindings
		WHERE user_id = ?
		LIMIT 1`,
		userID,
	)
	var binding storage.Binding
	var createdAtNS int64
	if err := row.Scan(
		&binding.UserID, &binding.ShadowUserName, &binding.Uin, &binding.OwnerUin, &binding.AppID,
		&binding.InstanceID, &binding.CountryCode, &binding.PhoneNumber, &createdAtNS,
	); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return storage.Binding{}, storage.ErrNotFound
		}
		return storage.Binding{}, err
	}
	binding.CreatedAt = time.Unix(0, createdAtNS).UTC()
	return binding, nil
}

func (s *Store) SaveFreeTrialOrderCheckpoint(ctx context.Context, checkpoint storage.FreeTrialOrderCheckpoint) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO free_trial_order_checkpoints (
			user_id, big_deal_id, deal_name, instance_id, org_id, app_id, created_at_ns
		) VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(user_id) DO UPDATE SET
			big_deal_id=excluded.big_deal_id,
			deal_name=excluded.deal_name,
			instance_id=excluded.instance_id,
			org_id=excluded.org_id,
			app_id=excluded.app_id,
			created_at_ns=excluded.created_at_ns`,
		checkpoint.UserID, checkpoint.BigDealID, checkpoint.DealName, checkpoint.InstanceID,
		"", checkpoint.AppID, checkpoint.CreatedAt.UnixNano(),
	)
	return err
}

func (s *Store) GetFreeTrialOrderCheckpointByUserID(ctx context.Context, userID string) (storage.FreeTrialOrderCheckpoint, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT user_id, big_deal_id, deal_name, instance_id, app_id, created_at_ns
		FROM free_trial_order_checkpoints
		WHERE user_id = ?
		LIMIT 1`,
		userID,
	)
	var checkpoint storage.FreeTrialOrderCheckpoint
	var createdAtNS int64
	if err := row.Scan(
		&checkpoint.UserID, &checkpoint.BigDealID, &checkpoint.DealName, &checkpoint.InstanceID,
		&checkpoint.AppID, &createdAtNS,
	); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return storage.FreeTrialOrderCheckpoint{}, storage.ErrNotFound
		}
		return storage.FreeTrialOrderCheckpoint{}, err
	}
	checkpoint.CreatedAt = time.Unix(0, createdAtNS).UTC()
	return checkpoint, nil
}

func (s *Store) SavePendingFreeTrialOrder(ctx context.Context, order storage.PendingFreeTrialOrder) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO pending_free_trial_orders (
			owner_uin, user_id, app_id, big_deal_id, deal_name, instance_id, org_id, status, created_at_ns, updated_at_ns
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(owner_uin) DO UPDATE SET
			user_id = excluded.user_id,
			app_id = excluded.app_id,
			big_deal_id = excluded.big_deal_id,
			deal_name = excluded.deal_name,
			instance_id = excluded.instance_id,
			org_id = excluded.org_id,
			status = excluded.status,
			updated_at_ns = excluded.updated_at_ns`,
		order.OwnerUin, order.UserID, order.AppID, order.BigDealID, order.DealName,
		order.InstanceID, "", string(order.Status), order.CreatedAt.UnixNano(), order.UpdatedAt.UnixNano(),
	)
	return err
}

func (s *Store) GetPendingFreeTrialOrderByOwnerUin(ctx context.Context, ownerUin int64) (storage.PendingFreeTrialOrder, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT owner_uin, user_id, app_id, big_deal_id, deal_name, instance_id, status, created_at_ns, updated_at_ns
		FROM pending_free_trial_orders
		WHERE owner_uin = ?
		LIMIT 1`,
		ownerUin,
	)
	var order storage.PendingFreeTrialOrder
	var status string
	var createdAtNS int64
	var updatedAtNS int64
	if err := row.Scan(
		&order.OwnerUin, &order.UserID, &order.AppID, &order.BigDealID, &order.DealName,
		&order.InstanceID, &status, &createdAtNS, &updatedAtNS,
	); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return storage.PendingFreeTrialOrder{}, storage.ErrNotFound
		}
		return storage.PendingFreeTrialOrder{}, err
	}
	order.Status = storage.PendingFreeTrialOrderStatus(status)
	order.CreatedAt = time.Unix(0, createdAtNS).UTC()
	order.UpdatedAt = time.Unix(0, updatedAtNS).UTC()
	return order, nil
}

func (s *Store) DeletePendingFreeTrialOrderByOwnerUin(ctx context.Context, ownerUin int64) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM pending_free_trial_orders WHERE owner_uin = ?`, ownerUin)
	return err
}

func (s *Store) IssueAuthCode(ctx context.Context, userID string, ttl time.Duration) (storage.AuthCode, error) {
	code, err := storage.NewAuthCode()
	if err != nil {
		return storage.AuthCode{}, err
	}
	record := storage.AuthCode{
		Code:      code,
		UserID:    userID,
		ExpiresAt: time.Now().UTC().Add(ttl),
	}
	_, err = s.db.ExecContext(ctx, `
		INSERT INTO auth_codes (code, user_id, expires_at_ns)
		VALUES (?, ?, ?)`,
		record.Code, record.UserID, record.ExpiresAt.UnixNano(),
	)
	if err != nil {
		return storage.AuthCode{}, err
	}
	return record, nil
}

func (s *Store) ConsumeAuthCode(ctx context.Context, code string) (storage.AuthCode, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return storage.AuthCode{}, err
	}
	defer func() {
		_ = tx.Rollback()
	}()

	row := tx.QueryRowContext(ctx, `
		SELECT user_id, expires_at_ns
		FROM auth_codes
		WHERE code = ?
		LIMIT 1`,
		code,
	)
	var userID string
	var expiresAtNS int64
	if err := row.Scan(&userID, &expiresAtNS); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return storage.AuthCode{}, storage.ErrNotFound
		}
		return storage.AuthCode{}, err
	}
	expiresAt := time.Unix(0, expiresAtNS).UTC()
	if time.Now().UTC().After(expiresAt) {
		if _, err := tx.ExecContext(ctx, `DELETE FROM auth_codes WHERE code = ?`, code); err != nil {
			return storage.AuthCode{}, err
		}
		if err := tx.Commit(); err != nil {
			return storage.AuthCode{}, err
		}
		return storage.AuthCode{}, storage.ErrNotFound
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM auth_codes WHERE code = ?`, code); err != nil {
		return storage.AuthCode{}, err
	}
	if err := tx.Commit(); err != nil {
		return storage.AuthCode{}, err
	}
	now := time.Now().UTC()
	return storage.AuthCode{
		Code:       code,
		UserID:     userID,
		ExpiresAt:  expiresAt,
		ConsumedAt: &now,
	}, nil
}

func (s *Store) Close() error {
	return s.db.Close()
}

func (s *Store) UpsertPackageProduct(ctx context.Context, product storage.PackageProduct) error {
	now := time.Now().UTC()
	createdAt := product.CreatedAt
	if createdAt.IsZero() {
		createdAt = now
	}
	updatedAt := product.UpdatedAt
	if updatedAt.IsZero() {
		updatedAt = now
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO package_products (
			code, display_name, credit_amount, currency, billing_goods_category_id, billing_region,
			billing_zone, billing_pay_mode, product_code, sub_product_code, billing_item_type_code,
			billing_item_code, billing_pid, billing_time_unit, billing_time_span, billing_action,
			billing_extra_params_json, billing_goods_detail_json, requires_standard_realname, enabled, metadata_json, created_at_ns, updated_at_ns
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(code) DO UPDATE SET
			display_name = excluded.display_name,
			credit_amount = excluded.credit_amount,
			currency = excluded.currency,
			billing_goods_category_id = excluded.billing_goods_category_id,
			billing_region = excluded.billing_region,
			billing_zone = excluded.billing_zone,
			billing_pay_mode = excluded.billing_pay_mode,
			product_code = excluded.product_code,
			sub_product_code = excluded.sub_product_code,
			billing_item_type_code = excluded.billing_item_type_code,
			billing_item_code = excluded.billing_item_code,
			billing_pid = excluded.billing_pid,
			billing_time_unit = excluded.billing_time_unit,
			billing_time_span = excluded.billing_time_span,
			billing_action = excluded.billing_action,
			billing_extra_params_json = excluded.billing_extra_params_json,
			billing_goods_detail_json = excluded.billing_goods_detail_json,
			requires_standard_realname = excluded.requires_standard_realname,
			enabled = excluded.enabled,
			metadata_json = excluded.metadata_json,
			updated_at_ns = excluded.updated_at_ns`,
		product.Code, product.DisplayName, product.CreditAmount, product.Currency, product.BillingGoodsCategoryID,
		product.BillingRegion, product.BillingZone, product.BillingPayMode, product.ProductCode,
		product.SubProductCode, product.BillingItemTypeCode, product.BillingItemCode, product.BillingPID,
		product.BillingTimeUnit, product.BillingTimeSpan, product.BillingAction, product.BillingExtraParamsJSON, product.BillingGoodsDetailJSON,
		boolToInt(product.RequiresStandardRealname), boolToInt(product.Enabled), product.MetadataJSON, createdAt.UnixNano(), updatedAt.UnixNano(),
	)
	return err
}

func (s *Store) ListPackageProducts(ctx context.Context) ([]storage.PackageProduct, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT code, display_name, credit_amount, currency, billing_goods_category_id, billing_region,
		       billing_zone, billing_pay_mode, product_code, sub_product_code, billing_item_type_code,
		       billing_item_code, billing_pid, billing_time_unit, billing_time_span, billing_action,
		       billing_extra_params_json, billing_goods_detail_json, requires_standard_realname, enabled, metadata_json, created_at_ns, updated_at_ns
		FROM package_products
		WHERE enabled = 1
		ORDER BY code`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var products []storage.PackageProduct
	for rows.Next() {
		product, err := scanPackageProduct(rows)
		if err != nil {
			return nil, err
		}
		products = append(products, product)
	}
	return products, rows.Err()
}

func (s *Store) GetPackageProductByCode(ctx context.Context, code string) (storage.PackageProduct, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT code, display_name, credit_amount, currency, billing_goods_category_id, billing_region,
		       billing_zone, billing_pay_mode, product_code, sub_product_code, billing_item_type_code,
		       billing_item_code, billing_pid, billing_time_unit, billing_time_span, billing_action,
		       billing_extra_params_json, billing_goods_detail_json, requires_standard_realname, enabled, metadata_json, created_at_ns, updated_at_ns
		FROM package_products
		WHERE code = ?
		LIMIT 1`, code)
	return scanPackageProduct(row)
}

func (s *Store) CreatePackageOrder(ctx context.Context, order storage.PackageOrder) error {
	orderIDsJSON, err := json.Marshal(order.BillingOrderIDs)
	if err != nil {
		return err
	}
	paidAtNS := nullTimeToUnixNano(order.PaidAt)
	cancelledAtNS := nullTimeToUnixNano(order.CancelledAt)
	_, err = s.db.ExecContext(ctx, `
		INSERT INTO package_orders (
			id, user_id, product_code, amount, currency, status, billing_big_order_id, billing_order_ids_json,
			pay_url, need_charge, client_token, payment_confirmation_key, billing_request_json, billing_response_json,
			paid_at_ns, cancelled_at_ns, created_at_ns, updated_at_ns
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		order.ID, order.UserID, order.ProductCode, order.Amount, order.Currency, string(order.Status), order.BillingBigOrderID,
		string(orderIDsJSON), order.PayURL, boolToInt(order.NeedCharge), order.ClientToken, order.PaymentConfirmationKey,
		order.BillingRequestJSON, order.BillingResponseJSON, paidAtNS, cancelledAtNS, order.CreatedAt.UnixNano(), order.UpdatedAt.UnixNano(),
	)
	return err
}

func (s *Store) UpdatePackageOrderLaunch(ctx context.Context, orderID string, status storage.PackageOrderStatus, bigOrderID string, orderIDs []string, payURL string, needCharge bool, requestJSON, responseJSON string) error {
	orderIDsJSON, err := json.Marshal(orderIDs)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `
		UPDATE package_orders
		SET status = ?,
		    billing_big_order_id = ?,
		    billing_order_ids_json = ?,
		    pay_url = ?,
		    need_charge = ?,
		    billing_request_json = ?,
		    billing_response_json = ?,
		    updated_at_ns = ?
		WHERE id = ?`,
		string(status), bigOrderID, string(orderIDsJSON), payURL, boolToInt(needCharge), requestJSON, responseJSON, time.Now().UTC().UnixNano(), orderID,
	)
	return err
}

func (s *Store) GetPackageOrderByID(ctx context.Context, id string) (storage.PackageOrder, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT id, user_id, product_code, amount, currency, status, billing_big_order_id, billing_order_ids_json,
		       pay_url, need_charge, client_token, payment_confirmation_key, billing_request_json, billing_response_json,
		       paid_at_ns, cancelled_at_ns, created_at_ns, updated_at_ns
		FROM package_orders
		WHERE id = ?
		LIMIT 1`, id)
	return scanPackageOrder(row)
}

func (s *Store) GetWalletAccountByUserID(ctx context.Context, userID string) (storage.WalletAccount, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT user_id, available_amount, frozen_amount, currency, version, created_at_ns, updated_at_ns
		FROM wallet_accounts
		WHERE user_id = ?
		LIMIT 1`, userID)
	var wallet storage.WalletAccount
	var createdAtNS int64
	var updatedAtNS int64
	if err := row.Scan(&wallet.UserID, &wallet.AvailableAmount, &wallet.FrozenAmount, &wallet.Currency, &wallet.Version, &createdAtNS, &updatedAtNS); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return storage.WalletAccount{}, storage.ErrNotFound
		}
		return storage.WalletAccount{}, err
	}
	wallet.CreatedAt = time.Unix(0, createdAtNS).UTC()
	wallet.UpdatedAt = time.Unix(0, updatedAtNS).UTC()
	return wallet, nil
}

func (s *Store) ApplyPackageOrderCredit(ctx context.Context, orderID string, paidAt time.Time, externalRefsJSON string, amount int64, reason string) (storage.WalletCreditResult, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return storage.WalletCreditResult{}, err
	}
	defer func() { _ = tx.Rollback() }()

	orderRow := tx.QueryRowContext(ctx, `
		SELECT id, user_id, product_code, amount, currency, status, billing_big_order_id, billing_order_ids_json,
		       pay_url, need_charge, client_token, payment_confirmation_key, billing_request_json, billing_response_json,
		       paid_at_ns, cancelled_at_ns, created_at_ns, updated_at_ns
		FROM package_orders
		WHERE id = ?
		LIMIT 1`, orderID)
	order, err := scanPackageOrder(orderRow)
	if err != nil {
		return storage.WalletCreditResult{}, err
	}
	if order.Status == storage.PackageOrderStatusCreditApplied {
		wallet, err := scanWalletAccount(tx.QueryRowContext(ctx, `
			SELECT user_id, available_amount, frozen_amount, currency, version, created_at_ns, updated_at_ns
			FROM wallet_accounts
			WHERE user_id = ?
			LIMIT 1`, order.UserID))
		if err != nil {
			return storage.WalletCreditResult{}, err
		}
		ledger, err := scanWalletLedgerEntry(tx.QueryRowContext(ctx, `
			SELECT id, user_id, order_id, type, amount_delta, before_balance, after_balance, reason, external_refs_json, idempotency_key, created_at_ns
			FROM wallet_ledger_entries
			WHERE idempotency_key = ?
			LIMIT 1`, order.PaymentConfirmationKey))
		if err != nil {
			return storage.WalletCreditResult{}, err
		}
		return storage.WalletCreditResult{Order: order, Wallet: wallet, Ledger: ledger}, nil
	}

	walletRow := tx.QueryRowContext(ctx, `
		SELECT user_id, available_amount, frozen_amount, currency, version, created_at_ns, updated_at_ns
		FROM wallet_accounts
		WHERE user_id = ?
		LIMIT 1`, order.UserID)
	wallet, err := scanWalletAccount(walletRow)
	if err != nil && !errors.Is(err, storage.ErrNotFound) {
		return storage.WalletCreditResult{}, err
	}
	now := time.Now().UTC()
	if errors.Is(err, storage.ErrNotFound) {
		wallet = storage.WalletAccount{
			UserID:          order.UserID,
			AvailableAmount: 0,
			FrozenAmount:    0,
			Currency:        order.Currency,
			Version:         0,
			CreatedAt:       now,
			UpdatedAt:       now,
		}
	}
	beforeBalance := wallet.AvailableAmount
	afterBalance := beforeBalance + amount
	wallet.AvailableAmount = afterBalance
	wallet.UpdatedAt = now
	wallet.Version++

	_, err = tx.ExecContext(ctx, `
		INSERT INTO wallet_accounts (user_id, available_amount, frozen_amount, currency, version, created_at_ns, updated_at_ns)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(user_id) DO UPDATE SET
			available_amount = excluded.available_amount,
			frozen_amount = excluded.frozen_amount,
			currency = excluded.currency,
			version = excluded.version,
			updated_at_ns = excluded.updated_at_ns`,
		wallet.UserID, wallet.AvailableAmount, wallet.FrozenAmount, wallet.Currency, wallet.Version, wallet.CreatedAt.UnixNano(), wallet.UpdatedAt.UnixNano(),
	)
	if err != nil {
		return storage.WalletCreditResult{}, err
	}

	ledger := storage.WalletLedgerEntry{
		ID:               newLedgerID(),
		UserID:           order.UserID,
		OrderID:          order.ID,
		Type:             "credit",
		AmountDelta:      amount,
		BeforeBalance:    beforeBalance,
		AfterBalance:     afterBalance,
		Reason:           reason,
		ExternalRefsJSON: externalRefsJSON,
		IdempotencyKey:   order.PaymentConfirmationKey,
		CreatedAt:        now,
	}
	_, err = tx.ExecContext(ctx, `
		INSERT INTO wallet_ledger_entries (
			id, user_id, order_id, type, amount_delta, before_balance, after_balance, reason, external_refs_json, idempotency_key, created_at_ns
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		ledger.ID, ledger.UserID, ledger.OrderID, ledger.Type, ledger.AmountDelta, ledger.BeforeBalance, ledger.AfterBalance, ledger.Reason, ledger.ExternalRefsJSON, ledger.IdempotencyKey, ledger.CreatedAt.UnixNano(),
	)
	if err != nil {
		if isUniqueConstraint(err) {
			existing, existingErr := scanWalletLedgerEntry(tx.QueryRowContext(ctx, `
				SELECT id, user_id, order_id, type, amount_delta, before_balance, after_balance, reason, external_refs_json, idempotency_key, created_at_ns
				FROM wallet_ledger_entries
				WHERE idempotency_key = ?
				LIMIT 1`, order.PaymentConfirmationKey))
			if existingErr != nil {
				return storage.WalletCreditResult{}, existingErr
			}
			ledger = existing
		} else {
			return storage.WalletCreditResult{}, err
		}
	}

	order.Status = storage.PackageOrderStatusCreditApplied
	order.PaidAt = &paidAt
	order.UpdatedAt = now
	_, err = tx.ExecContext(ctx, `
		UPDATE package_orders
		SET status = ?, paid_at_ns = ?, updated_at_ns = ?, billing_response_json = ?
		WHERE id = ?`,
		string(order.Status), paidAt.UnixNano(), now.UnixNano(), externalRefsJSON, order.ID,
	)
	if err != nil {
		return storage.WalletCreditResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return storage.WalletCreditResult{}, err
	}
	return storage.WalletCreditResult{Order: order, Wallet: wallet, Ledger: ledger}, nil
}

func isUniqueConstraint(err error) bool {
	return strings.Contains(err.Error(), "UNIQUE constraint failed")
}

func ensureColumn(ctx context.Context, db *sql.DB, tableName, columnName, columnDDL string) error {
	rows, err := db.QueryContext(ctx, "PRAGMA table_info("+tableName+")")
	if err != nil {
		return err
	}
	defer rows.Close()

	for rows.Next() {
		var cid int
		var name string
		var colType string
		var notNull int
		var dfltValue sql.NullString
		var pk int
		if err := rows.Scan(&cid, &name, &colType, &notNull, &dfltValue, &pk); err != nil {
			return err
		}
		if name == columnName {
			return nil
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	_, err = db.ExecContext(ctx, "ALTER TABLE "+tableName+" ADD COLUMN "+columnName+" "+columnDDL)
	return err
}

type scannable interface {
	Scan(dest ...any) error
}

func scanPackageProduct(scanner scannable) (storage.PackageProduct, error) {
	var product storage.PackageProduct
	var requiresStandardRealname int64
	var enabled int64
	var createdAtNS int64
	var updatedAtNS int64
	if err := scanner.Scan(
		&product.Code, &product.DisplayName, &product.CreditAmount, &product.Currency, &product.BillingGoodsCategoryID,
		&product.BillingRegion, &product.BillingZone, &product.BillingPayMode, &product.ProductCode,
		&product.SubProductCode, &product.BillingItemTypeCode, &product.BillingItemCode, &product.BillingPID,
		&product.BillingTimeUnit, &product.BillingTimeSpan, &product.BillingAction, &product.BillingExtraParamsJSON,
		&product.BillingGoodsDetailJSON, &requiresStandardRealname, &enabled, &product.MetadataJSON, &createdAtNS, &updatedAtNS,
	); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return storage.PackageProduct{}, storage.ErrNotFound
		}
		return storage.PackageProduct{}, err
	}
	product.RequiresStandardRealname = requiresStandardRealname == 1
	product.Enabled = enabled == 1
	product.CreatedAt = time.Unix(0, createdAtNS).UTC()
	product.UpdatedAt = time.Unix(0, updatedAtNS).UTC()
	return product, nil
}

func scanPackageOrder(scanner scannable) (storage.PackageOrder, error) {
	var order storage.PackageOrder
	var orderIDsJSON string
	var needCharge int64
	var paidAtNS int64
	var cancelledAtNS int64
	var createdAtNS int64
	var updatedAtNS int64
	if err := scanner.Scan(
		&order.ID, &order.UserID, &order.ProductCode, &order.Amount, &order.Currency, &order.Status, &order.BillingBigOrderID,
		&orderIDsJSON, &order.PayURL, &needCharge, &order.ClientToken, &order.PaymentConfirmationKey, &order.BillingRequestJSON,
		&order.BillingResponseJSON, &paidAtNS, &cancelledAtNS, &createdAtNS, &updatedAtNS,
	); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return storage.PackageOrder{}, storage.ErrNotFound
		}
		return storage.PackageOrder{}, err
	}
	order.NeedCharge = needCharge == 1
	_ = json.Unmarshal([]byte(orderIDsJSON), &order.BillingOrderIDs)
	order.CreatedAt = time.Unix(0, createdAtNS).UTC()
	order.UpdatedAt = time.Unix(0, updatedAtNS).UTC()
	if paidAtNS > 0 {
		t := time.Unix(0, paidAtNS).UTC()
		order.PaidAt = &t
	}
	if cancelledAtNS > 0 {
		t := time.Unix(0, cancelledAtNS).UTC()
		order.CancelledAt = &t
	}
	return order, nil
}

func scanWalletAccount(scanner scannable) (storage.WalletAccount, error) {
	var wallet storage.WalletAccount
	var createdAtNS int64
	var updatedAtNS int64
	if err := scanner.Scan(&wallet.UserID, &wallet.AvailableAmount, &wallet.FrozenAmount, &wallet.Currency, &wallet.Version, &createdAtNS, &updatedAtNS); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return storage.WalletAccount{}, storage.ErrNotFound
		}
		return storage.WalletAccount{}, err
	}
	wallet.CreatedAt = time.Unix(0, createdAtNS).UTC()
	wallet.UpdatedAt = time.Unix(0, updatedAtNS).UTC()
	return wallet, nil
}

func scanWalletLedgerEntry(scanner scannable) (storage.WalletLedgerEntry, error) {
	var entry storage.WalletLedgerEntry
	var createdAtNS int64
	if err := scanner.Scan(&entry.ID, &entry.UserID, &entry.OrderID, &entry.Type, &entry.AmountDelta, &entry.BeforeBalance, &entry.AfterBalance, &entry.Reason, &entry.ExternalRefsJSON, &entry.IdempotencyKey, &createdAtNS); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return storage.WalletLedgerEntry{}, storage.ErrNotFound
		}
		return storage.WalletLedgerEntry{}, err
	}
	entry.CreatedAt = time.Unix(0, createdAtNS).UTC()
	return entry, nil
}

func boolToInt(v bool) int64 {
	if v {
		return 1
	}
	return 0
}

func nullTimeToUnixNano(v *time.Time) int64 {
	if v == nil {
		return 0
	}
	return v.UnixNano()
}

func newLedgerID() string {
	id, _ := storage.NewAuthCode()
	return "ledger_" + id[:16]
}
