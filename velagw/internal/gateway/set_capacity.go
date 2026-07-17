package gateway

import (
	"context"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"git.woa.com/wisp/mono2/llmgateway/internal/observability"
	"go.opentelemetry.io/otel/attribute"
)

var nonSetNameChar = regexp.MustCompile(`[^a-zA-Z0-9_]+`)

func (s *Service) ListSetProvisionRequests(ctx context.Context, opts SetProvisionRequestListOptions) ([]SetProvisionRequest, error) {
	opts.Source = strings.TrimSpace(opts.Source)
	opts.Namespace = strings.TrimSpace(opts.Namespace)
	opts.Fleet = strings.TrimSpace(opts.Fleet)
	opts.SetID = strings.TrimSpace(opts.SetID)
	opts.Status = strings.TrimSpace(opts.Status)
	return s.store.ListSetProvisionRequests(ctx, opts)
}

func (s *Service) UpdateSetProvisionRequestStatus(ctx context.Context, id string, status string, lastError string) (SetProvisionRequest, error) {
	id = strings.TrimSpace(id)
	status = strings.TrimSpace(strings.ToLower(status))
	lastError = strings.TrimSpace(lastError)
	if id == "" {
		return SetProvisionRequest{}, fmt.Errorf("request id is required")
	}
	if !validSetProvisionStatus(status) {
		return SetProvisionRequest{}, fmt.Errorf("invalid set provision status %q", status)
	}
	request, ok, err := s.store.GetSetProvisionRequest(ctx, id)
	if err != nil {
		return SetProvisionRequest{}, err
	}
	if !ok {
		return SetProvisionRequest{}, fmt.Errorf("set provision request %q not found", id)
	}
	previousStatus := request.Status
	request.Status = status
	request.LastError = lastError
	request.LastStatusAt = s.nowUTC()
	if err := s.store.SaveSetProvisionRequest(ctx, request); err != nil {
		return SetProvisionRequest{}, err
	}
	s.emitCommittedTransition(ctx, observability.ScopeSetLifecycle, "llmgateway.set.state_changed",
		"set_provision_request", request.ID, previousStatus, request.Status,
		attribute.String("llmgateway.request.id", request.ID),
		attribute.String("llmgateway.set.id", request.SetID),
		attribute.String("llmgateway.shard.id", request.ShardRef),
	)
	stored, _, err := s.store.GetSetProvisionRequest(ctx, id)
	return stored, err
}

func validSetProvisionStatus(status string) bool {
	switch status {
	case SetProvisionStatusPending, SetProvisionStatusProvisioning, SetProvisionStatusCreated,
		SetProvisionStatusConfigured, SetProvisionStatusManaged, SetProvisionStatusError, SetProvisionStatusCancelled:
		return true
	default:
		return false
	}
}

