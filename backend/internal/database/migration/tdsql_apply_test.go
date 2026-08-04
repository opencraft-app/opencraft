package migration

import (
	"testing"

	"chatserver/internal/apperror"
)

func TestTDSQLPreflightError只允许Empty或Clean(t *testing.T) {
	tests := []struct {
		state State
		code  string
	}{
		{state: State{Kind: StateEmpty}},
		{state: State{Kind: StateClean}},
		{state: State{Kind: StatePending}, code: "DATABASE_MIGRATION_UNSAFE"},
		{state: State{Kind: StateDirty}, code: "DATABASE_MIGRATION_UNSAFE"},
		{state: State{Kind: StateUnsafe, Reason: ReasonNotEmpty}, code: "DATABASE_NOT_EMPTY"},
		{state: State{Kind: StateUnsafe, Reason: ReasonIdentity}, code: "DATABASE_MIGRATION_UNSAFE"},
	}
	for _, tt := range tests {
		err := tdsqlPreflightError(tt.state)
		if code := apperror.CodeOf(err); code != tt.code {
			t.Fatalf("state=%#v code=%q，期望 %q", tt.state, code, tt.code)
		}
	}
}

func TestCompleteTDSQLPrefixUsesTablesIntroducedByAppliedRevisions(t *testing.T) {
	expected := testTDSQLRuntimeExpectation(t)
	baseline := expected.Migrations[0]
	snapshot := TDSQLSnapshot{
		RevisionTableExists: true, RevisionColumnsValid: true,
		UserTables: append([]string(nil), baseline.Tables...),
		Revisions: []TDSQLRevision{{
			Version: baseline.Version, Hash: baseline.Hash,
			ClaimID: "dddddddddddddddddddddddddddddddd",
			Applied: baseline.Total, Total: baseline.Total,
		}},
	}
	if !isCompleteTDSQLPrefix(snapshot, expected) {
		t.Fatal("完成 baseline 但未建后续新表的数据库应可继续迁移")
	}
}
