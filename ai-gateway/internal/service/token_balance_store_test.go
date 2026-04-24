package service

import (
	"context"
	"testing"

	"git.woa.com/wisp/mono/ai-gateway/internal/model"
	"git.woa.com/wisp/mono/ai-gateway/internal/pkg/redisclient"
	"github.com/alicebob/miniredis/v2"
	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
	"gorm.io/gorm"
)

type tokenBalanceStoreMockSubRepo struct {
	sub          *model.Subscription
	getByIDCalls int
}

func (m *tokenBalanceStoreMockSubRepo) Create(sub *model.Subscription) error { return nil }

func (m *tokenBalanceStoreMockSubRepo) GetByID(id uuid.UUID) (*model.Subscription, error) {
	m.getByIDCalls++
	return m.sub, nil
}

func (m *tokenBalanceStoreMockSubRepo) GetActiveByUserID(userID uuid.UUID) (*model.Subscription, error) {
	return nil, nil
}

func (m *tokenBalanceStoreMockSubRepo) DeductTokens(subID uuid.UUID, amount int64) error { return nil }

func (m *tokenBalanceStoreMockSubRepo) DeductTokensToZero(subID uuid.UUID, amount int64) (int64, error) {
	return amount, nil
}

func (m *tokenBalanceStoreMockSubRepo) RefundTokens(subID uuid.UUID, amount int64) error { return nil }

func (m *tokenBalanceStoreMockSubRepo) SetTokenBalance(subID uuid.UUID, balance int64) error {
	return nil
}

func (m *tokenBalanceStoreMockSubRepo) ExpireOverdue() (int64, error) { return 0, nil }

func (m *tokenBalanceStoreMockSubRepo) CancelByUserID(userID uuid.UUID) error { return nil }

func (m *tokenBalanceStoreMockSubRepo) Update(sub *model.Subscription) error { return nil }

func (m *tokenBalanceStoreMockSubRepo) CountActive() (int64, error) { return 0, nil }

func (m *tokenBalanceStoreMockSubRepo) ListExpiredUserIDs() ([]uuid.UUID, error) { return nil, nil }

func (m *tokenBalanceStoreMockSubRepo) SumActiveTokenBalance() (int64, error) { return 0, nil }

func (m *tokenBalanceStoreMockSubRepo) DB() *gorm.DB { return nil }

func TestTokenBalanceStoreDeductSyncsFromDBOnRedisMiss(t *testing.T) {
	mr, err := miniredis.Run()
	if err != nil {
		t.Skipf("miniredis unavailable in current environment: %v", err)
	}
	defer mr.Close()
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	rc := redisclient.NewClientFromRedis(rdb)

	subID := uuid.New()
	repo := &tokenBalanceStoreMockSubRepo{
		sub: &model.Subscription{
			ID:           subID,
			TokenBalance: 100,
			Status:       model.SubscriptionStatusActive,
		},
	}

	store := NewTokenBalanceStore(rc, repo)
	defer store.Stop()

	if err := store.Deduct(context.Background(), subID, 30); err != nil {
		t.Fatalf("expected deduct to succeed after sync from DB, got error: %v", err)
	}

	balance, err := rc.GetTokenBalance(context.Background(), subID.String())
	if err != nil {
		t.Fatalf("expected redis balance to be readable, got error: %v", err)
	}
	if balance != 70 {
		t.Fatalf("expected redis balance 70 after deduct, got %d", balance)
	}
	if repo.getByIDCalls != 1 {
		t.Fatalf("expected one DB sync on first redis miss, got %d", repo.getByIDCalls)
	}

	if err := store.Deduct(context.Background(), subID, 20); err != nil {
		t.Fatalf("expected second deduct to succeed, got error: %v", err)
	}
	if repo.getByIDCalls != 1 {
		t.Fatalf("expected second deduct to reuse initialized redis balance, got %d DB syncs", repo.getByIDCalls)
	}
}