func (s *Service) ReconcileSetCapacity(ctx context.Context, policy SetCapacityPolicy) (SetCapacityResult, error) {
	normalized, err := normalizeSetCapacityPolicy(policy)
	if err != nil {
		return SetCapacityResult{}, err
	}
	sets, err := s.store.ListSets(ctx)
	if err != nil {
		return SetCapacityResult{}, err
	}
	counts := projectedUserCountsBySet(sets)
	requests, err := s.store.ListSetProvisionRequests(ctx, SetProvisionRequestListOptions{
		Source:    normalized.Source,
		Namespace: normalized.Namespace,
		Fleet:     normalized.Fleet,
	})
	if err != nil {
		return SetCapacityResult{}, err
	}
	leases, err := s.store.ListSetRuntimeLeases(ctx, SetRuntimeLeaseListOptions{
		Source:    normalized.Source,
		Namespace: normalized.Namespace,
		Fleet:     normalized.Fleet,
	})
	if err != nil {
		return SetCapacityResult{}, err
	}

	result := SetCapacityResult{Policy: normalized}
	for _, set := range sets {
		userCount := counts[set.ID]
		ready := setReadyForCapacity(set)
		capacity := setCapacitySnapshot(set, userCount, normalized.MaxUsersPerSet)
		if ready {
			result.ReadySets++
			result.ReadyFreeUsers += capacity.FreeUsers
		}
		result.Sets = append(result.Sets, SetCapacitySetSnapshot{
			SetID:             set.ID,
			Status:            set.Status,
			Ready:             ready,
			AcceptingNewUsers: ready && capacity.AcceptingNewUsers,
			CapacityStatus:    capacity.Status,
			UserCount:         userCount,
			FreeUsers:         capacity.FreeUsers,
			MaxUsers:          capacity.MaxUsers,
			WarnUsers:         capacity.WarnUsers,
			ReservedUsers:     capacity.ReservedUsers,
			Utilization:       formatUtilization(userCount, capacity.MaxUsers),
		})
	}
	sort.Slice(result.Sets, func(i, j int) bool { return result.Sets[i].SetID < result.Sets[j].SetID })

	inflightSetIDs := inflightSetProvisionIDs(requests, sets)
	result.InflightRequests = len(inflightSetIDs)
	result.InflightFreeUsers = result.InflightRequests * normalized.MaxUsersPerSet
	result.RequiredFreeUsers = requiredSetFreeUsers(normalized, result.ReadySets)
	result.DeficitUsers = result.RequiredFreeUsers - result.ReadyFreeUsers - result.InflightFreeUsers
	if result.DeficitUsers < 0 {
		result.DeficitUsers = 0
	}

	capacityRequestCount := 0
	if result.DeficitUsers > 0 {
		capacityRequestCount = int(math.Ceil(float64(result.DeficitUsers) / float64(normalized.MaxUsersPerSet)))
	}
	warmSetRequestCount := normalized.MinWarmSets - result.ReadySets - result.InflightRequests
	if warmSetRequestCount < 0 {
		warmSetRequestCount = 0
	}
	requestCount := maxInt(capacityRequestCount, warmSetRequestCount)
	if requestCount == 0 {
		return result, nil
	}
	if requestCount > normalized.MaxScaleUpPerCycle {
		requestCount = normalized.MaxScaleUpPerCycle
	}
	reason := setCapacityProvisionReason(result, warmSetRequestCount)
	existingSetIDs := map[string]bool{}
	for _, set := range sets {
		existingSetIDs[set.ID] = true
	}
	for _, request := range requests {
		existingSetIDs[request.SetID] = true
	}
	for _, lease := range leases {
		existingSetIDs[lease.SetID] = true
	}
	usedRedisDBs := usedRedisDBsByShard(requests, leases)
	shards, err := s.store.ListShards(ctx)
	if err != nil {
		return SetCapacityResult{}, err
	}
	allocations := allocatedSetIDsByShard(sets, requests, leases)
	provisionRingID, provisionRelease, err := s.releaseForNewSet(ctx, normalized.Source, normalized.Namespace, normalized.Fleet)
	if err != nil {
		return SetCapacityResult{}, err
	}
	for i := 0; i < requestCount; i++ {
		nextSetID := nextProvisionSetID(normalized.SetIDPrefix, existingSetIDs)
		existingSetIDs[nextSetID] = true
		shardRef, redisDB, err := chooseShardForProvision(normalized, shards, allocations, usedRedisDBs)
		if err != nil {
			return SetCapacityResult{}, err
		}
		markRedisDBUsed(usedRedisDBs, shardRef, redisDB)
		if allocations[shardRef] == nil {
			allocations[shardRef] = map[string]bool{}
		}
		allocations[shardRef][nextSetID] = true
		request := SetProvisionRequest{
			ID:             setProvisionRequestID(normalized.Source, normalized.Namespace, normalized.Fleet, nextSetID),
			Source:         normalized.Source,
			Namespace:      normalized.Namespace,
			Fleet:          normalized.Fleet,
			SetID:          nextSetID,
			ShardRef:       shardRef,
			DatabaseName:   databaseNameForSet(nextSetID),
			RedisDB:        strconv.Itoa(redisDB),
			ReleaseRingID:  provisionRingID,
			ReleaseID:      provisionRelease.ID,
			ReleaseImage:   provisionRelease.Image,
			Status:         SetProvisionStatusPending,
			Reason:         reason,
			RequestedUsers: result.DeficitUsers,
			MaxUsersPerSet: normalized.MaxUsersPerSet,
		}
		if err := s.store.SaveSetProvisionRequest(ctx, request); err != nil {
			return SetCapacityResult{}, err
		}
		result.CreatedRequests++
		result.Requests = append(result.Requests, request)
	}
	return result, nil
}

