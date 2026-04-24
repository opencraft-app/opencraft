package service

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestProviderCooldownStore_MarkAndRecoverByModel(t *testing.T) {
	store := NewProviderCooldownStore(
		nil,
		ProviderCooldownConfig{
			Default429TTLS: 1,
			Max429TTLS:     30,
		},
	)

	providerID := uuid.New()
	modelA := "gpt-4"
	modelB := "claude-3-7-sonnet"

	if cooled, err := store.Is429CoolingDown(context.Background(), providerID, modelA); err != nil || cooled {
		t.Fatalf("expected no cooldown before mark, cooled=%v err=%v", cooled, err)
	}

	if ttl := store.Mark429Cooldown(context.Background(), providerID, modelA, ""); ttl != 1*time.Second {
		t.Fatalf("expected default ttl to apply, got %s", ttl)
	}

	if cooled, err := store.Is429CoolingDown(context.Background(), providerID, modelA); err != nil || !cooled {
		t.Fatalf("expected model A to be cooling down, cooled=%v err=%v", cooled, err)
	}
	if cooled, err := store.Is429CoolingDown(context.Background(), providerID, modelB); err != nil || cooled {
		t.Fatalf("expected model B to stay available, cooled=%v err=%v", cooled, err)
	}

	time.Sleep(1100 * time.Millisecond)
	if cooled, err := store.Is429CoolingDown(context.Background(), providerID, modelA); err != nil || cooled {
		t.Fatalf("expected cooldown to expire, cooled=%v err=%v", cooled, err)
	}
}

func TestProviderCooldownStore_ClearCooldown(t *testing.T) {
	store := NewProviderCooldownStore(
		nil,
		ProviderCooldownConfig{
			Default429TTLS: 20,
			Max429TTLS:     30,
		},
	)

	providerID := uuid.New()
	modelName := "gpt-4o"

	store.Mark429Cooldown(context.Background(), providerID, modelName, "")
	if cooled, _ := store.Is429CoolingDown(context.Background(), providerID, modelName); !cooled {
		t.Fatal("expected cooldown after mark")
	}

	if err := store.Clear429Cooldown(context.Background(), providerID, modelName); err != nil {
		t.Fatalf("clear cooldown: %v", err)
	}
	if cooled, _ := store.Is429CoolingDown(context.Background(), providerID, modelName); cooled {
		t.Fatal("expected cooldown to clear after success")
	}
}
