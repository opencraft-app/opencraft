package service

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
)

const (
	SubscriptionStatusActive         = "active"
	SubscriptionStatusPendingPayment = "pending_payment"
	SubscriptionStatusCancelled      = "cancelled"
	SubscriptionStatusExpired        = "expired"

	CheckoutModeActive          = "active"
	CheckoutModePaymentRequired = "payment_required"
)

type Config struct {
	PlanMappings map[string]string
	Now          func() time.Time
}

type Plan struct {
	Code        string
	Description string
	MaxBotCount int
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

type Subscription struct {
	ID                      string
	ExternalUserID          string
	Code                    string
	Status                  string
	AIGatewayPlanID         string
	AIGatewaySubscriptionID string
	CurrentPeriodStart      *time.Time
	CurrentPeriodEnd        *time.Time
	SourceOrderID           string
	CreatedAt               time.Time
	UpdatedAt               time.Time
}

type SubscriptionEvent struct {
	ID             string
	SubscriptionID string
	EventType      string
	Code           string
	Status         string
	SourceOrderID  string
	CreatedAt      time.Time
}

type AdminListFilter struct {
	Search         string
	ExternalUserID string
	Status         string
	Code           string
	Limit          int
}

type PaymentOrder struct {
	ID              string
	ExternalUserID  string
	Code            string
	Status          string
	Provider        string
	ProviderOrderID string
	CheckoutURL     string
	CreatedAt       time.Time
	UpdatedAt       time.Time
}

const (
	PaymentOrderStatusPending   = "pending"
	PaymentOrderStatusPaid      = "paid"
	PaymentOrderStatusFailed    = "failed"
	PaymentOrderStatusCancelled = "cancelled"
)

type CheckoutResult struct {
	Mode         string
	Code         string
	Subscription *Subscription
	Order        *PaymentOrder
}

type Store interface {
	GetPlanByCode(ctx context.Context, code string) (*Plan, error)
	ListPlans(ctx context.Context) ([]Plan, error)
	UpsertPlan(ctx context.Context, plan *Plan) error
	DeletePlan(ctx context.Context, code string) error
	GetCurrentByExternalUserID(ctx context.Context, externalUserID string) (*Subscription, error)
	ListSubscriptions(ctx context.Context, filter AdminListFilter) ([]Subscription, error)
	ListEventsByExternalUserID(ctx context.Context, externalUserID string, limit int) ([]SubscriptionEvent, error)
	UpsertCurrent(ctx context.Context, subscription *Subscription) error
	AppendEvent(ctx context.Context, event *SubscriptionEvent) error
}

type PaymentClient interface {
	CreateOrder(ctx context.Context, externalUserID, code string) (*PaymentOrder, error)
}

type AIGatewayClient interface {
	SetSubscriptionByExternalUID(ctx context.Context, externalUserID, planID string) (*AIGatewaySubscription, error)
	CancelSubscriptionByExternalUID(ctx context.Context, externalUserID string) error
}

type AIGatewaySubscription struct {
	ID     string
	UserID string
	PlanID string
	Status string
}

type Service struct {
	store         Store
	paymentClient PaymentClient
	aiClient      AIGatewayClient
	planMappings  map[string]string
	now           func() time.Time
}

func New(cfg Config, store Store, paymentClient PaymentClient, aiClient AIGatewayClient) *Service {
	planMappings := make(map[string]string, len(cfg.PlanMappings))
	for key, value := range cfg.PlanMappings {
		planMappings[normalizeCode(key)] = strings.TrimSpace(value)
	}
	now := cfg.Now
	if now == nil {
		now = time.Now
	}
	return &Service{
		store:         store,
		paymentClient: paymentClient,
		aiClient:      aiClient,
		planMappings:  planMappings,
		now:           now,
	}
}

func (s *Service) Checkout(ctx context.Context, externalUserID, code string) (*CheckoutResult, error) {
	externalUserID = strings.TrimSpace(externalUserID)
	code = normalizeCode(code)
	if externalUserID == "" {
		return nil, fmt.Errorf("external user id is required")
	}
	if _, err := s.requirePlan(ctx, code); err != nil {
		return nil, fmt.Errorf("unknown code")
	}

	if code == "free" {
		subscription, err := s.applySubscription(ctx, externalUserID, code, "")
		if err != nil {
			return nil, err
		}
		return &CheckoutResult{
			Mode:         CheckoutModeActive,
			Code:         code,
			Subscription: subscription,
		}, nil
	}

	order, err := s.paymentClient.CreateOrder(ctx, externalUserID, code)
	if err != nil {
		return nil, err
	}
	return &CheckoutResult{
		Mode:  CheckoutModePaymentRequired,
		Code:  code,
		Order: order,
	}, nil
}

func (s *Service) ApplyPayment(ctx context.Context, orderID, externalUserID, code, providerOrderID string) (*Subscription, error) {
	existing, err := s.store.GetCurrentByExternalUserID(ctx, strings.TrimSpace(externalUserID))
	if err != nil {
		return nil, err
	}
	if existing != nil && existing.Status == SubscriptionStatusActive && existing.SourceOrderID == strings.TrimSpace(orderID) {
		return existing, nil
	}
	return s.applySubscription(ctx, externalUserID, code, orderID)
}

func (s *Service) GetCurrent(ctx context.Context, externalUserID string) (*Subscription, error) {
	return s.store.GetCurrentByExternalUserID(ctx, strings.TrimSpace(externalUserID))
}

func (s *Service) AdminList(ctx context.Context, filter AdminListFilter) ([]Subscription, error) {
	return s.store.ListSubscriptions(ctx, filter)
}

func (s *Service) AdminEvents(ctx context.Context, externalUserID string, limit int) ([]SubscriptionEvent, error) {
	return s.store.ListEventsByExternalUserID(ctx, strings.TrimSpace(externalUserID), limit)
}

func (s *Service) AdminListPlans(ctx context.Context) ([]Plan, error) {
	return s.store.ListPlans(ctx)
}

func (s *Service) AdminUpsertPlan(ctx context.Context, code, description string, maxBotCount int) (*Plan, error) {
	code = normalizeCode(code)
	if code == "" {
		return nil, fmt.Errorf("plan code is required")
	}
	if maxBotCount < 0 {
		return nil, fmt.Errorf("max bot count must be >= 0")
	}
	now := s.now().UTC()
	existing, err := s.store.GetPlanByCode(ctx, code)
	if err != nil {
		return nil, err
	}
	plan := &Plan{
		Code:        code,
		Description: strings.TrimSpace(description),
		MaxBotCount: maxBotCount,
		CreatedAt:   now,
		UpdatedAt:   now,
	}
	if existing != nil {
		plan.CreatedAt = existing.CreatedAt
	}
	if err := s.store.UpsertPlan(ctx, plan); err != nil {
		return nil, err
	}
	return plan, nil
}

func (s *Service) AdminDeletePlan(ctx context.Context, code string) error {
	code = normalizeCode(code)
	if code == "" {
		return fmt.Errorf("plan code is required")
	}
	current, err := s.store.ListSubscriptions(ctx, AdminListFilter{Code: code, Limit: 1})
	if err != nil {
		return err
	}
	if len(current) > 0 {
		return fmt.Errorf("plan is in use")
	}
	return s.store.DeletePlan(ctx, code)
}

func (s *Service) AdminSetSubscription(ctx context.Context, externalUserID, code string) (*Subscription, error) {
	if _, err := s.requirePlan(ctx, code); err != nil {
		return nil, fmt.Errorf("unknown code")
	}
	subscription, err := s.applySubscription(ctx, strings.TrimSpace(externalUserID), normalizeCode(code), "admin-manual")
	if err != nil {
		return nil, err
	}
	return subscription, nil
}

func (s *Service) AdminResync(ctx context.Context, externalUserID string) (*Subscription, error) {
	subscription, err := s.store.GetCurrentByExternalUserID(ctx, strings.TrimSpace(externalUserID))
	if err != nil {
		return nil, err
	}
	if subscription == nil {
		return nil, fmt.Errorf("subscription not found")
	}
	planID := strings.TrimSpace(s.planMappings[normalizeCode(subscription.Code)])
	if planID == "" {
		return nil, fmt.Errorf("unknown code")
	}

	remote, err := s.aiClient.SetSubscriptionByExternalUID(ctx, subscription.ExternalUserID, planID)
	if err != nil {
		return nil, err
	}

	now := s.now().UTC()
	subscription.AIGatewayPlanID = planID
	subscription.AIGatewaySubscriptionID = remote.ID
	subscription.UpdatedAt = now
	if err := s.store.UpsertCurrent(ctx, subscription); err != nil {
		return nil, err
	}
	if err := s.store.AppendEvent(ctx, &SubscriptionEvent{
		ID:             uuid.NewString(),
		SubscriptionID: subscription.ID,
		EventType:      "admin_resynced",
		Code:           subscription.Code,
		Status:         subscription.Status,
		CreatedAt:      now,
	}); err != nil {
		return nil, err
	}
	return subscription, nil
}

func (s *Service) requirePlan(ctx context.Context, code string) (*Plan, error) {
	plan, err := s.store.GetPlanByCode(ctx, normalizeCode(code))
	if err != nil {
		return nil, err
	}
	if plan == nil {
		return nil, fmt.Errorf("unknown code")
	}
	return plan, nil
}

func (s *Service) AdminCancel(ctx context.Context, externalUserID string) (*Subscription, error) {
	subscription, err := s.store.GetCurrentByExternalUserID(ctx, strings.TrimSpace(externalUserID))
	if err != nil {
		return nil, err
	}
	if subscription == nil {
		return nil, fmt.Errorf("subscription not found")
	}

	if err := s.aiClient.CancelSubscriptionByExternalUID(ctx, subscription.ExternalUserID); err != nil {
		return nil, err
	}

	now := s.now().UTC()
	subscription.Status = SubscriptionStatusCancelled
	subscription.UpdatedAt = now
	if err := s.store.UpsertCurrent(ctx, subscription); err != nil {
		return nil, err
	}
	if err := s.store.AppendEvent(ctx, &SubscriptionEvent{
		ID:             uuid.NewString(),
		SubscriptionID: subscription.ID,
		EventType:      "admin_cancelled",
		Code:           subscription.Code,
		Status:         subscription.Status,
		CreatedAt:      now,
	}); err != nil {
		return nil, err
	}
	return subscription, nil
}

func (s *Service) applySubscription(ctx context.Context, externalUserID, code, sourceOrderID string) (*Subscription, error) {
	planID := strings.TrimSpace(s.planMappings[normalizeCode(code)])
	if planID == "" {
		return nil, fmt.Errorf("unknown code")
	}

	current, err := s.store.GetCurrentByExternalUserID(ctx, strings.TrimSpace(externalUserID))
	if err != nil {
		return nil, err
	}
	if current != nil && current.Status == SubscriptionStatusActive && current.Code == normalizeCode(code) && strings.TrimSpace(sourceOrderID) == "" {
		return current, nil
	}

	periodValue, periodUnit, err := subscriptionPeriod(normalizeCode(code))
	if err != nil {
		return nil, err
	}

	start := s.now().UTC()
	if current != nil && current.Status == SubscriptionStatusActive && current.Code == normalizeCode(code) && current.CurrentPeriodEnd != nil && current.CurrentPeriodEnd.After(start) && strings.TrimSpace(sourceOrderID) != "" {
		start = current.CurrentPeriodEnd.UTC()
	}

	end, err := addPeriod(start, periodValue, periodUnit)
	if err != nil {
		return nil, err
	}

	remote, err := s.aiClient.SetSubscriptionByExternalUID(ctx, externalUserID, planID)
	if err != nil {
		return nil, err
	}

	now := s.now().UTC()
	record := &Subscription{
		ExternalUserID:          strings.TrimSpace(externalUserID),
		Code:                    normalizeCode(code),
		Status:                  SubscriptionStatusActive,
		AIGatewayPlanID:         planID,
		AIGatewaySubscriptionID: remote.ID,
		CurrentPeriodStart:      &start,
		CurrentPeriodEnd:        &end,
		SourceOrderID:           strings.TrimSpace(sourceOrderID),
		UpdatedAt:               now,
	}
	if current != nil {
		record.ID = current.ID
		record.CreatedAt = current.CreatedAt
	}
	if record.ID == "" {
		record.ID = uuid.NewString()
		record.CreatedAt = now
	}

	if err := s.store.UpsertCurrent(ctx, record); err != nil {
		return nil, err
	}
	if err := s.store.AppendEvent(ctx, &SubscriptionEvent{
		ID:             uuid.NewString(),
		SubscriptionID: record.ID,
		EventType:      "applied",
		Code:           record.Code,
		Status:         record.Status,
		SourceOrderID:  record.SourceOrderID,
		CreatedAt:      now,
	}); err != nil {
		return nil, err
	}
	return record, nil
}

func addPeriod(start time.Time, value int, unit string) (time.Time, error) {
	switch strings.TrimSpace(unit) {
	case "days":
		return start.AddDate(0, 0, value), nil
	case "months":
		return start.AddDate(0, value, 0), nil
	default:
		return time.Time{}, fmt.Errorf("unsupported period unit %q", unit)
	}
}

func subscriptionPeriod(code string) (int, string, error) {
	switch normalizeCode(code) {
	case "free":
		return 7, "days", nil
	case "lite", "pro":
		return 1, "months", nil
	default:
		return 0, "", fmt.Errorf("unknown code")
	}
}

func normalizeCode(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}