func (s *Service) releaseForNewSet(ctx context.Context, source, namespace, fleet string) (string, NewAPIRelease, error) {
	rings, err := s.store.ListReleaseRings(ctx)
	if err != nil {
		return "", NewAPIRelease{}, err
	}
	candidates := make([]ReleaseRing, 0)
	for _, ring := range rings {
		if ring.Source != source || ring.Namespace != namespace || ring.Fleet != fleet || !ring.AdmissionEnabled {
			continue
		}
		if ring.Status == ReleaseRingStatusPaused || ring.Status == ReleaseRingStatusDegraded {
			continue
		}
		candidates = append(candidates, ring)
	}
	if len(candidates) == 0 {
		return "", NewAPIRelease{}, nil
	}
	sort.Slice(candidates, func(i, j int) bool {
		if candidates[i].Ordinal != candidates[j].Ordinal {
			return candidates[i].Ordinal > candidates[j].Ordinal
		}
		return candidates[i].ID < candidates[j].ID
	})
	ring := candidates[0]
	releaseID := ring.ServingReleaseID
	if ring.Status == ReleaseRingStatusRolling && strings.TrimSpace(ring.TargetReleaseID) != "" {
		releaseID = ring.TargetReleaseID
	}
	release, ok, err := s.store.GetNewAPIRelease(ctx, releaseID)
	if err != nil {
		return "", NewAPIRelease{}, err
	}
	if !ok {
		return "", NewAPIRelease{}, fmt.Errorf("release ring %q references missing release %q", ring.ID, releaseID)
	}
	return ring.ID, release, nil
}

type shardProvisionCandidate struct {
	id        string
	allocated int
	maxSets   int
	redisDB   int
}

func chooseShardForProvision(
	policy SetCapacityPolicy,
	shards []Shard,
	allocations map[string]map[string]bool,
	usedRedisDBs map[string]map[int]bool,
) (string, int, error) {
	shardByID := make(map[string]Shard, len(shards))
	for _, shard := range shards {
		shardByID[shard.ID] = shard
	}
	candidates := make([]shardProvisionCandidate, 0, len(policy.ShardRefs))
	var lastRedisErr error
	for _, shardRef := range policy.ShardRefs {
		shard, managed := shardByID[shardRef]
		if managed && shard.Status != "" && shard.Status != ShardStatusActive {
			continue
		}
		allocated := len(allocations[shardRef])
		if managed && shard.MaxSets > 0 && allocated >= shard.MaxSets {
			continue
		}
		redisDB, err := nextProvisionRedisDB(policy, usedRedisDBs[shardRef])
		if err != nil {
			lastRedisErr = fmt.Errorf("no free redis db on shard %s: %w", shardRef, err)
			continue
		}
		candidates = append(candidates, shardProvisionCandidate{id: shardRef, allocated: allocated, maxSets: shard.MaxSets, redisDB: redisDB})
	}
	if len(candidates) == 0 {
		if lastRedisErr != nil {
			return "", 0, lastRedisErr
		}
		return "", 0, fmt.Errorf("no active shard has available Set capacity")
	}
	sort.Slice(candidates, func(i, j int) bool {
		left, right := candidates[i], candidates[j]
		if left.maxSets > 0 && right.maxSets > 0 {
			leftUnits := left.allocated * right.maxSets
			rightUnits := right.allocated * left.maxSets
			if leftUnits != rightUnits {
				return leftUnits < rightUnits
			}
		} else if left.allocated != right.allocated {
			return left.allocated < right.allocated
		}
		if left.allocated != right.allocated {
			return left.allocated < right.allocated
		}
		return left.id < right.id
	})
	return candidates[0].id, candidates[0].redisDB, nil
}

func allocatedSetIDsByShard(sets []Set, requests []SetProvisionRequest, leases []SetRuntimeLease) map[string]map[string]bool {
	result := map[string]map[string]bool{}
	assigned := map[string]bool{}
	add := func(setID string, shardRef string) {
		setID = strings.TrimSpace(setID)
		shardRef = strings.TrimSpace(shardRef)
		if setID == "" || shardRef == "" || assigned[setID] {
			return
		}
		assigned[setID] = true
		if result[shardRef] == nil {
			result[shardRef] = map[string]bool{}
		}
		result[shardRef][setID] = true
	}
	for _, set := range sets {
		add(set.ID, set.ShardID)
	}
	for _, request := range openSetProvisionRequests(requests) {
		add(request.SetID, request.ShardRef)
	}
	for _, lease := range leases {
		add(lease.SetID, lease.ShardRef)
	}
	return result
}

