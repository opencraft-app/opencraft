package store

import (
	"context"
	"errors"
	"strings"
	"sync"
	"time"

	"cvm-mock-e2b/internal/core"
)

// MemoryStore is a threadsafe in-memory implementation of Store.
type MemoryStore struct {
	mu                  sync.RWMutex
	pools               map[string]core.Pool
	instances           map[string]core.Instance
	sandboxes           map[string]core.Sandbox
	templateClasses     map[string]core.TemplateClass
	skus                map[string]core.SKU
	templateSKUs        map[string]map[string]core.TemplateSkuBinding
	templateBindings    map[string]map[string]core.TemplatePoolBinding
	autoscalePolicy     map[string]core.PoolAutoscalePolicy
	capacityBundles     map[string]core.CapacityBundle
	vpcShards           map[string]core.VPCShard
	vpcShardSubnets     map[string]map[string]core.VPCShardSubnet
	vpcShardBlueprints  map[string]core.VPCShardBlueprintSnapshot
	vpcShardProgress    map[string]core.VPCShardProvisionProgress
	vpcShardCreateLocks map[string]core.VPCShardCreateLock
	vpcShardCleanup     map[string]map[string]core.VPCShardCleanupResource
}

// NewMemoryStore constructs an empty store.
func NewMemoryStore() *MemoryStore {
	return &MemoryStore{
		pools:               make(map[string]core.Pool),
		instances:           make(map[string]core.Instance),
		sandboxes:           make(map[string]core.Sandbox),
		templateClasses:     make(map[string]core.TemplateClass),
		skus:                make(map[string]core.SKU),
		templateSKUs:        make(map[string]map[string]core.TemplateSkuBinding),
		templateBindings:    make(map[string]map[string]core.TemplatePoolBinding),
		autoscalePolicy:     make(map[string]core.PoolAutoscalePolicy),
		capacityBundles:     make(map[string]core.CapacityBundle),
		vpcShards:           make(map[string]core.VPCShard),
		vpcShardSubnets:     make(map[string]map[string]core.VPCShardSubnet),
		vpcShardBlueprints:  make(map[string]core.VPCShardBlueprintSnapshot),
		vpcShardProgress:    make(map[string]core.VPCShardProvisionProgress),
		vpcShardCreateLocks: make(map[string]core.VPCShardCreateLock),
		vpcShardCleanup:     make(map[string]map[string]core.VPCShardCleanupResource),
	}
}

func (s *MemoryStore) CreatePool(_ context.Context, pool core.Pool) (core.Pool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pools[pool.ID] = pool
	return pool, nil
}

func (s *MemoryStore) GetPool(_ context.Context, id string) (core.Pool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	pool, ok := s.pools[id]
	if !ok {
		return core.Pool{}, core.ErrPoolNotFound
	}
	return pool, nil
}

func (s *MemoryStore) UpdatePool(_ context.Context, pool core.Pool) (core.Pool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.pools[pool.ID]; !ok {
		return core.Pool{}, core.ErrPoolNotFound
	}
	s.pools[pool.ID] = pool
	return pool, nil
}

func (s *MemoryStore) ListPools(_ context.Context) ([]core.Pool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	items := make([]core.Pool, 0, len(s.pools))
	for _, p := range s.pools {
		items = append(items, p)
	}
	return items, nil
}

func (s *MemoryStore) ListPoolsByIDs(_ context.Context, ids []string) ([]core.Pool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	items := make([]core.Pool, 0, len(ids))
	for _, id := range ids {
		pool, ok := s.pools[id]
		if !ok {
			continue
		}
		items = append(items, pool)
	}
	return items, nil
}

func (s *MemoryStore) AddInstances(_ context.Context, poolID string, instances []core.Instance) ([]core.Instance, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.pools[poolID]; !ok {
		return nil, core.ErrPoolNotFound
	}
	for _, inst := range instances {
		s.instances[inst.ID] = inst
	}
	return instances, nil
}

func (s *MemoryStore) ListInstances(_ context.Context, poolID string) ([]core.Instance, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if _, ok := s.pools[poolID]; !ok {
		return nil, core.ErrPoolNotFound
	}
	var res []core.Instance
	for _, inst := range s.instances {
		if inst.PoolID == poolID {
			res = append(res, inst)
		}
	}
	return res, nil
}

