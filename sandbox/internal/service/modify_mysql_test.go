package service

import (
	"context"
	"database/sql"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"cvm-mock-e2b/internal/core"
	"cvm-mock-e2b/internal/provider"
	"cvm-mock-e2b/internal/store"
	"github.com/go-sql-driver/mysql"
)

// Optional real-MySQL regression. The supplied endpoint must be loopback; the
// test owns a freshly named DB, applies the actual migrations and drops only
// that DB. It never connects to a shared test/prod database.
func modifyMySQLStore(t *testing.T) (*store.MySQLStore, *sql.DB) {
	t.Helper()
	dsn := os.Getenv("SANDBOX_TEST_MYSQL_DSN")
	if dsn == "" {
		t.Skip("set SANDBOX_TEST_MYSQL_DSN to a disposable local MySQL endpoint")
	}
	cfg, err := mysql.ParseDSN(dsn)
	if err != nil {
		t.Fatal("invalid test MySQL DSN")
	}
	host, _, err := net.SplitHostPort(cfg.Addr)
	if err != nil || cfg.Net != "tcp" || (host != "127.0.0.1" && host != "::1") {
		t.Fatal("MySQL integration test requires a loopback TCP endpoint")
	}
	cfg.DBName = ""
	cfg.MultiStatements = true
	cfg.ParseTime = true
	admin, err := sql.Open("mysql", cfg.FormatDSN())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = admin.Close() })
	dbName := fmt.Sprintf("lv_modify_%d", time.Now().UnixNano())
	if _, err := admin.Exec("CREATE DATABASE " + dbName); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := admin.Exec("DROP DATABASE " + dbName); err != nil {
			t.Errorf("drop owned test DB: %v", err)
		}
	})
	cfg.DBName = dbName
	db, err := sql.Open("mysql", cfg.FormatDSN())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	paths, err := filepath.Glob("../../migrations/*.up.sql")
	if err != nil || len(paths) == 0 {
		t.Fatal("missing migrations")
	}
	for _, path := range paths {
		body, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = db.Exec(string(body)); err != nil {
			t.Fatalf("migration %s: %v", path, err)
		}
	}
	st, err := store.NewMySQLStore(cfg.FormatDSN())
	if err != nil {
		t.Fatal(err)
	}
	return st, db
}

// Once verify_delivery is persisted, rebind must not touch the cloud again.
type rebindOnlyProvider struct {
	*provider.MockCloudProvider
	t *testing.T
}

func (p *rebindOnlyProvider) StopInstanceForResize(context.Context, string) error {
	p.t.Fatal("replayed stop")
	return nil
}
func (p *rebindOnlyProvider) ResizeInstanceType(context.Context, string, string) error {
	p.t.Fatal("replayed compute resize")
	return nil
}
func (p *rebindOnlyProvider) ResizeSystemDisk(context.Context, string, int) error {
	p.t.Fatal("replayed disk resize")
	return nil
}
func (p *rebindOnlyProvider) StartInstance(context.Context, string) error {
	p.t.Fatal("replayed start")
	return nil
}

func assertModifyRebindResume(t *testing.T, backing store.Store) {
	t.Helper()
	ctx := context.Background()
	f := newModifyFixture(t, backing)
	op := f.begin(t, "task-rebind-boundary")
	if len("modify:"+op.ID) <= 32 {
		t.Fatal("fixture must exercise actual UUID operation ID overflow")
	}
	if _, err := f.svc.store.UpdateModifyOperationProgress(ctx, store.ModifyOperationProgress{ID: op.ID, Status: core.ModifyOperationStatusRunning, CurrentStep: core.ModifyStepVerifyDelivery, LastError: "previous rebind length failure"}); err != nil {
		t.Fatal(err)
	}
	cp := &rebindOnlyProvider{MockCloudProvider: provider.NewMockCloudProvider(), t: t}
	for attempt := 0; attempt < 2; attempt++ {
		got, err := f.svc.RunModifyOperation(ctx, cp, op.ID)
		if err != nil {
			t.Fatalf("resume rebind: %v", err)
		}
		if got.ID != op.ID || got.Status != core.ModifyOperationStatusCompleted || got.CurrentStep != core.ModifyStepDone || got.LastError != "" {
			t.Fatalf("unexpected terminal ledger: %+v", got)
		}
	}
	sb, err := f.svc.GetSandbox(ctx, f.sandboxID)
	if err != nil {
		t.Fatal(err)
	}
	if sb.ResolutionSource != "modify" {
		t.Fatalf("resolution_source=%q, want short category modify", sb.ResolutionSource)
	}
	if sb.PoolID != f.targetPool.ID || sb.TemplateClassID != f.targetPool.TemplateClassID {
		t.Fatalf("sandbox not rebound: %+v", sb)
	}
	inst, err := f.svc.GetInstance(ctx, f.instanceID)
	if err != nil {
		t.Fatal(err)
	}
	if inst.State != core.StateAllocated || inst.PoolID != f.targetPool.ID || inst.CloudID != "ins-modify-1" {
		t.Fatalf("instance not rebound in place: %+v", inst)
	}
}

