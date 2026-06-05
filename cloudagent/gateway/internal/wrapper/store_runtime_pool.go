package wrapper

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

var _ WarmRuntimePoolStore = (*Store)(nil)

func (s *Store) ReserveWarmRuntimeItem(ctx context.Context, req WarmRuntimeReserveRequest) (WarmRuntimeItem, bool, error) {
	if s == nil {
		return WarmRuntimeItem{}, false, errors.New("store is nil")
	}
	if req.PoolKey == "" {
		return WarmRuntimeItem{}, false, errors.New("warm runtime pool key is required")
	}
	if req.DesiredReady <= 0 {
		req.DesiredReady = 1
	}
	now := time.Now().UTC()
	itemID := "warm_" + randomHex(12)
	s.mu.Lock()
	defer s.mu.Unlock()

	conn, err := s.db.Conn(ctx)
	if err != nil {
		return WarmRuntimeItem{}, false, err
	}
	defer conn.Close()
	if _, err := conn.ExecContext(ctx, `BEGIN IMMEDIATE`); err != nil {
		return WarmRuntimeItem{}, false, err
	}
	committed := false
	defer func() {
		if !committed {
			_, _ = conn.ExecContext(context.Background(), `ROLLBACK`)
		}
	}()

	var inFlight int
	if err := conn.QueryRowContext(ctx, `
SELECT COUNT(*)
FROM warm_runtime_pool_items
WHERE pool_key = ? AND state IN (?, ?)`,
		req.PoolKey, warmRuntimePoolStateReady, warmRuntimePoolStateCreating).Scan(&inFlight); err != nil {
		return WarmRuntimeItem{}, false, err
	}
	if inFlight >= req.DesiredReady {
		if _, err := conn.ExecContext(ctx, `COMMIT`); err != nil {
			return WarmRuntimeItem{}, false, err
		}
		committed = true
		return WarmRuntimeItem{}, false, nil
	}
	if _, err := conn.ExecContext(ctx, `
INSERT INTO warm_runtime_pool_items (
	item_id, pool_key, state, owner_id, session_id, generation, fencing_token,
	lease_until, host_json, last_error, workflow_id, run_id,
	created_at, updated_at, claimed_at, discarded_at
)
VALUES (?, ?, ?, ?, '', 0, 0, '', '{}', '', ?, ?, ?, ?, '', '')`,
		itemID, req.PoolKey, warmRuntimePoolStateCreating, req.OwnerID, req.WorkflowID, req.RunID,
		now.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano)); err != nil {
		return WarmRuntimeItem{}, false, err
	}
	if _, err := conn.ExecContext(ctx, `COMMIT`); err != nil {
		return WarmRuntimeItem{}, false, err
	}
	committed = true
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