func (s *MemoryStore) ListInstancesByStates(ctx context.Context, poolID string, states []core.InstanceState, limit int) ([]core.Instance, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if _, ok := s.pools[poolID]; !ok {
		return nil, core.ErrPoolNotFound
	}
	if len(states) == 0 {
		return []core.Instance{}, nil
	}
	set := make(map[core.InstanceState]struct{}, len(states))
	for _, st := range states {
		set[st] = struct{}{}
	}
	total, index, shardOK := shardFromContext(ctx)
	res := make([]core.Instance, 0)
	for _, inst := range s.instances {
		if inst.PoolID != poolID {
			continue
		}
		if _, ok := set[inst.State]; !ok {
			continue
		}
		if shardOK && !shardMatch(inst.ID, total, index) {
			continue
		}
		res = append(res, inst)
		if limit > 0 && len(res) >= limit {
			break
		}
	}
	return res, nil
}

func (s *MemoryStore) GetInstance(_ context.Context, id string) (core.Instance, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	inst, ok := s.instances[id]
	if !ok {
		return core.Instance{}, core.ErrInstanceNotFound
	}
	return inst, nil
}

func (s *MemoryStore) ClaimCleanInstance(_ context.Context, poolID string) (core.Instance, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.pools[poolID]; !ok {
		return core.Instance{}, core.ErrPoolNotFound
	}
	for id, inst := range s.instances {
		if inst.PoolID == poolID && inst.State == core.StateClean {
			inst.State = core.StateAllocated
			inst.UpdatedAt = nowUTC()
			s.instances[id] = inst
			return inst, nil
		}
	}
	return core.Instance{}, core.ErrNoCleanInstance
}

func (s *MemoryStore) UpdateInstanceState(_ context.Context, id string, expected core.InstanceState, target core.InstanceState) (core.Instance, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	inst, ok := s.instances[id]
	if !ok {
		return core.Instance{}, core.ErrInstanceNotFound
	}
	if inst.State != expected {
		return core.Instance{}, core.ErrInvalidTransition
	}
	inst.State = target
	inst.UpdatedAt = nowUTC()
	s.instances[id] = inst
	return inst, nil
}

func (s *MemoryStore) UpdateInstanceCloudAndState(_ context.Context, id string, expected core.InstanceState, target core.InstanceState, address, cloudID string) (core.Instance, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	inst, ok := s.instances[id]
	if !ok {
		return core.Instance{}, core.ErrInstanceNotFound
	}
	if inst.State != expected {
		return core.Instance{}, core.ErrInvalidTransition
	}
	inst.State = target
	inst.Address = address
	inst.CloudID = cloudID
	inst.UpdatedAt = nowUTC()
	s.instances[id] = inst
	return inst, nil
}

func (s *MemoryStore) DeleteInstance(_ context.Context, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.instances, id)
	return nil
}

// Sandbox methods
func (s *MemoryStore) CreateSandbox(_ context.Context, sb core.Sandbox) (core.Sandbox, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sandboxes[sb.ID] = sb
	return sb, nil
}

func (s *MemoryStore) GetSandbox(_ context.Context, id string) (core.Sandbox, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	sb, ok := s.sandboxes[id]
	if !ok {
		return core.Sandbox{}, core.ErrSandboxNotFound
	}
	return sb, nil
}

func (s *MemoryStore) ListSandboxes(_ context.Context) ([]core.Sandbox, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	res := make([]core.Sandbox, 0, len(s.sandboxes))
	for _, sb := range s.sandboxes {
		res = append(res, sb)
	}
	return res, nil
}

func (s *MemoryStore) DeleteSandbox(_ context.Context, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.sandboxes, id)
	return nil
}

func (s *MemoryStore) UpsertTemplateClass(_ context.Context, templateClass core.TemplateClass) (core.TemplateClass, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.templateClasses[templateClass.ID] = templateClass
	return templateClass, nil
}

func (s *MemoryStore) GetTemplateClass(_ context.Context, id string) (core.TemplateClass, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	templateClass, ok := s.templateClasses[id]
	if !ok {
		return core.TemplateClass{}, core.ErrTemplateClassNotFound
	}
	return templateClass, nil
}

func (s *MemoryStore) ListTemplateClasses(_ context.Context) ([]core.TemplateClass, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	items := make([]core.TemplateClass, 0, len(s.templateClasses))
	for _, templateClass := range s.templateClasses {
		items = append(items, templateClass)
	}
	return items, nil
}

func (s *MemoryStore) UpsertSKU(_ context.Context, sku core.SKU) (core.SKU, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.skus[sku.ID] = sku
	return sku, nil
}

