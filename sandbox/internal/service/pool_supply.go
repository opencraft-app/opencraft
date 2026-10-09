package service

import (
	"context"
	"sort"
	"strings"
	"time"

	"cvm-mock-e2b/internal/core"
	"cvm-mock-e2b/internal/provider"
	"cvm-mock-e2b/internal/store"
)

const poolSupplyBatchSize = 5
const poolSupplyRequestTimeout = 30 * time.Second

type PoolSupplyRegionResult struct {
	Region           string
	BatchesPlanned   int
	BatchesSucceeded int
	Matched          int
	Missing          int
	MissingRows      int
	InvalidQuotas    int
	DuplicateRows    int
	Success          bool
	Error            string
	RequestIDs       []string
	Duration         time.Duration
	UpdatedTime      *time.Time
}

type PoolSupplySyncReport struct {
	Regions      []PoolSupplyRegionResult
	Matched      int
	Missing      int
	InvalidPools int
	InvalidZones int
	InvalidTypes int
}

type supplyKey struct {
	region       string
	zone         string
	instanceType string
}

type supplyRegion struct {
	zones    map[string]struct{}
	families map[string]struct{}
}

type supplyObservation struct {
	count     int64
	requestID string
}

func (s *Service) SyncPoolSupplyOverview(ctx context.Context, client provider.CVMInventoryClient, fallbackType string) (PoolSupplySyncReport, error) {
	pools, err := s.store.ListPools(ctx)
	if err != nil {
		return PoolSupplySyncReport{}, err
	}
	report := PoolSupplySyncReport{}
	byKey := make(map[supplyKey]string)
	regions := make(map[string]*supplyRegion)
	for _, pool := range pools {
		region, err := core.RegionFromZone(pool.Zone)
		if err != nil {
			report.InvalidPools++
			report.InvalidZones++
			continue
		}
		instanceType := strings.TrimSpace(pool.InstanceType)
		if instanceType == "" {
			instanceType = strings.TrimSpace(fallbackType)
		}
		family, suffix, hasDot := strings.Cut(instanceType, ".")
		if !hasDot || family == "" || suffix == "" {
			report.InvalidPools++
			report.InvalidTypes++
			continue
		}
		key := supplyKey{region, strings.TrimSpace(pool.Zone), instanceType}
		if _, ok := byKey[key]; !ok {
			byKey[key] = "pause"
		}
		if pool.Status == core.PoolStatusActive {
			byKey[key] = "active"
		}
		group := regions[region]
		if group == nil {
			group = &supplyRegion{zones: make(map[string]struct{}), families: make(map[string]struct{})}
			regions[region] = group
		}
		group.zones[key.zone] = struct{}{}
		group.families[family] = struct{}{}
	}

	rows := make(map[supplyKey]store.PoolSupplyOverview, len(byKey))
	for key, state := range byKey {
		rows[key] = store.PoolSupplyOverview{Region: key.region, Zone: key.zone, InstanceType: key.instanceType, SalesState: state}
	}
	regionNames := make([]string, 0, len(regions))
	for region := range regions {
		regionNames = append(regionNames, region)
	}
	sort.Strings(regionNames)
	for _, region := range regionNames {
		started := time.Now()
		group := regions[region]
		zones := sortedSupplyValues(group.zones)
		families := sortedSupplyValues(group.families)
		result := PoolSupplyRegionResult{Region: region, BatchesPlanned: ((len(zones) + poolSupplyBatchSize - 1) / poolSupplyBatchSize) * ((len(families) + poolSupplyBatchSize - 1) / poolSupplyBatchSize)}
		observations := make(map[supplyKey]supplyObservation)
		invalid := make(map[supplyKey]string)
		seen := make(map[supplyKey]struct{})
		for zi := 0; zi < len(zones); zi += poolSupplyBatchSize {
			zoneBatch := zones[zi:min(zi+poolSupplyBatchSize, len(zones))]
			for fi := 0; fi < len(families); fi += poolSupplyBatchSize {
				familyBatch := families[fi:min(fi+poolSupplyBatchSize, len(families))]
				if client == nil {
					result.Error = "CVM inventory client unavailable"
					continue
				}
				callCtx, cancel := context.WithTimeout(ctx, poolSupplyRequestTimeout)
				batch, callErr := client.DescribeCVMInventory(callCtx, region, familyBatch, zoneBatch)
				cancel()
				if callErr != nil {
					if result.Error == "" {
						result.Error = callErr.Error()
					}
					continue
				}
				result.BatchesSucceeded++
				if batch.RequestID != "" {
					result.RequestIDs = append(result.RequestIDs, batch.RequestID)
				}
				for _, item := range batch.Items {
					if item.InstanceChargeType != "POSTPAID_BY_HOUR" {
						continue
					}
					key := supplyKey{region, item.Zone, item.InstanceType}
					if _, wanted := rows[key]; !wanted {
						continue
					}
					if _, duplicate := seen[key]; duplicate {
						delete(observations, key)
						invalid[key] = "duplicate"
						continue
					}
					seen[key] = struct{}{}
					if item.InstanceQuota == nil || *item.InstanceQuota < 0 {
						invalid[key] = "invalid_quota"
						continue
					}
					if _, bad := invalid[key]; !bad {
						observations[key] = supplyObservation{count: *item.InstanceQuota, requestID: batch.RequestID}
					}
				}
			}
		}
		result.Success = result.Error == "" && result.BatchesSucceeded == result.BatchesPlanned
		if result.Success {
			updated := time.Now().UTC()
			result.UpdatedTime = &updated
			for key, row := range rows {
				if key.region != region {
					continue
				}
				if observation, ok := observations[key]; ok {
					row.Inventory = &store.PoolSupplyInventory{ResourceCount: observation.count, RequestID: observation.requestID, UpdatedTime: updated}
					rows[key] = row
					result.Matched++
				} else {
					result.Missing++
					switch invalid[key] {
					case "duplicate":
						result.DuplicateRows++
					case "invalid_quota":
						result.InvalidQuotas++
					default:
						result.MissingRows++
					}
				}
			}
		}
		result.Duration = time.Since(started)
		report.Matched += result.Matched
		report.Missing += result.Missing
		report.Regions = append(report.Regions, result)
	}
	keys := make([]supplyKey, 0, len(rows))
	for key := range rows {
		keys = append(keys, key)
	}
	sort.Slice(keys, func(i, j int) bool {
		if keys[i].region != keys[j].region {
			return keys[i].region < keys[j].region
		}
		if keys[i].zone != keys[j].zone {
			return keys[i].zone < keys[j].zone
		}
		return keys[i].instanceType < keys[j].instanceType
	})
	snapshot := make([]store.PoolSupplyOverview, 0, len(keys))
	for _, key := range keys {
		snapshot = append(snapshot, rows[key])
	}
	if err := s.store.SyncPoolSupplyOverview(ctx, snapshot); err != nil {
		return report, err
	}
	return report, nil
}

func sortedSupplyValues(set map[string]struct{}) []string {
	values := make([]string, 0, len(set))
	for value := range set {
		values = append(values, value)
	}
	sort.Strings(values)
	return values
}
