package gateway

import "testing"

func testInt(value int) *int {
	return &value
}

func testFloat(value float64) *float64 {
	return &value
}

func TestShardDetailComputesLogicalConnectionBudget(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})

	if err := svc.UpsertShard(t.Context(), UpsertShardInput{
		ID:                  "mysql-a",
		Name:                "MySQL A",
		Kind:                ShardKindMySQL,
		Status:              ShardStatusActive,
		Endpoint:            "mysql-a.example.internal:3306",
		MaxConnections:      testInt(4596),
		ReservedConnections: testInt(500),
		WarnRatio:           testFloat(0.7),
		CriticalRatio:       testFloat(0.85),
	}); err != nil {
		t.Fatal(err)
	}
	if err := svc.RegisterSet(t.Context(), RegisterSetInput{
		ID:              "set-a",
		BaseURL:         "http://set-a",
		Status:          SetStatusActive,
		ShardID:         "mysql-a",
		NewAPIReplicas:  testInt(3),
		SQLMaxOpenConns: testInt(200),
		SQLMaxIdleConns: testInt(50),
	}); err != nil {
		t.Fatal(err)
	}
	if err := svc.RegisterSet(t.Context(), RegisterSetInput{
		ID:              "set-b",
		BaseURL:         "http://set-b",
		Status:          SetStatusActive,
		ShardID:         "mysql-a",
		NewAPIReplicas:  testInt(2),
		SQLMaxOpenConns: testInt(300),
	}); err != nil {
		t.Fatal(err)
	}

	detail, err := svc.GetShardDetail(t.Context(), "mysql-a")
	if err != nil {
		t.Fatal(err)
	}
	if detail.AllocatableConnections != 4096 {
		t.Fatalf("allocatable=%d want 4096", detail.AllocatableConnections)
	}
	if detail.LogicalConnections != 1200 {
		t.Fatalf("logical=%d want 1200", detail.LogicalConnections)
	}
	if detail.RemainingConnections != 2896 {
		t.Fatalf("remaining=%d want 2896", detail.RemainingConnections)
	}
	if detail.CapacityStatus != ShardCapacityOK {
		t.Fatalf("capacity status=%q want %q", detail.CapacityStatus, ShardCapacityOK)
	}
	if len(detail.Sets) != 2 || detail.Sets[0].LogicalConnections != 600 || detail.Sets[1].LogicalConnections != 600 {
		t.Fatalf("unexpected set budgets: %+v", detail.Sets)
	}
}

func TestShardDetailProjectsRedisDBAllocationPerSet(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	if err := svc.UpsertShard(t.Context(), UpsertShardInput{
		ID: "shard-a", Kind: ShardKindMySQL, Status: ShardStatusActive,
		RedisEndpoint: "redis-a.internal:6379", RedisDBStart: testInt(0), RedisDBLimit: testInt(256),
	}); err != nil {
		t.Fatal(err)
	}
	if err := svc.RegisterSet(t.Context(), RegisterSetInput{ID: "set-a", BaseURL: "http://set-a", Status: SetStatusActive, ShardID: "shard-a"}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveSetRuntimeLease(t.Context(), SetRuntimeLease{
		Source: "prod", Namespace: "llmgateway", Fleet: "prod", SetID: "set-a", ShardRef: "shard-a",
		DatabaseName: "newapi_set_a", RedisDB: "7",
	}); err != nil {
		t.Fatal(err)
	}
	detail, err := svc.GetShardDetail(t.Context(), "shard-a")
	if err != nil {
		t.Fatal(err)
	}
	if detail.RedisDBAllocated != 1 || detail.RedisDBAvailable != 255 || detail.RedisDBUtilization != 1.0/256.0 {
		t.Fatalf("redis budget = %+v", detail)
	}
	if len(detail.Sets) != 1 || detail.Sets[0].DatabaseName != "newapi_set_a" || detail.Sets[0].RedisDB != "7" {
		t.Fatalf("set runtime projection = %+v", detail.Sets)
	}
}

func TestShardDetailWarnsWhenLogicalBudgetCrossesWatermarks(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})

	if err := svc.UpsertShard(t.Context(), UpsertShardInput{
		ID:                  "mysql-a",
		Kind:                ShardKindMySQL,
		Status:              ShardStatusActive,
		MaxConnections:      testInt(1000),
		ReservedConnections: testInt(100),
		WarnRatio:           testFloat(0.7),
		CriticalRatio:       testFloat(0.85),
	}); err != nil {
		t.Fatal(err)
	}
	if err := svc.RegisterSet(t.Context(), RegisterSetInput{
		ID:              "set-a",
		BaseURL:         "http://set-a",
		Status:          SetStatusActive,
		ShardID:         "mysql-a",
		NewAPIReplicas:  testInt(4),
		SQLMaxOpenConns: testInt(200),
	}); err != nil {
		t.Fatal(err)
	}

	detail, err := svc.GetShardDetail(t.Context(), "mysql-a")
	if err != nil {
		t.Fatal(err)
	}
	if detail.CapacityStatus != ShardCapacityCritical {
		t.Fatalf("capacity status=%q want %q", detail.CapacityStatus, ShardCapacityCritical)
	}
}

func TestUpsertShardKeepsCriticalRatioAtLeastWarnRatio(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})

	if err := svc.UpsertShard(t.Context(), UpsertShardInput{
		ID:             "mysql-a",
		MaxConnections: testInt(1000),
		WarnRatio:      testFloat(0.7),
		CriticalRatio:  testFloat(0.85),
	}); err != nil {
		t.Fatal(err)
	}
	if err := svc.UpsertShard(t.Context(), UpsertShardInput{
		ID:        "mysql-a",
		WarnRatio: testFloat(0.95),
	}); err != nil {
		t.Fatal(err)
	}
	detail, err := svc.GetShardDetail(t.Context(), "mysql-a")
	if err != nil {
		t.Fatal(err)
	}
	if detail.Shard.CriticalRatio != 0.95 {
		t.Fatalf("critical_ratio=%v want 0.95", detail.Shard.CriticalRatio)
	}
}
