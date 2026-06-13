package wrapper

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	mysql "github.com/go-sql-driver/mysql"
)

func TestMySQLStorePersistsACPSessionAcrossInstances(t *testing.T) {
	dsn := firstNonEmptyStoreEnv(testEnv("GATEWAY_STORE_MYSQL_E2E_DSN"), testEnv("GATEWAY_DB_DSN"))
	if dsn == "" || testEnv("GATEWAY_DB_DRIVER") != storeDialectMySQL {
		t.Skip("set GATEWAY_DB_DRIVER=mysql and GATEWAY_STORE_MYSQL_E2E_DSN or GATEWAY_DB_DSN")
	}
	if err := ensureMySQLDatabase(dsn); err != nil {
		t.Fatalf("ensure mysql database: %v", err)
	}
	root := t.TempDir()
	storeA, err := NewStoreWithConfig(StoreConfig{Root: root, Driver: storeDialectMySQL, DSN: dsn})
	if err != nil {
		t.Fatalf("open mysql store A: %v", err)
	}
	defer storeA.db.Close()
	sessionID := "session_mysql_live_" + randomHex(8)
	scope := Scope{TenantID: "tenant-devcloud-dep", ProjectID: "project-devcloud-dep"}
	session := &acpSession{
		SessionID:         sessionID,
		Scope:             scope,
		CWD:               "/workspace",
		WorkspaceKey:      "workspace_mysql_live_" + randomHex(8),
		Model:             "agent-sidecar-chat",
		State:             acpRuntimeStateReady,
		RuntimeGeneration: 1,
		CreatedAt:         time.Now().UTC(),
		UpdatedAt:         time.Now().UTC(),
		Runtime: ACPSessionRuntime{
			RuntimeID:        "rt_" + sessionID,
			OuterRuntime:     "wisp",
			RuntimeRecovery:  "reattach_or_recreate",
			AgentVersion:     defaultAgentVersion,
			WorkspaceVersion: defaultWorkspaceVersion,
			WispName:         "agent-" + sessionID,
			WispSMHSpaceID:   "space-" + sessionID,
		},
	}
	if err := storeA.SaveACPSession(session); err != nil {
		t.Fatalf("save mysql session: %v", err)
	}
	storeB, err := NewStoreWithConfig(StoreConfig{Root: root, Driver: storeDialectMySQL, DSN: dsn})
	if err != nil {
		t.Fatalf("open mysql store B: %v", err)
	}
	defer storeB.db.Close()
	loaded, err := storeB.LoadACPSession(scope, sessionID)
	if err != nil {
		t.Fatalf("load mysql session from second store: %v", err)
	}
	if loaded.SessionID != session.SessionID || loaded.WorkspaceKey != session.WorkspaceKey || loaded.Runtime.WispSMHSpaceID != session.Runtime.WispSMHSpaceID {
		t.Fatalf("loaded session lost identity: got=%#v want=%#v", loaded, session)
	}
	_ = storeB.DeleteACPSession(scope, sessionID)
}

func ensureMySQLDatabase(dsn string) error {
	cfg, err := mysql.ParseDSN(dsn)
	if err != nil {
		return err
	}
	dbName := cfg.DBName
	if dbName == "" {
		return nil
	}
	if strings.ContainsAny(dbName, "`'\";\\/") {
		return errors.New("unsafe mysql database name")
	}
	cfg.DBName = ""
	db, err := sql.Open(storeDialectMySQL, cfg.FormatDSN())
	if err != nil {
		return err
	}
	defer db.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		return err
	}
	_, err = db.ExecContext(ctx, "CREATE DATABASE IF NOT EXISTS `"+dbName+"` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci")
	return err
}

func testEnv(key string) string {
	return os.Getenv(key)
}
