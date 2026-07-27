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
