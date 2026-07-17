package gateway

import (
	"context"
	"time"
)

type SetCapacityPicker interface {
	PickSet(context.Context, func(Set) bool) (Set, bool, error)
	RecordUserAssigned(context.Context, string) error
	RefreshObservedCounts(context.Context) (int, error)
}

type StoreSetCapacityPicker struct {
	store Store
	now   func() time.Time
}

func NewStoreSetCapacityPicker(store Store, now func() time.Time) *StoreSetCapacityPicker {
	return &StoreSetCapacityPicker{store: store, now: now}
}

func (p *StoreSetCapacityPicker) PickSet(ctx context.Context, filter func(Set) bool) (Set, bool, error) {
	sets, err := p.store.ListSets(ctx)
	if err != nil {
		return Set{}, false, err
	}
	counts := projectedUserCountsBySet(sets)
	for {
		set, ok := pickLeastLoadedAcceptingSet(sets, counts, filter)
		if !ok {
			return Set{}, false, nil
		}
		reserved, err := p.store.TryReserveSetUserSlot(ctx, set.ID)
		if err != nil {
			return Set{}, false, err
		}
		if reserved {
			set.ObservedUserCount++
			return set, true, nil
		}
		counts[set.ID] = setCapacitySnapshot(set, counts[set.ID], 0).MaxUsers
	}
}

func (p *StoreSetCapacityPicker) RecordUserAssigned(ctx context.Context, setID string) error {
	return p.store.IncrementSetObservedUserCount(ctx, setID, 1)
}

func (p *StoreSetCapacityPicker) RefreshObservedCounts(ctx context.Context) (int, error) {
	counts, err := p.store.CountUserBindingsBySet(ctx)
	if err != nil {
		return 0, err
	}
	sets, err := p.store.ListSets(ctx)
	if err != nil {
		return 0, err
	}
	now := p.nowUTC()
	updated := 0
	for _, set := range sets {
		set.ObservedUserCount = counts[set.ID]
		set.CapacityUpdatedAt = now
		if err := p.store.SaveSet(ctx, set); err != nil {
			return updated, err
		}
		updated++
	}
	return updated, nil
}

func (p *StoreSetCapacityPicker) nowUTC() time.Time {
	if p != nil && p.now != nil {
		return p.now().UTC()
	}
	return time.Now().UTC()
}

func projectedUserCountsBySet(sets []Set) map[string]int {
	counts := make(map[string]int, len(sets))
	for _, set := range sets {
		if set.ObservedUserCount > 0 {
			counts[set.ID] = set.ObservedUserCount
		}
	}
	return counts
}
