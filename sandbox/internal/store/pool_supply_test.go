package store

import (
	"context"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
)

func TestMemorySyncPoolSupplyOverviewPreservesInventoryOnSalesChange(t *testing.T) {
	s := NewMemoryStore()
	first := time.Date(2026, 10, 9, 1, 2, 3, 0, time.UTC)
	rows := []PoolSupplyOverview{
		{Region: "ap-shanghai", Zone: "ap-shanghai-5", InstanceType: "SA9.MEDIUM8", SalesState: "active", Inventory: &PoolSupplyInventory{ResourceCount: 17, RequestID: "request-1", UpdatedTime: first}},
		{Region: "ap-shanghai", Zone: "ap-shanghai-8", InstanceType: "SA4.MEDIUM8", SalesState: "pause"},
	}
	if err := s.SyncPoolSupplyOverview(context.Background(), rows); err != nil {
		t.Fatal(err)
	}
	if err := s.SyncPoolSupplyOverview(context.Background(), []PoolSupplyOverview{{Region: "ap-shanghai", Zone: "ap-shanghai-5", InstanceType: "SA9.MEDIUM8", SalesState: "pause"}}); err != nil {
		t.Fatal(err)
	}
	if len(s.supplyOverview) != 1 {
		t.Fatalf("rows = %d, want 1", len(s.supplyOverview))
	}
	got := s.supplyOverview[poolSupplyKey{"ap-shanghai", "ap-shanghai-5", "SA9.MEDIUM8"}]
	if got.SalesState != "pause" || got.Inventory == nil || got.Inventory.ResourceCount != 17 || got.Inventory.RequestID != "request-1" || !got.Inventory.UpdatedTime.Equal(first) {
		t.Fatalf("stale inventory was lost or refreshed: %+v", got)
	}
	if err := s.SyncPoolSupplyOverview(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	if len(s.supplyOverview) != 0 {
		t.Fatalf("empty snapshot should remove old keys: %+v", s.supplyOverview)
	}
}

func TestMySQLSyncPoolSupplyOverviewIsTransactional(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	updated := time.Date(2026, 10, 9, 1, 2, 3, 0, time.UTC)
	mock.ExpectBegin()
	mock.ExpectExec("INSERT INTO pool_supply_overview").
		WithArgs("ap-shanghai", "ap-shanghai-5", "SA9.MEDIUM8", "active").
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec("UPDATE pool_supply_overview SET resource_count").
		WithArgs(int64(17), "request-1", updated, "ap-shanghai", "ap-shanghai-5", "SA9.MEDIUM8").
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec("DELETE FROM pool_supply_overview WHERE").
		WithArgs("ap-shanghai", "ap-shanghai-5", "SA9.MEDIUM8").
		WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectCommit()
	s := &MySQLStore{db: db}
	err = s.SyncPoolSupplyOverview(context.Background(), []PoolSupplyOverview{{
		Region: "ap-shanghai", Zone: "ap-shanghai-5", InstanceType: "SA9.MEDIUM8", SalesState: "active",
		Inventory: &PoolSupplyInventory{ResourceCount: 17, RequestID: "request-1", UpdatedTime: updated},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestMySQLSyncPoolSupplyOverviewFailureRollsBack(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	mock.ExpectBegin()
	mock.ExpectExec("INSERT INTO pool_supply_overview").
		WithArgs("ap-shanghai", "ap-shanghai-5", "SA9.MEDIUM8", "pause").
		WillReturnError(context.DeadlineExceeded)
	mock.ExpectRollback()
	s := &MySQLStore{db: db}
	if err := s.SyncPoolSupplyOverview(context.Background(), []PoolSupplyOverview{{Region: "ap-shanghai", Zone: "ap-shanghai-5", InstanceType: "SA9.MEDIUM8", SalesState: "pause"}}); err == nil {
		t.Fatal("expected failed snapshot to roll back")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestMySQLSyncPoolSupplyOverviewWithoutFreshInventory(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	mock.ExpectBegin()
	mock.ExpectExec("INSERT INTO pool_supply_overview").
		WithArgs("ap-shanghai", "ap-shanghai-5", "SA9.MEDIUM8", "pause").
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec("DELETE FROM pool_supply_overview WHERE").
		WithArgs("ap-shanghai", "ap-shanghai-5", "SA9.MEDIUM8").
		WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectCommit()
	s := &MySQLStore{db: db}
	if err := s.SyncPoolSupplyOverview(context.Background(), []PoolSupplyOverview{{Region: "ap-shanghai", Zone: "ap-shanghai-5", InstanceType: "SA9.MEDIUM8", SalesState: "pause"}}); err != nil {
		t.Fatal(err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestMySQLSyncPoolSupplyOverviewEmptySnapshotDeletesAll(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	mock.ExpectBegin()
	mock.ExpectExec("DELETE FROM pool_supply_overview$").WillReturnResult(sqlmock.NewResult(0, 2))
	mock.ExpectCommit()
	s := &MySQLStore{db: db}
	if err := s.SyncPoolSupplyOverview(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}
