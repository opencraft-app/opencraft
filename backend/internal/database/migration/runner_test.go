package migration

import (
	"context"
	"database/sql"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"

	atlasmigrate "ariga.io/atlas/sql/migrate"
	"chatserver/internal/apperror"
	"chatserver/internal/config"
	entmigrate "chatserver/internal/ent/migrate"
	_ "modernc.org/sqlite"
)

func TestEmbeddedDirForTDSQL只加载TDSQL物理Baseline(t *testing.T) {
	dir, err := embeddedDirFor(config.DatabaseDriverTDSQL)
	if err != nil {
		t.Fatalf("embeddedDirFor(tdsql) error = %v", err)
	}
	defer dir.Close()
	files, err := dir.Files()
	if err != nil {
		t.Fatal(err)
	}
	if len(files) == 0 {
		t.Fatal("TDSQL migration 目录为空")
	}
	for _, file := range files {
		if strings.Contains(string(file.Bytes()), "PRAGMA") ||
			strings.Contains(string(file.Bytes()), "sqlite_schema") {
			t.Fatalf("TDSQL migration 混入 SQLite SQL：%s", file.Name())
		}
		if file.Version() == "20260801000000" && !strings.Contains(string(file.Bytes()), "shardkey=`") {
			t.Fatalf("TDSQL baseline 缺少物理 shardkey：%s", file.Name())
		}
		if file.Version() != "20260801000000" && file.Version() != "20260802180000" && file.Version() != "20260804130000" && strings.Contains(string(file.Bytes()), "CREATE TABLE") {
			t.Fatalf("TDSQL 增量 migration 不应重建已发布表：%s", file.Name())
		}
		if file.Version() == "20260802180000" &&
			(!strings.Contains(string(file.Bytes()), "CREATE TABLE `computer_setup_codes`") ||
				!strings.Contains(string(file.Bytes()), "shardkey=`code_hash`")) {
			t.Fatalf("Computer setup code 增量 migration 缺少新表或 shardkey：%s", file.Name())
		}
		if file.Version() == "20260804130000" &&
			(!strings.Contains(string(file.Bytes()), "CREATE TABLE `direct_conversations`") ||
				!strings.Contains(string(file.Bytes()), "shardkey=`server_id`")) {
			t.Fatalf("Server scoped DM 增量 migration 缺少新表或 shardkey：%s", file.Name())
		}
	}
}

func TestApply在空库创建全部业务表并记录Revision(t *testing.T) {
	handle := openTestDatabase(t)
	defer handle.Close()
	migrations := sqliteMigrationCount(t)

	if err := Apply(context.Background(), handle); err != nil {
		t.Fatalf("Apply() error = %v", err)
	}
	if got := countBusinessTables(t, handle); got != len(entmigrate.Tables) {
		t.Fatalf("业务表数量 = %d，期望 %d", got, len(entmigrate.Tables))
	}
	if got := countRows(t, handle, "atlas_schema_revisions"); got != migrations {
		t.Fatalf("revision 数量 = %d，期望 %d", got, migrations)
	}

	if err := Apply(context.Background(), handle); err != nil {
		t.Fatalf("重复 Apply() error = %v", err)
	}
	if got := countRows(t, handle, "atlas_schema_revisions"); got != migrations {
		t.Fatalf("重复迁移后的 revision 数量 = %d，期望 %d", got, migrations)
	}
}

