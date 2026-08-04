package migration

import (
	"strings"
	"testing"

	"chatserver/internal/database/physicalschema"
)

func TestTDSQLRuntimeExpectation包含冻结Baseline和增量迁移(t *testing.T) {
	dir, err := embeddedDirFor("tdsql")
	if err != nil {
		t.Fatal(err)
	}
	defer dir.Close()
	runtime, err := tdsqlRuntimeExpectationFromDir(dir)
	if err != nil {
		t.Fatalf("tdsqlRuntimeExpectationFromDir() error = %v", err)
	}
	if len(runtime.Migrations) != 8 ||
		runtime.Migrations[0].Version != "20260801000000" ||
		runtime.Migrations[0].Hash != "EVq8iLGKqGF4ak8nxCZL94xTu4j4VAZWpwG3q0+m/Xk=" ||
		runtime.Migrations[1].Version != "20260802100000" ||
		runtime.Migrations[2].Version != "20260802170000" ||
		runtime.Migrations[3].Version != "20260802180000" ||
		runtime.Migrations[4].Version != "20260803190328" ||
		runtime.Migrations[5].Version != "20260804110000" ||
		runtime.Migrations[6].Version != "20260804120000" ||
		runtime.Migrations[7].Version != "20260804130000" ||
		len(runtime.UserTables) != 27 {
		t.Fatalf("runtime expectation = %#v", runtime)
	}
	for _, migration := range runtime.Migrations {
		if migration.Total <= 0 || strings.TrimSpace(migration.Hash) == "" {
			t.Fatalf("migration expectation = %#v", migration)
		}
	}
}

func TestClassifyTDSQLRuntime允许已完成Baseline后等待增量(t *testing.T) {
	runtime := testTDSQLRuntimeExpectation(t)
	baseline := runtime.Migrations[0]
	snapshot := TDSQLSnapshot{
		RevisionTableExists:  true,
		RevisionColumnsValid: true,
		UserTables:           withoutTables(runtime.UserTables, "computer_setup_codes", "direct_conversations"),
		Revisions: []TDSQLRevision{{
			Version: baseline.Version, Hash: baseline.Hash,
			ClaimID: strings.Repeat("d", 32), Applied: baseline.Total, Total: baseline.Total,
		}},
	}
	state := classifyTDSQLRuntime(snapshot, runtime)
	if state.Kind != StatePending || state.Version != baseline.Version {
		t.Fatalf("state = %#v", state)
	}

	for index, incremental := range runtime.Migrations[1:] {
		if incremental.Version == "20260802180000" {
			snapshot.UserTables = append(snapshot.UserTables, "computer_setup_codes")
		}
		if incremental.Version == "20260804130000" {
			snapshot.UserTables = append(snapshot.UserTables, "direct_conversations")
		}
		snapshot.Revisions = append(snapshot.Revisions, TDSQLRevision{
			Version: incremental.Version, Hash: incremental.Hash,
			ClaimID: strings.Repeat(string("abcdef0"[index]), 32),
			Applied: incremental.Total, Total: incremental.Total,
		})
	}
	state = classifyTDSQLRuntime(snapshot, runtime)
	latest := runtime.Migrations[len(runtime.Migrations)-1]
	if state.Kind != StateClean || state.Version != latest.Version {
		t.Fatalf("state = %#v", state)
	}
}

func withoutTable(values []string, excluded string) []string {
	result := make([]string, 0, len(values))
	for _, value := range values {
		if value != excluded {
			result = append(result, value)
		}
	}
	return result
}

func withoutTables(values []string, excluded ...string) []string {
	result := append([]string(nil), values...)
	for _, table := range excluded {
		result = withoutTable(result, table)
	}
	return result
}

