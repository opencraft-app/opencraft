package wrapper

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strings"
	"time"

	_ "github.com/go-sql-driver/mysql"
)

const (
	warmRuntimePoolMySQLDriver = "mysql"
)

var _ WarmRuntimePoolStore = (*MySQLWarmRuntimePoolStore)(nil)

type MySQLWarmRuntimePoolStore struct {
	db *sql.DB
}

func OpenMySQLWarmRuntimePoolStore(ctx context.Context, dsn string) (*MySQLWarmRuntimePoolStore, error) {
	dsn = normalizeMySQLDSN(dsn)
	if strings.TrimSpace(dsn) == "" {
		return nil, errors.New("warm runtime pool mysql dsn is required")
	}
	db, err := sql.Open(warmRuntimePoolMySQLDriver, dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(10)
	db.SetMaxIdleConns(5)
	db.SetConnMaxLifetime(5 * time.Minute)
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, err
	}
	store := &MySQLWarmRuntimePoolStore{db: db}
	if err := store.migrate(ctx); err != nil {
		_ = db.Close()
		return nil, err
	}
	return store, nil
}

func OpenWarmRuntimePoolStoreFromEnv(ctx context.Context) (WarmRuntimePoolStore, error) {
	driver := strings.ToLower(strings.TrimSpace(os.Getenv("GATEWAY_RUNTIME_WARM_POOL_DB_DRIVER")))
	dsn := firstNonEmpty(
		os.Getenv("GATEWAY_RUNTIME_WARM_POOL_DB_DSN"),
		os.Getenv("GATEWAY_RUNTIME_WARM_POOL_DB_PATH"),
	)
	if strings.TrimSpace(dsn) == "" {
		return nil, nil
	}
	if driver == "" {
		switch {
		case strings.HasPrefix(strings.TrimSpace(dsn), "mysql://"):
			driver = warmRuntimePoolMySQLDriver
		case strings.Contains(dsn, "@tcp("), strings.Contains(dsn, "@unix("):
			driver = warmRuntimePoolMySQLDriver
		default:
			return nil, fmt.Errorf("unsupported warm runtime pool dsn without driver")
		}
	}
	switch driver {
	case warmRuntimePoolMySQLDriver:
		return OpenMySQLWarmRuntimePoolStore(ctx, dsn)
	default:
		return nil, fmt.Errorf("unsupported warm runtime pool db driver %q", driver)
	}
}

func (s *MySQLWarmRuntimePoolStore) Close() error {
	if s == nil || s.db == nil {
		return nil
	}
	return s.db.Close()
}

func (s *MySQLWarmRuntimePoolStore) migrate(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `
CREATE TABLE IF NOT EXISTS warm_runtime_pool_items (
	item_id VARCHAR(191) PRIMARY KEY,
	pool_key VARCHAR(191) NOT NULL,
	state VARCHAR(32) NOT NULL,
	owner_id VARCHAR(191) NOT NULL DEFAULT '',
	session_id VARCHAR(191) NOT NULL DEFAULT '',
	generation BIGINT NOT NULL DEFAULT 0,
	fencing_token BIGINT NOT NULL DEFAULT 0,
	lease_until VARCHAR(64),
	host_json LONGTEXT NOT NULL,
	last_error TEXT NOT NULL,
	workflow_id VARCHAR(191) NOT NULL DEFAULT '',
	run_id VARCHAR(191) NOT NULL DEFAULT '',
	created_at VARCHAR(64) NOT NULL,
	updated_at VARCHAR(64) NOT NULL,
	claimed_at VARCHAR(64),
	discarded_at VARCHAR(64),
	KEY warm_runtime_pool_ready_idx (pool_key, state, updated_at),
	KEY warm_runtime_pool_owner_idx (owner_id, state, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
	return err
}

func (s *MySQLWarmRuntimePoolStore) ReserveWarmRuntimeItem(ctx context.Context, req WarmRuntimeReserveRequest) (WarmRuntimeItem, bool, error) {
	if s == nil || s.db == nil {
		return WarmRuntimeItem{}, false, errors.New("warm runtime pool mysql store is nil")
	}
	if req.PoolKey == "" {
		return WarmRuntimeItem{}, false, errors.New("warm runtime pool key is required")
	}
	if req.DesiredReady <= 0 {
		req.DesiredReady = 1
	}
	lockName := "cloudagent:" + req.PoolKey
	released, err := s.acquireAdvisoryLock(ctx, lockName)
	if err != nil {
		return WarmRuntimeItem{}, false, err
	}
	defer released()

	now := time.Now().UTC()
	itemID := "warm_" + randomHex(12)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return WarmRuntimeItem{}, false, err
	}
	defer tx.Rollback()
	var inFlight int
	if err := tx.QueryRowContext(ctx, `
SELECT COUNT(*)
FROM warm_runtime_pool_items
WHERE pool_key = ? AND state IN (?, ?)`,
		req.PoolKey, warmRuntimePoolStateReady, warmRuntimePoolStateCreating).Scan(&inFlight); err != nil {
		return WarmRuntimeItem{}, false, err
	}
	if inFlight >= req.DesiredReady {
		if err := tx.Commit(); err != nil {
			return WarmRuntimeItem{}, false, err
		}
		return WarmRuntimeItem{}, false, nil
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO warm_runtime_pool_items (
	item_id, pool_key, state, owner_id, session_id, generation, fencing_token,
	lease_until, host_json, last_error, workflow_id, run_id,
	created_at, updated_at, claimed_at, discarded_at
) VALUES (?, ?, ?, ?, '', 0, 0, '', '{}', '', ?, ?, ?, ?, '', '')`,
		itemID, req.PoolKey, warmRuntimePoolStateCreating, req.OwnerID, req.WorkflowID, req.RunID,
		now.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano)); err != nil {
		return WarmRuntimeItem{}, false, err
	}
	if err := tx.Commit(); err != nil {
		return WarmRuntimeItem{}, false, err
	}
	return WarmRuntimeItem{
		ItemID:     itemID,
		PoolKey:    req.PoolKey,
		State:      warmRuntimePoolStateCreating,
		OwnerID:    req.OwnerID,
		WorkflowID: req.WorkflowID,
		RunID:      req.RunID,
		CreatedAt:  now,
		UpdatedAt:  now,
	}, true, nil
}