func TestModifyRebindResumeUsesShortResolutionSource(t *testing.T) {
	assertModifyRebindResume(t, store.NewMemoryStore())
}

func TestModifyRebindResumeMySQLLengthBoundary(t *testing.T) {
	st, db := modifyMySQLStore(t)
	var limit int
	if err := db.QueryRow("SELECT CHARACTER_MAXIMUM_LENGTH FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='sandboxes' AND column_name='resolution_source'").Scan(&limit); err != nil {
		t.Fatal(err)
	}
	if limit != 32 {
		t.Fatalf("resolution_source width=%d want 32", limit)
	}
	var sqlMode string
	if err := db.QueryRow("SELECT @@sql_mode").Scan(&sqlMode); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(sqlMode, "STRICT_") {
		t.Fatal("MySQL integration test requires strict SQL mode")
	}
	assertModifyRebindResume(t, st)
}

func TestCreateModifyOperationMySQLAllowsOnlyOneRunningLedgerPerInstance(t *testing.T) {
	st, _ := modifyMySQLStore(t)
	ctx := context.Background()
	now := time.Now().UTC()
	base := core.ModifyOperation{
		SandboxID:    "sb-mysql",
		InstanceID:   "inst-mysql",
		SourcePoolID: "pool-old",
		TargetPoolID: "pool-new",
		TargetSKUID:  "sku-new",
		Status:       core.ModifyOperationStatusRunning,
		StartedAt:    now,
		UpdatedAt:    now,
	}
	type result struct {
		op      core.ModifyOperation
		created bool
		err     error
	}
	start := make(chan struct{})
	results := make(chan result, 2)
	var wg sync.WaitGroup
	for i := 1; i <= 2; i++ {
		candidate := base
		candidate.ID = fmt.Sprintf("mod-mysql-%d", i)
		candidate.IdempotencyKey = fmt.Sprintf("task-mysql-%d", i)
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			op, created, err := st.CreateModifyOperation(ctx, candidate)
			results <- result{op: op, created: created, err: err}
		}()
	}
	close(start)
	wg.Wait()
	close(results)

	createdCount := 0
	operationIDs := make(map[string]struct{})
	for got := range results {
		if got.err != nil {
			t.Fatalf("create competing running ledger: %v", got.err)
		}
		if got.created {
			createdCount++
		}
		operationIDs[got.op.ID] = struct{}{}
	}
	if createdCount != 1 || len(operationIDs) != 1 {
		t.Fatalf("created=%d distinct_operations=%d, want one shared running ledger", createdCount, len(operationIDs))
	}
}

