package store

import (
	"context"
	"fmt"
	"time"
)

type PoolSupplyInventory struct {
	ResourceCount int64
	RequestID     string
	UpdatedTime   time.Time
}

type PoolSupplyOverview struct {
	Region       string
	Zone         string
	InstanceType string
	SalesState   string
	// Nil means no fresh cloud observation; an existing inventory is preserved.
	Inventory *PoolSupplyInventory
}

type poolSupplyKey struct {
	region       string
	zone         string
	instanceType string
}

func validatePoolSupplyRows(rows []PoolSupplyOverview) error {
	seen := make(map[poolSupplyKey]struct{}, len(rows))
	for _, row := range rows {
		key := poolSupplyKey{row.Region, row.Zone, row.InstanceType}
		if row.Region == "" || row.Zone == "" || row.InstanceType == "" {
			return fmt.Errorf("pool supply key has empty component: %+v", key)
		}
		if row.SalesState != "active" && row.SalesState != "pause" {
			return fmt.Errorf("invalid pool supply sales_state %q", row.SalesState)
		}
		if row.Inventory != nil && (row.Inventory.ResourceCount < 0 || row.Inventory.UpdatedTime.IsZero()) {
			return fmt.Errorf("invalid pool supply inventory for %+v", key)
		}
		if _, ok := seen[key]; ok {
			return fmt.Errorf("duplicate pool supply key: %+v", key)
		}
		seen[key] = struct{}{}
	}
	return nil
}

func (s *MemoryStore) SyncPoolSupplyOverview(_ context.Context, rows []PoolSupplyOverview) error {
	if err := validatePoolSupplyRows(rows); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	next := make(map[poolSupplyKey]PoolSupplyOverview, len(rows))
	for _, row := range rows {
		key := poolSupplyKey{row.Region, row.Zone, row.InstanceType}
		if row.Inventory == nil {
			row.Inventory = s.supplyOverview[key].Inventory
		}
		if row.Inventory != nil {
			inventory := *row.Inventory
			row.Inventory = &inventory
		}
		next[key] = row
	}
	s.supplyOverview = next
	return nil
}
