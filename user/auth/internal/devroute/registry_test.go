package devroute

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

var registryReadyDriverSequence atomic.Uint64

type registryReadyDriverState struct {
	mu       sync.Mutex
	query    string
	queryErr error
}

type registryReadyDriver struct{ state *registryReadyDriverState }

func (d registryReadyDriver) Open(string) (driver.Conn, error) {
	return &registryReadyConn{state: d.state}, nil
}

type registryReadyConn struct{ state *registryReadyDriverState }

func (c *registryReadyConn) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("prepare is not supported")
}

func (c *registryReadyConn) Close() error { return nil }

func (c *registryReadyConn) Begin() (driver.Tx, error) {
	return nil, errors.New("transactions are not supported")
}

func (c *registryReadyConn) QueryContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Rows, error) {
	c.state.mu.Lock()
	c.state.query = query
	err := c.state.queryErr
	c.state.mu.Unlock()
	if err != nil {
		return nil, err
	}
	return &registryReadyRows{}, nil
}

type registryReadyRows struct{ returned bool }

func (r *registryReadyRows) Columns() []string { return []string{"COUNT(*)"} }
func (r *registryReadyRows) Close() error      { return nil }

func (r *registryReadyRows) Next(values []driver.Value) error {
	if r.returned {
		return io.EOF
	}
	r.returned = true
	values[0] = int64(0)
	return nil
}

func openRegistryReadyDB(t *testing.T, state *registryReadyDriverState) *sql.DB {
	t.Helper()
	driverName := fmt.Sprintf("developer-route-registry-ready-%d", registryReadyDriverSequence.Add(1))
	sql.Register(driverName, registryReadyDriver{state: state})
	db, err := sql.Open(driverName, "")
	if err != nil {
		t.Fatalf("open test database: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func TestMemoryRegistryUpsertDisableAndRevive(t *testing.T) {
	registry := NewMemoryRegistry()
	renewedAt := time.Date(2026, 9, 17, 6, 0, 0, 0, time.UTC)
	registration := StoredRegistration{
		UIN: " 450860000002 ", UserID: " user-1 ", BaseURL: " http://9.1.2.3:18084/ ",
		DeliveryMode: " DIRECT ", SourceIP: " 9.1.2.3 ", Port: 18084,
		RenewedAt: renewedAt, TTLSeconds: 3600,
	}
	if err := registry.Upsert(context.Background(), registration); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	stored, err := registry.Get(context.Background(), "450860000002")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if stored.UIN != "450860000002" || stored.UserID != "user-1" || stored.BaseURL != "http://9.1.2.3:18084" || stored.DeliveryMode != "direct" {
		t.Fatalf("registration was not normalized: %+v", stored)
	}
	disabledAt := renewedAt.Add(time.Minute)
	if err := registry.Disable(context.Background(), stored.UIN, disabledAt); err != nil {
		t.Fatalf("disable: %v", err)
	}
	stored, _ = registry.Get(context.Background(), stored.UIN)
	if stored.DisabledAt == nil || !stored.DisabledAt.Equal(disabledAt) {
		t.Fatalf("disabledAt=%v", stored.DisabledAt)
	}
	if err := registry.Upsert(context.Background(), registration); err != nil {
		t.Fatalf("revive: %v", err)
	}
	stored, _ = registry.Get(context.Background(), stored.UIN)
	if stored.DisabledAt != nil {
		t.Fatalf("upsert should clear tombstone: %+v", stored)
	}
}

func TestMemoryRegistryMissingRegistration(t *testing.T) {
	registry := NewMemoryRegistry()
	if _, err := registry.Get(context.Background(), "450860000002"); !errors.Is(err, ErrRegistryNotFound) {
		t.Fatalf("get error=%v", err)
	}
	if err := registry.Disable(context.Background(), "450860000002", time.Now()); !errors.Is(err, ErrRegistryNotFound) {
		t.Fatalf("disable error=%v", err)
	}
}

func TestNilMySQLRegistryFailsClosed(t *testing.T) {
	registry := NewMySQLRegistry(nil)
	if err := registry.Ready(context.Background()); err == nil {
		t.Fatal("expected readiness failure")
	}
	if _, err := registry.Get(context.Background(), "450860000002"); err == nil {
		t.Fatal("expected get failure")
	}
	if err := registry.Upsert(context.Background(), StoredRegistration{}); err == nil {
		t.Fatal("expected upsert failure")
	}
	if err := registry.Disable(context.Background(), "450860000002", time.Now()); err == nil {
		t.Fatal("expected disable failure")
	}
}

func TestMySQLRegistryReadyChecksRegistrationTable(t *testing.T) {
	state := &registryReadyDriverState{}
	registry := NewMySQLRegistry(openRegistryReadyDB(t, state))
	if err := registry.Ready(t.Context()); err != nil {
		t.Fatalf("ready: %v", err)
	}
	state.mu.Lock()
	query := state.query
	state.mu.Unlock()
	if !strings.Contains(query, "developer_route_registrations") {
		t.Fatalf("readiness query does not check the registry table: %q", query)
	}
}

func TestMySQLRegistryReadyFailsWhenRegistrationTableIsMissing(t *testing.T) {
	state := &registryReadyDriverState{queryErr: errors.New("table does not exist")}
	registry := NewMySQLRegistry(openRegistryReadyDB(t, state))
	if err := registry.Ready(t.Context()); err == nil {
		t.Fatal("expected readiness failure")
	}
}
