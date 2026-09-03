package service

import (
	"context"
	"database/sql"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
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
