package service

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
)

const (
	OrderStatusPending   = "pending"
	OrderStatusPaid      = "paid"
	OrderStatusFailed    = "failed"
	OrderStatusCancelled = "cancelled"
)

type Config struct {
	Provider string
	Now      func() time.Time
}

type Order struct {
	ID             string
	ExternalUserID string
	Code           string
	Status         string
	Provider       string
	ProviderOrderID string
	CheckoutURL    string
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

type Store interface {
	CreateOrder(ctx context.Context, order *Order) error
	GetOrderByID(ctx context.Context, orderID string) (*Order, error)
	UpdateOrder(ctx context.Context, order *Order) error
}

type SubscriptionClient interface {
	ApplyPayment(ctx context.Context, orderID, externalUserID, code, providerOrderID string) error
}

type Service struct {
	store              Store
	subscriptionClient SubscriptionClient
	provider           string
	now                func() time.Time
}

func New(cfg Config, store Store, subscriptionClient SubscriptionClient) *Service {
	now := cfg.Now
	if now == nil {
		now = time.Now
	}
	provider := strings.TrimSpace(cfg.Provider)
	if provider == "" {
		provider = "mock"
	}
	return &Service{
		store:              store,
		subscriptionClient: subscriptionClient,
		provider:           provider,
		now:                now,
	}
}

func (s *Service) CreateOrder(ctx context.Context, externalUserID, code string) (*Order, error) {
	externalUserID = strings.TrimSpace(externalUserID)
	code = strings.ToLower(strings.TrimSpace(code))
	if externalUserID == "" {
		return nil, fmt.Errorf("external user id is required")
	}
	if code == "" {
		return nil, fmt.Errorf("code is required")
	}

	now := s.now().UTC()
	order := &Order{
		ID:             uuid.NewString(),
		ExternalUserID: externalUserID,
		Code:           code,
		Status:         OrderStatusPending,
		Provider:       s.provider,
		CreatedAt:      now,
		UpdatedAt:      now,
	}
	if err := s.store.CreateOrder(ctx, order); err != nil {
		return nil, err
	}
	return order, nil
}

func (s *Service) GetOrder(ctx context.Context, orderID string) (*Order, error) {
	return s.store.GetOrderByID(ctx, strings.TrimSpace(orderID))
}

func (s *Service) MarkPaid(ctx context.Context, orderID, providerOrderID string) (*Order, error) {
	order, err := s.store.GetOrderByID(ctx, strings.TrimSpace(orderID))
	if err != nil {
		return nil, err
	}
	if order == nil {
		return nil, fmt.Errorf("order not found")
	}
	if order.Status == OrderStatusPaid {
		return order, nil
	}

	order.Status = OrderStatusPaid
	order.ProviderOrderID = strings.TrimSpace(providerOrderID)
	order.UpdatedAt = s.now().UTC()
	if err := s.store.UpdateOrder(ctx, order); err != nil {
		return nil, err
	}
	if err := s.subscriptionClient.ApplyPayment(ctx, order.ID, order.ExternalUserID, order.Code, order.ProviderOrderID); err != nil {
		return nil, err
	}
	return order, nil
}
