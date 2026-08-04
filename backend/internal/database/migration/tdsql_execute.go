package migration

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	atlasmigrate "ariga.io/atlas/sql/migrate"
)

func executeOwnedStatements(
	ctx context.Context,
	db tdsqlRevisionExecer,
	revision *atlasmigrate.Revision,
	claimID string,
	statements []string,
) error {
	if revision == nil || revision.Applied != 0 || revision.Total != len(statements) ||
		!claimIDPattern.MatchString(claimID) {
		return fmt.Errorf("invalid owned baseline execution")
	}
	started := time.Now()
	for index, statement := range statements {
		expectedApplied := revision.Applied
		if _, err := db.ExecContext(ctx, statement); err != nil {
			revision.Error = "statement_failed"
			revision.ErrorStmt = ""
			revision.ExecutionTime = time.Since(started)
			writeErr := writeOwnedRevision(ctx, db, revision, claimID, expectedApplied)
			return errors.Join(err, writeErr)
		}
		digest := sha256.Sum256([]byte(statement))
		revision.PartialHashes = append(
			revision.PartialHashes,
			hex.EncodeToString(digest[:]),
		)
		revision.Applied = index + 1
		revision.Error = ""
		revision.ErrorStmt = ""
		revision.ExecutionTime = time.Since(started)
		if err := writeOwnedRevision(ctx, db, revision, claimID, expectedApplied); err != nil {
			return err
		}
	}
	revision.PartialHashes = nil
	revision.ExecutionTime = time.Since(started)
	return writeOwnedRevision(ctx, db, revision, claimID, revision.Applied)
}
