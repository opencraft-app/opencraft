package migration

import (
	"context"
	"fmt"
	"regexp"
	"slices"
	"strings"

	atlasmigrate "ariga.io/atlas/sql/migrate"
	"chatserver/internal/config"
	"chatserver/internal/database/physicalschema"
)

// StateKind 是 migration 的事实状态，而不是命令动作。
type StateKind string

const (
	StateEmpty   StateKind = "empty"
	StateClean   StateKind = "clean"
	StatePending StateKind = "pending"
	StateDirty   StateKind = "dirty"
	StateUnsafe  StateKind = "unsafe"
)

const (
	ReasonNotEmpty         = "not_empty"
	ReasonRevisionSchema   = "revision_schema"
	ReasonRevisionCount    = "revision_count"
	ReasonIdentity         = "revision_identity"
	ReasonProgress         = "revision_progress"
	ReasonUnexpectedTable  = "unexpected_table"
	ReasonIncompleteTables = "incomplete_tables"
)

// TDSQLRevision 是状态分类所需的最小 revision 投影。
type TDSQLRevision struct {
	Version       string
	Hash          string
	ClaimID       string
	Applied       int
	Total         int
	Error         string
	PartialHashes []string
}

// TDSQLSnapshot 是一次纯只读数据库观察。
type TDSQLSnapshot struct {
	RevisionTableExists  bool
	RevisionColumnsValid bool
	UserTables           []string
	Revisions            []TDSQLRevision
}

// TDSQLExpectation 固定当前程序接受的 baseline identity 与业务表集合。
type TDSQLExpectation struct {
	Version    string
	Hash       string
	Total      int
	UserTables []string
}

// tdsqlMigrationExpectation 是一个已签入 runtime migration 的不可变身份。
type tdsqlMigrationExpectation struct {
	Version string
	Hash    string
	Total   int
	Tables  []string
}

// tdsqlRuntimeExpectation 表示当前程序接受的完整 TDSQL 迁移链。
type tdsqlRuntimeExpectation struct {
	Migrations []tdsqlMigrationExpectation
	UserTables []string
}

// State 是分类结果；Reason 只使用稳定机器码，不包含底层数据库文本。
type State struct {
	Kind    StateKind
	Reason  string
	Version string
	Applied int
	Total   int
}

var claimIDPattern = regexp.MustCompile(`^[0-9a-fA-F]{32}$`)

func tdsqlExpectation(_ context.Context) (TDSQLExpectation, error) {
	dir, err := embeddedDirFor(config.DatabaseDriverTDSQL)
	if err != nil {
		return TDSQLExpectation{}, err
	}
	defer dir.Close()
	if err := atlasmigrate.Validate(dir); err != nil {
		return TDSQLExpectation{}, err
	}
	runtime, err := tdsqlRuntimeExpectationFromDir(dir)
	if err != nil {
		return TDSQLExpectation{}, err
	}
	baseline := runtime.Migrations[0]
	if baseline.Version != "20260801000000" || baseline.Total != len(baseline.Tables) {
		return TDSQLExpectation{}, fmt.Errorf("TDSQL statement count does not match catalog")
	}
	return TDSQLExpectation{
		Version:    baseline.Version,
		Hash:       baseline.Hash,
		Total:      baseline.Total,
		UserTables: append([]string(nil), baseline.Tables...),
	}, nil
}

