package migration

import (
	"context"
	"database/sql"
	"errors"
	"testing"

	atlasmigrate "ariga.io/atlas/sql/migrate"
	gomysql "github.com/go-sql-driver/mysql"
)

func TestClaimRevision严格区分WonDuplicate和Failed(t *testing.T) {
	revision := &atlasmigrate.Revision{Version: "20260801000000", Total: 25, Hash: "hash"}
	tests := []struct {
		name    string
		err     error
		outcome ClaimOutcome
		wantErr bool
	}{
		{name: "won", outcome: ClaimWon},
		{name: "duplicate", err: &gomysql.MySQLError{Number: 1062}, outcome: ClaimDuplicate},
		{name: "failed", err: errors.New("connection lost"), outcome: ClaimFailed, wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			db := &claimExecFake{err: tt.err}
			outcome, err := claimRevision(
				context.Background(), db, revision, "0123456789abcdef0123456789abcdef",
			)
			if outcome != tt.outcome || (err != nil) != tt.wantErr {
				t.Fatalf("claimRevision() = (%q,%v)", outcome, err)
			}
			if db.calls != 1 {
				t.Fatalf("Exec 调用次数 = %d", db.calls)
			}
		})
	}
}

func TestWriteOwnedRevision要求CAS恰好命中一行(t *testing.T) {
	revision := &atlasmigrate.Revision{
		Version: "20260801000000", Applied: 1, Total: 25,
		PartialHashes: []string{"statement-1"},
	}
	for _, rows := range []int64{0, 2} {
		db := &claimExecFake{rows: rows}
		if err := writeOwnedRevision(
			context.Background(), db, revision,
			"0123456789abcdef0123456789abcdef", 0,
		); err == nil {
			t.Fatalf("RowsAffected=%d 时应拒绝", rows)
		}
	}
	db := &claimExecFake{rows: 1}
	if err := writeOwnedRevision(
		context.Background(), db, revision,
		"0123456789abcdef0123456789abcdef", 0,
	); err != nil {
		t.Fatalf("RowsAffected=1 error = %v", err)
	}
}

func TestNewClaimID生成128BitHex(t *testing.T) {
	first, err := newClaimID()
	if err != nil {
		t.Fatal(err)
	}
	second, err := newClaimID()
	if err != nil {
		t.Fatal(err)
	}
	if !claimIDPattern.MatchString(first) || !claimIDPattern.MatchString(second) || first == second {
		t.Fatalf("claim IDs = %q, %q", first, second)
	}
}

type claimExecFake struct {
	rows  int64
	err   error
	calls int
}

func (fake *claimExecFake) ExecContext(
	context.Context,
	string,
	...any,
) (sql.Result, error) {
	fake.calls++
	if fake.err != nil {
		return nil, fake.err
	}
	return claimResult(fake.rows), nil
}

type claimResult int64

func (claimResult) LastInsertId() (int64, error)        { return 0, nil }
func (result claimResult) RowsAffected() (int64, error) { return int64(result), nil }