func normalizeSetCapacityPolicy(policy SetCapacityPolicy) (SetCapacityPolicy, error) {
	policy.Source = strings.TrimSpace(policy.Source)
	policy.Namespace = strings.TrimSpace(policy.Namespace)
	policy.Fleet = strings.TrimSpace(policy.Fleet)
	policy.SetIDPrefix = strings.Trim(strings.TrimSpace(policy.SetIDPrefix), "-")
	if policy.Source == "" {
		policy.Source = "kro"
	}
	if policy.Namespace == "" {
		return SetCapacityPolicy{}, fmt.Errorf("namespace is required")
	}
	if policy.Fleet == "" {
		return SetCapacityPolicy{}, fmt.Errorf("fleet is required")
	}
	if policy.MaxUsersPerSet <= 0 {
		policy.MaxUsersPerSet = 10000
	}
	if policy.TargetUtilization <= 0 || policy.TargetUtilization >= 1 {
		policy.TargetUtilization = 0.70
	}
	if policy.MinReadyFreeUsers <= 0 {
		policy.MinReadyFreeUsers = 3000
	}
	if policy.MinWarmSets < 0 {
		policy.MinWarmSets = 0
	}
	if policy.MaxScaleUpPerCycle <= 0 {
		policy.MaxScaleUpPerCycle = 1
	}
	if policy.SetIDPrefix == "" {
		policy.SetIDPrefix = "set-auto"
	}
	if policy.RedisDBStart == nil {
		defaultRedisDBStart := 0
		policy.RedisDBStart = &defaultRedisDBStart
	}
	if policy.RedisDBLimit == nil {
		defaultRedisDBLimit := 256
		policy.RedisDBLimit = &defaultRedisDBLimit
	}
	if *policy.RedisDBStart < 0 {
		return SetCapacityPolicy{}, fmt.Errorf("redis_db_start must be greater than or equal to 0")
	}
	if *policy.RedisDBLimit <= 0 {
		return SetCapacityPolicy{}, fmt.Errorf("redis_db_limit must be greater than 0")
	}
	if *policy.RedisDBStart >= *policy.RedisDBLimit {
		return SetCapacityPolicy{}, fmt.Errorf("redis_db_start must be less than redis_db_limit")
	}
	shards := make([]string, 0, len(policy.ShardRefs))
	seen := map[string]bool{}
	for _, shard := range policy.ShardRefs {
		shard = strings.TrimSpace(shard)
		if shard == "" || seen[shard] {
			continue
		}
		seen[shard] = true
		shards = append(shards, shard)
	}
	if len(shards) == 0 {
		shards = []string{"default"}
	}
	policy.ShardRefs = shards
	return policy, nil
}

func usedRedisDBsByShard(requests []SetProvisionRequest, leases []SetRuntimeLease) map[string]map[int]bool {
	used := map[string]map[int]bool{}
	for _, request := range requests {
		if strings.EqualFold(strings.TrimSpace(request.Status), SetProvisionStatusCancelled) ||
			strings.EqualFold(strings.TrimSpace(request.Status), SetProvisionStatusError) {
			continue
		}
		redisDB, err := strconv.Atoi(strings.TrimSpace(request.RedisDB))
		if err != nil {
			continue
		}
		markRedisDBUsed(used, request.ShardRef, redisDB)
	}
	for _, lease := range leases {
		redisDB, err := strconv.Atoi(strings.TrimSpace(lease.RedisDB))
		if err != nil {
			continue
		}
		markRedisDBUsed(used, lease.ShardRef, redisDB)
	}
	return used
}

func markRedisDBUsed(used map[string]map[int]bool, shardRef string, redisDB int) {
	shardRef = strings.TrimSpace(shardRef)
	if shardRef == "" {
		shardRef = "default"
	}
	if used[shardRef] == nil {
		used[shardRef] = map[int]bool{}
	}
	used[shardRef][redisDB] = true
}

