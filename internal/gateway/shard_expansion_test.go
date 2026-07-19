package gateway

import (
	"errors"
	"testing"
)

func TestShardExpansionIsIdempotentAndRejectsConflictingPayload(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	input := CreateShardExpansionInput{
		IdempotencyKey: "ops-20260717-shard-c",
		ShardID:        "shard-c",
		Name:           "北京分片 C",
		MaxSets:        32,
		RedisDBStart:   512,
		RedisDBLimit:   768,
	}

	first, err := svc.CreateShardExpansion(t.Context(), input)
	if err != nil {
		t.Fatal(err)
	}
	second, err := svc.CreateShardExpansion(t.Context(), input)
	if err != nil {
		t.Fatal(err)
	}
	if first.ID != second.ID {
		t.Fatalf("idempotent replay returned %q, want %q", second.ID, first.ID)
	}
	if err := store.SaveShard(t.Context(), Shard{ID: "shard-c", Status: ShardStatusActive}); err != nil {
		t.Fatal(err)
	}
	afterProjection, err := svc.CreateShardExpansion(t.Context(), input)
	if err != nil || afterProjection.ID != first.ID {
		t.Fatalf("replay after fleet projection = %+v err=%v", afterProjection, err)
	}

	input.MaxSets = 64
	if _, err := svc.CreateShardExpansion(t.Context(), input); !errors.Is(err, ErrShardExpansionIdempotencyConflict) {
		t.Fatalf("conflicting replay error = %v", err)
	}
}

func TestShardExpansionAllowsOnlyOneActiveWorkflowPerShard(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	base := CreateShardExpansionInput{
		IdempotencyKey: "ops-shard-c-first", ShardID: "shard-c", Name: "北京分片 C",
		MaxSets: 32, RedisDBStart: 512, RedisDBLimit: 768,
	}
	if _, err := svc.CreateShardExpansion(t.Context(), base); err != nil {
		t.Fatal(err)
	}
	base.IdempotencyKey = "ops-shard-c-second"
	if _, err := svc.CreateShardExpansion(t.Context(), base); !errors.Is(err, ErrShardExpansionAlreadyActive) {
		t.Fatalf("second active workflow error = %v", err)
	}
}

func TestShardExpansionWaitsForMatchingFleetProjection(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	expansion, err := svc.CreateShardExpansion(t.Context(), CreateShardExpansionInput{
		IdempotencyKey: "ops-shard-c",
		ShardID:        "shard-c",
		Name:           "北京分片 C",
		MaxSets:        32,
		RedisDBStart:   512,
		RedisDBLimit:   768,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ReconcileShardExpansions(t.Context(), 25); err != nil {
		t.Fatal(err)
	}
	expansion, err = svc.RecordShardExpansionInfrastructure(t.Context(), expansion.ID, RecordShardExpansionInfrastructureInput{
		MySQLEndpoint: "mysql-c.internal:3306",
		RedisEndpoint: "redis-c.internal:6379",
		SecretName:    "newapi-shard-c",
		TerraformRun:  "https://terraform.example/runs/42",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ReconcileShardExpansions(t.Context(), 25); err != nil {
		t.Fatal(err)
	}
	expansion, _, err = store.GetShardExpansion(t.Context(), expansion.ID)
	if err != nil {
		t.Fatal(err)
	}
	if expansion.Status != ShardExpansionStatusWaitingFleetProjection {
		t.Fatalf("status without projection = %q", expansion.Status)
	}

	if err := svc.UpsertShard(t.Context(), UpsertShardInput{
		ID:            "shard-c",
		Name:          "shard-c",
		Kind:          ShardKindMySQL,
		Endpoint:      "mysql-c.internal:3306",
		RedisEndpoint: "redis-c.internal:6379",
		SecretName:    "newapi-shard-c",
		Status:        ShardStatusActive,
		MaxSets:       testInt(32),
		RedisDBStart:  testInt(512),
		RedisDBLimit:  testInt(768),
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ReconcileShardExpansions(t.Context(), 25); err != nil {
		t.Fatal(err)
	}
	expansion, _, err = store.GetShardExpansion(t.Context(), expansion.ID)
	if err != nil {
		t.Fatal(err)
	}
	if expansion.Status != ShardExpansionStatusVerifying {
		t.Fatalf("status with matching projection = %q", expansion.Status)
	}
}

func TestShardExpansionVerificationFailureCanRetry(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	expansion, err := svc.CreateShardExpansion(t.Context(), CreateShardExpansionInput{
		IdempotencyKey: "ops-shard-d",
		ShardID:        "shard-d",
		Name:           "北京分片 D",
		MaxSets:        8,
		RedisDBStart:   768,
		RedisDBLimit:   1024,
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, status := range []string{ShardExpansionStatusWaitingInfrastructure, ShardExpansionStatusInfrastructureReady, ShardExpansionStatusWaitingFleetProjection, ShardExpansionStatusVerifying} {
		expansion.Status = status
		updated, ok, err := store.UpdateShardExpansion(t.Context(), expansion, expansion.Version)
		if err != nil || !ok {
			t.Fatalf("set status %s: ok=%t err=%v", status, ok, err)
		}
		expansion = updated
	}

	expansion, err = svc.RecordShardExpansionVerification(t.Context(), expansion.ID, RecordShardExpansionVerificationInput{
		Success:  false,
		Evidence: "chat probe returned 503",
	})
	if err != nil {
		t.Fatal(err)
	}
	if expansion.Status != ShardExpansionStatusError || expansion.RetryStatus != ShardExpansionStatusVerifying {
		t.Fatalf("failed verification = %+v", expansion)
	}
	expansion, err = svc.RetryShardExpansion(t.Context(), expansion.ID)
	if err != nil {
		t.Fatal(err)
	}
	if expansion.Status != ShardExpansionStatusVerifying || expansion.LastError != "" {
		t.Fatalf("retried expansion = %+v", expansion)
	}
}