func (s *MemoryStore) GetSKU(_ context.Context, id string) (core.SKU, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	item, ok := s.skus[id]
	if !ok {
		return core.SKU{}, core.ErrSKUNotFound
	}
	return item, nil
}

func (s *MemoryStore) ListSKUs(_ context.Context) ([]core.SKU, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	items := make([]core.SKU, 0, len(s.skus))
	for _, sku := range s.skus {
		items = append(items, sku)
	}
	return items, nil
}

func (s *MemoryStore) UpsertTemplateSkuBinding(_ context.Context, binding core.TemplateSkuBinding) (core.TemplateSkuBinding, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.templateSKUs[binding.TemplateClassID]; !ok {
		s.templateSKUs[binding.TemplateClassID] = make(map[string]core.TemplateSkuBinding)
	}
	s.templateSKUs[binding.TemplateClassID][binding.SKUID] = binding
	return binding, nil
}

func (s *MemoryStore) ReplaceTemplateSkuBindings(_ context.Context, templateClassID string, bindings []core.TemplateSkuBinding) ([]core.TemplateSkuBinding, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	next := make(map[string]core.TemplateSkuBinding, len(bindings))
	for _, binding := range bindings {
		next[binding.SKUID] = binding
	}
	if len(next) == 0 {
		delete(s.templateSKUs, templateClassID)
		return []core.TemplateSkuBinding{}, nil
	}
	s.templateSKUs[templateClassID] = next
	items := make([]core.TemplateSkuBinding, 0, len(next))
	for _, binding := range next {
		items = append(items, binding)
	}
	return items, nil
}

func (s *MemoryStore) ListTemplateSkuBindings(_ context.Context, templateClassID string) ([]core.TemplateSkuBinding, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	bySKU := s.templateSKUs[templateClassID]
	items := make([]core.TemplateSkuBinding, 0, len(bySKU))
	for _, binding := range bySKU {
		items = append(items, binding)
	}
	return items, nil
}

func (s *MemoryStore) UpsertTemplatePoolBinding(_ context.Context, binding core.TemplatePoolBinding) (core.TemplatePoolBinding, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.templateBindings[binding.TemplateClassID]; !ok {
		s.templateBindings[binding.TemplateClassID] = make(map[string]core.TemplatePoolBinding)
	}
	s.templateBindings[binding.TemplateClassID][binding.PoolID] = binding
	return binding, nil
}

func (s *MemoryStore) ReplaceTemplatePoolBindings(_ context.Context, templateClassID string, bindings []core.TemplatePoolBinding) ([]core.TemplatePoolBinding, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	next := make(map[string]core.TemplatePoolBinding, len(bindings))
	for _, binding := range bindings {
		next[binding.PoolID] = binding
	}
	if len(next) == 0 {
		delete(s.templateBindings, templateClassID)
		return []core.TemplatePoolBinding{}, nil
	}
	s.templateBindings[templateClassID] = next
	items := make([]core.TemplatePoolBinding, 0, len(next))
	for _, binding := range next {
		items = append(items, binding)
	}
	return items, nil
}

func (s *MemoryStore) UpdateTemplatePoolBindingAdmission(_ context.Context, templateClassID string, poolID string, admissionState core.BindingAdmissionState, reason string) (core.TemplatePoolBinding, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	byPool, ok := s.templateBindings[templateClassID]
	if !ok {
		return core.TemplatePoolBinding{}, core.ErrTemplateClassNotFound
	}
	binding, ok := byPool[poolID]
	if !ok {
		return core.TemplatePoolBinding{}, core.ErrPoolNotFound
	}
	binding.AdmissionState = admissionState
	binding.Reason = reason
	binding.UpdatedAt = nowUTC()
	byPool[poolID] = binding
	return binding, nil
}

func (s *MemoryStore) ListTemplatePoolBindings(_ context.Context, templateClassID string) ([]core.TemplatePoolBinding, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	byPool := s.templateBindings[templateClassID]
	items := make([]core.TemplatePoolBinding, 0, len(byPool))
	for _, binding := range byPool {
		items = append(items, binding)
	}
	return items, nil
}

func (s *MemoryStore) DeleteTemplatePoolBinding(_ context.Context, templateClassID string, poolID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if byPool, ok := s.templateBindings[templateClassID]; ok {
		delete(byPool, poolID)
		if len(byPool) == 0 {
			delete(s.templateBindings, templateClassID)
		}
	}
	return nil
}

func (s *MemoryStore) UpsertPoolAutoscalePolicy(_ context.Context, policy core.PoolAutoscalePolicy) (core.PoolAutoscalePolicy, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.autoscalePolicy[policy.TemplateClassID] = policy
	return policy, nil
}