func nextProvisionRedisDB(policy SetCapacityPolicy, used map[int]bool) (int, error) {
	if used == nil {
		used = map[int]bool{}
	}
	redisDBStart, redisDBLimit := setCapacityRedisDBRange(policy)
	for redisDB := redisDBStart; redisDB < redisDBLimit; redisDB++ {
		if !used[redisDB] {
			return redisDB, nil
		}
	}
	return 0, fmt.Errorf("no free redis db in range [%d, %d)", redisDBStart, redisDBLimit)
}

func setCapacityRedisDBRange(policy SetCapacityPolicy) (int, int) {
	redisDBStart := 0
	redisDBLimit := 256
	if policy.RedisDBStart != nil {
		redisDBStart = *policy.RedisDBStart
	}
	if policy.RedisDBLimit != nil {
		redisDBLimit = *policy.RedisDBLimit
	}
	return redisDBStart, redisDBLimit
}

func requiredSetFreeUsers(policy SetCapacityPolicy, readySets int) int {
	byMinFree := policy.MinReadyFreeUsers
	byUtilization := int(math.Ceil(float64(readySets*policy.MaxUsersPerSet) * (1 - policy.TargetUtilization)))
	return maxInt(byMinFree, byUtilization)
}

func setCapacityProvisionReason(result SetCapacityResult, warmSetDeficit int) string {
	reasons := make([]string, 0, 2)
	if result.DeficitUsers > 0 {
		reasons = append(reasons, fmt.Sprintf("ready free users %d below required %d", result.ReadyFreeUsers, result.RequiredFreeUsers))
	}
	if warmSetDeficit > 0 {
		reasons = append(reasons, fmt.Sprintf("ready and inflight sets %d below minimum %d", result.ReadySets+result.InflightRequests, result.Policy.MinWarmSets))
	}
	return strings.Join(reasons, "; ")
}

func setReadyForCapacity(set Set) bool {
	return setReadyForServing(set)
}

func setReadyForServing(set Set) bool {
	if set.Status != SetStatusActive || !set.Setup || set.AdminUserID <= 0 || set.AdminAccessToken == "" {
		return false
	}
	if set.AdminWritesPaused {
		return false
	}
	if set.AdminHealthStatus == SetAdminHealthUnhealthy {
		return false
	}
	switch set.AdmissionStatus {
	case SetAdmissionStatusPassed:
		return true
	case SetAdmissionStatusPending, SetAdmissionStatusFailed:
		return false
	}
	return set.MaxUsers <= 0 && set.WarnUsers <= 0 && set.ReservedUsers <= 0
}

func openSetProvisionRequests(requests []SetProvisionRequest) []SetProvisionRequest {
	result := []SetProvisionRequest{}
	for _, request := range requests {
		if isOpenSetProvisionStatus(request.Status) {
			result = append(result, request)
		}
	}
	return result
}

func inflightSetProvisionIDs(requests []SetProvisionRequest, sets []Set) []string {
	result := make([]string, 0, len(requests)+len(sets))
	seen := map[string]bool{}
	for _, request := range requests {
		inflight := isOpenSetProvisionStatus(request.Status)
		if !inflight || seen[request.SetID] {
			continue
		}
		seen[request.SetID] = true
		result = append(result, request.SetID)
	}
	for _, set := range sets {
		if set.Status != SetStatusActive || seen[set.ID] {
			continue
		}
		switch set.AdmissionStatus {
		case SetAdmissionStatusPending, SetAdmissionStatusChecking:
			seen[set.ID] = true
			result = append(result, set.ID)
		}
	}
	return result
}

func isOpenSetProvisionStatus(status string) bool {
	switch strings.TrimSpace(strings.ToLower(status)) {
	case SetProvisionStatusPending, SetProvisionStatusProvisioning, SetProvisionStatusCreated:
		return true
	case SetProvisionStatusConfigured:
		return true
	default:
		return false
	}
}

func setProvisionRequestMatchesOptions(request SetProvisionRequest, opts SetProvisionRequestListOptions) bool {
	if opts.Source != "" && request.Source != opts.Source {
		return false
	}
	if opts.Namespace != "" && request.Namespace != opts.Namespace {
		return false
	}
	if opts.Fleet != "" && request.Fleet != opts.Fleet {
		return false
	}
	if opts.SetID != "" && request.SetID != opts.SetID {
		return false
	}
	if opts.Status != "" && request.Status != opts.Status {
		return false
	}
	return true
}