func tdsqlRuntimeExpectationFromDir(dir atlasmigrate.Dir) (tdsqlRuntimeExpectation, error) {
	if dir == nil {
		return tdsqlRuntimeExpectation{}, fmt.Errorf("TDSQL migration directory is nil")
	}
	if err := atlasmigrate.Validate(dir); err != nil {
		return tdsqlRuntimeExpectation{}, err
	}
	files, err := dir.Files()
	if err != nil {
		return tdsqlRuntimeExpectation{}, err
	}
	if len(files) == 0 || files[0].Version() != "20260801000000" {
		return tdsqlRuntimeExpectation{}, fmt.Errorf("TDSQL runtime is missing the published baseline")
	}
	checksums, err := dir.Checksum()
	if err != nil {
		return tdsqlRuntimeExpectation{}, err
	}
	runtime := tdsqlRuntimeExpectation{
		Migrations: make([]tdsqlMigrationExpectation, 0, len(files)),
	}
	for _, file := range files {
		statements, err := file.Stmts()
		if err != nil {
			return tdsqlRuntimeExpectation{}, err
		}
		if len(statements) == 0 {
			return tdsqlRuntimeExpectation{}, fmt.Errorf("TDSQL migration %s has no statements", file.Name())
		}
		hash, err := checksums.SumByName(file.Name())
		if err != nil {
			return tdsqlRuntimeExpectation{}, err
		}
		runtime.Migrations = append(runtime.Migrations, tdsqlMigrationExpectation{
			Version: file.Version(), Hash: hash, Total: len(statements),
			Tables: createdTables(statements),
		})
	}
	catalog, err := physicalschema.Current()
	if err != nil {
		return tdsqlRuntimeExpectation{}, err
	}
	for _, spec := range catalog.Tables() {
		runtime.UserTables = append(runtime.UserTables, spec.Name)
	}
	return runtime, nil
}

func classifyTDSQLRuntime(snapshot TDSQLSnapshot, expected tdsqlRuntimeExpectation) State {
	total := 0
	for _, migration := range expected.Migrations {
		total += migration.Total
	}
	if len(expected.Migrations) == 0 {
		return State{Kind: StateUnsafe, Reason: ReasonIdentity}
	}
	if snapshot.RevisionTableExists && !snapshot.RevisionColumnsValid {
		return State{Kind: StateUnsafe, Reason: ReasonRevisionSchema, Total: total}
	}
	if !snapshot.RevisionTableExists && len(snapshot.Revisions) != 0 {
		return State{Kind: StateUnsafe, Reason: ReasonRevisionSchema, Total: total}
	}
	if len(snapshot.Revisions) == 0 {
		if len(snapshot.UserTables) == 0 {
			return State{Kind: StateEmpty, Total: total}
		}
		return State{Kind: StateUnsafe, Reason: ReasonNotEmpty, Total: total}
	}
	if len(snapshot.Revisions) > len(expected.Migrations) {
		return State{Kind: StateUnsafe, Reason: ReasonRevisionCount, Total: total}
	}
	if !isExpectedTableSubset(snapshot.UserTables, expected.UserTables) {
		return State{Kind: StateUnsafe, Reason: ReasonUnexpectedTable, Total: total}
	}
	state := State{Kind: StatePending, Total: total}
	for index, revision := range snapshot.Revisions {
		migration := expected.Migrations[index]
		state.Version = revision.Version
		state.Applied += revision.Applied
		if revision.Version != migration.Version || revision.Hash != migration.Hash ||
			revision.Total != migration.Total || !claimIDPattern.MatchString(revision.ClaimID) {
			state.Kind = StateUnsafe
			state.Reason = ReasonIdentity
			return state
		}
		if revision.Applied < 0 || revision.Applied > revision.Total {
			state.Kind = StateUnsafe
			state.Reason = ReasonProgress
			return state
		}
		partialCount := len(revision.PartialHashes)
		if partialCount != revision.Applied &&
			!(revision.Applied == revision.Total && partialCount == 0) {
			state.Kind = StateUnsafe
			state.Reason = ReasonProgress
			return state
		}
		if revision.Error != "" {
			state.Kind = StateDirty
			return state
		}
		if revision.Applied < revision.Total || partialCount != 0 {
			return state
		}
	}
	expectedTables := tablesAfterRevisions(expected, len(snapshot.Revisions))
	if !sameTableSet(snapshot.UserTables, expectedTables) {
		state.Kind = StateUnsafe
		state.Reason = ReasonIncompleteTables
		return state
	}
	if len(snapshot.Revisions) == len(expected.Migrations) {
		state.Kind = StateClean
	}
	return state
}