func TestAgentHandleReuseMigration回填活动占用并释放墓碑(t *testing.T) {
	handle := openTestDatabase(t)
	defer handle.Close()

	fullDir, err := embeddedDir()
	if err != nil {
		t.Fatal(err)
	}
	defer fullDir.Close()
	files, err := fullDir.Files()
	if err != nil {
		t.Fatal(err)
	}
	preMigrationDir := atlasmigrate.OpenMemDir(t.Name() + "-before-handle-reuse")
	t.Cleanup(func() { _ = preMigrationDir.Close() })
	for _, file := range files {
		if file.Version() >= "20260804120000" {
			continue
		}
		if err := preMigrationDir.WriteFile(file.Name(), file.Bytes()); err != nil {
			t.Fatal(err)
		}
	}
	preFiles, err := preMigrationDir.Files()
	if err != nil {
		t.Fatal(err)
	}
	preSum, err := atlasmigrate.NewHashFile(preFiles)
	if err != nil {
		t.Fatal(err)
	}
	if err := atlasmigrate.WriteSumFile(preMigrationDir, preSum); err != nil {
		t.Fatal(err)
	}
	if err := applyDir(context.Background(), handle, preMigrationDir); err != nil {
		t.Fatal(err)
	}

	now := time.Date(2026, 8, 4, 12, 0, 0, 0, time.UTC)
	for _, row := range []struct {
		id, handle, status string
	}{
		{"0198f4c2-7a50-7e45-913c-6baf30401aa0", "active-agent", "active"},
		{"0198f4c2-7a51-7e45-913c-6baf30401aa1", "deleted-agent", "removed"},
	} {
		if _, err := handle.Exec(`
			INSERT INTO members (
				id, server_id, kind, role, display_name, handle, status,
				im_state, revision, created_at, updated_at
			) VALUES (?, ?, 'agent', 'member', ?, ?, ?, 'ready', 1, ?, ?)
		`, row.id, "0198f4c2-7a52-7e45-913c-6baf30401aa2",
			row.handle, row.handle, row.status, now, now); err != nil {
			t.Fatal(err)
		}
	}

	if err := Apply(context.Background(), handle); err != nil {
		t.Fatal(err)
	}
	var activeKey sql.NullString
	if err := handle.QueryRow(
		`SELECT active_handle_key FROM members WHERE handle = ?`,
		"active-agent",
	).Scan(&activeKey); err != nil || !activeKey.Valid || activeKey.String != "active-agent" {
		t.Fatalf("active handle key = (%#v, %v)", activeKey, err)
	}
	if err := handle.QueryRow(
		`SELECT active_handle_key FROM members WHERE handle = ?`,
		"deleted-agent",
	).Scan(&activeKey); err != nil || activeKey.Valid {
		t.Fatalf("deleted handle key = (%#v, %v)", activeKey, err)
	}
}

func sqliteMigrationCount(t *testing.T) int {
	t.Helper()
	dir, err := embeddedDir()
	if err != nil {
		t.Fatal(err)
	}
	defer dir.Close()
	files, err := dir.Files()
	if err != nil {
		t.Fatal(err)
	}
	return len(files)
}

func TestAgentPresenceMigration回填路由与Host租约(t *testing.T) {
	handle := openTestDatabase(t)
	defer handle.Close()

	fullDir, err := embeddedDir()
	if err != nil {
		t.Fatal(err)
	}
	defer fullDir.Close()
	files, err := fullDir.Files()
	if err != nil || len(files) < 2 {
		t.Fatalf("migration files = %d, %v", len(files), err)
	}
	baselineDir := atlasmigrate.OpenMemDir(t.Name() + "-baseline")
	t.Cleanup(func() { _ = baselineDir.Close() })
	if err := baselineDir.WriteFile(files[0].Name(), files[0].Bytes()); err != nil {
		t.Fatal(err)
	}
	baselineFiles, err := baselineDir.Files()
	if err != nil {
		t.Fatal(err)
	}
	baselineSum, err := atlasmigrate.NewHashFile(baselineFiles)
	if err != nil {
		t.Fatal(err)
	}
	if err := atlasmigrate.WriteSumFile(baselineDir, baselineSum); err != nil {
		t.Fatal(err)
	}
	if err := applyDir(
		context.Background(),
		handle,
		baselineDir,
	); err != nil {
		t.Fatal(err)
	}

	const (
		serverID     = "01989c24-7540-7f12-a27b-c83243215f01"
		agentID      = "01989c24-7540-7f12-a27b-c83243215f02"
		credentialID = "01989c24-7540-7f12-a27b-c83243215f03"
	)
	usedAt := time.Date(2026, 7, 31, 18, 30, 0, 0, time.UTC)
	if _, err := handle.Exec(`
		INSERT INTO agents (
			id, server_id, im_user_id, runtime_kind, reply_policy,
			desired_state, observed_state, credential_version, im_state,
			created_by_member_id, revision, created_at, updated_at
		) VALUES (?, ?, ?, 'codex', 'mention_and_dm', 'running', 'running',
		          1, 'ready', ?, 1, ?, ?)
	`, agentID, serverID, "a_MIGRATION_ROUTE", agentID, usedAt, usedAt); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Exec(`
		INSERT INTO agent_runtime_credentials (
			id, server_id, agent_id, version, secret_hash, state,
			last_used_at, created_at
		) VALUES (?, ?, ?, 1, ?, 'active', ?, ?)
	`, credentialID, serverID, agentID, make([]byte, 32), usedAt, usedAt); err != nil {
		t.Fatal(err)
	}

	if err := Apply(context.Background(), handle); err != nil {
		t.Fatal(err)
	}
	var presence string
	var hostSeen time.Time
	if err := handle.QueryRow(
		`SELECT im_presence, host_last_seen_at FROM agents WHERE id = ?`,
		agentID,
	).Scan(&presence, &hostSeen); err != nil {
		t.Fatal(err)
	}
	if presence != "unknown" || !hostSeen.Equal(usedAt) {
		t.Fatalf("presence=%q hostSeen=%v", presence, hostSeen)
	}
	var routeServerID, routeAgentID string
	if err := handle.QueryRow(`
		SELECT server_id, agent_id
		FROM agent_im_routes
		WHERE im_user_id = ?
	`, "a_MIGRATION_ROUTE").Scan(&routeServerID, &routeAgentID); err != nil {
		t.Fatal(err)
	}
	if routeServerID != serverID || routeAgentID != agentID {
		t.Fatalf("route=(%q,%q)", routeServerID, routeAgentID)
	}
}

