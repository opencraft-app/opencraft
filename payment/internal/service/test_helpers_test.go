package service

import "context"

type memoryStore struct {
	orders map[string]*Order
}

func newMemoryStore() *memoryStore {
	return &memoryStore{orders: make(map[string]*Order)}
}

func (m *memoryStore) CreateOrder(_ context.Context, order *Order) error {
	copy := *order
	m.orders[order.ID] = &copy
	return nil
}

func (m *memoryStore) GetOrderByID(_ context.Context, orderID string) (*Order, error) {
	order := m.orders[orderID]
	if order == nil {
		return nil, nil
	}
	copy := *order
	return &copy, nil
}

func (m *memoryStore) UpdateOrder(_ context.Context, order *Order) error {
	copy := *order
	m.orders[order.ID] = &copy
	return nil
}

type fakeSubscriptionClient struct {
	applyCalls int
}

func (f *fakeSubscriptionClient) ApplyPayment(_ context.Context, _, _, _, _ string) error {
	f.applyCalls++
	return nil
}
