package gateway

import (
	"errors"
	"testing"
)

func TestObserveShardCreatesImmutableProjection(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	input := UpsertShardInput{
		ID: "shard-a", Name: "Shard A", Kind: ShardKindMySQL,
		Endpoint: "mysql-a.internal:3306", RedisEndpoint: "redis-a.internal:6379",
		SecretName: "shard-a-runtime", RedisDBStart: testInt(0), RedisDBLimit: testInt(256),
		Status: ShardStatusActive, MaxSets: testInt(16),
	}

	if err := svc.ObserveShard(t.Context(), input); err != nil {
		t.Fatal(err)
	}
	if err := svc.ObserveShard(t.Context(), input); err != nil {
		t.Fatalf("repeat observation: %v", err)
	}
	detail, err := svc.GetShardDetail(t.Context(), "shard-a")
	if err != nil {
		t.Fatal(err)
	}
	if detail.Shard.Endpoint != input.Endpoint || detail.Shard.RedisDBLimit != 256 || detail.Shard.MaxSets != 16 {
		t.Fatalf("projection = %+v", detail.Shard)
	}
}

func TestObserveShardCompletesBootstrapProjectionOnce(t *testing.T) {
	store := NewMemoryStore()
	if err := store.SaveShard(t.Context(), Shard{
		ID: "shard-a", Name: "shard-a", Kind: ShardKindMySQL,
		Endpoint: "mysql-a.internal:3306", Status: ShardStatusActive,
		MaxConnections: 1000, ReservedConnections: 100,
	}); err != nil {
		t.Fatal(err)
	}
	svc := NewService(store, nil, Options{})
	input := UpsertShardInput{
		ID: "shard-a", Name: "shard-a", Kind: ShardKindMySQL,
		Endpoint: "mysql-a.internal:3306", RedisEndpoint: "redis-a.internal:6379",
		SecretName: "shard-a-runtime", RedisDBStart: testInt(0), RedisDBLimit: testInt(256),
		Status: ShardStatusActive, MaxSets: testInt(16),
		AdminSQLMaxOpenConns: testInt(32), TrafficSQLMaxOpenConns: testInt(24),
		SubscriptionWriteConcurrency: testInt(8),
	}

	if err := svc.ObserveShard(t.Context(), input); err != nil {
		t.Fatal(err)
	}
	detail, err := svc.GetShardDetail(t.Context(), "shard-a")
	if err != nil {
		t.Fatal(err)
	}
	if detail.Shard.RedisEndpoint != input.RedisEndpoint ||
		detail.Shard.SecretName != input.SecretName ||
		detail.Shard.RedisDBLimit != 256 ||
		detail.Shard.MaxSets != 16 ||
		detail.Shard.AdminSQLMaxOpenConns != 32 ||
		detail.Shard.TrafficSQLMaxOpenConns != 24 ||
		detail.Shard.SubscriptionWriteConcurrency != 8 {
		t.Fatalf("incomplete Fleet projection: %+v", detail.Shard)
	}
	if detail.Shard.MaxConnections != 1000 || detail.Shard.ReservedConnections != 100 {
		t.Fatalf("bootstrap capacity was not preserved: %+v", detail.Shard)
	}

	input.RedisEndpoint = "redis-b.internal:6379"
	err = svc.ObserveShard(t.Context(), input)
	if !errors.Is(err, ErrShardProjectionDrift) {
		t.Fatalf("error = %v, want ErrShardProjectionDrift after initialization", err)
	}
}

func TestObserveShardRejectsImmutableDrift(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	input := UpsertShardInput{
		ID: "shard-a", Name: "Shard A", Kind: ShardKindMySQL,
		Endpoint: "mysql-a.internal:3306", RedisEndpoint: "redis-a.internal:6379",
		SecretName: "shard-a-runtime", RedisDBStart: testInt(0), RedisDBLimit: testInt(256),
		Status: ShardStatusActive, MaxSets: testInt(16),
	}
	if err := svc.ObserveShard(t.Context(), input); err != nil {
		t.Fatal(err)
	}

	input.Endpoint = "mysql-b.internal:3306"
	err := svc.ObserveShard(t.Context(), input)
	if !errors.Is(err, ErrShardProjectionDrift) {
		t.Fatalf("error = %v, want ErrShardProjectionDrift", err)
	}
	detail, getErr := svc.GetShardDetail(t.Context(), "shard-a")
	if getErr != nil {
		t.Fatal(getErr)
	}
	if detail.Shard.Endpoint != "mysql-a.internal:3306" {
		t.Fatalf("drift overwrote immutable projection: %+v", detail.Shard)
	}
}
