package migration

import (
	"context"
	"strings"
	"testing"

	"git.woa.com/wisp/mono2/collaboration/internal/apperror"
)

func TestClassifyEmptyBaselineRecovery只接受精确旧版空库残留(t *testing.T) {
	signature := emptyBaselineRecoverySignature{
		Version:           "20260801000000",
		Hash:              "published-hash",
		LegacyTotal:       50,
		FirstStatementSHA: strings.Repeat("a", 64),
		FirstTable:        "account_login_identities",
	}
	exact := TDSQLSnapshot{
		RevisionTableExists:  true,
		RevisionColumnsValid: true,
		UserTables:           []string{"account_login_identities"},
		Revisions: []TDSQLRevision{{
			Version: "20260801000000", Hash: "published-hash",
			ClaimID: strings.Repeat("b", 32), Applied: 1, Total: 50,
			Error: "statement_failed", ErrorStmt: "",
			PartialHashes: []string{strings.Repeat("a", 64)},
		}},
	}

	action, err := classifyEmptyBaselineRecovery(exact, signature)
	if err != nil || action != emptyBaselineRecoveryDropTableAndRevision {
		t.Fatalf("exact recovery = (%q, %v)", action, err)
	}

	postDrop := cloneTDSQLSnapshot(exact)
	postDrop.UserTables = nil
	action, err = classifyEmptyBaselineRecovery(postDrop, signature)
	if err != nil || action != emptyBaselineRecoveryDeleteRevision {
		t.Fatalf("post-drop recovery = (%q, %v)", action, err)
	}

	alreadyEmpty := TDSQLSnapshot{
		RevisionTableExists:  true,
		RevisionColumnsValid: true,
	}
	action, err = classifyEmptyBaselineRecovery(alreadyEmpty, signature)
	if err != nil || action != emptyBaselineRecoveryAlreadyEmpty {
		t.Fatalf("already-empty recovery = (%q, %v)", action, err)
	}

	mutations := []func(*TDSQLSnapshot){
		func(value *TDSQLSnapshot) { value.RevisionColumnsValid = false },
		func(value *TDSQLSnapshot) { value.UserTables = append(value.UserTables, "accounts") },
		func(value *TDSQLSnapshot) { value.Revisions[0].Version = "other" },
		func(value *TDSQLSnapshot) { value.Revisions[0].Hash = "other" },
		func(value *TDSQLSnapshot) { value.Revisions[0].ClaimID = "invalid" },
		func(value *TDSQLSnapshot) { value.Revisions[0].Applied = 2 },
		func(value *TDSQLSnapshot) { value.Revisions[0].Total = 25 },
		func(value *TDSQLSnapshot) { value.Revisions[0].Error = "other" },
		func(value *TDSQLSnapshot) { value.Revisions[0].ErrorStmt = "sensitive statement" },
		func(value *TDSQLSnapshot) { value.Revisions[0].PartialHashes = nil },
		func(value *TDSQLSnapshot) { value.Revisions[0].PartialHashes[0] = strings.Repeat("c", 64) },
		func(value *TDSQLSnapshot) { value.Revisions = append(value.Revisions, value.Revisions[0]) },
	}
	for index, mutate := range mutations {
		candidate := cloneTDSQLSnapshot(exact)
		mutate(&candidate)
		if action, err := classifyEmptyBaselineRecovery(candidate, signature); err == nil {
			t.Fatalf("mutation %d unexpectedly accepted as %q", index, action)
		}
	}
}

func TestEmptyBaselineRecoverySignature绑定已发布MySQLBaseline(t *testing.T) {
	dir, err := embeddedDirFor("mysql")
	if err != nil {
		t.Fatal(err)
	}
	defer dir.Close()
	signature, err := emptyBaselineRecoverySignatureFromDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if signature.Version != "20260801000000" ||
		signature.LegacyTotal != 50 ||
		signature.FirstTable != "account_login_identities" ||
		len(signature.FirstStatementSHA) != 64 ||
		strings.TrimSpace(signature.Hash) == "" {
		t.Fatalf("signature = %#v", signature)
	}
}