func (s *MemoryStore) GetPoolAutoscalePolicy(_ context.Context, templateClassID string) (core.PoolAutoscalePolicy, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	policy, ok := s.autoscalePolicy[templateClassID]
	if !ok {
		return core.PoolAutoscalePolicy{}, core.ErrPoolAutoscalePolicyNotFound
	}
	return policy, nil
}

func (s *MemoryStore) UpsertCapacityBundle(_ context.Context, bundle core.CapacityBundle) (core.CapacityBundle, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.capacityBundles[bundle.ID] = bundle
	return bundle, nil
}

func (s *MemoryStore) GetCapacityBundle(_ context.Context, id string) (core.CapacityBundle, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	bundle, ok := s.capacityBundles[id]
	if !ok {
		return core.CapacityBundle{}, core.ErrCapacityBundleNotFound
	}
	return bundle, nil
}

func (s *MemoryStore) ListCapacityBundles(_ context.Context) ([]core.CapacityBundle, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	items := make([]core.CapacityBundle, 0, len(s.capacityBundles))
	for _, bundle := range s.capacityBundles {
		items = append(items, bundle)
	}
	return items, nil
}

func (s *MemoryStore) ReserveCapacityBundleForPool(_ context.Context, bundleID string, templateClassID string, skuID string, poolID string) (core.CapacityBundle, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	bundle, ok := s.capacityBundles[bundleID]
	if !ok {
		return core.CapacityBundle{}, core.ErrCapacityBundleNotFound
	}
	if bundle.LineageTags == nil {
		bundle.LineageTags = map[string]string{}
	}
	if existing := bundle.LineageTags["pool_id"]; existing != "" && existing != poolID {
		return core.CapacityBundle{}, errors.New("capacity bundle already reserved by another pool")
	}
	if existing := bundle.LineageTags["sku_id"]; existing != "" && existing != skuID {
		return core.CapacityBundle{}, errors.New("capacity bundle already reserved by another sku")
	}
	switch bundle.Status {
	case core.CapacityBundleStatusWarm, core.CapacityBundleStatusActive:
	default:
		return core.CapacityBundle{}, errors.New("capacity bundle is not reservable")
	}
	bundle.Status = core.CapacityBundleStatusActive
	bundle.LineageTags["template_class_id"] = templateClassID
	bundle.LineageTags["sku_id"] = skuID
	bundle.LineageTags["pool_id"] = poolID
	bundle.UpdatedAt = nowUTC()
	s.capacityBundles[bundleID] = bundle
	return bundle, nil
}

func (s *MemoryStore) TryStartPoolSGShardRecovery(_ context.Context, poolID string) (core.Pool, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	pool, ok := s.pools[poolID]
	if !ok {
		return core.Pool{}, false, core.ErrPoolNotFound
	}
	if pool.LastAutoscaleAction == "sg_shard_recovery_pending" {
		return pool, false, nil
	}
	pool.LastAutoscaleAction = "sg_shard_recovery_pending"
	pool.AutoscaleGeneration++
	s.pools[poolID] = pool
	return pool, true, nil
}

func (s *MemoryStore) BeginSKUPoolRollout(_ context.Context, skuID string, poolID string, desiredImage string, startedAt time.Time) (core.SKU, core.Pool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	sku, ok := s.skus[skuID]
	if !ok {
		return core.SKU{}, core.Pool{}, core.ErrSKUNotFound
	}
	pool, ok := s.pools[poolID]
	if !ok {
		return core.SKU{}, core.Pool{}, core.ErrPoolNotFound
	}
	pool.BaseImage = desiredImage
	pool.LastAutoscaleAction = "sku_rollout_start"
	s.pools[poolID] = pool
	for id, inst := range s.instances {
		if inst.PoolID != poolID || inst.State != core.StateClean {
			continue
		}
		inst.State = core.StateDry
		inst.UpdatedAt = nowUTC()
		s.instances[id] = inst
	}
	sku.RolloutState = core.SKURolloutStateRolling
	sku.RolloutCursorPoolID = poolID
	sku.LastRolloutStartedAt = &startedAt
	sku.LastRolloutError = ""
	s.skus[skuID] = sku
	return sku, pool, nil
}

func (s *MemoryStore) UpsertVPCShard(_ context.Context, shard core.VPCShard) (core.VPCShard, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.vpcShards[shard.ID] = shard
	return shard, nil
}

