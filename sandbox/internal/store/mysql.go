package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"slices"
	"strings"
	"time"

	"github.com/go-sql-driver/mysql"

	"cvm-mock-e2b/internal/core"
)

// MySQLStore persists pools and instances in MySQL.
type MySQLStore struct {
	db *sql.DB
}

type rowScanner interface {
	Scan(dest ...any) error
}

// NewMySQLStore builds a store from DSN (e.g. user:pass@tcp(host:3306)/db?parseTime=true).
func NewMySQLStore(dsn string) (*MySQLStore, error) {
	cfg, err := mysql.ParseDSN(dsn)
	if err != nil {
		return nil, err
	}
	cfg.ParseTime = true
	cfg.Loc = time.UTC
	if cfg.Params == nil {
		cfg.Params = make(map[string]string)
	}
	cfg.Params["time_zone"] = "'+00:00'"
	if strings.TrimSpace(cfg.DBName) == "" {
		return nil, errors.New("mysql dsn must include database name")
	}
	db, err := sql.Open("mysql", cfg.FormatDSN())
	if err != nil {
		return nil, err
	}
	m := &MySQLStore{db: db}
	if err := verifySchema(db, cfg.DBName); err != nil {
		_ = db.Close()
		return nil, err
	}
	m.logf("connected dsn=%s", maskDSN(dsn))
	return m, nil
}

var requiredTables = []string{
	"skus",
	"instances",
	"pools",
	"sandboxes",
	"template_classes",
	"template_sku_bindings",
	"template_pool_bindings",
	"pool_autoscale_policies",
	"capacity_bundles",
	"vpc_shards",
	"vpc_shard_subnets",
	"vpc_shard_blueprint_snapshots",
	"vpc_shard_provision_progress",
	"vpc_shard_create_locks",
	"vpc_shard_cleanup_resources",
}

const templatePoolBindingColumns = `
	template_class_id, pool_id, priority, weight, role, admission_state, reason, created_at, updated_at
`

func verifySchema(db *sql.DB, dbName string) error {
	rows, err := db.Query(`
		SELECT table_name
		FROM information_schema.tables
		WHERE table_schema = ?
	`, dbName)
	if err != nil {
		return err
	}
	defer rows.Close()

	found := make(map[string]struct{}, len(requiredTables))
	for rows.Next() {
		var table string
		if err := rows.Scan(&table); err != nil {
			return err
		}
		found[table] = struct{}{}
	}
	if err := rows.Err(); err != nil {
		return err
	}

	missing := make([]string, 0)
	for _, table := range requiredTables {
		if _, ok := found[table]; !ok {
			missing = append(missing, table)
		}
	}
	if len(missing) > 0 {
		slices.Sort(missing)
		return fmt.Errorf("sandbox schema missing tables %s; run sandbox migrations first", strings.Join(missing, ", "))
	}
	return nil
}

func (s *MySQLStore) CreatePool(ctx context.Context, pool core.Pool) (core.Pool, error) {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO pools (
			id, name, description, base_image, desired_capacity, instance_type, status, pause_reason,
			consecutive_refill_failures, last_refill_error_code, last_refill_error, vpc_id, subnet_id, zone,
			security_groups, template_class_id, sku_id, capacity_state, max_capacity, capacity_bundle_id,
			autoscale_generation, last_autoscale_action, last_health_transition_at, created_at
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, pool.ID, pool.Name, pool.Description, pool.BaseImage, pool.DesiredCap, pool.InstanceType, pool.Status, pool.PauseReason, pool.ConsecutiveRefillFailures, pool.LastRefillErrorCode, pool.LastRefillError, pool.VpcID, pool.SubnetID, pool.Zone, encodeSecurityGroups(pool.SecurityGroups), pool.TemplateClassID, pool.SKUID, pool.CapacityState, pool.MaxCapacity, pool.CapacityBundleID, pool.AutoscaleGeneration, pool.LastAutoscaleAction, pool.LastHealthTransition, pool.CreatedAt)
	s.logf("CreatePool id=%s name=%s err=%v", pool.ID, pool.Name, err)
	return pool, err
}

func (s *MySQLStore) GetPool(ctx context.Context, id string) (core.Pool, error) {
	var (
		p                    core.Pool
		sgStr                string
		pauseReason          sql.NullString
		lastRefillErrCode    sql.NullString
		lastRefillErr        sql.NullString
		lastHealthTransition sql.NullTime
	)
	err := s.db.QueryRowContext(ctx, `
		SELECT id, name, description, base_image, desired_capacity, instance_type, status, pause_reason, consecutive_refill_failures, last_refill_error_code, last_refill_error, vpc_id, subnet_id, zone, security_groups, template_class_id, sku_id, capacity_state, max_capacity, capacity_bundle_id, autoscale_generation, last_autoscale_action, last_health_transition_at, created_at
		FROM pools
		WHERE id = ?
	`, id).Scan(&p.ID, &p.Name, &p.Description, &p.BaseImage, &p.DesiredCap, &p.InstanceType, &p.Status, &pauseReason, &p.ConsecutiveRefillFailures, &lastRefillErrCode, &lastRefillErr, &p.VpcID, &p.SubnetID, &p.Zone, &sgStr, &p.TemplateClassID, &p.SKUID, &p.CapacityState, &p.MaxCapacity, &p.CapacityBundleID, &p.AutoscaleGeneration, &p.LastAutoscaleAction, &lastHealthTransition, &p.CreatedAt)
	s.logf("GetPool id=%s err=%v", id, err)
	if errors.Is(err, sql.ErrNoRows) {
		return core.Pool{}, core.ErrPoolNotFound
	}
	p.PauseReason = nullStringValue(pauseReason)
	p.LastRefillErrorCode = nullStringValue(lastRefillErrCode)
	p.LastRefillError = nullStringValue(lastRefillErr)
	p.SecurityGroups = decodeSecurityGroups(sgStr)
	if lastHealthTransition.Valid {
		ts := lastHealthTransition.Time
		p.LastHealthTransition = &ts
	}
	return p, err
}

func (s *MySQLStore) ListPools(ctx context.Context) ([]core.Pool, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, name, description, base_image, desired_capacity, instance_type, status, pause_reason, consecutive_refill_failures, last_refill_error_code, last_refill_error, vpc_id, subnet_id, zone, security_groups, template_class_id, sku_id, capacity_state, max_capacity, capacity_bundle_id, autoscale_generation, last_autoscale_action, last_health_transition_at, created_at
		FROM pools
		ORDER BY created_at ASC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	res := make([]core.Pool, 0)
	for rows.Next() {
		var (
			p                    core.Pool
			sgStr                string
			pauseReason          sql.NullString
			lastRefillErrCode    sql.NullString
			lastRefillErr        sql.NullString
			lastHealthTransition sql.NullTime
		)
		if err := rows.Scan(&p.ID, &p.Name, &p.Description, &p.BaseImage, &p.DesiredCap, &p.InstanceType, &p.Status, &pauseReason, &p.ConsecutiveRefillFailures, &lastRefillErrCode, &lastRefillErr, &p.VpcID, &p.SubnetID, &p.Zone, &sgStr, &p.TemplateClassID, &p.SKUID, &p.CapacityState, &p.MaxCapacity, &p.CapacityBundleID, &p.AutoscaleGeneration, &p.LastAutoscaleAction, &lastHealthTransition, &p.CreatedAt); err != nil {
			return nil, err
		}
		p.PauseReason = nullStringValue(pauseReason)
		p.LastRefillErrorCode = nullStringValue(lastRefillErrCode)
		p.LastRefillError = nullStringValue(lastRefillErr)
		p.SecurityGroups = decodeSecurityGroups(sgStr)
		if lastHealthTransition.Valid {
			ts := lastHealthTransition.Time
			p.LastHealthTransition = &ts
		}
		res = append(res, p)
	}
	return res, rows.Err()
}

func (s *MySQLStore) UpdatePool(ctx context.Context, pool core.Pool) (core.Pool, error) {
	_, err := s.db.ExecContext(ctx, `
		UPDATE pools SET
			name = ?, description = ?, base_image = ?, desired_capacity = ?, instance_type = ?, status = ?, pause_reason = ?,
			consecutive_refill_failures = ?, last_refill_error_code = ?, last_refill_error = ?, vpc_id = ?, subnet_id = ?,
			zone = ?, security_groups = ?, template_class_id = ?, capacity_state = ?, max_capacity = ?, capacity_bundle_id = ?,
			sku_id = ?, autoscale_generation = ?, last_autoscale_action = ?, last_health_transition_at = ?
		WHERE id = ?
	`, pool.Name, pool.Description, pool.BaseImage, pool.DesiredCap, pool.InstanceType, pool.Status, pool.PauseReason, pool.ConsecutiveRefillFailures, pool.LastRefillErrorCode, pool.LastRefillError, pool.VpcID, pool.SubnetID, pool.Zone, encodeSecurityGroups(pool.SecurityGroups), pool.TemplateClassID, pool.CapacityState, pool.MaxCapacity, pool.CapacityBundleID, pool.SKUID, pool.AutoscaleGeneration, pool.LastAutoscaleAction, pool.LastHealthTransition, pool.ID)
	return pool, err
}