func TestRecoverEmptyBaseline计划零写入且Apply按固定顺序收敛(t *testing.T) {
	signature := emptyBaselineRecoverySignature{
		Version: "20260801000000", Hash: "published-hash", LegacyTotal: 50,
		FirstStatementSHA: strings.Repeat("a", 64), FirstTable: "account_login_identities",
	}
	dirty := exactRecoverySnapshot(signature)
	empty := TDSQLSnapshot{RevisionTableExists: true, RevisionColumnsValid: true}

	planStore := &emptyBaselineRecoveryStoreFake{snapshot: dirty, tableRows: 0, postSnapshot: empty, deleteRows: 1}
	plan, err := recoverEmptyBaseline(context.Background(), planStore, signature, false)
	if err != nil || plan.Applied || plan.AlreadyEmpty || strings.Join(planStore.events, ",") != "snapshot,count" {
		t.Fatalf("plan = (%#v, %v), events=%v", plan, err, planStore.events)
	}

	applyStore := &emptyBaselineRecoveryStoreFake{snapshot: dirty, tableRows: 0, postSnapshot: empty, deleteRows: 1}
	applied, err := recoverEmptyBaseline(context.Background(), applyStore, signature, true)
	if err != nil || !applied.Applied || !applied.AlreadyEmpty ||
		strings.Join(applyStore.events, ",") != "snapshot,count,drop,delete,snapshot" {
		t.Fatalf("apply = (%#v, %v), events=%v", applied, err, applyStore.events)
	}

	nonEmpty := &emptyBaselineRecoveryStoreFake{snapshot: dirty, tableRows: 1, postSnapshot: empty, deleteRows: 1}
	if _, err := recoverEmptyBaseline(context.Background(), nonEmpty, signature, true); apperror.CodeOf(err) != "DATABASE_NOT_EMPTY" ||
		strings.Join(nonEmpty.events, ",") != "snapshot,count" {
		t.Fatalf("non-empty err=%v events=%v", err, nonEmpty.events)
	}
}

func exactRecoverySnapshot(signature emptyBaselineRecoverySignature) TDSQLSnapshot {
	return TDSQLSnapshot{
		RevisionTableExists: true, RevisionColumnsValid: true,
		UserTables: []string{signature.FirstTable},
		Revisions: []TDSQLRevision{{
			Version: signature.Version, Hash: signature.Hash,
			ClaimID: strings.Repeat("b", 32), Applied: 1, Total: signature.LegacyTotal,
			Error: "statement_failed", PartialHashes: []string{signature.FirstStatementSHA},
		}},
	}
}

type emptyBaselineRecoveryStoreFake struct {
	snapshot     TDSQLSnapshot
	postSnapshot TDSQLSnapshot
	tableRows    int64
	deleteRows   int64
	events       []string
	snapshots    int
}

func (fake *emptyBaselineRecoveryStoreFake) Snapshot(context.Context) (TDSQLSnapshot, error) {
	fake.events = append(fake.events, "snapshot")
	fake.snapshots++
	if fake.snapshots == 1 {
		return cloneTDSQLSnapshot(fake.snapshot), nil
	}
	return cloneTDSQLSnapshot(fake.postSnapshot), nil
}

func (fake *emptyBaselineRecoveryStoreFake) CountFirstTable(context.Context, string) (int64, error) {
	fake.events = append(fake.events, "count")
	return fake.tableRows, nil
}

func (fake *emptyBaselineRecoveryStoreFake) DropFirstTable(context.Context, string) error {
	fake.events = append(fake.events, "drop")
	return nil
}

func (fake *emptyBaselineRecoveryStoreFake) DeleteRevision(context.Context, TDSQLRevision) (int64, error) {
	fake.events = append(fake.events, "delete")
	return fake.deleteRows, nil
}