var createTableStatement = regexp.MustCompile("(?i)^\\s*CREATE\\s+TABLE\\s+`([^`]+)`\\s*\\(")

func createdTables(statements []string) []string {
	result := make([]string, 0)
	for _, statement := range statements {
		matches := createTableStatement.FindStringSubmatch(strings.TrimSpace(statement))
		if len(matches) == 2 {
			result = append(result, matches[1])
		}
	}
	slices.Sort(result)
	return result
}

func tablesAfterRevisions(expected tdsqlRuntimeExpectation, count int) []string {
	if count > len(expected.Migrations) {
		count = len(expected.Migrations)
	}
	set := make(map[string]struct{})
	for _, migration := range expected.Migrations[:count] {
		for _, table := range migration.Tables {
			set[table] = struct{}{}
		}
	}
	result := make([]string, 0, len(set))
	for table := range set {
		result = append(result, table)
	}
	slices.Sort(result)
	return result
}

func classifyTDSQLSnapshot(snapshot TDSQLSnapshot, expected TDSQLExpectation) State {
	if snapshot.RevisionTableExists && !snapshot.RevisionColumnsValid {
		return State{Kind: StateUnsafe, Reason: ReasonRevisionSchema}
	}
	if !snapshot.RevisionTableExists && len(snapshot.Revisions) != 0 {
		return State{Kind: StateUnsafe, Reason: ReasonRevisionSchema}
	}
	if len(snapshot.Revisions) == 0 {
		if len(snapshot.UserTables) == 0 {
			return State{Kind: StateEmpty, Total: expected.Total}
		}
		return State{Kind: StateUnsafe, Reason: ReasonNotEmpty, Total: expected.Total}
	}
	if len(snapshot.Revisions) != 1 {
		return State{Kind: StateUnsafe, Reason: ReasonRevisionCount, Total: expected.Total}
	}
	revision := snapshot.Revisions[0]
	state := State{
		Kind: StateUnsafe, Version: revision.Version,
		Applied: revision.Applied, Total: revision.Total,
	}
	if revision.Version != expected.Version || revision.Hash != expected.Hash ||
		revision.Total != expected.Total || !claimIDPattern.MatchString(revision.ClaimID) {
		state.Reason = ReasonIdentity
		return state
	}
	if revision.Applied < 0 || revision.Applied > revision.Total {
		state.Reason = ReasonProgress
		return state
	}
	partialCount := len(revision.PartialHashes)
	if partialCount != revision.Applied && !(revision.Applied == revision.Total && partialCount == 0) {
		state.Reason = ReasonProgress
		return state
	}
	if !isExpectedTableSubset(snapshot.UserTables, expected.UserTables) {
		state.Reason = ReasonUnexpectedTable
		return state
	}
	if revision.Error != "" {
		state.Kind = StateDirty
		state.Reason = ""
		return state
	}
	if revision.Applied < revision.Total || partialCount != 0 {
		state.Kind = StatePending
		state.Reason = ""
		return state
	}
	if !sameTableSet(snapshot.UserTables, expected.UserTables) {
		state.Reason = ReasonIncompleteTables
		return state
	}
	state.Kind = StateClean
	state.Reason = ""
	return state
}

func isExpectedTableSubset(actual []string, expected []string) bool {
	allowed := make(map[string]struct{}, len(expected))
	for _, table := range expected {
		allowed[table] = struct{}{}
	}
	seen := make(map[string]struct{}, len(actual))
	for _, table := range actual {
		if _, ok := allowed[table]; !ok {
			return false
		}
		if _, duplicate := seen[table]; duplicate {
			return false
		}
		seen[table] = struct{}{}
	}
	return true
}

func sameTableSet(actual []string, expected []string) bool {
	if len(actual) != len(expected) {
		return false
	}
	actualCopy := append([]string(nil), actual...)
	expectedCopy := append([]string(nil), expected...)
	slices.Sort(actualCopy)
	slices.Sort(expectedCopy)
	return slices.Equal(actualCopy, expectedCopy)
}
