package gateway

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

const (
	apiKeyRouteRebuildCursorVersion = 1
	defaultAPIKeyRouteRebuildBatch  = 1000
	activeAPIKeyRouteRebuildDelay   = 1
	idleAPIKeyRouteRebuildInterval  = 3600
)

type apiKeyRouteRebuildCursor struct {
	Version         int       `json:"v"`
	AfterKeyID      string    `json:"after_key_id,omitempty"`
	ThroughKeyID    string    `json:"through_key_id"`
	CycleStartedAt  time.Time `json:"cycle_started_at"`
	Restored        int       `json:"restored"`
	RuntimeRestored int       `json:"runtime_restored"`
}

type apiKeyRouteRebuildResult struct {
	Restored        int
	RuntimeRestored int
	Completed       bool
	AfterKeyID      string
}

func encodeAPIKeyRouteRebuildCursor(cursor apiKeyRouteRebuildCursor) string {
	raw, err := json.Marshal(cursor)
	if err != nil {
		return ""
	}
	return base64.RawURLEncoding.EncodeToString(raw)
}

func decodeAPIKeyRouteRebuildCursor(value string) (apiKeyRouteRebuildCursor, bool) {
	value = strings.TrimSpace(value)
	if value == "" {
		return apiKeyRouteRebuildCursor{}, false
	}
	raw, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return apiKeyRouteRebuildCursor{}, false
	}
	var cursor apiKeyRouteRebuildCursor
	if err := json.Unmarshal(raw, &cursor); err != nil || cursor.Version != apiKeyRouteRebuildCursorVersion || strings.TrimSpace(cursor.ThroughKeyID) == "" {
		return apiKeyRouteRebuildCursor{}, false
	}
	return cursor, true
}

func (s *Service) rebuildAPIKeyRoutesJob(ctx context.Context, job *WorkerJob, limit int) (apiKeyRouteRebuildResult, error) {
	if s.options.KeyRouteCache == nil {
		return apiKeyRouteRebuildResult{}, fmt.Errorf("key route cache is required")
	}
	if limit <= 0 || limit > 5000 {
		limit = defaultAPIKeyRouteRebuildBatch
	}

	cursor, continuing := decodeAPIKeyRouteRebuildCursor(job.Cursor)
	if strings.TrimSpace(job.Cursor) != "" && !continuing {
		return apiKeyRouteRebuildResult{}, fmt.Errorf("invalid api key route rebuild cursor")
	}
	if !continuing {
		runtimeRestored, err := s.BackfillLegacySetRuntimeRoutes(ctx, 0)
		if err != nil {
			return apiKeyRouteRebuildResult{}, fmt.Errorf("restore set runtime routes: %w", err)
		}
		watermark, err := s.store.GetAPIKeyRouteRecoveryWatermark(ctx)
		if err != nil {
			return apiKeyRouteRebuildResult{}, fmt.Errorf("read api key route recovery watermark: %w", err)
		}
		if watermark == "" {
			job.Cursor = ""
			job.IntervalSeconds = idleAPIKeyRouteRebuildInterval
			return apiKeyRouteRebuildResult{RuntimeRestored: runtimeRestored, Completed: true}, nil
		}
		cursor = apiKeyRouteRebuildCursor{
			Version: apiKeyRouteRebuildCursorVersion, ThroughKeyID: watermark,
			CycleStartedAt: s.nowUTC(), RuntimeRestored: runtimeRestored,
		}
	}

	records, err := s.store.ListAPIKeyRouteRecoveryRecords(ctx, cursor.AfterKeyID, cursor.ThroughKeyID, limit)
	if err != nil {
		return apiKeyRouteRebuildResult{}, fmt.Errorf("list api key route recovery page: %w", err)
	}
	sets, err := s.store.ListSets(ctx)
	if err != nil {
		return apiKeyRouteRebuildResult{}, fmt.Errorf("list sets for api key route recovery: %w", err)
	}
	setsByID := make(map[string]Set, len(sets))
	for _, set := range sets {
		setsByID[set.ID] = set
	}

	for _, record := range records {
		set, ok := setsByID[record.Binding.SetID]
		if !ok {
			job.Cursor = encodeAPIKeyRouteRebuildCursor(cursor)
			job.IntervalSeconds = activeAPIKeyRouteRebuildDelay
			return apiKeyRouteRebuildResult{Restored: cursor.Restored, RuntimeRestored: cursor.RuntimeRestored, AfterKeyID: cursor.AfterKeyID}, fmt.Errorf("set %q not found for api key %q", record.Binding.SetID, record.Binding.ExternalKeyID)
		}
		snapshot, err := s.buildRecoveredTrafficRouteSnapshot(record, set)
		if err == nil {
			err = s.options.KeyRouteCache.SetRoute(ctx, snapshot)
		}
		if err == nil {
			err = verifyRecoveredTrafficRoute(ctx, s.options.KeyRouteCache, snapshot)
		}
		if err != nil {
			job.Cursor = encodeAPIKeyRouteRebuildCursor(cursor)
			job.IntervalSeconds = activeAPIKeyRouteRebuildDelay
			return apiKeyRouteRebuildResult{Restored: cursor.Restored, RuntimeRestored: cursor.RuntimeRestored, AfterKeyID: cursor.AfterKeyID}, fmt.Errorf("restore api key route %q: %w", record.Binding.ExternalKeyID, err)
		}
		cursor.AfterKeyID = record.Binding.ExternalKeyID
		cursor.Restored++
	}

	completed := len(records) < limit || cursor.AfterKeyID == cursor.ThroughKeyID
	if completed {
		job.Cursor = ""
		job.IntervalSeconds = idleAPIKeyRouteRebuildInterval
	} else {
		job.Cursor = encodeAPIKeyRouteRebuildCursor(cursor)
		job.IntervalSeconds = activeAPIKeyRouteRebuildDelay
	}
	return apiKeyRouteRebuildResult{
		Restored: cursor.Restored, RuntimeRestored: cursor.RuntimeRestored,
		Completed: completed, AfterKeyID: cursor.AfterKeyID,
	}, nil
}

