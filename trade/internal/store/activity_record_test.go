package store

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"testing"
)

type participationExecStub struct {
	query string
	args  []any
	err   error
}

func (s *participationExecStub) ExecContext(_ context.Context, query string, args ...any) (sql.Result, error) {
	s.query, s.args = query, args
	if s.err != nil {
		return nil, s.err
	}
	return participationResultStub{}, nil
}

type participationResultStub struct{}

func (participationResultStub) LastInsertId() (int64, error) { return 7, nil }
func (participationResultStub) RowsAffected() (int64, error) { return 1, nil }

func TestInsertUserParticipation_RenewScene(t *testing.T) {
	exec := &participationExecStub{}
	id, err := insertUserParticipation(context.Background(), exec, &UserActivityParticipation{
		Uin: "123", AppID: "456", ActivityID: 10, Scene: ActivitySceneRenew,
		BundleID: "bundle", ActID: 20, DealName: "deal", BigDealNo: "big",
	})
	if err != nil || id != 7 {
		t.Fatalf("id=%d err=%v", id, err)
	}
	if !strings.Contains(exec.query, "scene") || exec.args[4] != ActivitySceneRenew {
		t.Fatalf("renew scene not persisted: args=%v", exec.args)
	}
}

func TestInsertUserParticipation_Duplicate(t *testing.T) {
	exec := &participationExecStub{err: errors.New("Error 1062: Duplicate entry")}
	_, err := insertUserParticipation(context.Background(), exec, &UserActivityParticipation{Scene: ActivitySceneRenew})
	if !errors.Is(err, ErrActivityParticipationDuplicate) {
		t.Fatalf("err=%v, want duplicate participation", err)
	}
}
