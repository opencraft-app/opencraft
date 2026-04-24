package service

import "context"

type memoryStore struct {
	current *Subscription
	events  []*SubscriptionEvent
	plans   map[string]*Plan
}

func newMemoryStore() *memoryStore {
	return &memoryStore{
		plans: make(map[string]*Plan),
	}
}

func (m *memoryStore) GetPlanByCode(_ context.Context, code string) (*Plan, error) {
	plan, ok := m.plans[code]
	if !ok {
		return nil, nil
	}
	copy := *plan
	return &copy, nil
}

func (m *memoryStore) ListPlans(_ context.Context) ([]Plan, error) {
	items := make([]Plan, 0, len(m.plans))
	for _, plan := range m.plans {
		copy := *plan
		items = append(items, copy)
	}
	return items, nil
}

func (m *memoryStore) UpsertPlan(_ context.Context, plan *Plan) error {
	copy := *plan
	m.plans[plan.Code] = &copy
	return nil
}

func (m *memoryStore) DeletePlan(_ context.Context, code string) error {
	delete(m.plans, code)
	return nil
}

func (m *memoryStore) GetCurrentByExternalUserID(_ context.Context, externalUserID string) (*Subscription, error) {
	if m.current == nil || m.current.ExternalUserID != externalUserID {
		return nil, nil
	}
	copy := *m.current
	return &copy, nil
}

func (m *memoryStore) UpsertCurrent(_ context.Context, subscription *Subscription) error {
	copy := *subscription
	m.current = &copy
	return nil
}

func (m *memoryStore) AppendEvent(_ context.Context, event *SubscriptionEvent) error {
	copy := *event
	m.events = append(m.events, &copy)
	return nil
}

func (m *memoryStore) ListSubscriptions(_ context.Context, filter AdminListFilter) ([]Subscription, error) {
	items := make([]Subscription, 0, 1)
	if m.current == nil {
		return items, nil
	}
	current := *m.current
	if filter.ExternalUserID != "" && current.ExternalUserID != filter.ExternalUserID {
		return items, nil
	}
	if filter.Status != "" && current.Status != filter.Status {
		return items, nil
	}
	if filter.Code != "" && current.Code != filter.Code {
		return items, nil
	}
	if filter.Search != "" && current.ExternalUserID != filter.Search {
		return items, nil
	}
	items = append(items, current)
	return items, nil
}

func (m *memoryStore) ListEventsByExternalUserID(_ context.Context, externalUserID string, limit int) ([]SubscriptionEvent, error) {
	if m.current == nil || m.current.ExternalUserID != externalUserID {
		return nil, nil
	}
	items := make([]SubscriptionEvent, 0, len(m.events))
	for _, event := range m.events {
		if event.SubscriptionID == m.current.ID {
			copy := *event
			items = append(items, copy)
		}
	}
	if limit > 0 && len(items) > limit {
		items = items[:limit]
	}
	return items, nil
}

type fakePaymentClient struct {
	createOrderResult *PaymentOrder
}

func (f *fakePaymentClient) CreateOrder(_ context.Context, externalUserID, code string) (*PaymentOrder, error) {
	if f.createOrderResult != nil {
		copy := *f.createOrderResult
		copy.ExternalUserID = externalUserID
		copy.Code = code
		return &copy, nil
	}
	return &PaymentOrder{}, nil
}

type fakeAIGatewayClient struct {
	setCalls       int
	cancelCalls    int
	lastExternalID string
	lastPlanID     string
}

func (f *fakeAIGatewayClient) SetSubscriptionByExternalUID(_ context.Context, externalUserID, planID string) (*AIGatewaySubscription, error) {
	f.setCalls++
	f.lastExternalID = externalUserID
	f.lastPlanID = planID
	return &AIGatewaySubscription{
		ID:     "ai-sub-" + planID,
		UserID: "ai-user",
		PlanID: planID,
		Status: SubscriptionStatusActive,
	}, nil
}

func (f *fakeAIGatewayClient) CancelSubscriptionByExternalUID(_ context.Context, externalUserID string) error {
	f.cancelCalls++
	f.lastExternalID = externalUserID
	return nil
}
