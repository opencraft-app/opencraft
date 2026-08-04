package migration

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"testing"

	atlasmigrate "ariga.io/atlas/sql/migrate"
)

func TestExecuteOwnedStatements逐条DDL和CAS并最终清理(t *testing.T) {
	db := &ownedExecFake{casRows: 1}
	revision := &atlasmigrate.Revision{
		Version: "20260801000000", Total: 2, Hash: "hash", OperatorVersion: "chatserver-v1",
	}
	err := executeOwnedStatements(
		context.Background(), db, revision,
		"0123456789abcdef0123456789abcdef",
		[]string{"CREATE TABLE `a` (`id` bigint)", "CREATE TABLE `b` (`id` bigint)"},
	)
	if err != nil {
		t.Fatalf("executeOwnedStatements() error = %v", err)
	}
	want := []string{"ddl", "cas", "ddl", "cas", "cas"}
	if strings.Join(db.events, ",") != strings.Join(want, ",") {
		t.Fatalf("events = %v，期望 %v", db.events, want)
	}
	if revision.Applied != 2 || len(revision.PartialHashes) != 0 || revision.Error != "" {
		t.Fatalf("revision = %#v", revision)
	}
}

func TestExecuteOwnedStatements进度CAS失败立即停止(t *testing.T) {
	db := &ownedExecFake{casRows: 0}
	revision := &atlasmigrate.Revision{Version: "20260801000000", Total: 2, Hash: "hash"}
	err := executeOwnedStatements(
		context.Background(), db, revision,
		"0123456789abcdef0123456789abcdef",
		[]string{"CREATE TABLE `a` (`id` bigint)", "CREATE TABLE `b` (`id` bigint)"},
	)
	if err == nil || strings.Join(db.events, ",") != "ddl,cas" {
		t.Fatalf("err=%v events=%v", err, db.events)
	}
}

func TestExecuteOwnedStatementsDDL失败写入脱敏错误并停止(t *testing.T) {
	db := &ownedExecFake{casRows: 1, failDDLAt: 1}
	revision := &atlasmigrate.Revision{Version: "20260801000000", Total: 2, Hash: "hash"}
	err := executeOwnedStatements(
		context.Background(), db, revision,
		"0123456789abcdef0123456789abcdef",
		[]string{"CREATE TABLE `secret_name` (`id` bigint)", "CREATE TABLE `b` (`id` bigint)"},
	)
	if err == nil || strings.Join(db.events, ",") != "ddl,cas" {
		t.Fatalf("err=%v events=%v", err, db.events)
	}
	if revision.Error != "statement_failed" || revision.ErrorStmt != "" ||
		strings.Contains(revision.Error, "secret_name") {
		t.Fatalf("revision error 未脱敏：%#v", revision)
	}
}

type ownedExecFake struct {
	casRows   int64
	failDDLAt int
	ddlCalls  int
	events    []string
}

func (fake *ownedExecFake) ExecContext(
	_ context.Context,
	query string,
	_ ...any,
) (sql.Result, error) {
	if strings.HasPrefix(strings.TrimSpace(strings.ToUpper(query)), "UPDATE") {
		fake.events = append(fake.events, "cas")
		return claimResult(fake.casRows), nil
	}
	fake.events = append(fake.events, "ddl")
	fake.ddlCalls++
	if fake.failDDLAt == fake.ddlCalls {
		return nil, errors.New("contains private database text")
	}
	return claimResult(0), nil
}
