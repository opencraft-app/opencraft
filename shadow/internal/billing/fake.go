package billing

import (
	"context"
	"fmt"
	"sync/atomic"
)

type FakeProvider struct {
	seq atomic.Int64
}

func NewFakeProvider() *FakeProvider {
	return &FakeProvider{}
}

func (p *FakeProvider) CreateFreeTrialOrderAndPay(_ context.Context, in FreeTrialOrderInput) (FreeTrialOrderResult, error) {
	id := p.seq.Add(1)
	return FreeTrialOrderResult{
		BigDealID:  fmt.Sprintf("bigdeal-%06d", id),
		DealName:   fmt.Sprintf("deal-%06d", id),
		InstanceID: fmt.Sprintf("ins-%06d", id),
	}, nil
}