func TestApplyDir在Checksum错误时零Schema写入(t *testing.T) {
	handle := openTestDatabase(t)
	defer handle.Close()
	dir := atlasmigrate.OpenMemDir(t.Name())
	t.Cleanup(func() { _ = dir.Close() })
	if err := dir.WriteFile("20260730000000_bad.sql", []byte("CREATE TABLE should_not_exist(id text);")); err != nil {
		t.Fatal(err)
	}
	if err := dir.WriteFile("atlas.sum", []byte("h1:invalid=\n")); err != nil {
		t.Fatal(err)
	}

	err := applyDir(context.Background(), handle, dir)
	if code := apperror.CodeOf(err); code != "MIGRATION_CHECKSUM_MISMATCH" {
		t.Fatalf("错误码 = %q，期望 MIGRATION_CHECKSUM_MISMATCH；err=%v", code, err)
	}
	if tableExists(t, handle, "should_not_exist") {
		t.Fatal("checksum 错误后仍写入了业务 Schema")
	}
}

func TestApplyDir失败Migration按文件事务完整回滚(t *testing.T) {
	handle := openTestDatabase(t)
	defer handle.Close()
	dir := atlasmigrate.OpenMemDir(t.Name())
	t.Cleanup(func() { _ = dir.Close() })
	sqlText := "CREATE TABLE should_rollback(id text);\nINVALID SQL;\n"
	if err := dir.WriteFile("20260730000001_rollback.sql", []byte(sqlText)); err != nil {
		t.Fatal(err)
	}
	files, err := dir.Files()
	if err != nil {
		t.Fatal(err)
	}
	sum, err := atlasmigrate.NewHashFile(files)
	if err != nil {
		t.Fatal(err)
	}
	if err := atlasmigrate.WriteSumFile(dir, sum); err != nil {
		t.Fatal(err)
	}

	err = applyDir(context.Background(), handle, dir)
	if code := apperror.CodeOf(err); code != "MIGRATION_FAILED" {
		t.Fatalf("错误码 = %q，期望 MIGRATION_FAILED；err=%v", code, err)
	}
	if tableExists(t, handle, "should_rollback") {
		t.Fatal("失败 migration 没有完整回滚")
	}
}

func openTestDatabase(t *testing.T) *sql.DB {
	t.Helper()
	path := filepath.Join(t.TempDir(), "chatserver.db")
	query := url.Values{}
	query.Add("_pragma", "journal_mode(WAL)")
	query.Add("_pragma", "synchronous(FULL)")
	query.Add("_pragma", "busy_timeout(5000)")
	query.Add("_pragma", "foreign_keys(OFF)")
	query.Set("_time_format", "sqlite")
	dsn := (&url.URL{Scheme: "file", Path: path, RawQuery: query.Encode()}).String()
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	if err := db.PingContext(context.Background()); err != nil {
		_ = db.Close()
		t.Fatal(err)
	}
	return db
}

func countBusinessTables(t *testing.T, db *sql.DB) int {
	t.Helper()
	var count int
	err := db.QueryRow(`
		SELECT COUNT(*)
		FROM sqlite_schema
		WHERE type = 'table'
		  AND name NOT LIKE 'sqlite_%'
		  AND name <> 'atlas_schema_revisions'
	`).Scan(&count)
	if err != nil {
		t.Fatal(err)
	}
	return count
}

func countRows(t *testing.T, db *sql.DB, table string) int {
	t.Helper()
	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func tableExists(t *testing.T, db *sql.DB, table string) bool {
	t.Helper()
	var count int
	if err := db.QueryRow(
		"SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name = ?",
		table,
	).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count == 1
}