func (s *MySQLWarmRuntimePoolStore) UpsertWarmRuntimeItem(ctx context.Context, item WarmRuntimeItem) error {
	if s == nil || s.db == nil {
		return errors.New("warm runtime pool mysql store is nil")
	}
	if item.ItemID == "" {
		return errors.New("warm runtime item id is required")
	}
	if item.PoolKey == "" {
		return errors.New("warm runtime pool key is required")
	}
	if item.State == "" {
		item.State = warmRuntimePoolStateCreating
	}
	hostJSON, err := json.Marshal(item.Host)
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	createdAt := item.CreatedAt
	if createdAt.IsZero() {
		createdAt = now
	}
	updatedAt := item.UpdatedAt
	if updatedAt.IsZero() {
		updatedAt = now
	}
	_, err = s.db.ExecContext(ctx, `
INSERT INTO warm_runtime_pool_items (
	item_id, pool_key, state, owner_id, session_id, generation, fencing_token,
	lease_until, host_json, last_error, workflow_id, run_id,
	created_at, updated_at, claimed_at, discarded_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON DUPLICATE KEY UPDATE
	pool_key = VALUES(pool_key),
	state = VALUES(state),
	owner_id = VALUES(owner_id),
	session_id = VALUES(session_id),
	generation = VALUES(generation),
	fencing_token = VALUES(fencing_token),
	lease_until = VALUES(lease_until),
	host_json = VALUES(host_json),
	last_error = VALUES(last_error),
	workflow_id = VALUES(workflow_id),
	run_id = VALUES(run_id),
	updated_at = VALUES(updated_at),
	claimed_at = VALUES(claimed_at),
	discarded_at = VALUES(discarded_at)`,
		item.ItemID, item.PoolKey, item.State, item.OwnerID, item.SessionID, item.Generation, item.Fence,
		formatOptionalWorkspaceTime(item.LeaseUntil), string(hostJSON), item.LastError, item.WorkflowID, item.RunID,
		createdAt.Format(time.RFC3339Nano), updatedAt.Format(time.RFC3339Nano),
		formatOptionalWorkspaceTime(item.ClaimedAt), formatOptionalWorkspaceTime(item.DiscardedAt))
	return err
}

func (s *MySQLWarmRuntimePoolStore) MarkWarmRuntimeItemReady(ctx context.Context, itemID string, host WarmRuntimeHost) error {
	if err := validateWarmRuntimeHost(host); err != nil {
		return err
	}
	hostJSON, err := json.Marshal(host)
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	result, err := s.db.ExecContext(ctx, `
UPDATE warm_runtime_pool_items
SET state = ?, host_json = ?, last_error = '', updated_at = ?
WHERE item_id = ? AND state IN (?, ?)`,
		warmRuntimePoolStateReady, string(hostJSON), now.Format(time.RFC3339Nano), itemID,
		warmRuntimePoolStateCreating, warmRuntimePoolStateFailed)
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected == 0 {
		return fmt.Errorf("warm runtime item %s is not markable ready", itemID)
	}
	return nil
}