func (s *MemoryStore) GetVPCShard(_ context.Context, id string) (core.VPCShard, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	item, ok := s.vpcShards[id]
	if !ok {
		return core.VPCShard{}, core.ErrVPCShardNotFound
	}
	return item, nil
}

func (s *MemoryStore) ListVPCShards(_ context.Context) ([]core.VPCShard, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	items := make([]core.VPCShard, 0, len(s.vpcShards))
	for _, shard := range s.vpcShards {
		items = append(items, shard)
	}
	return items, nil
}

func (s *MemoryStore) ReplaceVPCShardSubnets(_ context.Context, shardID string, subnets []core.VPCShardSubnet) ([]core.VPCShardSubnet, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.vpcShards[shardID]; !ok {
		return nil, core.ErrVPCShardNotFound
	}
	next := make(map[string]core.VPCShardSubnet, len(subnets))
	for _, subnet := range subnets {
		next[subnet.ID] = subnet
	}
	if len(next) == 0 {
		delete(s.vpcShardSubnets, shardID)
		return []core.VPCShardSubnet{}, nil
	}
	s.vpcShardSubnets[shardID] = next
	items := make([]core.VPCShardSubnet, 0, len(next))
	for _, subnet := range next {
		items = append(items, subnet)
	}
	return items, nil
}

func (s *MemoryStore) ListVPCShardSubnets(_ context.Context, shardID string) ([]core.VPCShardSubnet, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if _, ok := s.vpcShards[shardID]; !ok {
		return nil, core.ErrVPCShardNotFound
	}
	byID := s.vpcShardSubnets[shardID]
	items := make([]core.VPCShardSubnet, 0, len(byID))
	for _, subnet := range byID {
		items = append(items, subnet)
	}
	return items, nil
}

func (s *MemoryStore) ReserveNextVPCShardSubnet(_ context.Context, shardID string) (core.VPCShard, core.VPCShardSubnet, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	shard, ok := s.vpcShards[shardID]
	if !ok {
		return core.VPCShard{}, core.VPCShardSubnet{}, core.ErrVPCShardNotFound
	}
	byID := s.vpcShardSubnets[shardID]
	var chosen *core.VPCShardSubnet
	for _, subnet := range byID {
		if subnet.Role != core.VPCShardSubnetRoleWorkload {
			continue
		}
		if subnet.NearWaterline {
			continue
		}
		if subnet.ReservationState != core.VPCShardSubnetReservationAvailable {
			continue
		}
		candidate := subnet
		if chosen == nil || candidate.Ordinal < chosen.Ordinal || (candidate.Ordinal == chosen.Ordinal && candidate.ID < chosen.ID) {
			chosen = &candidate
		}
	}
	if chosen == nil {
		return core.VPCShard{}, core.VPCShardSubnet{}, core.ErrVPCShardSubnetNotFound
	}
	chosen.ReservationState = core.VPCShardSubnetReservationReserved
	chosen.UpdatedAt = nowUTC()
	byID[chosen.ID] = *chosen
	return shard, *chosen, nil
}

func (s *MemoryStore) ActivateVPCShardSubnet(_ context.Context, shardID string, subnetMemberID string, switchedAt time.Time, waterlineReason string) (core.VPCShard, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	shard, ok := s.vpcShards[shardID]
	if !ok {
		return core.VPCShard{}, core.ErrVPCShardNotFound
	}
	byID := s.vpcShardSubnets[shardID]
	subnet, ok := byID[subnetMemberID]
	if !ok {
		return core.VPCShard{}, core.ErrVPCShardSubnetNotFound
	}
	if previousID := shard.ActiveSubnetMemberID; previousID != "" && previousID != subnetMemberID {
		if previous, ok := byID[previousID]; ok {
			if previous.NearWaterline {
				previous.ReservationState = core.VPCShardSubnetReservationExhausted
			} else {
				previous.ReservationState = core.VPCShardSubnetReservationAvailable
			}
			previous.UpdatedAt = switchedAt.UTC()
			byID[previousID] = previous
		}
	}
	subnet.ReservationState = core.VPCShardSubnetReservationActive
	subnet.UpdatedAt = switchedAt.UTC()
	byID[subnetMemberID] = subnet
	shard.ActiveSubnetMemberID = subnetMemberID
	shard.LastSwitchAt = ptrTime(switchedAt.UTC())
	shard.LastWaterlineReason = waterlineReason
	shard.UpdatedAt = switchedAt.UTC()
	s.vpcShards[shardID] = shard
	return shard, nil
}