func (s *MySQLStore) ListPoolsByIDs(ctx context.Context, ids []string) ([]core.Pool, error) {
	if len(ids) == 0 {
		return []core.Pool{}, nil
	}
	all, err := s.ListPools(ctx)
	if err != nil {
		return nil, err
	}
	byID := make(map[string]core.Pool, len(all))
	for _, pool := range all {
		byID[pool.ID] = pool
	}
	result := make([]core.Pool, 0, len(ids))
	for _, id := range ids {
		pool, ok := byID[id]
		if !ok {
			continue
		}
		result = append(result, pool)
	}
	return result, nil
}

func (s *MySQLStore) AddInstances(ctx context.Context, poolID string, instances []core.Instance) ([]core.Instance, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	stmt, err := tx.PrepareContext(ctx, `
		INSERT INTO instances (id, pool_id, state, cloud_id, address, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
	`)
	if err != nil {
		_ = tx.Rollback()
		return nil, err
	}
	defer stmt.Close()
	for _, inst := range instances {
		if _, err := stmt.ExecContext(ctx, inst.ID, inst.PoolID, inst.State, inst.CloudID, inst.Address, inst.CreatedAt, inst.UpdatedAt); err != nil {
			_ = tx.Rollback()
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return instances, nil
}

func (s *MySQLStore) ListInstances(ctx context.Context, poolID string) ([]core.Instance, error) {
	query := `
		SELECT id, pool_id, state, cloud_id, address, created_at, updated_at
		FROM instances
		WHERE pool_id = ?
	`
	args := []any{poolID}
	if total, index, ok := shardFromContext(ctx); ok {
		// TDSQL sharding-friendly filter: allow workers to handle a subset of shards.
		query += ` AND MOD(CRC32(id), ?) = ?`
		args = append(args, total, index)
	}
	query += ` ORDER BY created_at ASC`
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	res := make([]core.Instance, 0)
	for rows.Next() {
		var inst core.Instance
		if err := rows.Scan(&inst.ID, &inst.PoolID, &inst.State, &inst.CloudID, &inst.Address, &inst.CreatedAt, &inst.UpdatedAt); err != nil {
			return nil, err
		}
		res = append(res, inst)
	}
	return res, rows.Err()
}

func (s *MySQLStore) ListInstancesByStates(ctx context.Context, poolID string, states []core.InstanceState, limit int) ([]core.Instance, error) {
	if len(states) == 0 {
		return []core.Instance{}, nil
	}
	placeholders := make([]string, 0, len(states))
	args := make([]any, 0, len(states)+2)
	args = append(args, poolID)
	for _, st := range states {
		placeholders = append(placeholders, "?")
		args = append(args, st)
	}
	query := `
		SELECT id, pool_id, state, cloud_id, address, created_at, updated_at
		FROM instances
		WHERE pool_id = ? AND state IN (` + strings.Join(placeholders, ",") + `)
	`
	if total, index, ok := shardFromContext(ctx); ok {
		query += ` AND MOD(CRC32(id), ?) = ?`
		args = append(args, total, index)
	}
	query += ` ORDER BY created_at ASC`
	if limit > 0 {
		query += ` LIMIT ?`
		args = append(args, limit)
	}
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	res := make([]core.Instance, 0)
	for rows.Next() {
		var inst core.Instance
		if err := rows.Scan(&inst.ID, &inst.PoolID, &inst.State, &inst.CloudID, &inst.Address, &inst.CreatedAt, &inst.UpdatedAt); err != nil {
			return nil, err
		}
		res = append(res, inst)
	}
	return res, rows.Err()
}

func (s *MySQLStore) GetInstance(ctx context.Context, id string) (core.Instance, error) {
	var inst core.Instance
	err := s.db.QueryRowContext(ctx, `
		SELECT id, pool_id, state, cloud_id, address, created_at, updated_at
		FROM instances
		WHERE id = ?
	`, id).Scan(&inst.ID, &inst.PoolID, &inst.State, &inst.CloudID, &inst.Address, &inst.CreatedAt, &inst.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return core.Instance{}, core.ErrInstanceNotFound
	}
	return inst, err
}

func (s *MySQLStore) ClaimCleanInstance(ctx context.Context, poolID string) (core.Instance, error) {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return core.Instance{}, err
	}
	var inst core.Instance
	err = tx.QueryRowContext(ctx, `
		SELECT id, pool_id, state, cloud_id, address, created_at, updated_at
		FROM instances
		WHERE pool_id = ? AND state = ?
		LIMIT 1 FOR UPDATE
	`, poolID, core.StateClean).Scan(&inst.ID, &inst.PoolID, &inst.State, &inst.CloudID, &inst.Address, &inst.CreatedAt, &inst.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		_ = tx.Rollback()
		return core.Instance{}, core.ErrNoCleanInstance
	}
	if err != nil {
		_ = tx.Rollback()
		return core.Instance{}, err
	}
	now := time.Now().UTC()
	if _, err := tx.ExecContext(ctx, `
		UPDATE instances SET state = ?, updated_at = ? WHERE id = ?
	`, core.StateAllocated, now, inst.ID); err != nil {
		_ = tx.Rollback()
		return core.Instance{}, err
	}
	inst.State = core.StateAllocated
	inst.UpdatedAt = now
	if err := tx.Commit(); err != nil {
		return core.Instance{}, err
	}
	return inst, nil
}

func (s *MySQLStore) UpdateInstanceState(ctx context.Context, id string, expected core.InstanceState, target core.InstanceState) (core.Instance, error) {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return core.Instance{}, err
	}
	var inst core.Instance
	err = tx.QueryRowContext(ctx, `
		SELECT id, pool_id, state, cloud_id, address, created_at, updated_at
		FROM instances
		WHERE id = ?
		FOR UPDATE
	`, id).Scan(&inst.ID, &inst.PoolID, &inst.State, &inst.CloudID, &inst.Address, &inst.CreatedAt, &inst.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		_ = tx.Rollback()
		return core.Instance{}, core.ErrInstanceNotFound
	}
	if err != nil {
		_ = tx.Rollback()
		return core.Instance{}, err
	}
	if inst.State != expected {
		_ = tx.Rollback()
		return core.Instance{}, core.ErrInvalidTransition
	}
	now := time.Now().UTC()
	if _, err := tx.ExecContext(ctx, `
		UPDATE instances SET state = ?, updated_at = ? WHERE id = ?
	`, target, now, id); err != nil {
		_ = tx.Rollback()
		return core.Instance{}, err
	}
	inst.State = target
	inst.UpdatedAt = now
	if err := tx.Commit(); err != nil {
		return core.Instance{}, err
	}
	return inst, nil
}

func (s *MySQLStore) UpdateInstanceCloudAndState(ctx context.Context, id string, expected core.InstanceState, target core.InstanceState, address, cloudID string) (core.Instance, error) {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return core.Instance{}, err
	}
	var inst core.Instance
	err = tx.QueryRowContext(ctx, `
		SELECT id, pool_id, state, cloud_id, address, created_at, updated_at
		FROM instances
		WHERE id = ?
		FOR UPDATE
	`, id).Scan(&inst.ID, &inst.PoolID, &inst.State, &inst.CloudID, &inst.Address, &inst.CreatedAt, &inst.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		_ = tx.Rollback()
		return core.Instance{}, core.ErrInstanceNotFound
	}
	if err != nil {
		_ = tx.Rollback()
		return core.Instance{}, err
	}
	if inst.State != expected {
		_ = tx.Rollback()
		return core.Instance{}, core.ErrInvalidTransition
	}
	now := time.Now().UTC()
	if _, err := tx.ExecContext(ctx, `
		UPDATE instances SET state = ?, address = ?, cloud_id = ?, updated_at = ? WHERE id = ?
	`, target, address, cloudID, now, id); err != nil {
		_ = tx.Rollback()
		return core.Instance{}, err
	}
	inst.State = target
	inst.Address = address
	inst.CloudID = cloudID
	inst.UpdatedAt = now
	if err := tx.Commit(); err != nil {
		return core.Instance{}, err
	}
	return inst, nil
}