func (s *MySQLWarmRuntimePoolStore) MarkWarmRuntimeItemState(ctx context.Context, itemID string, state string, lastErr string) error {
	if s == nil || s.db == nil {
		return errors.New("warm runtime pool mysql store is nil")
	}
	if itemID == "" {
		return errors.New("warm runtime item id is required")
	}
	if state == "" {
		return errors.New("warm runtime item state is required")
	}
	now := time.Now().UTC()
	discardedAt := ""
	if state == warmRuntimePoolStateDiscarded {
		discardedAt = now.Format(time.RFC3339Nano)
	}
	_, err := s.db.ExecContext(ctx, `
UPDATE warm_runtime_pool_items
SET state = ?, last_error = ?, updated_at = ?, discarded_at = COALESCE(NULLIF(?, ''), discarded_at)
WHERE item_id = ?`,
		state, lastErr, now.Format(time.RFC3339Nano), discardedAt, itemID)
	return err
}

func (s *MySQLWarmRuntimePoolStore) ClaimWarmRuntime(ctx context.Context, req WarmRuntimeClaimRequest) (WarmRuntimeClaim, error) {
	if s == nil || s.db == nil {
		return WarmRuntimeClaim{}, errors.New("warm runtime pool mysql store is nil")
	}
	if req.PoolKey == "" {
		return WarmRuntimeClaim{}, errors.New("warm runtime pool key is required")
	}
	if req.OwnerID == "" {
		return WarmRuntimeClaim{}, errors.New("warm runtime owner id is required")
	}
	if req.SessionID == "" {
		return WarmRuntimeClaim{}, errors.New("session id is required")
	}
	if req.Generation <= 0 {
		return WarmRuntimeClaim{}, errors.New("generation is required")
	}
	now := time.Now().UTC()
	leaseUntil := now.Add(warmRuntimeClaimTTL(req.TTL))
	readyCutoff := now.Add(-warmRuntimeReadyTTL(req.MaxReadyAge))
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return WarmRuntimeClaim{}, err
	}
	defer tx.Rollback()
	itemID, err := selectFreshWarmRuntimeItem(ctx, tx, req.PoolKey, readyCutoff, true)
	if errors.Is(err, sql.ErrNoRows) {
		return WarmRuntimeClaim{}, ErrWarmRuntimePoolMiss
	}
	if err != nil {
		return WarmRuntimeClaim{}, err
	}
	result, err := tx.ExecContext(ctx, `
UPDATE warm_runtime_pool_items
SET state = ?,
	owner_id = ?,
	session_id = ?,
	generation = ?,
	fencing_token = fencing_token + 1,
	lease_until = ?,
	claimed_at = ?,
	updated_at = ?
WHERE item_id = ? AND pool_key = ? AND state = ?`,
		warmRuntimePoolStateClaimed, req.OwnerID, req.SessionID, req.Generation,
		leaseUntil.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano),
		itemID, req.PoolKey, warmRuntimePoolStateReady)
	if err != nil {
		return WarmRuntimeClaim{}, err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return WarmRuntimeClaim{}, err
	}
	if affected == 0 {
		return WarmRuntimeClaim{}, ErrWarmRuntimePoolMiss
	}
	item, ok, err := loadWarmRuntimeItemWithQueryer(ctx, tx, itemID)
	if err != nil {
		return WarmRuntimeClaim{}, err
	}
	if !ok {
		return WarmRuntimeClaim{}, ErrWarmRuntimePoolMiss
	}
	if err := tx.Commit(); err != nil {
		return WarmRuntimeClaim{}, err
	}
	return WarmRuntimeClaim{
		ItemID:      item.ItemID,
		PoolKey:     item.PoolKey,
		OwnerID:     item.OwnerID,
		SessionID:   item.SessionID,
		Generation:  item.Generation,
		ClaimedAt:   item.ClaimedAt,
		LeaseUntil:  item.LeaseUntil,
		Fence:       item.Fence,
		Host:        item.Host,
		SourceState: warmRuntimePoolStateReady,
	}, nil
}

func (s *MySQLWarmRuntimePoolStore) DiscardWarmRuntime(ctx context.Context, claim WarmRuntimeClaim, reason string) error {
	return s.finishWarmRuntimeClaim(ctx, claim, warmRuntimePoolStateDiscarding, reason)
}

