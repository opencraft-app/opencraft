package wallet

import (
	"context"
	"time"

	"shadow/internal/storage"
)

type Service struct {
	store storage.Store
}

func NewService(store storage.Store) *Service {
	return &Service{store: store}
}

func (s *Service) GetAccount(ctx context.Context, userID string) (storage.WalletAccount, error) {
	return s.store.GetWalletAccountByUserID(ctx, userID)
}

func (s *Service) ApplyOrderCredit(ctx context.Context, orderID string, paidAt time.Time, externalRefsJSON string, amount int64, reason string) (storage.WalletCreditResult, error) {
	return s.store.ApplyPackageOrderCredit(ctx, orderID, paidAt, externalRefsJSON, amount, reason)
}