func (s *MySQLStore) DeleteInstance(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM instances WHERE id = ?`, id)
	return err
}

// Sandbox methods
func (s *MySQLStore) CreateSandbox(ctx context.Context, sb core.Sandbox) (core.Sandbox, error) {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO sandboxes (
			id, instance_id, pool_id, template_class_id, resolution_mode, resolution_source, resolution_divergence, region,
			metadata, env_vars, timeout_seconds, auto_pause, secure, allow_internet, created_at, updated_at
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, sb.ID, sb.InstanceID, sb.PoolID, sb.TemplateClassID, sb.ResolutionMode, sb.ResolutionSource, sb.ResolutionDivergence, sb.Region, encodeJSONMap(sb.Metadata), encodeJSONMap(sb.EnvVars), sb.TimeoutSeconds, sb.AutoPause, sb.Secure, sb.AllowInternetAccess, sb.CreatedAt, sb.UpdatedAt)
	s.logf("CreateSandbox id=%s pool=%s inst=%s err=%v", sb.ID, sb.PoolID, sb.InstanceID, err)
	return sb, err
}

func (s *MySQLStore) GetSandbox(ctx context.Context, id string) (core.Sandbox, error) {
	var (
		sb                core.Sandbox
		metaStr           sql.NullString
		envStr            sql.NullString
		resolutionDiverge sql.NullString
		autoPause         sql.NullBool
		secure            sql.NullBool
		allowNet          sql.NullBool
	)
	err := s.db.QueryRowContext(ctx, `
		SELECT id, instance_id, pool_id, template_class_id, resolution_mode, resolution_source, resolution_divergence, region, metadata, env_vars, timeout_seconds, auto_pause, secure, allow_internet, created_at, updated_at
		FROM sandboxes WHERE id = ?
	`, id).Scan(&sb.ID, &sb.InstanceID, &sb.PoolID, &sb.TemplateClassID, &sb.ResolutionMode, &sb.ResolutionSource, &resolutionDiverge, &sb.Region, &metaStr, &envStr, &sb.TimeoutSeconds, &autoPause, &secure, &allowNet, &sb.CreatedAt, &sb.UpdatedAt)
	s.logf("GetSandbox id=%s err=%v", id, err)
	if errors.Is(err, sql.ErrNoRows) {
		return core.Sandbox{}, core.ErrSandboxNotFound
	}
	if err != nil {
		return core.Sandbox{}, err
	}
	sb.ResolutionDivergence = resolutionDiverge.String
	sb.Metadata = decodeJSONMap(metaStr.String)
	sb.EnvVars = decodeJSONMap(envStr.String)
	sb.AutoPause = autoPause.Bool
	sb.Secure = secure.Bool
	sb.AllowInternetAccess = allowNet.Bool
	return sb, nil
}

func (s *MySQLStore) ListSandboxes(ctx context.Context) ([]core.Sandbox, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, instance_id, pool_id, template_class_id, resolution_mode, resolution_source, resolution_divergence, region, metadata, env_vars, timeout_seconds, auto_pause, secure, allow_internet, created_at, updated_at
		FROM sandboxes
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var res []core.Sandbox
	for rows.Next() {
		var (
			sb                core.Sandbox
			metaStr           sql.NullString
			envStr            sql.NullString
			resolutionDiverge sql.NullString
			autoPause         sql.NullBool
			secure            sql.NullBool
			allowNet          sql.NullBool
		)
		if err := rows.Scan(&sb.ID, &sb.InstanceID, &sb.PoolID, &sb.TemplateClassID, &sb.ResolutionMode, &sb.ResolutionSource, &resolutionDiverge, &sb.Region, &metaStr, &envStr, &sb.TimeoutSeconds, &autoPause, &secure, &allowNet, &sb.CreatedAt, &sb.UpdatedAt); err != nil {
			return nil, err
		}
		sb.ResolutionDivergence = resolutionDiverge.String
		sb.Metadata = decodeJSONMap(metaStr.String)
		sb.EnvVars = decodeJSONMap(envStr.String)
		sb.AutoPause = autoPause.Bool
		sb.Secure = secure.Bool
		sb.AllowInternetAccess = allowNet.Bool
		res = append(res, sb)
	}
	return res, rows.Err()
}

func (s *MySQLStore) DeleteSandbox(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM sandboxes WHERE id = ?`, id)
	s.logf("DeleteSandbox id=%s err=%v", id, err)
	return err
}

func (s *MySQLStore) UpsertTemplateClass(ctx context.Context, templateClass core.TemplateClass) (core.TemplateClass, error) {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO template_classes (
			id, name, description, workload_type, region, default_pool_selection_policy,
			resolution_mode, status, import_generation, divergence_message, created_at, updated_at
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON DUPLICATE KEY UPDATE
			name = VALUES(name),
			description = VALUES(description),
			workload_type = VALUES(workload_type),
			region = VALUES(region),
			default_pool_selection_policy = VALUES(default_pool_selection_policy),
			resolution_mode = VALUES(resolution_mode),
			status = VALUES(status),
			import_generation = VALUES(import_generation),
			divergence_message = VALUES(divergence_message),
			updated_at = VALUES(updated_at)
	`, templateClass.ID, templateClass.Name, templateClass.Description, templateClass.WorkloadType, templateClass.Region, templateClass.DefaultPoolSelectionPolicy, templateClass.ResolutionMode, templateClass.Status, templateClass.ImportGeneration, templateClass.DivergenceMessage, templateClass.CreatedAt, templateClass.UpdatedAt)
	return templateClass, err
}

func (s *MySQLStore) GetTemplateClass(ctx context.Context, id string) (core.TemplateClass, error) {
	var templateClass core.TemplateClass
	err := s.db.QueryRowContext(ctx, `
		SELECT id, name, description, workload_type, region, default_pool_selection_policy, resolution_mode, status, import_generation, divergence_message, created_at, updated_at
		FROM template_classes
		WHERE id = ?
	`, id).Scan(&templateClass.ID, &templateClass.Name, &templateClass.Description, &templateClass.WorkloadType, &templateClass.Region, &templateClass.DefaultPoolSelectionPolicy, &templateClass.ResolutionMode, &templateClass.Status, &templateClass.ImportGeneration, &templateClass.DivergenceMessage, &templateClass.CreatedAt, &templateClass.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return core.TemplateClass{}, core.ErrTemplateClassNotFound
	}
	return templateClass, err
}

func (s *MySQLStore) ListTemplateClasses(ctx context.Context) ([]core.TemplateClass, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, name, description, workload_type, region, default_pool_selection_policy, resolution_mode, status, import_generation, divergence_message, created_at, updated_at
		FROM template_classes
		ORDER BY created_at ASC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var items []core.TemplateClass
	for rows.Next() {
		var templateClass core.TemplateClass
		if err := rows.Scan(&templateClass.ID, &templateClass.Name, &templateClass.Description, &templateClass.WorkloadType, &templateClass.Region, &templateClass.DefaultPoolSelectionPolicy, &templateClass.ResolutionMode, &templateClass.Status, &templateClass.ImportGeneration, &templateClass.DivergenceMessage, &templateClass.CreatedAt, &templateClass.UpdatedAt); err != nil {
			return nil, err
		}
		items = append(items, templateClass)
	}
	return items, rows.Err()
}

func (s *MySQLStore) UpsertSKU(ctx context.Context, sku core.SKU) (core.SKU, error) {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO skus (
			id, name, description, template_class_id, base_image, desired_image_id, stable_image_id,
			instance_type, network_template_id, security_group_rule_template_id, autoscale_policy_id,
			default_desired_capacity, rollout_state, rollout_cursor_pool_id, generation,
			converged_pool_count, total_pool_count, pools_pending_rollout, last_rollout_started_at,
			last_rollout_error, created_at, updated_at
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON DUPLICATE KEY UPDATE
			name = VALUES(name),
			description = VALUES(description),
			template_class_id = VALUES(template_class_id),
			base_image = VALUES(base_image),
			desired_image_id = VALUES(desired_image_id),
			stable_image_id = VALUES(stable_image_id),
			instance_type = VALUES(instance_type),
			network_template_id = VALUES(network_template_id),
			security_group_rule_template_id = VALUES(security_group_rule_template_id),
			autoscale_policy_id = VALUES(autoscale_policy_id),
			default_desired_capacity = VALUES(default_desired_capacity),
			rollout_state = VALUES(rollout_state),
			rollout_cursor_pool_id = VALUES(rollout_cursor_pool_id),
			generation = VALUES(generation),
			converged_pool_count = VALUES(converged_pool_count),
			total_pool_count = VALUES(total_pool_count),
			pools_pending_rollout = VALUES(pools_pending_rollout),
			last_rollout_started_at = VALUES(last_rollout_started_at),
			last_rollout_error = VALUES(last_rollout_error),
			updated_at = VALUES(updated_at)
	`, sku.ID, sku.Name, sku.Description, sku.TemplateClassID, sku.BaseImage, sku.DesiredImageID, sku.StableImageID, sku.InstanceType, sku.NetworkTemplateID, sku.SecurityGroupRuleTemplateID, sku.AutoscalePolicyID, sku.DefaultDesiredCapacity, sku.RolloutState, sku.RolloutCursorPoolID, sku.Generation, sku.ConvergedPoolCount, sku.TotalPoolCount, sku.PoolsPendingRollout, sku.LastRolloutStartedAt, sku.LastRolloutError, sku.CreatedAt, sku.UpdatedAt)
	return sku, err
}