func (s *MySQLWarmRuntimePoolStore) ConsumeWarmRuntime(ctx context.Context, claim WarmRuntimeClaim) error {
	return s.finishWarmRuntimeClaim(ctx, claim, warmRuntimePoolStateConsumed, "claimed runtime attached to session")
}

func (s *MySQLWarmRuntimePoolStore) finishWarmRuntimeClaim(ctx context.Context, claim WarmRuntimeClaim, state string, reason string) error {
	if s == nil || s.db == nil || claim.ItemID == "" {
		return nil
	}
	now := time.Now().UTC()
	result, err := s.db.ExecContext(ctx, `
UPDATE warm_runtime_pool_items
SET state = ?, last_error = ?, updated_at = ?, discarded_at = ?
WHERE item_id = ? AND state = ? AND owner_id = ? AND session_id = ? AND generation = ? AND fencing_token = ?`,
		state, reason, now.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano),
		claim.ItemID, warmRuntimePoolStateClaimed, claim.OwnerID, claim.SessionID, claim.Generation, claim.Fence)
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected == 0 {
		return fmt.Errorf("warm runtime item %s is no longer owned by this claim", claim.ItemID)
	}
	return nil
}

func (s *MySQLWarmRuntimePoolStore) ListWarmRuntimeItems(ctx context.Context, req WarmRuntimeListRequest) ([]WarmRuntimeItem, error) {
	if s == nil || s.db == nil {
		return nil, nil
	}
	if req.Limit <= 0 {
		req.Limit = 100
	}
	where := "WHERE 1=1"
	args := []any{}
	if req.PoolKey != "" {
		where += " AND pool_key = ?"
		args = append(args, req.PoolKey)
	}
	if req.State != "" {
		where += " AND state = ?"
		args = append(args, req.State)
	}
	args = append(args, req.Limit)
	rows, err := s.db.QueryContext(ctx, `
SELECT item_id, pool_key, state, owner_id, session_id, generation, fencing_token,
       lease_until, host_json, last_error, workflow_id, run_id,
       created_at, updated_at, claimed_at, discarded_at
FROM warm_runtime_pool_items
`+where+`
ORDER BY updated_at ASC
LIMIT ?`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var items []WarmRuntimeItem
	for rows.Next() {
		item, err := scanWarmRuntimeItemRows(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *MySQLWarmRuntimePoolStore) acquireAdvisoryLock(ctx context.Context, name string) (func(), error) {
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return nil, err
	}
	var acquired int
	if err := conn.QueryRowContext(ctx, `SELECT GET_LOCK(?, 5)`, name).Scan(&acquired); err != nil {
		_ = conn.Close()
		return nil, err
	}
	if acquired != 1 {
		_ = conn.Close()
		return nil, fmt.Errorf("timed out acquiring warm runtime pool mysql lock")
	}
	return func() {
		_, _ = conn.ExecContext(context.Background(), `SELECT RELEASE_LOCK(?)`, name)
		_ = conn.Close()
	}, nil
}

func normalizeMySQLDSN(raw string) string {
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "mysql://") {
		if converted, err := mysqlURLToDSN(raw); err == nil {
			raw = converted
		}
	}
	if raw != "" && !strings.Contains(raw, "parseTime=") {
		if strings.Contains(raw, "?") {
			raw += "&parseTime=true"
		} else {
			raw += "?parseTime=true"
		}
	}
	return raw
}

func mysqlURLToDSN(raw string) (string, error) {
	parsed, err := url.Parse(raw)
	if err != nil {
		return "", err
	}
	user := parsed.User.Username()
	password, hasPassword := parsed.User.Password()
	auth := user
	if hasPassword {
		auth += ":" + password
	}
	dbName := strings.TrimPrefix(parsed.Path, "/")
	dsn := fmt.Sprintf("%s@tcp(%s)/%s", auth, parsed.Host, dbName)
	if parsed.RawQuery != "" {
		dsn += "?" + parsed.RawQuery
	}
	return dsn, nil
}

type warmRuntimePoolQueryer interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func loadWarmRuntimeItemWithQueryer(ctx context.Context, q warmRuntimePoolQueryer, itemID string) (WarmRuntimeItem, bool, error) {
	return scanWarmRuntimeItem(q.QueryRowContext(ctx, `
SELECT item_id, pool_key, state, owner_id, session_id, generation, fencing_token,
       lease_until, host_json, last_error, workflow_id, run_id,
       created_at, updated_at, claimed_at, discarded_at
FROM warm_runtime_pool_items
WHERE item_id = ?`, itemID))
}