func (s *MemoryStore) UpsertVPCShardBlueprintSnapshot(_ context.Context, snapshot core.VPCShardBlueprintSnapshot) (core.VPCShardBlueprintSnapshot, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.vpcShardBlueprints[snapshot.ID] = snapshot
	return snapshot, nil
}

func (s *MemoryStore) GetVPCShardBlueprintSnapshot(_ context.Context, id string) (core.VPCShardBlueprintSnapshot, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	item, ok := s.vpcShardBlueprints[id]
	if !ok {
		return core.VPCShardBlueprintSnapshot{}, core.ErrVPCShardBlueprintSnapshotNotFound
	}
	return item, nil
}

func (s *MemoryStore) ListVPCShardBlueprintSnapshots(_ context.Context) ([]core.VPCShardBlueprintSnapshot, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	items := make([]core.VPCShardBlueprintSnapshot, 0, len(s.vpcShardBlueprints))
	for _, snapshot := range s.vpcShardBlueprints {
		items = append(items, snapshot)
	}
	return items, nil
}

func (s *MemoryStore) UpsertVPCShardProvisionProgress(_ context.Context, progress core.VPCShardProvisionProgress) (core.VPCShardProvisionProgress, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.vpcShardProgress[progress.VPCShardID] = progress
	return progress, nil
}

func (s *MemoryStore) GetVPCShardProvisionProgress(_ context.Context, shardID string) (core.VPCShardProvisionProgress, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	progress, ok := s.vpcShardProgress[shardID]
	if !ok {
		return core.VPCShardProvisionProgress{}, core.ErrVPCShardProvisionProgressNotFound
	}
	return progress, nil
}

func (s *MemoryStore) TryStartVPCShardCreate(_ context.Context, blueprintFingerprint string, region string) (core.VPCShardCreateLock, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := strings.TrimSpace(blueprintFingerprint) + "|" + strings.TrimSpace(region)
	if key == "|" {
		return core.VPCShardCreateLock{}, false, errors.New("missing vpc shard create lock key")
	}
	if lock, ok := s.vpcShardCreateLocks[key]; ok {
		return lock, false, nil
	}
	lock := core.VPCShardCreateLock{
		ID:                   key,
		BlueprintFingerprint: strings.TrimSpace(blueprintFingerprint),
		Region:               strings.TrimSpace(region),
		CreatedAt:            nowUTC(),
	}
	s.vpcShardCreateLocks[key] = lock
	return lock, true, nil
}

func (s *MemoryStore) DeleteVPCShardCreateLock(_ context.Context, blueprintFingerprint string, region string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.vpcShardCreateLocks, strings.TrimSpace(blueprintFingerprint)+"|"+strings.TrimSpace(region))
	return nil
}

func (s *MemoryStore) ReplaceVPCShardCleanupResources(_ context.Context, shardID string, resources []core.VPCShardCleanupResource) ([]core.VPCShardCleanupResource, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.vpcShards[shardID]; !ok {
		return nil, core.ErrVPCShardNotFound
	}
	next := make(map[string]core.VPCShardCleanupResource, len(resources))
	for _, resource := range resources {
		next[resource.ID] = resource
	}
	if len(next) == 0 {
		delete(s.vpcShardCleanup, shardID)
		return []core.VPCShardCleanupResource{}, nil
	}
	s.vpcShardCleanup[shardID] = next
	items := make([]core.VPCShardCleanupResource, 0, len(next))
	for _, resource := range next {
		items = append(items, resource)
	}
	return items, nil
}

func (s *MemoryStore) ListVPCShardCleanupResources(_ context.Context, shardID string) ([]core.VPCShardCleanupResource, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if _, ok := s.vpcShards[shardID]; !ok {
		return nil, core.ErrVPCShardNotFound
	}
	byID := s.vpcShardCleanup[shardID]
	items := make([]core.VPCShardCleanupResource, 0, len(byID))
	for _, resource := range byID {
		items = append(items, resource)
	}
	return items, nil
}

func (s *MemoryStore) DeleteVPCShardCleanupResource(_ context.Context, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for shardID, byID := range s.vpcShardCleanup {
		if _, ok := byID[id]; !ok {
			continue
		}
		delete(byID, id)
		if len(byID) == 0 {
			delete(s.vpcShardCleanup, shardID)
		}
		return nil
	}
	return nil
}

func nowUTC() time.Time {
	return time.Now().UTC()
}

func ptrTime(ts time.Time) *time.Time {
	return &ts
}