func (s *MySQLStore) GetSKU(ctx context.Context, id string) (core.SKU, error) {
	var sku core.SKU
	var lastRolloutStartedAt sql.NullTime
	err := s.db.QueryRowContext(ctx, `
		SELECT id, name, description, template_class_id, base_image, desired_image_id, stable_image_id,
			instance_type, network_template_id, security_group_rule_template_id, autoscale_policy_id,
			default_desired_capacity, rollout_state, rollout_cursor_pool_id, generation,
			converged_pool_count, total_pool_count, pools_pending_rollout, last_rollout_started_at,
			last_rollout_error, created_at, updated_at
		FROM skus
		WHERE id = ?
	`, id).Scan(&sku.ID, &sku.Name, &sku.Description, &sku.TemplateClassID, &sku.BaseImage, &sku.DesiredImageID, &sku.StableImageID, &sku.InstanceType, &sku.NetworkTemplateID, &sku.SecurityGroupRuleTemplateID, &sku.AutoscalePolicyID, &sku.DefaultDesiredCapacity, &sku.RolloutState, &sku.RolloutCursorPoolID, &sku.Generation, &sku.ConvergedPoolCount, &sku.TotalPoolCount, &sku.PoolsPendingRollout, &lastRolloutStartedAt, &sku.LastRolloutError, &sku.CreatedAt, &sku.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return core.SKU{}, core.ErrSKUNotFound
	}
	if lastRolloutStartedAt.Valid {
		ts := lastRolloutStartedAt.Time
		sku.LastRolloutStartedAt = &ts
	}
	return sku, err
}

func (s *MySQLStore) ListSKUs(ctx context.Context) ([]core.SKU, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, name, description, template_class_id, base_image, desired_image_id, stable_image_id,
			instance_type, network_template_id, security_group_rule_template_id, autoscale_policy_id,
			default_desired_capacity, rollout_state, rollout_cursor_pool_id, generation,
			converged_pool_count, total_pool_count, pools_pending_rollout, last_rollout_started_at,
			last_rollout_error, created_at, updated_at
		FROM skus
		ORDER BY created_at ASC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var items []core.SKU
	for rows.Next() {
		var sku core.SKU
		var lastRolloutStartedAt sql.NullTime
		if err := rows.Scan(&sku.ID, &sku.Name, &sku.Description, &sku.TemplateClassID, &sku.BaseImage, &sku.DesiredImageID, &sku.StableImageID, &sku.InstanceType, &sku.NetworkTemplateID, &sku.SecurityGroupRuleTemplateID, &sku.AutoscalePolicyID, &sku.DefaultDesiredCapacity, &sku.RolloutState, &sku.RolloutCursorPoolID, &sku.Generation, &sku.ConvergedPoolCount, &sku.TotalPoolCount, &sku.PoolsPendingRollout, &lastRolloutStartedAt, &sku.LastRolloutError, &sku.CreatedAt, &sku.UpdatedAt); err != nil {
			return nil, err
		}
		if lastRolloutStartedAt.Valid {
			ts := lastRolloutStartedAt.Time
			sku.LastRolloutStartedAt = &ts
		}
		items = append(items, sku)
	}
	return items, rows.Err()
}