func TestClassifyTDSQLSnapshot按固定优先级分类(t *testing.T) {
	expected := testTDSQLExpectation(t)
	clean := TDSQLSnapshot{
		RevisionTableExists:  true,
		RevisionColumnsValid: true,
		UserTables:           append([]string(nil), expected.UserTables...),
		Revisions: []TDSQLRevision{{
			Version: expected.Version, Hash: expected.Hash, ClaimID: strings.Repeat("a", 32),
			Applied: expected.Total, Total: expected.Total,
		}},
	}
	pending := clean
	pending.Revisions = []TDSQLRevision{{
		Version: expected.Version, Hash: expected.Hash, ClaimID: strings.Repeat("b", 32),
		Applied: 1, Total: expected.Total, PartialHashes: []string{"stmt-1"},
	}}
	dirty := pending
	dirty.Revisions = append([]TDSQLRevision(nil), pending.Revisions...)
	dirty.Revisions[0].Error = "ddl failed"

	tests := []struct {
		name     string
		snapshot TDSQLSnapshot
		kind     StateKind
		reason   string
	}{
		{name: "empty", snapshot: TDSQLSnapshot{}, kind: StateEmpty},
		{
			name: "not empty without revision", snapshot: TDSQLSnapshot{UserTables: []string{"members"}},
			kind: StateUnsafe, reason: ReasonNotEmpty,
		},
		{
			name: "invalid revision schema wins", snapshot: TDSQLSnapshot{
				RevisionTableExists: true, UserTables: []string{"unexpected"},
			}, kind: StateUnsafe, reason: ReasonRevisionSchema,
		},
		{name: "pending", snapshot: pending, kind: StatePending},
		{name: "dirty", snapshot: dirty, kind: StateDirty},
		{name: "clean", snapshot: clean, kind: StateClean},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			state := classifyTDSQLSnapshot(tt.snapshot, expected)
			if state.Kind != tt.kind || (tt.reason != "" && state.Reason != tt.reason) {
				t.Fatalf("state = %#v，期望 kind=%q reason=%q", state, tt.kind, tt.reason)
			}
		})
	}
}

func TestClassifyTDSQLSnapshot拒绝Identity进度和表集合异常(t *testing.T) {
	expected := testTDSQLExpectation(t)
	base := TDSQLSnapshot{
		RevisionTableExists:  true,
		RevisionColumnsValid: true,
		UserTables:           append([]string(nil), expected.UserTables...),
		Revisions: []TDSQLRevision{{
			Version: expected.Version, Hash: expected.Hash, ClaimID: strings.Repeat("c", 32),
			Applied: expected.Total, Total: expected.Total,
		}},
	}
	mutations := []func(*TDSQLSnapshot){
		func(value *TDSQLSnapshot) { value.Revisions = append(value.Revisions, value.Revisions[0]) },
		func(value *TDSQLSnapshot) { value.Revisions[0].Version = "future" },
		func(value *TDSQLSnapshot) { value.Revisions[0].Hash = "wrong" },
		func(value *TDSQLSnapshot) { value.Revisions[0].Total++ },
		func(value *TDSQLSnapshot) { value.Revisions[0].ClaimID = "not-hex" },
		func(value *TDSQLSnapshot) { value.Revisions[0].Applied = -1 },
		func(value *TDSQLSnapshot) { value.Revisions[0].PartialHashes = []string{"unexpected"} },
		func(value *TDSQLSnapshot) { value.UserTables = append(value.UserTables, "unexpected") },
	}
	for index, mutate := range mutations {
		value := cloneTDSQLSnapshot(base)
		mutate(&value)
		state := classifyTDSQLSnapshot(value, expected)
		if state.Kind != StateUnsafe {
			t.Fatalf("mutation %d state = %#v，期望 unsafe", index, state)
		}
	}
}

func testTDSQLExpectation(t *testing.T) TDSQLExpectation {
	t.Helper()
	catalog, err := physicalschema.Current()
	if err != nil {
		t.Fatal(err)
	}
	tables := catalog.Tables()
	names := make([]string, 0, len(tables))
	for _, table := range tables {
		names = append(names, table.Name)
	}
	return TDSQLExpectation{
		Version: "20260801000000", Hash: "runtime-hash", Total: 25, UserTables: names,
	}
}

func testTDSQLRuntimeExpectation(t *testing.T) tdsqlRuntimeExpectation {
	t.Helper()
	dir, err := embeddedDirFor("tdsql")
	if err != nil {
		t.Fatal(err)
	}
	defer dir.Close()
	expected, err := tdsqlRuntimeExpectationFromDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	return expected
}

func cloneTDSQLSnapshot(value TDSQLSnapshot) TDSQLSnapshot {
	cloned := value
	cloned.UserTables = append([]string(nil), value.UserTables...)
	cloned.Revisions = append([]TDSQLRevision(nil), value.Revisions...)
	for index := range cloned.Revisions {
		cloned.Revisions[index].PartialHashes = append(
			[]string(nil), value.Revisions[index].PartialHashes...,
		)
	}
	return cloned
}