func (s *Store) UpsertWarmRuntimeItem(ctx context.Context, item WarmRuntimeItem) error {
	if s == nil {
		return errors.New("store is nil")
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
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err = s.db.ExecContext(ctx, `
INSERT INTO warm_runtime_pool_items (
	item_id, pool_key, state, owner_id, session_id, generation, fencing_token,
	lease_until, host_json, last_error, workflow_id, run_id,
	created_at, updated_at, claimed_at, discarded_at
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(item_id) DO UPDATE SET
	pool_key = excluded.pool_key,
	state = excluded.state,
	owner_id = excluded.owner_id,
	session_id = excluded.session_id,
	generation = excluded.generation,
	fencing_token = excluded.fencing_token,
	lease_until = excluded.lease_until,
	host_json = excluded.host_json,
	last_error = excluded.last_error,
	workflow_id = excluded.workflow_id,
	run_id = excluded.run_id,
	updated_at = excluded.updated_at,
	claimed_at = excluded.claimed_at,
	discarded_at = excluded.discarded_at`,
		item.ItemID, item.PoolKey, item.State, item.OwnerID, item.SessionID, item.Generation, item.Fence,
		formatOptionalWorkspaceTime(item.LeaseUntil), string(hostJSON), item.LastError, item.WorkflowID, item.RunID,
		createdAt.Format(time.RFC3339Nano), updatedAt.Format(time.RFC3339Nano),
		formatOptionalWorkspaceTime(item.ClaimedAt), formatOptionalWorkspaceTime(item.DiscardedAt))
	return err
}

func (s *Store) MarkWarmRuntimeItemReady(ctx context.Context, itemID string, host WarmRuntimeHost) error {
	if err := validateWarmRuntimeHost(host); err != nil {
		return err
	}
	hostJSON, err := json.Marshal(host)
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	s.mu.Lock()
	defer s.mu.Unlock()
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

func (s *Store) MarkWarmRuntimeItemState(ctx context.Context, itemID string, state string, lastErr string) error {
	if s == nil {
		return errors.New("store is nil")
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
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.ExecContext(ctx, `
UPDATE warm_runtime_pool_items
SET state = ?, last_error = ?, updated_at = ?, discarded_at = COALESCE(NULLIF(?, ''), discarded_at)
WHERE item_id = ?`,
		state, lastErr, now.Format(time.RFC3339Nano), discardedAt, itemID)
	return err
}

func (s *Store) ClaimWarmRuntime(ctx context.Context, req WarmRuntimeClaimRequest) (WarmRuntimeClaim, error) {
	if s == nil {
		return WarmRuntimeClaim{}, errors.New("store is nil")
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
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return WarmRuntimeClaim{}, err
	}
	defer tx.Rollback()
	var itemID string
	err = tx.QueryRowContext(ctx, `
SELECT item_id
FROM warm_runtime_pool_items
WHERE pool_key = ? AND state = ?
ORDER BY updated_at ASC
LIMIT 1`, req.PoolKey, warmRuntimePoolStateReady).Scan(&itemID)
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
	item, ok, err := loadWarmRuntimeItemTx(ctx, tx, itemID)
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

func (s *Store) DiscardWarmRuntime(ctx context.Context, claim WarmRuntimeClaim, reason string) error {
	return s.finishWarmRuntimeClaim(ctx, claim, warmRuntimePoolStateDiscarding, reason)
}

func (s *Store) ConsumeWarmRuntime(ctx context.Context, claim WarmRuntimeClaim) error {
	return s.finishWarmRuntimeClaim(ctx, claim, warmRuntimePoolStateConsumed, "claimed runtime attached to session")
}

func (s *Store) finishWarmRuntimeClaim(ctx context.Context, claim WarmRuntimeClaim, state string, reason string) error {
	if s == nil || claim.ItemID == "" {
		return nil
	}
	now := time.Now().UTC()
	s.mu.Lock()
	defer s.mu.Unlock()
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

func (s *Store) ListWarmRuntimeItems(ctx context.Context, req WarmRuntimeListRequest) ([]WarmRuntimeItem, error) {
	if s == nil {
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
	s.mu.Lock()
	defer s.mu.Unlock()
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

func loadWarmRuntimeItemTx(ctx context.Context, tx *sql.Tx, itemID string) (WarmRuntimeItem, bool, error) {
	return scanWarmRuntimeItem(tx.QueryRowContext(ctx, `
SELECT item_id, pool_key, state, owner_id, session_id, generation, fencing_token,
       lease_until, host_json, last_error, workflow_id, run_id,
       created_at, updated_at, claimed_at, discarded_at
FROM warm_runtime_pool_items
WHERE item_id = ?`, itemID))
}

type warmRuntimeItemScanner interface {
	Scan(dest ...any) error
}

func scanWarmRuntimeItem(row warmRuntimeItemScanner) (WarmRuntimeItem, bool, error) {
	item, err := scanWarmRuntimeItemInto(row)
	if errors.Is(err, sql.ErrNoRows) {
		return WarmRuntimeItem{}, false, nil
	}
	if err != nil {
		return WarmRuntimeItem{}, false, err
	}
	return item, true, nil
}

func scanWarmRuntimeItemRows(row warmRuntimeItemScanner) (WarmRuntimeItem, error) {
	return scanWarmRuntimeItemInto(row)
}

func scanWarmRuntimeItemInto(row warmRuntimeItemScanner) (WarmRuntimeItem, error) {
	var item WarmRuntimeItem
	var leaseUntilText, claimedAtText, discardedAtText string
	var hostJSON string
	var createdAtText, updatedAtText string
	if err := row.Scan(
		&item.ItemID, &item.PoolKey, &item.State, &item.OwnerID, &item.SessionID, &item.Generation, &item.Fence,
		&leaseUntilText, &hostJSON, &item.LastError, &item.WorkflowID, &item.RunID,
		&createdAtText, &updatedAtText, &claimedAtText, &discardedAtText,
	); err != nil {
		return WarmRuntimeItem{}, err
	}
	if hostJSON != "" {
		if err := json.Unmarshal([]byte(hostJSON), &item.Host); err != nil {
			return WarmRuntimeItem{}, err
		}
	}
	var parseErr error
	if item.LeaseUntil, parseErr = parseOptionalWorkspaceTime("warm runtime lease_until", leaseUntilText); parseErr != nil {
		return WarmRuntimeItem{}, parseErr
	}
	if item.CreatedAt, parseErr = parseOptionalWorkspaceTime("warm runtime created_at", createdAtText); parseErr != nil {
		return WarmRuntimeItem{}, parseErr
	}
	if item.UpdatedAt, parseErr = parseOptionalWorkspaceTime("warm runtime updated_at", updatedAtText); parseErr != nil {
		return WarmRuntimeItem{}, parseErr
	}
	if item.ClaimedAt, parseErr = parseOptionalWorkspaceTime("warm runtime claimed_at", claimedAtText); parseErr != nil {
		return WarmRuntimeItem{}, parseErr
	}
	if item.DiscardedAt, parseErr = parseOptionalWorkspaceTime("warm runtime discarded_at", discardedAtText); parseErr != nil {
		return WarmRuntimeItem{}, parseErr
	}
	return item, nil
}
