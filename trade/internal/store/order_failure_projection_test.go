package store

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"io"
	"strings"
	"testing"
)

type projectionRecorder struct {
	queries   []string
	commits   int
	rollbacks int
	failAt    int
}

type projectionConnector struct{ recorder *projectionRecorder }

func (c projectionConnector) Connect(context.Context) (driver.Conn, error) {
	return projectionConn{recorder: c.recorder}, nil
}
func (c projectionConnector) Driver() driver.Driver { return projectionDriver{} }

type projectionDriver struct{}

func (projectionDriver) Open(string) (driver.Conn, error) { return nil, errors.New("use connector") }

type projectionConn struct{ recorder *projectionRecorder }

func (projectionConn) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("unexpected prepare")
}
func (projectionConn) Close() error                { return nil }
func (c projectionConn) Begin() (driver.Tx, error) { return projectionTx{recorder: c.recorder}, nil }
func (c projectionConn) ExecContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Result, error) {
	c.recorder.queries = append(c.recorder.queries, query)
	if c.recorder.failAt == len(c.recorder.queries) {
		return nil, errors.New("forced exec failure")
	}
	return driver.RowsAffected(1), nil
}
func (c projectionConn) QueryContext(_ context.Context, _ string, _ []driver.NamedValue) (driver.Rows, error) {
	return &projectionRows{}, nil
}

type projectionRows struct{ returned bool }

func (*projectionRows) Columns() []string { return []string{"resource_id"} }
func (*projectionRows) Close() error      { return nil }
func (r *projectionRows) Next(dest []driver.Value) error {
	if r.returned {
		return io.EOF
	}
	r.returned = true
	dest[0] = nil
	return nil
}

type projectionTx struct{ recorder *projectionRecorder }

func (tx projectionTx) Commit() error   { tx.recorder.commits++; return nil }
func (tx projectionTx) Rollback() error { tx.recorder.rollbacks++; return nil }

func projectionStore(t *testing.T, recorder *projectionRecorder) *MySQLStore {
	t.Helper()
	db := sql.OpenDB(projectionConnector{recorder: recorder})
	t.Cleanup(func() { _ = db.Close() })
	return &MySQLStore{db: db}
}

func TestMarkFailedProjectsOrderInSameTransaction(t *testing.T) {
	for _, tc := range []struct {
		name string
		call func(*MySQLStore) error
	}{
		{"by deal", func(s *MySQLStore) error {
			return s.MarkFailed(context.Background(), "deal-1", FlowTypeCreateResource, "123", []byte(`{"returnCode":352014}`))
		}},
		{"by ID", func(s *MySQLStore) error {
			return s.MarkFailedByID(context.Background(), 9, []byte(`{"result":"failed"}`))
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			recorder := &projectionRecorder{}
			if err := tc.call(projectionStore(t, recorder)); err != nil {
				t.Fatal(err)
			}
			if len(recorder.queries) != 2 || recorder.commits != 1 {
				t.Fatalf("queries=%d commits=%d", len(recorder.queries), recorder.commits)
			}
			if !strings.Contains(recorder.queries[1], "provision_failed") ||
				!strings.Contains(recorder.queries[1], "f.status = 'failed'") ||
				!strings.Contains(recorder.queries[1], "f.app_id = o.app_id") ||
				!strings.Contains(recorder.queries[1], "o.status IN ('created', 'pending_pay', 'paid_pending_provision')") {
				t.Fatalf("failure projection lacks terminal/CAS guards: %s", recorder.queries[1])
			}
		})
	}
}

func TestMarkFailedRollsBackWhenOrderProjectionFails(t *testing.T) {
	recorder := &projectionRecorder{failAt: 2}
	err := projectionStore(t, recorder).MarkFailedByID(context.Background(), 9, []byte(`{"result":"failed"}`))
	if err == nil || recorder.commits != 0 || recorder.rollbacks != 1 {
		t.Fatalf("err=%v commits=%d rollbacks=%d", err, recorder.commits, recorder.rollbacks)
	}
}

func TestCreateOrderReconcilesEarlierTerminalFlow(t *testing.T) {
	recorder := &projectionRecorder{}
	err := projectionStore(t, recorder).CreateOrder(context.Background(), CreateOrderInput{
		DealName: "deal-1", AppID: "123", Status: OrderStatusPaidPendingProvision,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(recorder.queries) != 3 || !strings.Contains(recorder.queries[1], "f.status = 'failed'") ||
		!strings.Contains(recorder.queries[2], "f.status = 'completed'") ||
		!strings.Contains(recorder.queries[2], "f.resource_id IS NOT NULL") {
		t.Fatalf("missing callback-before-insert reconciliation: %#v", recorder.queries)
	}
}

func TestMarkOrderProvisionedCannotOverwriteFailure(t *testing.T) {
	recorder := &projectionRecorder{}
	if err := projectionStore(t, recorder).MarkOrderProvisioned(context.Background(), "deal-1", "pass-1"); err != nil {
		t.Fatal(err)
	}
	if len(recorder.queries) != 1 || !strings.Contains(recorder.queries[0],
		"status IN ('created', 'pending_pay', 'paid_pending_provision', 'provisioned')") ||
		!strings.Contains(recorder.queries[0], "resource_id = ?") {
		t.Fatalf("success update is missing terminal/resource guards: %#v", recorder.queries)
	}
}