func TestModifyRunningLedgerUniqueMigrationUpgradesExistingTable(t *testing.T) {
	_, db := modifyMySQLStore(t)
	if _, err := db.Exec(`DROP TABLE modify_operations`); err != nil {
		t.Fatalf("drop fresh-schema table: %v", err)
	}
	if _, err := db.Exec(`
		CREATE TABLE modify_operations (
		  id VARCHAR(64) PRIMARY KEY,
		  idempotency_key VARCHAR(128) NOT NULL,
		  sandbox_id VARCHAR(64) NOT NULL,
		  instance_id VARCHAR(64) NOT NULL,
		  source_pool_id VARCHAR(64) NOT NULL,
		  target_pool_id VARCHAR(64) NOT NULL,
		  target_sku_id VARCHAR(64) NOT NULL,
		  target_template_class_id VARCHAR(64) NOT NULL DEFAULT '',
		  target_instance_type VARCHAR(64) NOT NULL,
		  target_system_disk_size INT NOT NULL DEFAULT 0,
		  status VARCHAR(32) NOT NULL,
		  current_step VARCHAR(64) NOT NULL DEFAULT '',
		  last_error TEXT,
		  started_at DATETIME(6) NOT NULL,
		  updated_at DATETIME(6) NOT NULL,
		  completed_at DATETIME(6) NULL,
		  UNIQUE KEY uniq_modify_operations_idempotency_key (idempotency_key),
		  KEY idx_modify_operations_status (status),
		  KEY idx_modify_operations_sandbox (sandbox_id),
		  KEY idx_modify_operations_instance_status (instance_id, status)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
	`); err != nil {
		t.Fatalf("create legacy modify_operations: %v", err)
	}
	if _, err := db.Exec(`
		INSERT INTO modify_operations (
			id, idempotency_key, sandbox_id, instance_id, source_pool_id, target_pool_id,
			target_sku_id, target_instance_type, target_system_disk_size, status,
			current_step, started_at, updated_at
		) VALUES
			('mod-oldest', 'task-oldest', 'sb-1', 'inst-1', 'pool-old', 'pool-new', 'sku-new', 'SA9.LARGE8', 80, 'running', '', '2026-09-08 01:00:00', '2026-09-08 01:00:00'),
			('mod-newer', 'task-newer', 'sb-1', 'inst-1', 'pool-old', 'pool-new', 'sku-new', 'SA9.LARGE8', 80, 'running', '', '2026-09-08 02:00:00', '2026-09-08 02:00:00')
	`); err != nil {
		t.Fatalf("seed duplicate legacy running ledgers: %v", err)
	}

	body, err := os.ReadFile("../../migrations/000010_enforce_single_running_modify_operation.up.sql")
	if err != nil {
		t.Fatalf("read incremental migration: %v", err)
	}
	if _, err := db.Exec(string(body)); err == nil {
		t.Fatal("expected migration to fail closed while duplicate running ledgers exist")
	}

	var runningCount int
	if err := db.QueryRow(`SELECT COUNT(*) FROM modify_operations WHERE instance_id='inst-1' AND status='running'`).Scan(&runningCount); err != nil {
		t.Fatal(err)
	}
	if runningCount != 2 {
		t.Fatalf("running ledgers=%d, want migration failure to preserve both for manual review", runningCount)
	}
	var generatedColumnCount int
	if err := db.QueryRow(`
		SELECT COUNT(*) FROM information_schema.columns
		WHERE table_schema=DATABASE() AND table_name='modify_operations' AND column_name='running_instance_id'
	`).Scan(&generatedColumnCount); err != nil {
		t.Fatal(err)
	}
	if generatedColumnCount != 0 {
		t.Fatalf("generated column count=%d after failed atomic ALTER, want 0", generatedColumnCount)
	}

	// Simulate an operator reviewing both targets/progress and explicitly
	// quarantining the unsafe duplicate before retrying the migration.
	if _, err := db.Exec(`
		UPDATE modify_operations
		SET status='failed', last_error='manually quarantined after duplicate review', completed_at=NOW(6), updated_at=NOW(6)
		WHERE id='mod-newer'
	`); err != nil {
		t.Fatalf("resolve duplicate after review: %v", err)
	}
	if _, err := db.Exec(string(body)); err != nil {
		t.Fatalf("apply incremental migration after duplicate review: %v", err)
	}
	if _, err := db.Exec(`
		INSERT INTO modify_operations (
			id, idempotency_key, sandbox_id, instance_id, source_pool_id, target_pool_id,
			target_sku_id, target_instance_type, target_system_disk_size, status,
			current_step, started_at, updated_at
		) VALUES ('mod-third', 'task-third', 'sb-1', 'inst-1', 'pool-old', 'pool-new', 'sku-new', 'SA9.LARGE8', 80, 'running', '', NOW(6), NOW(6))
	`); err == nil {
		t.Fatal("expected unique constraint to reject a second running ledger")
	}
}