func nextProvisionSetID(prefix string, existing map[string]bool) string {
	for i := 1; ; i++ {
		setID := fmt.Sprintf("%s-%06d", prefix, i)
		if !existing[setID] {
			return setID
		}
	}
}

func setProvisionRequestID(source string, namespace string, fleet string, setID string) string {
	return strings.Join([]string{source, namespace, fleet, setID}, ":")
}

func databaseNameForSet(setID string) string {
	name := nonSetNameChar.ReplaceAllString(setID, "_")
	name = strings.Trim(name, "_")
	if name == "" {
		name = "set"
	}
	return "newapi_" + strings.ToLower(name)
}

func formatUtilization(userCount int, maxUsers int) string {
	if maxUsers <= 0 {
		return "0.0000"
	}
	return fmt.Sprintf("%.4f", float64(userCount)/float64(maxUsers))
}

func maxInt(a int, b int) int {
	if a > b {
		return a
	}
	return b
}

type setCapacity struct {
	MaxUsers          int
	WarnUsers         int
	ReservedUsers     int
	FreeUsers         int
	AcceptingNewUsers bool
	Status            string
}

func setCapacitySnapshot(set Set, userCount int, fallbackMaxUsers int) setCapacity {
	maxUsers := set.MaxUsers
	if maxUsers <= 0 {
		maxUsers = fallbackMaxUsers
	}
	if maxUsers < 0 {
		maxUsers = 0
	}
	warnUsers := set.WarnUsers
	if warnUsers < 0 {
		warnUsers = 0
	}
	reservedUsers := set.ReservedUsers
	if reservedUsers < 0 {
		reservedUsers = 0
	}
	capacity := setCapacity{
		MaxUsers:      maxUsers,
		WarnUsers:     warnUsers,
		ReservedUsers: reservedUsers,
		Status:        "ok",
	}
	if maxUsers <= 0 {
		capacity.Status = "unlimited"
		capacity.AcceptingNewUsers = true
		return capacity
	}
	capacity.FreeUsers = maxUsers - userCount - reservedUsers
	if capacity.FreeUsers < 0 {
		capacity.FreeUsers = 0
	}
	capacity.AcceptingNewUsers = capacity.FreeUsers > 0
	switch {
	case !capacity.AcceptingNewUsers:
		capacity.Status = "full"
	case warnUsers > 0 && userCount >= warnUsers:
		capacity.Status = "warn"
	default:
		capacity.Status = "ok"
	}
	return capacity
}

func setAcceptsNewUsers(set Set, userCount int) bool {
	if !setReadyForCapacity(set) {
		return false
	}
	return setCapacitySnapshot(set, userCount, 0).AcceptingNewUsers
}

func pickLeastLoadedAcceptingSet(sets []Set, counts map[string]int, filter func(Set) bool) (Set, bool) {
	return pickLeastLoadedSet(sets, counts, false, func(set Set) bool {
		if filter != nil && !filter(set) {
			return false
		}
		return setAcceptsNewUsers(set, counts[set.ID])
	})
}

func pickLeastLoadedSet(sets []Set, counts map[string]int, readyPreferred bool, filter func(Set) bool) (Set, bool) {
	candidates := make([]Set, 0, len(sets))
	for _, set := range sets {
		if filter != nil && !filter(set) {
			continue
		}
		candidates = append(candidates, set)
	}
	if len(candidates) == 0 {
		return Set{}, false
	}
	if readyPreferred {
		ready := make([]Set, 0, len(candidates))
		for _, set := range candidates {
			if setReadyForCapacity(set) {
				ready = append(ready, set)
			}
		}
		if len(ready) > 0 {
			candidates = ready
		}
	}
	sort.Slice(candidates, func(i, j int) bool {
		leftCount := counts[candidates[i].ID]
		rightCount := counts[candidates[j].ID]
		if leftCount != rightCount {
			return leftCount < rightCount
		}
		return candidates[i].ID < candidates[j].ID
	})
	return candidates[0], true
}
