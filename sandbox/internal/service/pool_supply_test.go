package service

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"cvm-mock-e2b/internal/core"
	"cvm-mock-e2b/internal/provider"
	"cvm-mock-e2b/internal/store"
)

type supplyStore struct {
	store.Store
	pools []core.Pool
	rows  []store.PoolSupplyOverview
}

func (s *supplyStore) ListPools(context.Context) ([]core.Pool, error) { return s.pools, nil }
func (s *supplyStore) SyncPoolSupplyOverview(_ context.Context, rows []store.PoolSupplyOverview) error {
	s.rows = rows
	return nil
}

type supplyCall struct {
	region   string
	families []string
	zones    []string
}

type supplyClient struct {
	calls []supplyCall
	query func(region string, families, zones []string) (provider.CVMInventoryBatch, error)
}

func (c *supplyClient) DescribeCVMInventory(_ context.Context, region string, families, zones []string) (provider.CVMInventoryBatch, error) {
	c.calls = append(c.calls, supplyCall{region, append([]string(nil), families...), append([]string(nil), zones...)})
	return c.query(region, families, zones)
}

func TestSyncPoolSupplyOverviewAggregatesSalesAndExactInventory(t *testing.T) {
	s := &supplyStore{pools: []core.Pool{
		{ID: "active", Zone: "ap-shanghai-5", InstanceType: "SA9.MEDIUM8", Status: core.PoolStatusActive},
		{ID: "paused", Zone: "ap-shanghai-5", InstanceType: "SA9.MEDIUM8", Status: core.PoolStatusPaused},
	}}
	count := int64(17)
	c := &supplyClient{query: func(region string, families, zones []string) (provider.CVMInventoryBatch, error) {
		return provider.CVMInventoryBatch{RequestID: "request-1", Items: []provider.CVMInventoryItem{
			{Zone: "ap-shanghai-5", InstanceType: "SA9.MEDIUM2", InstanceChargeType: "POSTPAID_BY_HOUR", InstanceQuota: &count},
			{Zone: "ap-shanghai-5", InstanceType: "SA9.MEDIUM8", InstanceChargeType: "POSTPAID_BY_HOUR", InstanceQuota: &count},
		}}, nil
	}}
	report, err := NewService(s).SyncPoolSupplyOverview(context.Background(), c, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(c.calls) != 1 || c.calls[0].region != "ap-shanghai" || len(c.calls[0].families) != 1 || c.calls[0].families[0] != "SA9" || len(s.rows) != 1 {
		t.Fatalf("calls=%+v rows=%+v", c.calls, s.rows)
	}
	row := s.rows[0]
	if row.SalesState != "active" || row.Inventory == nil || row.Inventory.ResourceCount != 17 || row.Inventory.RequestID != "request-1" || row.Inventory.UpdatedTime.IsZero() || report.Matched != 1 {
		t.Fatalf("unexpected sync result: row=%+v report=%+v", row, report)
	}
}

func TestSyncPoolSupplyOverviewChunksBothFiltersAndKeepsFailedRegionStale(t *testing.T) {
	s := &supplyStore{}
	for i := 1; i <= 6; i++ {
		s.pools = append(s.pools, core.Pool{ID: fmt.Sprint(i), Zone: fmt.Sprintf("ap-shanghai-%d", i), InstanceType: fmt.Sprintf("SA%d.MEDIUM8", i), Status: core.PoolStatusPaused})
	}
	c := &supplyClient{query: func(region string, families, zones []string) (provider.CVMInventoryBatch, error) {
		if len(families) > 5 || len(zones) > 5 {
			t.Fatalf("filter limit exceeded: families=%v zones=%v", families, zones)
		}
		if len(families) == 1 && len(zones) == 1 {
			return provider.CVMInventoryBatch{}, errors.New("batch failed")
		}
		count := int64(9)
		return provider.CVMInventoryBatch{RequestID: "request-ok", Items: []provider.CVMInventoryItem{{Zone: "ap-shanghai-1", InstanceType: "SA1.MEDIUM8", InstanceChargeType: "POSTPAID_BY_HOUR", InstanceQuota: &count}}}, nil
	}}
	report, err := NewService(s).SyncPoolSupplyOverview(context.Background(), c, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(c.calls) != 4 || len(s.rows) != 6 || len(report.Regions) != 1 || report.Regions[0].Success {
		t.Fatalf("unexpected batches or report: calls=%+v rows=%+v report=%+v", c.calls, s.rows, report)
	}
	for _, row := range s.rows {
		if row.SalesState != "pause" || row.Inventory != nil {
			t.Fatalf("failed region should update only sales state: %+v", row)
		}
	}
}

func TestSyncPoolSupplyOverviewMissingExactTypeIsUnknown(t *testing.T) {
	s := &supplyStore{pools: []core.Pool{{ID: "one", Zone: "ap-shanghai-5", InstanceType: "SA9.MEDIUM8", Status: core.PoolStatusActive}}}
	count := int64(9)
	c := &supplyClient{query: func(string, []string, []string) (provider.CVMInventoryBatch, error) {
		return provider.CVMInventoryBatch{Items: []provider.CVMInventoryItem{{Zone: "ap-shanghai-5", InstanceType: "SA9.MEDIUM2", InstanceChargeType: "POSTPAID_BY_HOUR", InstanceQuota: &count}}}, nil
	}}
	report, err := NewService(s).SyncPoolSupplyOverview(context.Background(), c, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(s.rows) != 1 || s.rows[0].Inventory != nil {
		t.Fatalf("family-level match must not set stock: %+v", s.rows)
	}
	if len(report.Regions) != 1 || report.Regions[0].MissingRows != 1 {
		t.Fatalf("missing exact row was not classified: %+v", report)
	}
}

func TestSyncPoolSupplyOverviewKeepsInvalidQuotaUnknownAcrossRegions(t *testing.T) {
	s := &supplyStore{pools: []core.Pool{
		{ID: "shanghai", Zone: "ap-shanghai-5", InstanceType: "SA9.MEDIUM8", Status: core.PoolStatusPaused},
		{ID: "beijing", Zone: "ap-beijing-8", InstanceType: "SA4.MEDIUM8", Status: core.PoolStatusActive},
	}}
	negative := int64(-1)
	c := &supplyClient{query: func(region string, families, zones []string) (provider.CVMInventoryBatch, error) {
		if region == "ap-beijing" {
			return provider.CVMInventoryBatch{}, errors.New("cloud unavailable")
		}
		return provider.CVMInventoryBatch{RequestID: "shanghai-request", Items: []provider.CVMInventoryItem{
			{Zone: "ap-shanghai-5", InstanceType: "SA9.MEDIUM8", InstanceChargeType: "POSTPAID_BY_HOUR", InstanceQuota: &negative},
		}}, nil
	}}
	report, err := NewService(s).SyncPoolSupplyOverview(context.Background(), c, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Regions) != 2 || report.Regions[0].Success || !report.Regions[1].Success || report.Matched != 0 || report.Missing != 1 || report.Regions[1].InvalidQuotas != 1 {
		t.Fatalf("unexpected regional result: %+v", report)
	}
	if len(s.rows) != 2 || s.rows[0].Inventory != nil || s.rows[1].Inventory != nil {
		t.Fatalf("invalid and failed stock must remain unknown: %+v", s.rows)
	}
	if s.rows[0].SalesState != "active" || s.rows[1].SalesState != "pause" {
		t.Fatalf("sales states should still reflect pools: %+v", s.rows)
	}
}

func TestSyncPoolSupplyOverviewRejectsDuplicateRows(t *testing.T) {
	s := &supplyStore{pools: []core.Pool{{ID: "one", Zone: "ap-shanghai-5", InstanceType: "SA9.MEDIUM8", Status: core.PoolStatusActive}}}
	first, second := int64(7), int64(8)
	c := &supplyClient{query: func(string, []string, []string) (provider.CVMInventoryBatch, error) {
		return provider.CVMInventoryBatch{Items: []provider.CVMInventoryItem{
			{Zone: "ap-shanghai-5", InstanceType: "SA9.MEDIUM8", InstanceChargeType: "POSTPAID_BY_HOUR", InstanceQuota: &first},
			{Zone: "ap-shanghai-5", InstanceType: "SA9.MEDIUM8", InstanceChargeType: "POSTPAID_BY_HOUR", InstanceQuota: &second},
		}}, nil
	}}
	report, err := NewService(s).SyncPoolSupplyOverview(context.Background(), c, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(s.rows) != 1 || s.rows[0].Inventory != nil || report.Regions[0].DuplicateRows != 1 {
		t.Fatalf("duplicate cloud rows must not overwrite inventory: rows=%+v report=%+v", s.rows, report)
	}
}

func TestSyncPoolSupplyOverviewReportsInvalidPoolConfig(t *testing.T) {
	s := &supplyStore{pools: []core.Pool{
		{ID: "zone", Zone: "invalid", InstanceType: "SA9.MEDIUM8", Status: core.PoolStatusActive},
		{ID: "type", Zone: "ap-shanghai-5", InstanceType: "SA9", Status: core.PoolStatusActive},
	}}
	report, err := NewService(s).SyncPoolSupplyOverview(context.Background(), nil, "")
	if err != nil {
		t.Fatal(err)
	}
	if report.InvalidPools != 2 || report.InvalidZones != 1 || report.InvalidTypes != 1 || len(s.rows) != 0 {
		t.Fatalf("invalid pools should not be queried or stored: report=%+v rows=%+v", report, s.rows)
	}
}

func TestSyncPoolSupplyOverviewUsesInstanceTypeFallback(t *testing.T) {
	s := &supplyStore{pools: []core.Pool{{ID: "legacy", Zone: "ap-shanghai-5", Status: core.PoolStatusActive}}}
	count := int64(0)
	c := &supplyClient{query: func(region string, families, zones []string) (provider.CVMInventoryBatch, error) {
		if region != "ap-shanghai" || len(families) != 1 || families[0] != "SA9" {
			t.Fatalf("unexpected fallback filters: region=%s families=%v zones=%v", region, families, zones)
		}
		return provider.CVMInventoryBatch{Items: []provider.CVMInventoryItem{{Zone: "ap-shanghai-5", InstanceType: "SA9.MEDIUM8", InstanceChargeType: "POSTPAID_BY_HOUR", InstanceQuota: &count}}}, nil
	}}
	report, err := NewService(s).SyncPoolSupplyOverview(context.Background(), c, "SA9.MEDIUM8")
	if err != nil || report.Matched != 1 || len(s.rows) != 1 || s.rows[0].InstanceType != "SA9.MEDIUM8" || s.rows[0].Inventory == nil || s.rows[0].Inventory.ResourceCount != 0 {
		t.Fatalf("fallback failed: rows=%+v report=%+v err=%v", s.rows, report, err)
	}
}

func TestSyncPoolSupplyOverviewEmptyPoolsClearsSnapshot(t *testing.T) {
	s := &supplyStore{}
	report, err := NewService(s).SyncPoolSupplyOverview(context.Background(), nil, "")
	if err != nil || len(report.Regions) != 0 || len(s.rows) != 0 {
		t.Fatalf("empty pools: report=%+v rows=%+v err=%v", report, s.rows, err)
	}
}
