//go:build integration

package gateway

import (
	"context"
	"database/sql"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/go-sql-driver/mysql"
)

func TestMySQLPlanSchemaUsesSeparateImmutablePlanAndSetPlanTables(t *testing.T) {
	store := newIsolatedPlanMySQLStore(t)
	defer store.Close()

	svc := NewService(store, nil, Options{})
	plan := Plan{
		ID: "starter-2026-07", Name: "入门型", MonthlyTokens: 1_000_000,
		PeriodValue: 1, PeriodUnit: "months", IsActive: true,
	}
	if err := svc.RegisterPlan(t.Context(), plan); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveSetPlan(t.Context(), SetPlan{
		PlanID: plan.ID, SetID: "set-a", UpstreamPlanID: 42, Status: SetPlanStatusReady,
	}); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := store.GetPlan(t.Context(), plan.ID); err != nil || !ok {
		t.Fatalf("get plan ok=%v err=%v", ok, err)
	}
	if state, ok, err := store.GetSetPlan(t.Context(), plan.ID, "set-a"); err != nil || !ok || state.UpstreamPlanID != 42 {
		t.Fatalf("get set plan ok=%v state=%+v err=%v", ok, state, err)
	}

	var oldTableCount int
	if err := store.db.QueryRowContext(t.Context(), `
		SELECT COUNT(*) FROM information_schema.tables
		WHERE table_schema = DATABASE() AND table_name = 'llmgateway_plan_mappings'
	`).Scan(&oldTableCount); err != nil {
		t.Fatal(err)
	}
	if oldTableCount != 0 {
		t.Fatal("legacy llmgateway_plan_mappings table still exists")
	}
}

func newIsolatedPlanMySQLStore(t *testing.T) *MySQLStore {
	t.Helper()
	dsn := strings.TrimSpace(os.Getenv("LLMGATEWAY_MYSQL_TEST_DSN"))
	if dsn == "" {
		t.Skip("LLMGATEWAY_MYSQL_TEST_DSN is required")
	}
	cfg, err := mysql.ParseDSN(dsn)
	if err != nil {
		t.Fatal(err)
	}
	if !regexp.MustCompile(`^llmgateway_it_[a-zA-Z0-9_]+$`).MatchString(cfg.DBName) {
		t.Fatalf("unsafe integration database name %q", cfg.DBName)
	}
	rootCfg := *cfg
	rootCfg.DBName = ""
	rootDB, err := sql.Open("mysql", rootCfg.FormatDSN())
	if err != nil {
		t.Fatal(err)
	}
	defer rootDB.Close()
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	if _, err := rootDB.ExecContext(ctx, "DROP DATABASE IF EXISTS `"+cfg.DBName+"`"); err != nil {
		t.Fatal(err)
	}
	if _, err := rootDB.ExecContext(ctx, "CREATE DATABASE `"+cfg.DBName+"` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"); err != nil {
		t.Fatal(err)
	}
	store, err := NewMySQLStore(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	return store
}