func (s *MySQLStore) UpsertTemplateSkuBinding(ctx context.Context, binding core.TemplateSkuBinding) (core.TemplateSkuBinding, error) {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO template_sku_bindings (
			template_class_id, sku_id, priority, weight, admission_state, region_affinity, rollout_eligibility, created_at, updated_at
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON DUPLICATE KEY UPDATE
			priority = VALUES(priority),
			weight = VALUES(weight),
			admission_state = VALUES(admission_state),
			region_affinity = VALUES(region_affinity),
			rollout_eligibility = VALUES(rollout_eligibility),
			updated_at = VALUES(updated_at)
	`, binding.TemplateClassID, binding.SKUID, binding.Priority, binding.Weight, binding.AdmissionState, binding.RegionAffinity, binding.RolloutEligibility, binding.CreatedAt, binding.UpdatedAt)
	return binding, err
}

func (s *MySQLStore) ReplaceTemplateSkuBindings(ctx context.Context, templateClassID string, bindings []core.TemplateSkuBinding) ([]core.TemplateSkuBinding, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()

	if _, err = tx.ExecContext(ctx, `DELETE FROM template_sku_bindings WHERE template_class_id = ?`, templateClassID); err != nil {
		return nil, err
	}
	if len(bindings) == 0 {
		if err = tx.Commit(); err != nil {
			return nil, err
		}
		return []core.TemplateSkuBinding{}, nil
	}

	stmt, err := tx.PrepareContext(ctx, `
		INSERT INTO template_sku_bindings (
			template_class_id, sku_id, priority, weight, admission_state, region_affinity, rollout_eligibility, created_at, updated_at
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	`)
	if err != nil {
		return nil, err
	}
	defer stmt.Close()
	for _, binding := range bindings {
		if _, err = stmt.ExecContext(ctx, binding.TemplateClassID, binding.SKUID, binding.Priority, binding.Weight, binding.AdmissionState, binding.RegionAffinity, binding.RolloutEligibility, binding.CreatedAt, binding.UpdatedAt); err != nil {
			return nil, err
		}
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return bindings, nil
}

func (s *MySQLStore) ListTemplateSkuBindings(ctx context.Context, templateClassID string) ([]core.TemplateSkuBinding, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT template_class_id, sku_id, priority, weight, admission_state, region_affinity, rollout_eligibility, created_at, updated_at
		FROM template_sku_bindings
		WHERE template_class_id = ?
		ORDER BY priority ASC, weight DESC, sku_id ASC
	`, templateClassID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var items []core.TemplateSkuBinding
	for rows.Next() {
		var binding core.TemplateSkuBinding
		if err := rows.Scan(&binding.TemplateClassID, &binding.SKUID, &binding.Priority, &binding.Weight, &binding.AdmissionState, &binding.RegionAffinity, &binding.RolloutEligibility, &binding.CreatedAt, &binding.UpdatedAt); err != nil {
			return nil, err
		}
		items = append(items, binding)
	}
	return items, rows.Err()
}

func (s *MySQLStore) UpsertTemplatePoolBinding(ctx context.Context, binding core.TemplatePoolBinding) (core.TemplatePoolBinding, error) {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO template_pool_bindings (
			template_class_id, pool_id, priority, weight, role, admission_state, reason, created_at, updated_at
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON DUPLICATE KEY UPDATE
			priority = VALUES(priority),
			weight = VALUES(weight),
			role = VALUES(role),
			admission_state = VALUES(admission_state),
			reason = VALUES(reason),
			updated_at = VALUES(updated_at)
	`, binding.TemplateClassID, binding.PoolID, binding.Priority, binding.Weight, binding.Role, binding.AdmissionState, binding.Reason, binding.CreatedAt, binding.UpdatedAt)
	return binding, err
}

func (s *MySQLStore) ReplaceTemplatePoolBindings(ctx context.Context, templateClassID string, bindings []core.TemplatePoolBinding) ([]core.TemplatePoolBinding, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()

	if _, err = tx.ExecContext(ctx, `DELETE FROM template_pool_bindings WHERE template_class_id = ?`, templateClassID); err != nil {
		return nil, err
	}
	if len(bindings) == 0 {
		if err = tx.Commit(); err != nil {
			return nil, err
		}
		return []core.TemplatePoolBinding{}, nil
	}

	stmt, err := tx.PrepareContext(ctx, `
		INSERT INTO template_pool_bindings (
			template_class_id, pool_id, priority, weight, role, admission_state, reason, created_at, updated_at
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	`)
	if err != nil {
		return nil, err
	}
	defer stmt.Close()
	for _, binding := range bindings {
		if _, err = stmt.ExecContext(ctx, binding.TemplateClassID, binding.PoolID, binding.Priority, binding.Weight, binding.Role, binding.AdmissionState, binding.Reason, binding.CreatedAt, binding.UpdatedAt); err != nil {
			return nil, err
		}
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return bindings, nil
}

func (s *MySQLStore) UpdateTemplatePoolBindingAdmission(ctx context.Context, templateClassID string, poolID string, admissionState core.BindingAdmissionState, reason string) (core.TemplatePoolBinding, error) {
	_, err := s.db.ExecContext(ctx, `
		UPDATE template_pool_bindings
		SET admission_state = ?, reason = ?, updated_at = UTC_TIMESTAMP(6)
		WHERE template_class_id = ? AND pool_id = ?
	`, admissionState, reason, templateClassID, poolID)
	if err != nil {
		return core.TemplatePoolBinding{}, err
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT `+templatePoolBindingColumns+`
		FROM template_pool_bindings
		WHERE template_class_id = ? AND pool_id = ?
	`, templateClassID, poolID)
	if err != nil {
		return core.TemplatePoolBinding{}, err
	}
	defer rows.Close()
	if rows.Next() {
		binding, err := scanTemplatePoolBinding(rows)
		if err != nil {
			return core.TemplatePoolBinding{}, err
		}
		return binding, nil
	}
	return core.TemplatePoolBinding{}, core.ErrPoolNotFound
}

func (s *MySQLStore) ListTemplatePoolBindings(ctx context.Context, templateClassID string) ([]core.TemplatePoolBinding, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT `+templatePoolBindingColumns+`
		FROM template_pool_bindings
		WHERE template_class_id = ?
		ORDER BY priority ASC, weight DESC, pool_id ASC
	`, templateClassID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var items []core.TemplatePoolBinding
	for rows.Next() {
		binding, err := scanTemplatePoolBinding(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, binding)
	}
	return items, rows.Err()
}

func scanTemplatePoolBinding(scanner rowScanner) (core.TemplatePoolBinding, error) {
	var binding core.TemplatePoolBinding
	err := scanner.Scan(
		&binding.TemplateClassID,
		&binding.PoolID,
		&binding.Priority,
		&binding.Weight,
		&binding.Role,
		&binding.AdmissionState,
		&binding.Reason,
		&binding.CreatedAt,
		&binding.UpdatedAt,
	)
	return binding, err
}

func (s *MySQLStore) DeleteTemplatePoolBinding(ctx context.Context, templateClassID string, poolID string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM template_pool_bindings WHERE template_class_id = ? AND pool_id = ?`, templateClassID, poolID)
	return err
}

func (s *MySQLStore) UpsertPoolAutoscalePolicy(ctx context.Context, policy core.PoolAutoscalePolicy) (core.PoolAutoscalePolicy, error) {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO pool_autoscale_policies (
			template_class_id, min_pool_count, max_pool_count, min_clean_per_pool, target_clean_per_pool,
			max_clean_per_pool, warm_bundle_target, slow_horizon_target, scale_out_cooldown_seconds,
			scale_in_cooldown_seconds, refill_failure_threshold, zone_failure_threshold,
			capacity_pressure_limit_pct, created_at, updated_at
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON DUPLICATE KEY UPDATE
			min_pool_count = VALUES(min_pool_count),
			max_pool_count = VALUES(max_pool_count),
			min_clean_per_pool = VALUES(min_clean_per_pool),
			target_clean_per_pool = VALUES(target_clean_per_pool),
			max_clean_per_pool = VALUES(max_clean_per_pool),
			warm_bundle_target = VALUES(warm_bundle_target),
			slow_horizon_target = VALUES(slow_horizon_target),
			scale_out_cooldown_seconds = VALUES(scale_out_cooldown_seconds),
			scale_in_cooldown_seconds = VALUES(scale_in_cooldown_seconds),
			refill_failure_threshold = VALUES(refill_failure_threshold),
			zone_failure_threshold = VALUES(zone_failure_threshold),
			capacity_pressure_limit_pct = VALUES(capacity_pressure_limit_pct),
			updated_at = VALUES(updated_at)
	`, policy.TemplateClassID, policy.MinPoolCount, policy.MaxPoolCount, policy.MinCleanPerPool, policy.TargetCleanPerPool, policy.MaxCleanPerPool, policy.WarmBundleTarget, policy.SlowHorizonTarget, policy.ScaleOutCooldownSeconds, policy.ScaleInCooldownSeconds, policy.RefillFailureThreshold, policy.ZoneFailureThreshold, policy.CapacityPressureLimitPct, policy.CreatedAt, policy.UpdatedAt)
	return policy, err
}

func (s *MySQLStore) GetPoolAutoscalePolicy(ctx context.Context, templateClassID string) (core.PoolAutoscalePolicy, error) {
	var policy core.PoolAutoscalePolicy
	err := s.db.QueryRowContext(ctx, `
		SELECT template_class_id, min_pool_count, max_pool_count, min_clean_per_pool, target_clean_per_pool, max_clean_per_pool, warm_bundle_target, slow_horizon_target, scale_out_cooldown_seconds, scale_in_cooldown_seconds, refill_failure_threshold, zone_failure_threshold, capacity_pressure_limit_pct, created_at, updated_at
		FROM pool_autoscale_policies
		WHERE template_class_id = ?
	`, templateClassID).Scan(&policy.TemplateClassID, &policy.MinPoolCount, &policy.MaxPoolCount, &policy.MinCleanPerPool, &policy.TargetCleanPerPool, &policy.MaxCleanPerPool, &policy.WarmBundleTarget, &policy.SlowHorizonTarget, &policy.ScaleOutCooldownSeconds, &policy.ScaleInCooldownSeconds, &policy.RefillFailureThreshold, &policy.ZoneFailureThreshold, &policy.CapacityPressureLimitPct, &policy.CreatedAt, &policy.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return core.PoolAutoscalePolicy{}, core.ErrPoolAutoscalePolicyNotFound
	}
	return policy, err
}

func (s *MySQLStore) UpsertCapacityBundle(ctx context.Context, bundle core.CapacityBundle) (core.CapacityBundle, error) {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO capacity_bundles (
			id, region, zone, vpc_id, subnet_id, security_group_ids, network_template_id,
			status, bootstrap_generation, lineage_tags, last_validation_result, created_at, updated_at
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON DUPLICATE KEY UPDATE
			region = VALUES(region),
			zone = VALUES(zone),
			vpc_id = VALUES(vpc_id),
			subnet_id = VALUES(subnet_id),
			security_group_ids = VALUES(security_group_ids),
			network_template_id = VALUES(network_template_id),
			status = VALUES(status),
			bootstrap_generation = VALUES(bootstrap_generation),
			lineage_tags = VALUES(lineage_tags),
			last_validation_result = VALUES(last_validation_result),
			updated_at = VALUES(updated_at)
	`, bundle.ID, bundle.Region, bundle.Zone, bundle.VpcID, bundle.SubnetID, encodeSecurityGroups(bundle.SecurityGroupIDs), bundle.NetworkTemplateID, bundle.Status, bundle.BootstrapGeneration, encodeJSONMap(bundle.LineageTags), bundle.LastValidationResult, bundle.CreatedAt, bundle.UpdatedAt)
	return bundle, err
}

func (s *MySQLStore) GetCapacityBundle(ctx context.Context, id string) (core.CapacityBundle, error) {
	bundle, err := s.readCapacityBundle(s.db.QueryRowContext(ctx, `
		SELECT id, region, zone, vpc_id, subnet_id, security_group_ids, network_template_id, status, bootstrap_generation, lineage_tags, last_validation_result, created_at, updated_at
		FROM capacity_bundles
		WHERE id = ?
	`, id))
	return bundle, err
}

func (s *MySQLStore) ListCapacityBundles(ctx context.Context) ([]core.CapacityBundle, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, region, zone, vpc_id, subnet_id, security_group_ids, network_template_id, status, bootstrap_generation, lineage_tags, last_validation_result, created_at, updated_at
		FROM capacity_bundles
		ORDER BY created_at ASC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var items []core.CapacityBundle
	for rows.Next() {
		bundle, err := s.readCapacityBundle(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, bundle)
	}
	return items, rows.Err()
}

func (s *MySQLStore) ReserveCapacityBundleForPool(ctx context.Context, bundleID string, templateClassID string, skuID string, poolID string) (core.CapacityBundle, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return core.CapacityBundle{}, err
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()

	bundle, err := s.readCapacityBundle(tx.QueryRowContext(ctx, `
		SELECT id, region, zone, vpc_id, subnet_id, security_group_ids, network_template_id, status, bootstrap_generation, lineage_tags, last_validation_result, created_at, updated_at
		FROM capacity_bundles
		WHERE id = ?
		FOR UPDATE
	`, bundleID))
	if err != nil {
		return core.CapacityBundle{}, err
	}
	if bundle.LineageTags == nil {
		bundle.LineageTags = map[string]string{}
	}
	if existing := strings.TrimSpace(bundle.LineageTags["pool_id"]); existing != "" && existing != poolID {
		return core.CapacityBundle{}, fmt.Errorf("capacity bundle %s already reserved by pool %s", bundleID, existing)
	}
	if existing := strings.TrimSpace(bundle.LineageTags["sku_id"]); existing != "" && existing != skuID {
		return core.CapacityBundle{}, fmt.Errorf("capacity bundle %s already reserved by sku %s", bundleID, existing)
	}
	switch bundle.Status {
	case core.CapacityBundleStatusWarm, core.CapacityBundleStatusActive:
	default:
		return core.CapacityBundle{}, fmt.Errorf("capacity bundle %s is not reservable from status %s", bundleID, bundle.Status)
	}
	now := time.Now().UTC()
	bundle.Status = core.CapacityBundleStatusActive
	bundle.LineageTags["template_class_id"] = templateClassID
	bundle.LineageTags["sku_id"] = skuID
	bundle.LineageTags["pool_id"] = poolID
	bundle.UpdatedAt = now
	if _, err = tx.ExecContext(ctx, `
		UPDATE capacity_bundles
		SET status = ?, lineage_tags = ?, updated_at = ?
		WHERE id = ?
	`, bundle.Status, encodeJSONMap(bundle.LineageTags), bundle.UpdatedAt, bundle.ID); err != nil {
		return core.CapacityBundle{}, err
	}
	if err = tx.Commit(); err != nil {
		return core.CapacityBundle{}, err
	}
	return bundle, nil
}

func (s *MySQLStore) TryStartPoolSGShardRecovery(ctx context.Context, poolID string) (core.Pool, bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return core.Pool{}, false, err
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()

	var (
		p                    core.Pool
		sgStr                string
		pauseReason          sql.NullString
		lastRefillErrCode    sql.NullString
		lastRefillErr        sql.NullString
		lastHealthTransition sql.NullTime
	)
	err = tx.QueryRowContext(ctx, `
		SELECT id, name, description, base_image, desired_capacity, instance_type, status, pause_reason, consecutive_refill_failures, last_refill_error_code, last_refill_error, vpc_id, subnet_id, zone, security_groups, template_class_id, sku_id, capacity_state, max_capacity, capacity_bundle_id, autoscale_generation, last_autoscale_action, last_health_transition_at, created_at
		FROM pools
		WHERE id = ?
		FOR UPDATE
	`, poolID).Scan(&p.ID, &p.Name, &p.Description, &p.BaseImage, &p.DesiredCap, &p.InstanceType, &p.Status, &pauseReason, &p.ConsecutiveRefillFailures, &lastRefillErrCode, &lastRefillErr, &p.VpcID, &p.SubnetID, &p.Zone, &sgStr, &p.TemplateClassID, &p.SKUID, &p.CapacityState, &p.MaxCapacity, &p.CapacityBundleID, &p.AutoscaleGeneration, &p.LastAutoscaleAction, &lastHealthTransition, &p.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return core.Pool{}, false, core.ErrPoolNotFound
	}
	if err != nil {
		return core.Pool{}, false, err
	}
	p.PauseReason = nullStringValue(pauseReason)
	p.LastRefillErrorCode = nullStringValue(lastRefillErrCode)
	p.LastRefillError = nullStringValue(lastRefillErr)
	p.SecurityGroups = decodeSecurityGroups(sgStr)
	if lastHealthTransition.Valid {
		ts := lastHealthTransition.Time
		p.LastHealthTransition = &ts
	}
	if p.LastAutoscaleAction == "sg_shard_recovery_pending" {
		if err = tx.Commit(); err != nil {
			return core.Pool{}, false, err
		}
		return p, false, nil
	}
	p.LastAutoscaleAction = "sg_shard_recovery_pending"
	p.AutoscaleGeneration++
	if _, err = tx.ExecContext(ctx, `
		UPDATE pools
		SET autoscale_generation = ?, last_autoscale_action = ?
		WHERE id = ?
	`, p.AutoscaleGeneration, p.LastAutoscaleAction, p.ID); err != nil {
		return core.Pool{}, false, err
	}
	if err = tx.Commit(); err != nil {
		return core.Pool{}, false, err
	}
	return p, true, nil
}

func (s *MySQLStore) BeginSKUPoolRollout(ctx context.Context, skuID string, poolID string, desiredImage string, startedAt time.Time) (core.SKU, core.Pool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return core.SKU{}, core.Pool{}, err
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()

	if _, err = tx.ExecContext(ctx, `
		UPDATE pools
		SET base_image = ?, last_autoscale_action = ?
		WHERE id = ?
	`, desiredImage, "sku_rollout_start", poolID); err != nil {
		return core.SKU{}, core.Pool{}, err
	}
	if _, err = tx.ExecContext(ctx, `
		UPDATE instances
		SET state = ?, updated_at = ?
		WHERE pool_id = ? AND state = ?
	`, core.StateDry, startedAt, poolID, core.StateClean); err != nil {
		return core.SKU{}, core.Pool{}, err
	}
	if _, err = tx.ExecContext(ctx, `
		UPDATE skus
		SET rollout_state = ?, rollout_cursor_pool_id = ?, last_rollout_started_at = ?, last_rollout_error = '', updated_at = ?
		WHERE id = ?
	`, core.SKURolloutStateRolling, poolID, startedAt, startedAt, skuID); err != nil {
		return core.SKU{}, core.Pool{}, err
	}
	if err = tx.Commit(); err != nil {
		return core.SKU{}, core.Pool{}, err
	}
	sku, err := s.GetSKU(ctx, skuID)
	if err != nil {
		return core.SKU{}, core.Pool{}, err
	}
	pool, err := s.GetPool(ctx, poolID)
	if err != nil {
		return core.SKU{}, core.Pool{}, err
	}
	return sku, pool, nil
}

func (s *MySQLStore) UpsertVPCShard(ctx context.Context, shard core.VPCShard) (core.VPCShard, error) {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO vpc_shards (
			id, blueprint_snapshot_id, blueprint_fingerprint, template_class_id, sku_id, network_template_id,
			region, vpc_id, state, active_subnet_member_id, last_switch_at, last_waterline_reason,
			cleanup_state, cleanup_started_at, cleanup_last_error, created_at, updated_at
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON DUPLICATE KEY UPDATE
			blueprint_snapshot_id = VALUES(blueprint_snapshot_id),
			blueprint_fingerprint = VALUES(blueprint_fingerprint),
			template_class_id = VALUES(template_class_id),
			sku_id = VALUES(sku_id),
			network_template_id = VALUES(network_template_id),
			region = VALUES(region),
			vpc_id = VALUES(vpc_id),
			state = VALUES(state),
			active_subnet_member_id = VALUES(active_subnet_member_id),
			last_switch_at = VALUES(last_switch_at),
			last_waterline_reason = VALUES(last_waterline_reason),
			cleanup_state = VALUES(cleanup_state),
			cleanup_started_at = VALUES(cleanup_started_at),
			cleanup_last_error = VALUES(cleanup_last_error),
			updated_at = VALUES(updated_at)
	`, shard.ID, shard.BlueprintSnapshotID, shard.BlueprintFingerprint, shard.TemplateClassID, shard.SKUID, shard.NetworkTemplateID, shard.Region, shard.VpcID, shard.State, shard.ActiveSubnetMemberID, shard.LastSwitchAt, shard.LastWaterlineReason, shard.CleanupState, shard.CleanupStartedAt, shard.CleanupLastError, shard.CreatedAt, shard.UpdatedAt)
	return shard, err
}

func (s *MySQLStore) GetVPCShard(ctx context.Context, id string) (core.VPCShard, error) {
	return s.readVPCShard(s.db.QueryRowContext(ctx, `
		SELECT id, blueprint_snapshot_id, blueprint_fingerprint, template_class_id, sku_id, network_template_id,
		       region, vpc_id, state, active_subnet_member_id, last_switch_at, last_waterline_reason,
		       cleanup_state, cleanup_started_at, cleanup_last_error, created_at, updated_at
		FROM vpc_shards
		WHERE id = ?
	`, id))
}

func (s *MySQLStore) ListVPCShards(ctx context.Context) ([]core.VPCShard, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, blueprint_snapshot_id, blueprint_fingerprint, template_class_id, sku_id, network_template_id,
		       region, vpc_id, state, active_subnet_member_id, last_switch_at, last_waterline_reason,
		       cleanup_state, cleanup_started_at, cleanup_last_error, created_at, updated_at
		FROM vpc_shards
		ORDER BY created_at ASC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var items []core.VPCShard
	for rows.Next() {
		shard, err := s.readVPCShard(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, shard)
	}
	return items, rows.Err()
}

func (s *MySQLStore) ReplaceVPCShardSubnets(ctx context.Context, shardID string, subnets []core.VPCShardSubnet) ([]core.VPCShardSubnet, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()
	if _, err = tx.ExecContext(ctx, `DELETE FROM vpc_shard_subnets WHERE vpc_shard_id = ?`, shardID); err != nil {
		return nil, err
	}
	for _, subnet := range subnets {
		if _, err = tx.ExecContext(ctx, `
			INSERT INTO vpc_shard_subnets (
				id, vpc_shard_id, subnet_id, zone, role, ordinal, reservation_state, near_waterline, created_at, updated_at
			)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`, subnet.ID, shardID, subnet.SubnetID, subnet.Zone, subnet.Role, subnet.Ordinal, subnet.ReservationState, subnet.NearWaterline, subnet.CreatedAt, subnet.UpdatedAt); err != nil {
			return nil, err
		}
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return subnets, nil
}

func (s *MySQLStore) ListVPCShardSubnets(ctx context.Context, shardID string) ([]core.VPCShardSubnet, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, vpc_shard_id, subnet_id, zone, role, ordinal, reservation_state, near_waterline, created_at, updated_at
		FROM vpc_shard_subnets
		WHERE vpc_shard_id = ?
		ORDER BY ordinal ASC, created_at ASC
	`, shardID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var items []core.VPCShardSubnet
	for rows.Next() {
		subnet, err := s.readVPCShardSubnet(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, subnet)
	}
	if len(items) == 0 {
		if _, err := s.GetVPCShard(ctx, shardID); err != nil {
			return nil, err
		}
	}
	return items, rows.Err()
}

func (s *MySQLStore) ReserveNextVPCShardSubnet(ctx context.Context, shardID string) (core.VPCShard, core.VPCShardSubnet, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return core.VPCShard{}, core.VPCShardSubnet{}, err
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()
	shard, err := s.readVPCShard(tx.QueryRowContext(ctx, `
		SELECT id, blueprint_snapshot_id, blueprint_fingerprint, template_class_id, sku_id, network_template_id,
		       region, vpc_id, state, active_subnet_member_id, last_switch_at, last_waterline_reason,
		       cleanup_state, cleanup_started_at, cleanup_last_error, created_at, updated_at
		FROM vpc_shards
		WHERE id = ?
		FOR UPDATE
	`, shardID))
	if err != nil {
		return core.VPCShard{}, core.VPCShardSubnet{}, err
	}
	subnet, err := s.readVPCShardSubnet(tx.QueryRowContext(ctx, `
		SELECT id, vpc_shard_id, subnet_id, zone, role, ordinal, reservation_state, near_waterline, created_at, updated_at
		FROM vpc_shard_subnets
		WHERE vpc_shard_id = ? AND role = ? AND reservation_state = ? AND near_waterline = FALSE
		ORDER BY ordinal ASC, created_at ASC
		LIMIT 1
		FOR UPDATE
	`, shardID, core.VPCShardSubnetRoleWorkload, core.VPCShardSubnetReservationAvailable))
	if err != nil {
		return core.VPCShard{}, core.VPCShardSubnet{}, err
	}
	now := time.Now().UTC()
	if _, err = tx.ExecContext(ctx, `
		UPDATE vpc_shard_subnets
		SET reservation_state = ?, updated_at = ?
		WHERE id = ?
	`, core.VPCShardSubnetReservationReserved, now, subnet.ID); err != nil {
		return core.VPCShard{}, core.VPCShardSubnet{}, err
	}
	subnet.ReservationState = core.VPCShardSubnetReservationReserved
	subnet.UpdatedAt = now
	if err = tx.Commit(); err != nil {
		return core.VPCShard{}, core.VPCShardSubnet{}, err
	}
	return shard, subnet, nil
}

func (s *MySQLStore) ActivateVPCShardSubnet(ctx context.Context, shardID string, subnetMemberID string, switchedAt time.Time, waterlineReason string) (core.VPCShard, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return core.VPCShard{}, err
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()
	shard, err := s.readVPCShard(tx.QueryRowContext(ctx, `
		SELECT id, blueprint_snapshot_id, blueprint_fingerprint, template_class_id, sku_id, network_template_id,
		       region, vpc_id, state, active_subnet_member_id, last_switch_at, last_waterline_reason,
		       cleanup_state, cleanup_started_at, cleanup_last_error, created_at, updated_at
		FROM vpc_shards
		WHERE id = ?
		FOR UPDATE
	`, shardID))
	if err != nil {
		return core.VPCShard{}, err
	}
	subnet, err := s.readVPCShardSubnet(tx.QueryRowContext(ctx, `
		SELECT id, vpc_shard_id, subnet_id, zone, role, ordinal, reservation_state, near_waterline, created_at, updated_at
		FROM vpc_shard_subnets
		WHERE id = ? AND vpc_shard_id = ?
		FOR UPDATE
	`, subnetMemberID, shardID))
	if err != nil {
		return core.VPCShard{}, err
	}
	if previousID := strings.TrimSpace(shard.ActiveSubnetMemberID); previousID != "" && previousID != subnetMemberID {
		previous, err := s.readVPCShardSubnet(tx.QueryRowContext(ctx, `
			SELECT id, vpc_shard_id, subnet_id, zone, role, ordinal, reservation_state, near_waterline, created_at, updated_at
			FROM vpc_shard_subnets
			WHERE id = ? AND vpc_shard_id = ?
			FOR UPDATE
		`, previousID, shardID))
		if err != nil && !errors.Is(err, core.ErrVPCShardSubnetNotFound) {
			return core.VPCShard{}, err
		}
		if err == nil {
			nextState := core.VPCShardSubnetReservationAvailable
			if previous.NearWaterline {
				nextState = core.VPCShardSubnetReservationExhausted
			}
			if _, err = tx.ExecContext(ctx, `
				UPDATE vpc_shard_subnets
				SET reservation_state = ?, updated_at = ?
				WHERE id = ?
			`, nextState, switchedAt.UTC(), previous.ID); err != nil {
				return core.VPCShard{}, err
			}
		}
	}
	if _, err = tx.ExecContext(ctx, `
		UPDATE vpc_shard_subnets
		SET reservation_state = ?, updated_at = ?
		WHERE id = ?
	`, core.VPCShardSubnetReservationActive, switchedAt.UTC(), subnet.ID); err != nil {
		return core.VPCShard{}, err
	}
	if _, err = tx.ExecContext(ctx, `
		UPDATE vpc_shards
		SET active_subnet_member_id = ?, last_switch_at = ?, last_waterline_reason = ?, updated_at = ?
		WHERE id = ?
	`, subnet.ID, switchedAt.UTC(), waterlineReason, switchedAt.UTC(), shardID); err != nil {
		return core.VPCShard{}, err
	}
	if err = tx.Commit(); err != nil {
		return core.VPCShard{}, err
	}
	return s.GetVPCShard(ctx, shardID)
}

func (s *MySQLStore) UpsertVPCShardBlueprintSnapshot(ctx context.Context, snapshot core.VPCShardBlueprintSnapshot) (core.VPCShardBlueprintSnapshot, error) {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO vpc_shard_blueprint_snapshots (
			id, schema_version, source_region, network_template_id, blueprint_fingerprint,
			topology_json, validation_state, created_at
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON DUPLICATE KEY UPDATE
			schema_version = VALUES(schema_version),
			source_region = VALUES(source_region),
			network_template_id = VALUES(network_template_id),
			blueprint_fingerprint = VALUES(blueprint_fingerprint),
			topology_json = VALUES(topology_json),
			validation_state = VALUES(validation_state)
	`, snapshot.ID, snapshot.SchemaVersion, snapshot.SourceRegion, snapshot.NetworkTemplateID, snapshot.BlueprintFingerprint, snapshot.TopologyJSON, snapshot.ValidationState, snapshot.CreatedAt)
	return snapshot, err
}

func (s *MySQLStore) GetVPCShardBlueprintSnapshot(ctx context.Context, id string) (core.VPCShardBlueprintSnapshot, error) {
	return s.readVPCShardBlueprintSnapshot(s.db.QueryRowContext(ctx, `
		SELECT id, schema_version, source_region, network_template_id, blueprint_fingerprint,
		       topology_json, validation_state, created_at
		FROM vpc_shard_blueprint_snapshots
		WHERE id = ?
	`, id))
}

func (s *MySQLStore) ListVPCShardBlueprintSnapshots(ctx context.Context) ([]core.VPCShardBlueprintSnapshot, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, schema_version, source_region, network_template_id, blueprint_fingerprint,
		       topology_json, validation_state, created_at
		FROM vpc_shard_blueprint_snapshots
		ORDER BY created_at ASC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var items []core.VPCShardBlueprintSnapshot
	for rows.Next() {
		item, err := s.readVPCShardBlueprintSnapshot(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *MySQLStore) UpsertVPCShardProvisionProgress(ctx context.Context, progress core.VPCShardProvisionProgress) (core.VPCShardProvisionProgress, error) {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO vpc_shard_provision_progress (
			id, vpc_shard_id, blueprint_snapshot_id, blueprint_fingerprint,
			status, last_step, last_error, started_at, updated_at, completed_at
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON DUPLICATE KEY UPDATE
			blueprint_snapshot_id = VALUES(blueprint_snapshot_id),
			blueprint_fingerprint = VALUES(blueprint_fingerprint),
			status = VALUES(status),
			last_step = VALUES(last_step),
			last_error = VALUES(last_error),
			started_at = VALUES(started_at),
			updated_at = VALUES(updated_at),
			completed_at = VALUES(completed_at)
	`, progress.ID, progress.VPCShardID, progress.BlueprintSnapshotID, progress.BlueprintFingerprint, progress.Status, progress.LastStep, progress.LastError, progress.StartedAt, progress.UpdatedAt, progress.CompletedAt)
	return progress, err
}

func (s *MySQLStore) GetVPCShardProvisionProgress(ctx context.Context, shardID string) (core.VPCShardProvisionProgress, error) {
	return s.readVPCShardProvisionProgress(s.db.QueryRowContext(ctx, `
		SELECT id, vpc_shard_id, blueprint_snapshot_id, blueprint_fingerprint,
		       status, last_step, last_error, started_at, updated_at, completed_at
		FROM vpc_shard_provision_progress
		WHERE vpc_shard_id = ?
	`, shardID))
}

func (s *MySQLStore) TryStartVPCShardCreate(ctx context.Context, blueprintFingerprint string, region string) (core.VPCShardCreateLock, bool, error) {
	blueprintFingerprint = strings.TrimSpace(blueprintFingerprint)
	region = strings.TrimSpace(region)
	if blueprintFingerprint == "" || region == "" {
		return core.VPCShardCreateLock{}, false, errors.New("missing vpc shard create lock key")
	}
	lock := core.VPCShardCreateLock{
		ID:                   blueprintFingerprint + "|" + region,
		BlueprintFingerprint: blueprintFingerprint,
		Region:               region,
		CreatedAt:            time.Now().UTC(),
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO vpc_shard_create_locks (
			id, blueprint_fingerprint, region, created_at
		) VALUES (?, ?, ?, ?)
	`, lock.ID, lock.BlueprintFingerprint, lock.Region, lock.CreatedAt)
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "duplicate") {
			return lock, false, nil
		}
		return core.VPCShardCreateLock{}, false, err
	}
	return lock, true, nil
}

func (s *MySQLStore) DeleteVPCShardCreateLock(ctx context.Context, blueprintFingerprint string, region string) error {
	_, err := s.db.ExecContext(ctx, `
		DELETE FROM vpc_shard_create_locks
		WHERE blueprint_fingerprint = ? AND region = ?
	`, strings.TrimSpace(blueprintFingerprint), strings.TrimSpace(region))
	return err
}

func (s *MySQLStore) ReplaceVPCShardCleanupResources(ctx context.Context, shardID string, resources []core.VPCShardCleanupResource) ([]core.VPCShardCleanupResource, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()
	if _, err = tx.ExecContext(ctx, `DELETE FROM vpc_shard_cleanup_resources WHERE vpc_shard_id = ?`, shardID); err != nil {
		return nil, err
	}
	for _, resource := range resources {
		if _, err = tx.ExecContext(ctx, `
			INSERT INTO vpc_shard_cleanup_resources (id, vpc_shard_id, resource_type, resource_id, created_at)
			VALUES (?, ?, ?, ?, ?)
		`, resource.ID, shardID, resource.ResourceType, resource.ResourceID, resource.CreatedAt); err != nil {
			return nil, err
		}
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return resources, nil
}

func (s *MySQLStore) ListVPCShardCleanupResources(ctx context.Context, shardID string) ([]core.VPCShardCleanupResource, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, vpc_shard_id, resource_type, resource_id, created_at
		FROM vpc_shard_cleanup_resources
		WHERE vpc_shard_id = ?
		ORDER BY created_at ASC
	`, shardID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var items []core.VPCShardCleanupResource
	for rows.Next() {
		resource, err := s.readVPCShardCleanupResource(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, resource)
	}
	if len(items) == 0 {
		if _, err := s.GetVPCShard(ctx, shardID); err != nil {
			return nil, err
		}
	}
	return items, rows.Err()
}

func (s *MySQLStore) DeleteVPCShardCleanupResource(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM vpc_shard_cleanup_resources WHERE id = ?`, id)
	return err
}

func (s *MySQLStore) readCapacityBundle(scanner rowScanner) (core.CapacityBundle, error) {
	var bundle core.CapacityBundle
	var (
		securityGroupIDs string
		lineageTags      sql.NullString
	)
	err := scanner.Scan(&bundle.ID, &bundle.Region, &bundle.Zone, &bundle.VpcID, &bundle.SubnetID, &securityGroupIDs, &bundle.NetworkTemplateID, &bundle.Status, &bundle.BootstrapGeneration, &lineageTags, &bundle.LastValidationResult, &bundle.CreatedAt, &bundle.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return core.CapacityBundle{}, core.ErrCapacityBundleNotFound
	}
	if err != nil {
		return core.CapacityBundle{}, err
	}
	bundle.SecurityGroupIDs = decodeSecurityGroups(securityGroupIDs)
	bundle.LineageTags = decodeJSONMap(lineageTags.String)
	return bundle, nil
}

func (s *MySQLStore) readVPCShard(scanner rowScanner) (core.VPCShard, error) {
	var (
		shard             core.VPCShard
		blueprintSnapshot sql.NullString
		activeSubnetID    sql.NullString
		lastSwitchAt      sql.NullTime
		lastWaterline     sql.NullString
		cleanupState      sql.NullString
		cleanupStartedAt  sql.NullTime
		cleanupLastError  sql.NullString
	)
	err := scanner.Scan(&shard.ID, &blueprintSnapshot, &shard.BlueprintFingerprint, &shard.TemplateClassID, &shard.SKUID, &shard.NetworkTemplateID, &shard.Region, &shard.VpcID, &shard.State, &activeSubnetID, &lastSwitchAt, &lastWaterline, &cleanupState, &cleanupStartedAt, &cleanupLastError, &shard.CreatedAt, &shard.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return core.VPCShard{}, core.ErrVPCShardNotFound
	}
	if err != nil {
		return core.VPCShard{}, err
	}
	shard.BlueprintSnapshotID = nullStringValue(blueprintSnapshot)
	shard.ActiveSubnetMemberID = nullStringValue(activeSubnetID)
	if lastSwitchAt.Valid {
		ts := lastSwitchAt.Time
		shard.LastSwitchAt = &ts
	}
	shard.LastWaterlineReason = nullStringValue(lastWaterline)
	shard.CleanupState = core.VPCShardCleanupState(nullStringValue(cleanupState))
	if cleanupStartedAt.Valid {
		ts := cleanupStartedAt.Time
		shard.CleanupStartedAt = &ts
	}
	shard.CleanupLastError = nullStringValue(cleanupLastError)
	return shard, nil
}

func (s *MySQLStore) readVPCShardBlueprintSnapshot(scanner rowScanner) (core.VPCShardBlueprintSnapshot, error) {
	var snapshot core.VPCShardBlueprintSnapshot
	err := scanner.Scan(&snapshot.ID, &snapshot.SchemaVersion, &snapshot.SourceRegion, &snapshot.NetworkTemplateID, &snapshot.BlueprintFingerprint, &snapshot.TopologyJSON, &snapshot.ValidationState, &snapshot.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return core.VPCShardBlueprintSnapshot{}, core.ErrVPCShardBlueprintSnapshotNotFound
	}
	if err != nil {
		return core.VPCShardBlueprintSnapshot{}, err
	}
	return snapshot, nil
}

func (s *MySQLStore) readVPCShardProvisionProgress(scanner rowScanner) (core.VPCShardProvisionProgress, error) {
	var (
		progress    core.VPCShardProvisionProgress
		lastError   sql.NullString
		completedAt sql.NullTime
	)
	err := scanner.Scan(&progress.ID, &progress.VPCShardID, &progress.BlueprintSnapshotID, &progress.BlueprintFingerprint, &progress.Status, &progress.LastStep, &lastError, &progress.StartedAt, &progress.UpdatedAt, &completedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return core.VPCShardProvisionProgress{}, core.ErrVPCShardProvisionProgressNotFound
	}
	if err != nil {
		return core.VPCShardProvisionProgress{}, err
	}
	progress.LastError = nullStringValue(lastError)
	if completedAt.Valid {
		ts := completedAt.Time
		progress.CompletedAt = &ts
	}
	return progress, nil
}

func (s *MySQLStore) readVPCShardSubnet(scanner rowScanner) (core.VPCShardSubnet, error) {
	var subnet core.VPCShardSubnet
	err := scanner.Scan(&subnet.ID, &subnet.VPCShardID, &subnet.SubnetID, &subnet.Zone, &subnet.Role, &subnet.Ordinal, &subnet.ReservationState, &subnet.NearWaterline, &subnet.CreatedAt, &subnet.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return core.VPCShardSubnet{}, core.ErrVPCShardSubnetNotFound
	}
	if err != nil {
		return core.VPCShardSubnet{}, err
	}
	return subnet, nil
}

func (s *MySQLStore) readVPCShardCleanupResource(scanner rowScanner) (core.VPCShardCleanupResource, error) {
	var resource core.VPCShardCleanupResource
	err := scanner.Scan(&resource.ID, &resource.VPCShardID, &resource.ResourceType, &resource.ResourceID, &resource.CreatedAt)
	if err != nil {
		return core.VPCShardCleanupResource{}, err
	}
	return resource, nil
}

func nullStringValue(v sql.NullString) string {
	if v.Valid {
		return v.String
	}
	return ""
}

// encodeSecurityGroups joins security group IDs for storage.
func encodeSecurityGroups(sgs []string) string {
	if len(sgs) == 0 {
		return ""
	}
	return strings.Join(sgs, ",")
}

// decodeSecurityGroups splits stored string into slice.
func decodeSecurityGroups(s string) []string {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if trimmed := strings.TrimSpace(p); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}

func encodeJSONMap(m map[string]string) string {
	if len(m) == 0 {
		return ""
	}
	b, _ := json.Marshal(m)
	return string(b)
}

func decodeJSONMap(s string) map[string]string {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	var m map[string]string
	if err := json.Unmarshal([]byte(s), &m); err != nil {
		return nil
	}
	return m
}

// logf wraps log.Printf with mysql prefix.
func (s *MySQLStore) logf(format string, args ...interface{}) {
	log.Printf("[mysql] "+format, args...)
}

// maskDSN hides password for logs.
func maskDSN(dsn string) string {
	if i := strings.Index(dsn, "@"); i != -1 {
		return "***" + dsn[i:]
	}
	return dsn
}