func (s *Service) buildRecoveredTrafficRouteSnapshot(record TrafficRouteRecoveryRecord, set Set) (TrafficRouteSnapshot, error) {
	binding := record.Binding
	if binding.KeyVersion != externalKeyVersionV2 || strings.TrimSpace(binding.ExternalKeyID) == "" || strings.TrimSpace(binding.SecretHash) == "" {
		return TrafficRouteSnapshot{}, fmt.Errorf("api key has no valid v2 route identity")
	}
	upstreamKey := binding.UpstreamKey
	upstreamKeyID := binding.UpstreamKeyID
	routeMode := LLMRoutePlatformFirst
	if normalizeLLMRouteMode(record.BYOKRoutingMode) == LLMRouteBYOKFirst && strings.TrimSpace(record.BYOKUpstreamKey) != "" {
		upstreamKey = record.BYOKUpstreamKey
		upstreamKeyID = record.BYOKUpstreamKeyID
		routeMode = LLMRouteBYOKFirst
	}
	enabled := set.Status != SetStatusDisabled
	if binding.UserID != "" && (record.TenantBackend == UserBackendPending || record.TenantStatus != TenantStatusActive) {
		enabled = false
	}
	return TrafficRouteSnapshot{
		ExternalKeyHash: binding.ExternalKeyHash, ExternalKeyID: binding.ExternalKeyID,
		SecretHash: binding.SecretHash, KeyVersion: binding.KeyVersion, RouteSlot: binding.RouteSlot,
		SetID: binding.SetID, SetBaseURL: trafficBaseURLForSet(set), UserID: binding.UserID,
		UpstreamKey: upstreamKey, UpstreamKeyID: upstreamKeyID,
		PlatformKey: binding.UpstreamKey, PlatformKeyID: binding.UpstreamKeyID,
		RouteMode: routeMode, Enabled: enabled, CreatedAt: binding.CreatedAt, UpdatedAt: s.nowUTC(),
	}, nil
}

func verifyRecoveredTrafficRoute(ctx context.Context, cache APIKeyRouteCache, want TrafficRouteSnapshot) error {
	got, ok, err := cache.GetRoute(ctx, TrafficRouteLookup{
		ExternalKeyHash: want.ExternalKeyHash, ExternalKeyID: want.ExternalKeyID,
		SecretHash: want.SecretHash, Version: want.KeyVersion, RouteSlot: want.RouteSlot, Valid: true,
	})
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("route missing after publish")
	}
	if got.ExternalKeyID != want.ExternalKeyID || got.SetID != want.SetID || got.UpstreamKey != want.UpstreamKey || got.PlatformKey != want.PlatformKey || got.RouteMode != want.RouteMode || got.Enabled != want.Enabled {
		return fmt.Errorf("route differs after publish")
	}
	return nil
}
