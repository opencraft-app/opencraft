package service

import (
	"context"
	"errors"
	"fmt"
	"math/rand"
	"slices"
	"sort"
	"strings"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"go.opentelemetry.io/otel/attribute"

	"cvm-mock-e2b/internal/core"
	"cvm-mock-e2b/internal/observability"
	"cvm-mock-e2b/internal/store"
)

// Service hosts the control-plane operations.
type Service struct {
	store     store.Store
	idCounter uint64
	shuffle   func(n int, swap func(i, j int))
}

type AddressVerifier func(ctx context.Context, address string) error

type AllocationResolution struct {
	Pool             core.Pool
	Instance         core.Instance
	TemplateClassID  string
	SKUID            string
	ResolutionMode   core.ResolutionMode
	ResolutionSource string
	Divergence       string
}

type CreateBoundPoolInput struct {
	Name           string
	Description    string
	BaseImage      string
	InstanceType   string
	SKUID          string
	VpcID          string
	SubnetID       string
	Zone           string
	SecurityGroups []string
}

func emitCapacityBundleConflict(ctx context.Context, explanation string, attrs ...attribute.KeyValue) {
	observability.EmitEvent(ctx, "sandbox.capacity_bundle.reservation_conflict", explanation, attrs...)
}

const defaultInstanceType = "SA9.MEDIUM2"

const (
	hermesTemplateClassID       = "hermes"
	hermesPreferredInstanceType = "SA5.LARGE8"
)

var allowedTransitions = map[core.InstanceState][]core.InstanceState{
	core.StateCreating:  {core.StateClean, core.StateFailed},
	core.StateClean:     {core.StateAllocated, core.StateDeleting, core.StateFailed},
	core.StateAllocated: {core.StateDry, core.StatePausing},
	// Resetting/reinstall is a worker-only transition. Keep legacy REINSTALLING for old rows.
	core.StateDry:          {core.StateResetting, core.StateReinstalling},
	core.StateResetting:    {core.StateClean, core.StateFailed},
	core.StateReinstalling: {core.StateClean, core.StateFailed},
	core.StateDeleting:     {core.StateDeleted},
	core.StateFailed:       {core.StateDeleted},
	// Pause path (Q26-D 修订版 + Q29=E5 + Q32=b 拍板 2026-05-14)：
	// 关机语义保留数据，pausing 失败时回滚到 Allocated；paused 终态可被销毁/失败。
	core.StatePausing: {core.StatePaused, core.StateAllocated, core.StateFailed},
	// Resume path (R-F 2026-05-15，对偶 trade 续费链路 .tmp/trade-pass-renew-design.md §10 R-F)：
	// 开机语义恢复数据，paused → resuming → allocated；resuming 失败回滚到 paused 让 ctl 子 task 重投。
	core.StatePaused:   {core.StateDeleting, core.StateFailed, core.StateResuming},
	core.StateResuming: {core.StateAllocated, core.StatePaused, core.StateFailed},
}

// NewService wires a Service with the provided store.
func NewService(store store.Store) *Service {
	return &Service{store: store, shuffle: rand.Shuffle}
}

// CreatePool registers a new pool.
func (s *Service) CreatePool(ctx context.Context, name, desc, baseImage string, desiredCap int, vpcID, subnetID, zone string, securityGroups []string) (core.Pool, error) {
	if name == "" {
		name = "default"
	}
	if strings.TrimSpace(vpcID) == "" || strings.TrimSpace(subnetID) == "" || strings.TrimSpace(zone) == "" {
		return core.Pool{}, fmt.Errorf("missing pool network config: need vpc_id, subnet_id, zone")
	}
	now := time.Now().UTC()
	pool := core.Pool{
		ID:             s.nextID("pool"),
		Name:           name,
		Description:    desc,
		BaseImage:      baseImage,
		DesiredCap:     desiredCap,
		InstanceType:   defaultInstanceType,
		Status:         core.PoolStatusActive,
		VpcID:          vpcID,
		SubnetID:       subnetID,
		Zone:           zone,
		SecurityGroups: securityGroups,
		CreatedAt:      now,
	}
	pool, err := normalizePool(pool)
	if err != nil {
		return core.Pool{}, err
	}
	return s.store.CreatePool(ctx, pool)
}

// CreateBoundPool creates an operator-managed pool in a safe state with its
// logical SKU binding present in the initial row.
func (s *Service) CreateBoundPool(ctx context.Context, input CreateBoundPoolInput) (core.Pool, error) {
	sku, err := s.resolveActivePoolSKU(ctx, input.SKUID)
	if err != nil {
		return core.Pool{}, err
	}
	name := strings.TrimSpace(input.Name)
	if name == "" {
		name = "default"
	}
	pool := core.Pool{
		ID:              s.nextID("pool"),
		Name:            name,
		Description:     strings.TrimSpace(input.Description),
		BaseImage:       strings.TrimSpace(input.BaseImage),
		DesiredCap:      0,
		InstanceType:    strings.TrimSpace(input.InstanceType),
		Status:          core.PoolStatusPaused,
		PauseReason:     "awaiting operator activation",
		VpcID:           strings.TrimSpace(input.VpcID),
		SubnetID:        strings.TrimSpace(input.SubnetID),
		Zone:            strings.TrimSpace(input.Zone),
		SecurityGroups:  input.SecurityGroups,
		TemplateClassID: sku.TemplateClassID,
		SKUID:           sku.ID,
		CreatedAt:       time.Now().UTC(),
	}
	pool, err = normalizePool(pool)
	if err != nil {
		return core.Pool{}, err
	}
	return s.store.CreatePool(ctx, pool)
}

// BindPoolSKU applies the one-time logical binding allowed for a legacy pool.
// Existing bindings are immutable, while repeating the same binding is idempotent.
func (s *Service) BindPoolSKU(ctx context.Context, pool core.Pool, skuID string) (core.Pool, error) {
	skuID = strings.TrimSpace(skuID)
	if skuID == "" {
		return core.Pool{}, fmt.Errorf("%w: sku_id is required", core.ErrInvalidPoolSKUBinding)
	}
	existingSKU := strings.TrimSpace(pool.SKUID)
	existingClass := strings.TrimSpace(pool.TemplateClassID)
	if existingSKU != "" || existingClass != "" {
		if existingSKU == skuID && existingClass != "" {
			return pool, nil
		}
		return core.Pool{}, fmt.Errorf("%w: existing sku_id cannot be cleared or changed", core.ErrInvalidPoolSKUBinding)
	}
	sku, err := s.resolveActivePoolSKU(ctx, skuID)
	if err != nil {
		return core.Pool{}, err
	}
	pool.SKUID = sku.ID
	pool.TemplateClassID = sku.TemplateClassID
	return pool, nil
}

func (s *Service) resolveActivePoolSKU(ctx context.Context, skuID string) (core.SKU, error) {
	skuID = strings.TrimSpace(skuID)
	if skuID == "" {
		return core.SKU{}, fmt.Errorf("%w: sku_id is required", core.ErrInvalidPoolSKUBinding)
	}
	sku, err := s.store.GetSKU(ctx, skuID)
	if err != nil {
		if errors.Is(err, core.ErrSKUNotFound) {
			return core.SKU{}, fmt.Errorf("%w: sku_id not found", core.ErrInvalidPoolSKUBinding)
		}
		return core.SKU{}, err
	}
	if _, err := s.store.GetTemplateClass(ctx, sku.TemplateClassID); err != nil {
		return core.SKU{}, fmt.Errorf("%w: template class is unavailable", core.ErrInvalidPoolSKUBinding)
	}
	bindings, err := s.store.ListTemplateSkuBindings(ctx, sku.TemplateClassID)
	if err != nil {
		return core.SKU{}, err
	}
	for _, binding := range bindings {
		if binding.SKUID != sku.ID {
			continue
		}
		if binding.AdmissionState != "active" {
			return core.SKU{}, fmt.Errorf("%w: sku binding is not active", core.ErrInvalidPoolSKUBinding)
		}
		if !binding.RolloutEligibility {
			return core.SKU{}, fmt.Errorf("%w: sku binding is not rollout eligible", core.ErrInvalidPoolSKUBinding)
		}
		return sku, nil
	}
	return core.SKU{}, fmt.Errorf("%w: sku binding is not active", core.ErrInvalidPoolSKUBinding)
}

func (s *Service) ListPools(ctx context.Context) ([]core.Pool, error) {
	return s.store.ListPools(ctx)
}

// GetPool fetches a pool by id.
func (s *Service) GetPool(ctx context.Context, id string) (core.Pool, error) {
	return s.store.GetPool(ctx, id)
}

// UpdatePool updates pool metadata including desired capacity.
func (s *Service) UpdatePool(ctx context.Context, pool core.Pool) (core.Pool, error) {
	var err error
	pool, err = normalizePool(pool)
	if err != nil {
		return core.Pool{}, err
	}
	return s.store.UpdatePool(ctx, pool)
}

func (s *Service) PausePool(ctx context.Context, id, reason, code, detail string) (core.Pool, error) {
	pool, err := s.store.GetPool(ctx, id)
	if err != nil {
		return core.Pool{}, err
	}
	pool.Status = core.PoolStatusPaused
	pool.PauseReason = strings.TrimSpace(reason)
	pool.ConsecutiveRefillFailures++
	pool.LastRefillErrorCode = strings.TrimSpace(code)
	pool.LastRefillError = strings.TrimSpace(detail)
	return s.UpdatePool(ctx, pool)
}

func (s *Service) RecordPoolRefillFailure(ctx context.Context, id, code, detail string, threshold int) (core.Pool, bool, error) {
	pool, err := s.store.GetPool(ctx, id)
	if err != nil {
		return core.Pool{}, false, err
	}
	pool.ConsecutiveRefillFailures++
	pool.LastRefillErrorCode = strings.TrimSpace(code)
	pool.LastRefillError = strings.TrimSpace(detail)
	paused := false
	if threshold > 0 && pool.ConsecutiveRefillFailures >= threshold {
		pool.Status = core.PoolStatusPaused
		pool.PauseReason = fmt.Sprintf("refill circuit breaker opened after %d consecutive failures", pool.ConsecutiveRefillFailures)
		paused = true
	}
	pool, err = s.UpdatePool(ctx, pool)
	return pool, paused, err
}

func (s *Service) ResetPoolRefillFailures(ctx context.Context, id string) (core.Pool, error) {
	pool, err := s.store.GetPool(ctx, id)
	if err != nil {
		return core.Pool{}, err
	}
	if pool.Status != core.PoolStatusActive &&
		pool.ConsecutiveRefillFailures == 0 &&
		pool.LastRefillErrorCode == "" &&
		pool.LastRefillError == "" &&
		pool.PauseReason == "" {
		return pool, nil
	}
	if pool.Status == core.PoolStatusActive {
		pool.PauseReason = ""
	}
	pool.ConsecutiveRefillFailures = 0
	pool.LastRefillErrorCode = ""
	pool.LastRefillError = ""
	return s.UpdatePool(ctx, pool)
}

func normalizePool(pool core.Pool) (core.Pool, error) {
	if strings.TrimSpace(pool.VpcID) == "" || strings.TrimSpace(pool.SubnetID) == "" || strings.TrimSpace(pool.Zone) == "" {
		return core.Pool{}, fmt.Errorf("missing pool network config: need vpc_id, subnet_id, zone")
	}
	if strings.TrimSpace(pool.BaseImage) == "" {
		return core.Pool{}, fmt.Errorf("missing pool base_image")
	}
	securityGroups := make([]string, 0, len(pool.SecurityGroups))
	for _, sg := range pool.SecurityGroups {
		trimmed := strings.TrimSpace(sg)
		if trimmed == "" {
			continue
		}
		securityGroups = append(securityGroups, trimmed)
	}
	if len(securityGroups) == 0 {
		return core.Pool{}, fmt.Errorf("missing pool security_groups")
	}
	pool.SecurityGroups = securityGroups
	if strings.TrimSpace(pool.InstanceType) == "" {
		pool.InstanceType = defaultInstanceType
	}
	if pool.Status == "" {
		pool.Status = core.PoolStatusActive
	}
	if pool.CapacityState == "" {
		pool.CapacityState = core.PoolCapacityStateActive
	}
	switch pool.Status {
	case core.PoolStatusActive, core.PoolStatusPaused:
	default:
		return core.Pool{}, fmt.Errorf("invalid pool status %q", pool.Status)
	}
	switch pool.CapacityState {
	case core.PoolCapacityStateActive,
		core.PoolCapacityStateDraining,
		core.PoolCapacityStatePaused,
		core.PoolCapacityStateQuarantined,
		core.PoolCapacityStateRetiring:
	default:
		return core.Pool{}, fmt.Errorf("invalid pool capacity_state %q", pool.CapacityState)
	}
	return pool, nil
}

func normalizeTemplateClass(templateClass core.TemplateClass) (core.TemplateClass, error) {
	if strings.TrimSpace(templateClass.ID) == "" {
		return core.TemplateClass{}, fmt.Errorf("missing template class id")
	}
	if strings.TrimSpace(templateClass.Name) == "" {
		templateClass.Name = templateClass.ID
	}
	if templateClass.DefaultPoolSelectionPolicy == "" {
		templateClass.DefaultPoolSelectionPolicy = "priority"
	}
	if templateClass.ResolutionMode == "" {
		templateClass.ResolutionMode = core.ResolutionModeLegacy
	}
	if templateClass.Status == "" {
		templateClass.Status = core.TemplateClassStatusActive
	}
	switch templateClass.ResolutionMode {
	case core.ResolutionModeLegacy, core.ResolutionModeShadow, core.ResolutionModeSandboxPrimary:
	default:
		return core.TemplateClass{}, fmt.Errorf("invalid template resolution_mode %q", templateClass.ResolutionMode)
	}
	switch templateClass.Status {
	case core.TemplateClassStatusActive, core.TemplateClassStatusPaused:
	default:
		return core.TemplateClass{}, fmt.Errorf("invalid template status %q", templateClass.Status)
	}
	return templateClass, nil
}

func normalizeSKU(sku core.SKU) (core.SKU, error) {
	if strings.TrimSpace(sku.ID) == "" {
		return core.SKU{}, fmt.Errorf("missing sku id")
	}
	if strings.TrimSpace(sku.TemplateClassID) == "" {
		return core.SKU{}, fmt.Errorf("missing sku template_class_id")
	}
	if strings.TrimSpace(sku.BaseImage) == "" {
		return core.SKU{}, fmt.Errorf("missing sku base_image")
	}
	if strings.TrimSpace(sku.DesiredImageID) == "" {
		sku.DesiredImageID = sku.BaseImage
	}
	if strings.TrimSpace(sku.InstanceType) == "" {
		sku.InstanceType = defaultInstanceType
	}
	if sku.RolloutState == "" {
		sku.RolloutState = core.SKURolloutStateStable
	}
	switch sku.RolloutState {
	case core.SKURolloutStateStable, core.SKURolloutStateRolling, core.SKURolloutStateBlocked, core.SKURolloutStateDegraded:
	default:
		return core.SKU{}, fmt.Errorf("invalid sku rollout_state %q", sku.RolloutState)
	}
	return sku, nil
}

func normalizeTemplateSkuBinding(binding core.TemplateSkuBinding) (core.TemplateSkuBinding, error) {
	if strings.TrimSpace(binding.TemplateClassID) == "" || strings.TrimSpace(binding.SKUID) == "" {
		return core.TemplateSkuBinding{}, fmt.Errorf("missing template_class_id or sku_id")
	}
	binding.AdmissionState = strings.TrimSpace(binding.AdmissionState)
	if binding.Weight <= 0 {
		binding.Weight = 1
	}
	if binding.AdmissionState == "" {
		binding.AdmissionState = "active"
	}
	switch binding.AdmissionState {
	case "active", "paused", "quarantined":
	default:
		return core.TemplateSkuBinding{}, fmt.Errorf("invalid template sku admission_state %q", binding.AdmissionState)
	}
	return binding, nil
}

func normalizeTemplatePoolBinding(binding core.TemplatePoolBinding) (core.TemplatePoolBinding, error) {
	if strings.TrimSpace(binding.TemplateClassID) == "" || strings.TrimSpace(binding.PoolID) == "" {
		return core.TemplatePoolBinding{}, fmt.Errorf("missing template_class_id or pool_id")
	}
	if binding.Weight <= 0 {
		binding.Weight = 1
	}
	if binding.Role == "" {
		binding.Role = core.PoolBindingRolePrimary
	}
	if binding.AdmissionState == "" {
		binding.AdmissionState = core.BindingAdmissionStateActive
	}
	switch binding.Role {
	case core.PoolBindingRolePrimary, core.PoolBindingRoleFallback, core.PoolBindingRoleBurst:
	default:
		return core.TemplatePoolBinding{}, fmt.Errorf("invalid pool binding role %q", binding.Role)
	}
	switch binding.AdmissionState {
	case core.BindingAdmissionStateActive, core.BindingAdmissionStateDraining, core.BindingAdmissionStatePaused, core.BindingAdmissionStateQuarantined:
	default:
		return core.TemplatePoolBinding{}, fmt.Errorf("invalid pool binding admission_state %q", binding.AdmissionState)
	}
	return binding, nil
}

func normalizePoolAutoscalePolicy(policy core.PoolAutoscalePolicy) (core.PoolAutoscalePolicy, error) {
	if strings.TrimSpace(policy.TemplateClassID) == "" {
		return core.PoolAutoscalePolicy{}, fmt.Errorf("missing template_class_id")
	}
	return policy, nil
}

func normalizeCapacityBundle(bundle core.CapacityBundle) (core.CapacityBundle, error) {
	if strings.TrimSpace(bundle.ID) == "" {
		return core.CapacityBundle{}, fmt.Errorf("missing capacity bundle id")
	}
	if strings.TrimSpace(bundle.Region) == "" || strings.TrimSpace(bundle.Zone) == "" || strings.TrimSpace(bundle.VpcID) == "" || strings.TrimSpace(bundle.SubnetID) == "" {
		return core.CapacityBundle{}, fmt.Errorf("missing capacity bundle network config")
	}
	if bundle.Status == "" {
		bundle.Status = core.CapacityBundleStatusProvisioning
	}
	switch bundle.Status {
	case core.CapacityBundleStatusProvisioning, core.CapacityBundleStatusWarm, core.CapacityBundleStatusActive, core.CapacityBundleStatusExhausted, core.CapacityBundleStatusManualReview:
	default:
		return core.CapacityBundle{}, fmt.Errorf("invalid capacity bundle status %q", bundle.Status)
	}
	return bundle, nil
}

// RefillVerified records instances as CREATING then finalizes them into CLEAN only after verifier passes.
// This is the only supported path for transitioning CREATING -> CLEAN for refilled instances.
func (s *Service) RefillVerified(ctx context.Context, poolID string, count int, addresses []string, cloudIDs []string, verify AddressVerifier) ([]core.Instance, error) {
	if verify == nil {
		return nil, fmt.Errorf("missing verifier")
	}
	if len(addresses) > 0 {
		count = len(addresses) // addresses drives cardinality when provided
	}
	if len(cloudIDs) > 0 {
		count = len(cloudIDs) // cloud IDs drive cardinality if provided
	}
	if count <= 0 {
		return nil, fmt.Errorf("count must be positive")
	}
	placeholders, err := s.InsertCreating(ctx, poolID, count)
	if err != nil {
		return nil, err
	}
	finalized := make([]core.Instance, 0, len(placeholders))
	for i, ph := range placeholders {
		addr := fmt.Sprintf("10.0.%d.%d", time.Now().Nanosecond()%250, i+10)
		if len(addresses) > 0 {
			addr = addresses[i]
		}
		cloudID := s.nextID("cloud")
		if len(cloudIDs) > 0 {
			cloudID = cloudIDs[i]
		}
		target := core.StateClean
		if err := verify(ctx, addr); err != nil {
			target = core.StateFailed
		}
		inst, ferr := s.FinalizeCreating(ctx, ph.ID, target, addr, cloudID)
		if ferr != nil {
			return nil, ferr
		}
		finalized = append(finalized, inst)
	}
	return finalized, nil
}

// InsertCreating inserts placeholder instances in CREATING state without cloud/address.
func (s *Service) InsertCreating(ctx context.Context, poolID string, count int) ([]core.Instance, error) {
	if count <= 0 {
		return nil, fmt.Errorf("count must be positive")
	}
	now := time.Now().UTC()
	items := make([]core.Instance, 0, count)
	total, index, shardOK := store.ShardFromContext(ctx)
	for i := 0; i < count; i++ {
		id := s.nextID("i")
		if shardOK {
			// Ensure newly created placeholders belong to the worker shard; otherwise refill never converges.
			for !store.ShardMatch(id, total, index) {
				id = s.nextID("i")
			}
		}
		items = append(items, core.Instance{
			ID:        id,
			PoolID:    poolID,
			State:     core.StateCreating,
			CreatedAt: now,
			UpdatedAt: now,
		})
	}
	return s.store.AddInstances(ctx, poolID, items)
}

// FinalizeCreating sets cloud/address and advances from CREATING to target state.
func (s *Service) FinalizeCreating(ctx context.Context, id string, target core.InstanceState, address, cloudID string) (core.Instance, error) {
	if target != core.StateClean && target != core.StateFailed {
		return core.Instance{}, core.ErrInvalidTransition
	}
	return s.store.UpdateInstanceCloudAndState(ctx, id, core.StateCreating, target, address, cloudID)
}

// AddFailedInstance records a failed provision attempt (e.g., cloud created but unusable).
func (s *Service) AddFailedInstance(ctx context.Context, poolID, cloudID, address string) (core.Instance, error) {
	now := time.Now().UTC()
	id := s.nextID("i")
	if total, index, ok := store.ShardFromContext(ctx); ok {
		for !store.ShardMatch(id, total, index) {
			id = s.nextID("i")
		}
	}
	inst := core.Instance{
		ID:        id,
		PoolID:    poolID,
		State:     core.StateFailed,
		CloudID:   cloudID,
		Address:   address,
		CreatedAt: now,
		UpdatedAt: now,
	}
	added, err := s.store.AddInstances(ctx, poolID, []core.Instance{inst})
	if err != nil {
		return core.Instance{}, err
	}
	return added[0], nil
}

func (s *Service) ListInstances(ctx context.Context, poolID string) ([]core.Instance, error) {
	return s.store.ListInstances(ctx, poolID)
}

func (s *Service) ListInstancesByStates(ctx context.Context, poolID string, states []core.InstanceState, limit int) ([]core.Instance, error) {
	return s.store.ListInstancesByStates(ctx, poolID, states, limit)
}

// Allocate picks a CLEAN instance and moves it to ALLOCATED.
func (s *Service) Allocate(ctx context.Context, poolID string) (core.Instance, error) {
	return s.store.ClaimCleanInstance(ctx, poolID)
}

// AllocateAny picks a CLEAN instance from a random pool, retrying across pools up to maxAttempts.
func (s *Service) AllocateAny(ctx context.Context, maxAttempts int) (core.Pool, core.Instance, error) {
	pools, err := s.store.ListPools(ctx)
	if err != nil {
		return core.Pool{}, core.Instance{}, err
	}
	if len(pools) == 0 {
		return core.Pool{}, core.Instance{}, core.ErrNoCleanInstance
	}
	if maxAttempts <= 0 {
		maxAttempts = len(pools)
	}

	attempts := 0
	for attempts < maxAttempts {
		cycle := append([]core.Pool(nil), pools...)
		if len(cycle) > 1 && s.shuffle != nil {
			s.shuffle(len(cycle), func(i, j int) {
				cycle[i], cycle[j] = cycle[j], cycle[i]
			})
		}
		for _, pool := range cycle {
			if attempts >= maxAttempts {
				break
			}
			attempts++

			inst, err := s.Allocate(ctx, pool.ID)
			if err == nil {
				return pool, inst, nil
			}
			if errors.Is(err, core.ErrNoCleanInstance) || errors.Is(err, core.ErrPoolNotFound) {
				continue
			}
			return core.Pool{}, core.Instance{}, err
		}
	}

	return core.Pool{}, core.Instance{}, core.ErrNoCleanInstance
}

// Release moves an instance back into the DRY state so the reset worker can
// reinstall it and return it to the CLEAN pool.
//
// Accepted transitions:
//   - ALLOCATED → DRY: normal release path (sandbox deletion on a running pass).
//   - PAUSED    → DRY: release path for a sandbox that was already isolated via
//     the trade pass isolation flow (Q26-D 修订版). Without this, deleting an
//     isolated sandbox would silently fail Release and leak the instance in
//     PAUSED forever, because the reset worker only sweeps DRY/RESETTING.
//   - DRY       → DRY: idempotent no-op for retrying callers.
//
// Any other source state returns ErrInvalidTransition; in particular CLEAN,
// CREATING, RESETTING, PAUSING and RESUMING must not be released directly.
func (s *Service) Release(ctx context.Context, instanceID string) (core.Instance, error) {
	inst, err := s.store.GetInstance(ctx, instanceID)
	if err != nil {
		return core.Instance{}, err
	}
	switch inst.State {
	case core.StateAllocated, core.StatePaused:
		return s.store.UpdateInstanceState(ctx, instanceID, inst.State, core.StateDry)
	case core.StateDry:
		// Idempotent: caller is retrying after a partial failure.
		return inst, nil
	default:
		return core.Instance{}, core.ErrInvalidTransition
	}
}

// Pause moves an instance from ALLOCATED to PAUSING. The caller must follow up
// with the cloud-side StopInstance call and then either MarkPaused on success
// or RollbackPausing on failure.
//
// Implements Q26-D 修订版 + Q29=E5 拍板（2026-05-14）：trade pass isolation 走
// "关机保留数据"路径，不再走历史的 ALLOCATED → DRY → RESETTING（释放 + 重装）。
func (s *Service) Pause(ctx context.Context, instanceID string) (core.Instance, error) {
	inst, err := s.store.GetInstance(ctx, instanceID)
	if err != nil {
		return core.Instance{}, err
	}
	switch inst.State {
	case core.StateAllocated:
		return s.store.UpdateInstanceState(ctx, instanceID, core.StateAllocated, core.StatePausing)
	case core.StatePausing, core.StatePaused:
		// Idempotent: caller is retrying or pause already applied.
		return inst, nil
	default:
		return core.Instance{}, core.ErrInvalidTransition
	}
}

// MarkPaused transitions PAUSING to PAUSED after the cloud-side StopInstance
// call has succeeded. Idempotent for an already-paused instance.
func (s *Service) MarkPaused(ctx context.Context, instanceID string) (core.Instance, error) {
	inst, err := s.store.GetInstance(ctx, instanceID)
	if err != nil {
		return core.Instance{}, err
	}
	switch inst.State {
	case core.StatePausing:
		return s.store.UpdateInstanceState(ctx, instanceID, core.StatePausing, core.StatePaused)
	case core.StatePaused:
		return inst, nil
	default:
		return core.Instance{}, core.ErrInvalidTransition
	}
}

// RollbackPausing rolls a PAUSING instance back to ALLOCATED when the cloud-side
// StopInstance call fails irrecoverably. The caller (handler) is responsible for
// surfacing the error to the upstream pass isolation flow so it can retry.
func (s *Service) RollbackPausing(ctx context.Context, instanceID string) (core.Instance, error) {
	inst, err := s.store.GetInstance(ctx, instanceID)
	if err != nil {
		return core.Instance{}, err
	}
	if inst.State != core.StatePausing {
		return core.Instance{}, core.ErrInvalidTransition
	}
	return s.store.UpdateInstanceState(ctx, instanceID, core.StatePausing, core.StateAllocated)
}

// Resume moves an instance from PAUSED to RESUMING. The caller must follow up
// with a real cloud StartInstance call and then transition RESUMING -> ALLOCATED
// via MarkResumed (or roll back via RollbackResuming on failure).
//
// Implements R-F（2026-05-15，对偶 Pause 侧 Q26-D 修订版）：trade pass renew 走
// "开机恢复数据"路径，对偶 PAUSED → RESUMING → ALLOCATED；详见
// .tmp/trade-pass-renew-design.md §10 R-F。
func (s *Service) Resume(ctx context.Context, instanceID string) (core.Instance, error) {
	inst, err := s.store.GetInstance(ctx, instanceID)
	if err != nil {
		return core.Instance{}, err
	}
	switch inst.State {
	case core.StatePaused:
		return s.store.UpdateInstanceState(ctx, instanceID, core.StatePaused, core.StateResuming)
	case core.StateResuming, core.StateAllocated:
		// Idempotent: caller is retrying or resume already applied.
		return inst, nil
	default:
		return core.Instance{}, core.ErrInvalidTransition
	}
}

// MarkResumed transitions RESUMING to ALLOCATED after the cloud-side StartInstance
// call has succeeded. Idempotent for an already-allocated instance.
func (s *Service) MarkResumed(ctx context.Context, instanceID string) (core.Instance, error) {
	inst, err := s.store.GetInstance(ctx, instanceID)
	if err != nil {
		return core.Instance{}, err
	}
	switch inst.State {
	case core.StateResuming:
		return s.store.UpdateInstanceState(ctx, instanceID, core.StateResuming, core.StateAllocated)
	case core.StateAllocated:
		return inst, nil
	default:
		return core.Instance{}, core.ErrInvalidTransition
	}
}

// RollbackResuming rolls a RESUMING instance back to PAUSED when the cloud-side
// StartInstance call fails irrecoverably. The caller (handler) is responsible
// for surfacing the error to the upstream pass renew flow so it can retry
// within the 1h ctl child-task window.
func (s *Service) RollbackResuming(ctx context.Context, instanceID string) (core.Instance, error) {
	inst, err := s.store.GetInstance(ctx, instanceID)
	if err != nil {
		return core.Instance{}, err
	}
	if inst.State != core.StateResuming {
		return core.Instance{}, core.ErrInvalidTransition
	}
	return s.store.UpdateInstanceState(ctx, instanceID, core.StateResuming, core.StatePaused)
}

// MarkCleanInstancesDry transitions all current CLEAN inventory in a pool to DRY.
// This is used when the pool image changes so workers can recycle standby stock.
func (s *Service) MarkCleanInstancesDry(ctx context.Context, poolID string) error {
	insts, err := s.store.ListInstancesByStates(ctx, poolID, []core.InstanceState{core.StateClean}, 0)
	if err != nil {
		return err
	}
	for _, inst := range insts {
		if _, err := s.store.UpdateInstanceState(ctx, inst.ID, core.StateClean, core.StateDry); err != nil {
			if errors.Is(err, core.ErrInvalidTransition) {
				continue
			}
			return err
		}
	}
	return nil
}

// AdvanceState is called by workers to progress lifecycle.
func (s *Service) AdvanceState(ctx context.Context, instanceID string, target core.InstanceState) (core.Instance, error) {
	inst, err := s.store.GetInstance(ctx, instanceID)
	if err != nil {
		return core.Instance{}, err
	}
	if !isAllowed(inst.State, target) {
		return core.Instance{}, core.ErrInvalidTransition
	}
	return s.store.UpdateInstanceState(ctx, instanceID, inst.State, target)
}

// GetInstance fetches a single instance.
func (s *Service) GetInstance(ctx context.Context, id string) (core.Instance, error) {
	return s.store.GetInstance(ctx, id)
}

// DeleteInstance removes an instance record (used for FAILED cleanup).
func (s *Service) DeleteInstance(ctx context.Context, id string) error {
	return s.store.DeleteInstance(ctx, id)
}

// Sandbox helpers
func (s *Service) CreateSandbox(ctx context.Context, sb core.Sandbox) (core.Sandbox, error) {
	if sb.ID == "" {
		sb.ID = uuid.NewString()
	}
	now := time.Now().UTC()
	if sb.CreatedAt.IsZero() {
		sb.CreatedAt = now
	}
	sb.UpdatedAt = now
	return s.store.CreateSandbox(ctx, sb)
}

func (s *Service) GetSandbox(ctx context.Context, id string) (core.Sandbox, error) {
	return s.store.GetSandbox(ctx, id)
}

func (s *Service) ListSandboxes(ctx context.Context) ([]core.Sandbox, error) {
	return s.store.ListSandboxes(ctx)
}

func (s *Service) DeleteSandbox(ctx context.Context, id string) error {
	return s.store.DeleteSandbox(ctx, id)
}

func (s *Service) UpsertTemplateClass(ctx context.Context, templateClass core.TemplateClass) (core.TemplateClass, error) {
	now := time.Now().UTC()
	if templateClass.CreatedAt.IsZero() {
		templateClass.CreatedAt = now
	}
	templateClass.UpdatedAt = now
	var err error
	templateClass, err = normalizeTemplateClass(templateClass)
	if err != nil {
		return core.TemplateClass{}, err
	}
	return s.store.UpsertTemplateClass(ctx, templateClass)
}

func (s *Service) GetTemplateClass(ctx context.Context, id string) (core.TemplateClass, error) {
	return s.store.GetTemplateClass(ctx, id)
}

func (s *Service) ListTemplateClasses(ctx context.Context) ([]core.TemplateClass, error) {
	return s.store.ListTemplateClasses(ctx)
}

func (s *Service) UpsertSKU(ctx context.Context, sku core.SKU) (core.SKU, error) {
	now := time.Now().UTC()
	if sku.CreatedAt.IsZero() {
		sku.CreatedAt = now
	}
	sku.UpdatedAt = now
	var err error
	sku, err = normalizeSKU(sku)
	if err != nil {
		return core.SKU{}, err
	}
	if _, err := s.store.GetTemplateClass(ctx, sku.TemplateClassID); err != nil {
		return core.SKU{}, err
	}
	return s.store.UpsertSKU(ctx, sku)
}

func (s *Service) GetSKU(ctx context.Context, id string) (core.SKU, error) {
	return s.store.GetSKU(ctx, id)
}

func (s *Service) ListSKUs(ctx context.Context) ([]core.SKU, error) {
	return s.store.ListSKUs(ctx)
}

func (s *Service) ListPoolsForSKU(ctx context.Context, skuID string) ([]core.Pool, error) {
	skuID = strings.TrimSpace(skuID)
	if skuID == "" {
		return []core.Pool{}, nil
	}
	pools, err := s.store.ListPools(ctx)
	if err != nil {
		return nil, err
	}
	filtered := make([]core.Pool, 0, len(pools))
	for _, pool := range pools {
		if pool.SKUID != skuID {
			continue
		}
		filtered = append(filtered, pool)
	}
	sort.SliceStable(filtered, func(i, j int) bool { return filtered[i].ID < filtered[j].ID })
	return filtered, nil
}

func (s *Service) UpsertTemplateSkuBinding(ctx context.Context, binding core.TemplateSkuBinding) (core.TemplateSkuBinding, error) {
	now := time.Now().UTC()
	if binding.CreatedAt.IsZero() {
		binding.CreatedAt = now
	}
	binding.UpdatedAt = now
	var err error
	binding, err = normalizeTemplateSkuBinding(binding)
	if err != nil {
		return core.TemplateSkuBinding{}, err
	}
	if _, err := s.store.GetTemplateClass(ctx, binding.TemplateClassID); err != nil {
		return core.TemplateSkuBinding{}, err
	}
	sku, err := s.store.GetSKU(ctx, binding.SKUID)
	if err != nil {
		return core.TemplateSkuBinding{}, err
	}
	if sku.TemplateClassID != binding.TemplateClassID {
		return core.TemplateSkuBinding{}, fmt.Errorf("sku %s belongs to template class %s, not %s", binding.SKUID, sku.TemplateClassID, binding.TemplateClassID)
	}
	return s.store.UpsertTemplateSkuBinding(ctx, binding)
}

func (s *Service) ListTemplateSkuBindings(ctx context.Context, templateClassID string) ([]core.TemplateSkuBinding, error) {
	if _, err := s.store.GetTemplateClass(ctx, templateClassID); err != nil {
		return nil, err
	}
	return s.store.ListTemplateSkuBindings(ctx, templateClassID)
}

func (s *Service) ReplaceTemplateSkuBindings(ctx context.Context, templateClassID string, bindings []core.TemplateSkuBinding) ([]core.TemplateSkuBinding, error) {
	if _, err := s.store.GetTemplateClass(ctx, templateClassID); err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	normalized := make([]core.TemplateSkuBinding, 0, len(bindings))
	for _, binding := range bindings {
		binding.TemplateClassID = templateClassID
		if binding.CreatedAt.IsZero() {
			binding.CreatedAt = now
		}
		binding.UpdatedAt = now
		var err error
		binding, err = normalizeTemplateSkuBinding(binding)
		if err != nil {
			return nil, err
		}
		sku, err := s.store.GetSKU(ctx, binding.SKUID)
		if err != nil {
			return nil, err
		}
		if sku.TemplateClassID != templateClassID {
			return nil, fmt.Errorf("sku %s belongs to template class %s, not %s", binding.SKUID, sku.TemplateClassID, templateClassID)
		}
		normalized = append(normalized, binding)
	}
	sort.SliceStable(normalized, func(i, j int) bool {
		if normalized[i].Priority != normalized[j].Priority {
			return normalized[i].Priority < normalized[j].Priority
		}
		if normalized[i].Weight != normalized[j].Weight {
			return normalized[i].Weight > normalized[j].Weight
		}
		return normalized[i].SKUID < normalized[j].SKUID
	})
	return s.store.ReplaceTemplateSkuBindings(ctx, templateClassID, normalized)
}

func (s *Service) UpsertTemplatePoolBinding(ctx context.Context, binding core.TemplatePoolBinding) (core.TemplatePoolBinding, error) {
	if _, err := s.store.GetTemplateClass(ctx, binding.TemplateClassID); err != nil {
		return core.TemplatePoolBinding{}, err
	}
	binding, err := s.prepareTemplatePoolBinding(ctx, binding, "", time.Now().UTC())
	if err != nil {
		return core.TemplatePoolBinding{}, err
	}
	return s.store.UpsertTemplatePoolBinding(ctx, binding)
}

func (s *Service) ListTemplatePoolBindings(ctx context.Context, templateClassID string) ([]core.TemplatePoolBinding, error) {
	if _, err := s.store.GetTemplateClass(ctx, templateClassID); err != nil {
		return nil, err
	}
	bindings, err := s.store.ListTemplatePoolBindings(ctx, templateClassID)
	if err != nil {
		return nil, err
	}
	sortTemplatePoolBindings(bindings)
	return bindings, nil
}

func (s *Service) ReplaceTemplatePoolBindings(ctx context.Context, templateClassID string, bindings []core.TemplatePoolBinding) ([]core.TemplatePoolBinding, error) {
	if _, err := s.store.GetTemplateClass(ctx, templateClassID); err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	normalized := make([]core.TemplatePoolBinding, 0, len(bindings))
	for _, binding := range bindings {
		var err error
		binding, err = s.prepareTemplatePoolBinding(ctx, binding, templateClassID, now)
		if err != nil {
			return nil, err
		}
		normalized = append(normalized, binding)
	}
	sortTemplatePoolBindings(normalized)
	return s.store.ReplaceTemplatePoolBindings(ctx, templateClassID, normalized)
}

func (s *Service) DeleteTemplatePoolBinding(ctx context.Context, templateClassID string, poolID string) error {
	return s.store.DeleteTemplatePoolBinding(ctx, templateClassID, poolID)
}

func (s *Service) ReconcileTemplateBindingAdmissions(ctx context.Context) (int, error) {
	templateClasses, err := s.store.ListTemplateClasses(ctx)
	if err != nil {
		return 0, err
	}
	updated := 0
	for _, templateClass := range templateClasses {
		bindings, err := s.ListTemplatePoolBindings(ctx, templateClass.ID)
		if err != nil {
			return updated, err
		}
		if len(bindings) == 0 {
			continue
		}
		changed := false
		for _, binding := range bindings {
			pool, err := s.store.GetPool(ctx, binding.PoolID)
			if err != nil {
				return updated, err
			}
			nextState, nextReason, shouldApply := reconciledBindingAdmission(binding, pool)
			if !shouldApply {
				continue
			}
			if _, err := s.store.UpdateTemplatePoolBindingAdmission(ctx, binding.TemplateClassID, binding.PoolID, nextState, nextReason); err != nil {
				return updated, err
			}
			changed = true
		}
		if !changed {
			continue
		}
		updated++
	}
	return updated, nil
}

func (s *Service) ResolveTemplateClassPools(ctx context.Context, templateClassID string) (core.TemplateClass, []core.TemplatePoolBinding, []core.Pool, error) {
	templateClass, err := s.store.GetTemplateClass(ctx, templateClassID)
	if err != nil {
		return core.TemplateClass{}, nil, nil, err
	}
	bindings, err := s.ListTemplatePoolBindings(ctx, templateClassID)
	if err != nil {
		return core.TemplateClass{}, nil, nil, err
	}
	skuBindings, err := s.store.ListTemplateSkuBindings(ctx, templateClassID)
	if err != nil {
		return core.TemplateClass{}, nil, nil, err
	}
	if len(skuBindings) > 0 {
		sortTemplateSKUBindings(skuBindings)
		pools, err := s.resolvePoolsForTemplateSKUs(ctx, skuBindings)
		if err != nil {
			return core.TemplateClass{}, nil, nil, err
		}
		return templateClass, bindings, pools, nil
	}
	activeBindings, poolIDs := activeTemplateBindings(bindings)
	pools, err := s.store.ListPoolsByIDs(ctx, poolIDs)
	if err != nil {
		return core.TemplateClass{}, nil, nil, err
	}
	byID := make(map[string]core.Pool, len(pools))
	for _, pool := range pools {
		byID[pool.ID] = pool
	}
	resolved := make([]core.Pool, 0, len(activeBindings))
	for _, binding := range activeBindings {
		pool, ok := byID[binding.PoolID]
		if !ok {
			continue
		}
		if !poolEligibleForAdmission(pool) {
			continue
		}
		resolved = append(resolved, pool)
	}
	return templateClass, bindings, resolved, nil
}

func (s *Service) resolvePoolsForTemplateSKUs(ctx context.Context, bindings []core.TemplateSkuBinding) ([]core.Pool, error) {
	skus, err := s.store.ListSKUs(ctx)
	if err != nil {
		return nil, err
	}
	skuByID := make(map[string]core.SKU, len(skus))
	for _, sku := range skus {
		skuByID[sku.ID] = sku
	}
	pools, err := s.store.ListPools(ctx)
	if err != nil {
		return nil, err
	}
	poolsBySKU := make(map[string][]core.Pool)
	for _, pool := range pools {
		if strings.TrimSpace(pool.SKUID) == "" {
			continue
		}
		if !poolEligibleForAdmission(pool) {
			continue
		}
		poolsBySKU[pool.SKUID] = append(poolsBySKU[pool.SKUID], pool)
	}
	resolved := make([]core.Pool, 0)
	for _, binding := range bindings {
		if strings.TrimSpace(binding.AdmissionState) != "" && binding.AdmissionState != "active" {
			continue
		}
		if !binding.RolloutEligibility {
			continue
		}
		if _, ok := skuByID[binding.SKUID]; !ok {
			continue
		}
		if strings.TrimSpace(binding.RegionAffinity) != "" {
			for _, pool := range poolsBySKU[binding.SKUID] {
				if regionFromZone(pool.Zone) == binding.RegionAffinity {
					resolved = append(resolved, pool)
				}
			}
			continue
		}
		resolved = append(resolved, poolsBySKU[binding.SKUID]...)
	}
	return resolved, nil
}

func activeTemplateBindings(bindings []core.TemplatePoolBinding) ([]core.TemplatePoolBinding, []string) {
	activeBindings := make([]core.TemplatePoolBinding, 0, len(bindings))
	poolIDs := make([]string, 0, len(bindings))
	for _, binding := range bindings {
		if binding.AdmissionState != core.BindingAdmissionStateActive {
			continue
		}
		activeBindings = append(activeBindings, binding)
		poolIDs = append(poolIDs, binding.PoolID)
	}
	return activeBindings, poolIDs
}

func regionFromZone(zone string) string {
	trimmed := strings.TrimSpace(zone)
	if trimmed == "" {
		return ""
	}
	parts := strings.Split(trimmed, "-")
	if len(parts) < 2 {
		return trimmed
	}
	return strings.Join(parts[:2], "-")
}

func (s *Service) PoolRolloutReady(ctx context.Context, pool core.Pool) bool {
	if !poolEligibleForAdmission(pool) {
		return false
	}
	if strings.TrimSpace(pool.BaseImage) == "" {
		return false
	}
	target := pool.DesiredCap
	if target <= 0 {
		return true
	}
	clean, err := s.store.ListInstancesByStates(ctx, pool.ID, []core.InstanceState{core.StateClean}, 0)
	if err != nil {
		return false
	}
	return len(clean) >= target
}

func (s *Service) UpsertPoolAutoscalePolicy(ctx context.Context, policy core.PoolAutoscalePolicy) (core.PoolAutoscalePolicy, error) {
	now := time.Now().UTC()
	if policy.CreatedAt.IsZero() {
		policy.CreatedAt = now
	}
	policy.UpdatedAt = now
	var err error
	policy, err = normalizePoolAutoscalePolicy(policy)
	if err != nil {
		return core.PoolAutoscalePolicy{}, err
	}
	if _, err := s.store.GetTemplateClass(ctx, policy.TemplateClassID); err != nil {
		return core.PoolAutoscalePolicy{}, err
	}
	return s.store.UpsertPoolAutoscalePolicy(ctx, policy)
}

func (s *Service) GetPoolAutoscalePolicy(ctx context.Context, templateClassID string) (core.PoolAutoscalePolicy, error) {
	return s.store.GetPoolAutoscalePolicy(ctx, templateClassID)
}

func (s *Service) UpsertCapacityBundle(ctx context.Context, bundle core.CapacityBundle) (core.CapacityBundle, error) {
	now := time.Now().UTC()
	if bundle.CreatedAt.IsZero() {
		bundle.CreatedAt = now
	}
	bundle.UpdatedAt = now
	var err error
	bundle, err = normalizeCapacityBundle(bundle)
	if err != nil {
		return core.CapacityBundle{}, err
	}
	return s.store.UpsertCapacityBundle(ctx, bundle)
}

func (s *Service) TryStartPoolSGShardRecovery(ctx context.Context, poolID string) (core.Pool, bool, error) {
	poolID = strings.TrimSpace(poolID)
	if poolID == "" {
		return core.Pool{}, false, fmt.Errorf("missing pool id")
	}
	return s.store.TryStartPoolSGShardRecovery(ctx, poolID)
}

func (s *Service) BeginSKUPoolRollout(ctx context.Context, skuID string, poolID string, desiredImage string, startedAt time.Time) (core.SKU, core.Pool, error) {
	skuID = strings.TrimSpace(skuID)
	poolID = strings.TrimSpace(poolID)
	desiredImage = strings.TrimSpace(desiredImage)
	if skuID == "" || poolID == "" || desiredImage == "" {
		return core.SKU{}, core.Pool{}, fmt.Errorf("missing sku rollout parameters")
	}
	return s.store.BeginSKUPoolRollout(ctx, skuID, poolID, desiredImage, startedAt.UTC())
}

func (s *Service) GetCapacityBundle(ctx context.Context, id string) (core.CapacityBundle, error) {
	return s.store.GetCapacityBundle(ctx, id)
}

func (s *Service) ListCapacityBundles(ctx context.Context) ([]core.CapacityBundle, error) {
	return s.store.ListCapacityBundles(ctx)
}

func (s *Service) AllocateForRequest(ctx context.Context, templateClassID, legacyTemplateID, requestedSKUID string) (AllocationResolution, error) {
	templateClassID = strings.TrimSpace(templateClassID)
	legacyTemplateID = strings.TrimSpace(legacyTemplateID)
	requestedSKUID = strings.TrimSpace(requestedSKUID)
	if templateClassID == "" {
		if legacyTemplateID == "" {
			pool, inst, err := s.AllocateAny(ctx, 0)
			if err != nil {
				return AllocationResolution{}, err
			}
			return AllocationResolution{
				Pool:             pool,
				Instance:         inst,
				SKUID:            pool.SKUID,
				ResolutionSource: "super_pool",
			}, nil
		}
		pool, err := s.GetPool(ctx, legacyTemplateID)
		if err != nil {
			return AllocationResolution{}, err
		}
		inst, err := s.Allocate(ctx, pool.ID)
		if err != nil {
			return AllocationResolution{}, err
		}
		return AllocationResolution{
			Pool:             pool,
			Instance:         inst,
			SKUID:            pool.SKUID,
			ResolutionMode:   core.ResolutionModeLegacy,
			ResolutionSource: "legacy_template_id",
		}, nil
	}

	templateClass, bindings, resolvedPools, err := s.resolveTemplateClassPoolsForAllocation(ctx, templateClassID, requestedSKUID)
	if err != nil {
		return AllocationResolution{}, err
	}
	skuBindings, err := s.ListTemplateSkuBindings(ctx, templateClassID)
	if err != nil && !errors.Is(err, core.ErrTemplateClassNotFound) {
		return AllocationResolution{}, err
	}
	base := AllocationResolution{
		TemplateClassID: templateClassID,
		ResolutionMode:  templateClass.ResolutionMode,
		SKUID:           requestedSKUID,
	}
	switch templateClass.ResolutionMode {
	case core.ResolutionModeLegacy:
		if legacyTemplateID != "" {
			return s.allocateLegacyResolution(ctx, base, legacyTemplateID, resolvedPools, "legacy_template_id")
		}
		return AllocationResolution{}, fmt.Errorf("legacy resolution mode requires legacy templateID")
	case core.ResolutionModeShadow:
		if legacyTemplateID != "" {
			return s.allocateLegacyResolution(ctx, base, legacyTemplateID, resolvedPools, "shadow_legacy")
		}
		return s.allocateResolvedResolution(ctx, base, resolvedPools, "shadow_binding")
	case core.ResolutionModeSandboxPrimary:
		if requestedSKUID == "" {
			preferredSKUID, err := s.preferredSKUIDForAllocation(ctx, templateClassID)
			if err != nil {
				return AllocationResolution{}, err
			}
			if preferredSKUID != "" {
				preferredTemplateClass, _, preferredPools, err := s.resolveTemplateClassPoolsForAllocation(ctx, templateClassID, preferredSKUID)
				if err != nil && !errors.Is(err, core.ErrSKUNotFound) {
					return AllocationResolution{}, err
				}
				if len(preferredPools) > 0 {
					preferredBase := AllocationResolution{
						TemplateClassID: templateClassID,
						ResolutionMode:  preferredTemplateClass.ResolutionMode,
						SKUID:           preferredSKUID,
					}
					preferredResolution, err := s.allocateResolvedResolution(ctx, preferredBase, preferredPools, "sandbox_binding")
					if err == nil {
						return preferredResolution, nil
					}
					if !errors.Is(err, core.ErrNoCleanInstance) {
						return AllocationResolution{}, err
					}
				}
			}
		}
		if len(resolvedPools) > 0 {
			return s.allocateResolvedResolution(ctx, base, resolvedPools, "sandbox_binding")
		}
		if legacyTemplateID != "" && len(bindings) == 0 && len(skuBindings) == 0 {
			return s.allocateLegacyResolution(ctx, base, legacyTemplateID, resolvedPools, "legacy_compat_fallback")
		}
		return AllocationResolution{}, core.ErrNoCleanInstance
	default:
		return AllocationResolution{}, fmt.Errorf("unsupported resolution mode %q", templateClass.ResolutionMode)
	}
}

func (s *Service) allocateResolvedResolution(ctx context.Context, base AllocationResolution, pools []core.Pool, source string) (AllocationResolution, error) {
	pool, inst, err := s.allocateFromResolvedPools(ctx, pools)
	if err != nil {
		return AllocationResolution{}, err
	}
	base.Pool = pool
	base.Instance = inst
	if base.SKUID == "" {
		base.SKUID = pool.SKUID
	}
	base.ResolutionSource = source
	return base, nil
}

func (s *Service) allocateLegacyResolution(ctx context.Context, base AllocationResolution, legacyTemplateID string, resolvedPools []core.Pool, source string) (AllocationResolution, error) {
	pool, inst, divergence, err := s.allocateFromLegacyPool(ctx, legacyTemplateID, resolvedPools)
	if err != nil {
		return AllocationResolution{}, err
	}
	base.Pool = pool
	base.Instance = inst
	if base.SKUID == "" {
		base.SKUID = pool.SKUID
	}
	base.ResolutionSource = source
	base.Divergence = divergence
	return base, nil
}

func (s *Service) resolveTemplateClassPoolsForAllocation(ctx context.Context, templateClassID, requestedSKUID string) (core.TemplateClass, []core.TemplatePoolBinding, []core.Pool, error) {
	templateClass, err := s.store.GetTemplateClass(ctx, templateClassID)
	if err != nil {
		return core.TemplateClass{}, nil, nil, err
	}
	bindings, err := s.ListTemplatePoolBindings(ctx, templateClassID)
	if err != nil {
		return core.TemplateClass{}, nil, nil, err
	}
	skuBindings, err := s.store.ListTemplateSkuBindings(ctx, templateClassID)
	if err != nil {
		return core.TemplateClass{}, nil, nil, err
	}
	if len(skuBindings) == 0 {
		if requestedSKUID != "" {
			return core.TemplateClass{}, nil, nil, core.ErrSKUNotFound
		}
		return s.ResolveTemplateClassPools(ctx, templateClassID)
	}
	selectedBindings, err := s.selectTemplateSKUBindingsForAllocation(ctx, templateClassID, requestedSKUID, skuBindings)
	if err != nil {
		return core.TemplateClass{}, nil, nil, err
	}
	pools, err := s.resolvePoolsForTemplateSKUs(ctx, selectedBindings)
	if err != nil {
		return core.TemplateClass{}, nil, nil, err
	}
	return templateClass, bindings, pools, nil
}

func (s *Service) selectTemplateSKUBindingsForAllocation(ctx context.Context, templateClassID, requestedSKUID string, bindings []core.TemplateSkuBinding) ([]core.TemplateSkuBinding, error) {
	bindings = append([]core.TemplateSkuBinding(nil), bindings...)
	sortTemplateSKUBindings(bindings)
	skus, err := s.store.ListSKUs(ctx)
	if err != nil {
		return nil, err
	}
	skuByID := make(map[string]core.SKU, len(skus))
	for _, sku := range skus {
		skuByID[sku.ID] = sku
	}
	if requestedSKUID != "" {
		sku, ok := skuByID[requestedSKUID]
		if !ok || sku.TemplateClassID != templateClassID {
			return nil, core.ErrSKUNotFound
		}
		return filterRequestedSKUBindings(bindings, requestedSKUID)
	}
	for _, binding := range bindings {
		sku, ok := skuByID[binding.SKUID]
		if !ok {
			continue
		}
		if sku.TemplateClassID != templateClassID {
			return nil, fmt.Errorf("sku %s belongs to template class %s, not %s", binding.SKUID, sku.TemplateClassID, templateClassID)
		}
	}
	return bindings, nil
}

func filterRequestedSKUBindings(bindings []core.TemplateSkuBinding, requestedSKUID string) ([]core.TemplateSkuBinding, error) {
	if requestedSKUID == "" {
		return bindings, nil
	}
	filtered := make([]core.TemplateSkuBinding, 0, len(bindings))
	for _, binding := range bindings {
		if binding.SKUID != requestedSKUID {
			continue
		}
		filtered = append(filtered, binding)
	}
	if len(filtered) == 0 {
		return nil, core.ErrSKUNotFound
	}
	return filtered, nil
}

func (s *Service) preferredSKUIDForAllocation(ctx context.Context, templateClassID string) (string, error) {
	if templateClassID != hermesTemplateClassID {
		return "", nil
	}
	bindings, err := s.store.ListTemplateSkuBindings(ctx, templateClassID)
	if err != nil {
		return "", err
	}
	sortTemplateSKUBindings(bindings)
	skus, err := s.store.ListSKUs(ctx)
	if err != nil {
		return "", err
	}
	skuByID := make(map[string]core.SKU, len(skus))
	for _, sku := range skus {
		skuByID[sku.ID] = sku
	}
	for _, binding := range bindings {
		sku, ok := skuByID[binding.SKUID]
		if !ok {
			continue
		}
		if sku.TemplateClassID != templateClassID {
			return "", fmt.Errorf("sku %s belongs to template class %s, not %s", binding.SKUID, sku.TemplateClassID, templateClassID)
		}
		if strings.TrimSpace(sku.InstanceType) == hermesPreferredInstanceType {
			return sku.ID, nil
		}
	}
	return "", nil
}

func sortTemplateSKUBindings(bindings []core.TemplateSkuBinding) {
	sort.SliceStable(bindings, func(i, j int) bool {
		if bindings[i].Priority != bindings[j].Priority {
			return bindings[i].Priority < bindings[j].Priority
		}
		if bindings[i].Weight != bindings[j].Weight {
			return bindings[i].Weight > bindings[j].Weight
		}
		return bindings[i].SKUID < bindings[j].SKUID
	})
}

func (s *Service) allocateFromResolvedPools(ctx context.Context, pools []core.Pool) (core.Pool, core.Instance, error) {
	for _, pool := range pools {
		inst, err := s.Allocate(ctx, pool.ID)
		if err == nil {
			return pool, inst, nil
		}
		if errors.Is(err, core.ErrNoCleanInstance) || errors.Is(err, core.ErrPoolNotFound) {
			continue
		}
		return core.Pool{}, core.Instance{}, err
	}
	return core.Pool{}, core.Instance{}, core.ErrNoCleanInstance
}

func (s *Service) allocateFromLegacyPool(ctx context.Context, legacyTemplateID string, resolvedPools []core.Pool) (core.Pool, core.Instance, string, error) {
	pool, err := s.GetPool(ctx, legacyTemplateID)
	if err != nil {
		return core.Pool{}, core.Instance{}, "", err
	}
	if !poolEligibleForAdmission(pool) {
		return core.Pool{}, core.Instance{}, "", core.ErrNoCleanInstance
	}
	inst, err := s.Allocate(ctx, legacyTemplateID)
	if err != nil {
		return core.Pool{}, core.Instance{}, "", err
	}
	divergence := ""
	if len(resolvedPools) == 0 {
		divergence = "legacy pool used without active sandbox bindings"
	} else if !slices.ContainsFunc(resolvedPools, func(item core.Pool) bool { return item.ID == legacyTemplateID }) {
		divergence = fmt.Sprintf("legacy pool %s not present in active sandbox bindings", legacyTemplateID)
	}
	return pool, inst, divergence, nil
}

func poolEligibleForAdmission(pool core.Pool) bool {
	if pool.Status != core.PoolStatusActive {
		return false
	}
	switch pool.CapacityState {
	case "", core.PoolCapacityStateActive:
		return true
	default:
		return false
	}
}

func desiredBindingAdmissionFromPool(pool core.Pool) (core.BindingAdmissionState, string) {
	if pool.Status != core.PoolStatusActive {
		return core.BindingAdmissionStatePaused, autoAdmissionReason(firstNonEmptyString(strings.TrimSpace(pool.PauseReason), "pool paused"))
	}
	switch pool.CapacityState {
	case "", core.PoolCapacityStateActive:
		return core.BindingAdmissionStateActive, ""
	case core.PoolCapacityStateDraining, core.PoolCapacityStateRetiring:
		return core.BindingAdmissionStateDraining, autoAdmissionReason("pool draining")
	case core.PoolCapacityStatePaused:
		return core.BindingAdmissionStatePaused, autoAdmissionReason("pool capacity paused")
	case core.PoolCapacityStateQuarantined:
		return core.BindingAdmissionStateQuarantined, autoAdmissionReason("pool quarantined")
	default:
		return core.BindingAdmissionStateQuarantined, autoAdmissionReason("pool capacity unavailable")
	}
}

func firstNonEmptyString(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func autoAdmissionReason(reason string) string {
	trimmed := strings.TrimSpace(reason)
	if trimmed == "" {
		return "auto:derived"
	}
	return "auto:" + trimmed
}

func isAutoAdmissionReason(reason string) bool {
	return strings.HasPrefix(strings.TrimSpace(reason), "auto:")
}

func reconciledBindingAdmission(binding core.TemplatePoolBinding, pool core.Pool) (core.BindingAdmissionState, string, bool) {
	desiredState, desiredReason := desiredBindingAdmissionFromPool(pool)
	currentReason := strings.TrimSpace(binding.Reason)

	if binding.AdmissionState == desiredState && currentReason == desiredReason {
		return binding.AdmissionState, binding.Reason, false
	}

	if desiredState == core.BindingAdmissionStateActive {
		if binding.AdmissionState == core.BindingAdmissionStateActive {
			return binding.AdmissionState, binding.Reason, false
		}
		if !isAutoAdmissionReason(currentReason) {
			return binding.AdmissionState, binding.Reason, false
		}
		return core.BindingAdmissionStateActive, "", true
	}

	if binding.AdmissionState != core.BindingAdmissionStateActive && !isAutoAdmissionReason(currentReason) {
		return binding.AdmissionState, binding.Reason, false
	}

	return desiredState, desiredReason, true
}

func (s *Service) WarmCapacityBundleCount(ctx context.Context, templateClassID string) (int, error) {
	templateClassID = strings.TrimSpace(templateClassID)
	if templateClassID == "" {
		return 0, fmt.Errorf("missing template_class_id")
	}
	bundles, err := s.store.ListCapacityBundles(ctx)
	if err != nil {
		return 0, err
	}
	count := 0
	for _, bundle := range bundles {
		if strings.TrimSpace(bundle.LineageTags["template_class_id"]) != templateClassID {
			continue
		}
		switch bundle.Status {
		case core.CapacityBundleStatusWarm, core.CapacityBundleStatusActive:
			count++
		}
	}
	return count, nil
}

func (s *Service) WarmCapacityBundleCountForSKU(ctx context.Context, skuID string) (int, error) {
	skuID = strings.TrimSpace(skuID)
	if skuID == "" {
		return 0, fmt.Errorf("missing sku_id")
	}
	bundles, err := s.store.ListCapacityBundles(ctx)
	if err != nil {
		return 0, err
	}
	count := 0
	for _, bundle := range bundles {
		if strings.TrimSpace(bundle.LineageTags["sku_id"]) != skuID {
			continue
		}
		switch bundle.Status {
		case core.CapacityBundleStatusWarm, core.CapacityBundleStatusActive:
			count++
		}
	}
	return count, nil
}

func (s *Service) EnsurePoolForCapacityBundle(ctx context.Context, binding core.TemplateSkuBinding, sku core.SKU, bundleID string) (core.Pool, bool, error) {
	if strings.TrimSpace(bundleID) == "" {
		return core.Pool{}, false, fmt.Errorf("missing capacity bundle id")
	}
	if strings.TrimSpace(binding.TemplateClassID) == "" {
		return core.Pool{}, false, fmt.Errorf("missing template_class_id")
	}
	if binding.SKUID != sku.ID {
		return core.Pool{}, false, fmt.Errorf("template sku binding %s does not match sku %s", binding.SKUID, sku.ID)
	}
	bundle, err := s.store.GetCapacityBundle(ctx, bundleID)
	if err != nil {
		return core.Pool{}, false, err
	}
	if existingTemplateClass := strings.TrimSpace(bundle.LineageTags["template_class_id"]); existingTemplateClass != "" && existingTemplateClass != binding.TemplateClassID {
		err := fmt.Errorf("capacity bundle %s belongs to template class %s, not %s", bundleID, existingTemplateClass, binding.TemplateClassID)
		emitCapacityBundleConflict(ctx, "当前容量 bundle 已归属于别的模板类，控制器拒绝把它拿来给当前模板类派生 pool，避免串用网络资源。", attribute.String("bundle_id", bundleID), attribute.String("requested_template_class_id", binding.TemplateClassID), attribute.String("existing_template_class_id", existingTemplateClass), attribute.String("error", err.Error()))
		return core.Pool{}, false, err
	}
	if existingSKUID := strings.TrimSpace(bundle.LineageTags["sku_id"]); existingSKUID != "" && existingSKUID != sku.ID {
		err := fmt.Errorf("capacity bundle %s belongs to sku %s, not %s", bundleID, existingSKUID, sku.ID)
		emitCapacityBundleConflict(ctx, "当前容量 bundle 已归属于别的 SKU，控制器拒绝复用这份网络切片，避免不同规格源混用同一个 bundle。", attribute.String("bundle_id", bundleID), attribute.String("requested_sku_id", sku.ID), attribute.String("existing_sku_id", existingSKUID), attribute.String("error", err.Error()))
		return core.Pool{}, false, err
	}
	poolID := strings.TrimSpace(bundle.LineageTags["pool_id"])
	if poolID == "" {
		poolID = s.nextID("pool")
		bundle, err = s.store.ReserveCapacityBundleForPool(ctx, bundleID, binding.TemplateClassID, sku.ID, poolID)
		if err != nil {
			emitCapacityBundleConflict(ctx, "控制器尝试预占容量 bundle 给新 pool 时失败，通常表示该 bundle 已被别的 pool 抢占或状态已不再可用。", attribute.String("bundle_id", bundleID), attribute.String("requested_pool_id", poolID), attribute.String("requested_sku_id", sku.ID), attribute.String("error", err.Error()))
			return core.Pool{}, false, err
		}
		poolID = strings.TrimSpace(bundle.LineageTags["pool_id"])
	}
	if poolID == "" {
		return core.Pool{}, false, fmt.Errorf("capacity bundle %s did not produce a pool id", bundleID)
	}
	if existing, err := s.store.GetPool(ctx, poolID); err == nil {
		if existing.SKUID != "" && existing.SKUID != sku.ID {
			err := fmt.Errorf("capacity bundle %s points to pool %s owned by sku %s", bundleID, existing.ID, existing.SKUID)
			emitCapacityBundleConflict(ctx, "容量 bundle 虽然已经绑定到 pool，但这个 pool 属于另一个 SKU，控制器拒绝继续沿用这条映射。", attribute.String("bundle_id", bundleID), attribute.String("pool_id", existing.ID), attribute.String("requested_sku_id", sku.ID), attribute.String("existing_sku_id", existing.SKUID), attribute.String("error", err.Error()))
			return core.Pool{}, false, err
		}
		if existing.TemplateClassID != "" && existing.TemplateClassID != binding.TemplateClassID {
			err := fmt.Errorf("capacity bundle %s points to pool %s owned by template class %s", bundleID, existing.ID, existing.TemplateClassID)
			emitCapacityBundleConflict(ctx, "容量 bundle 虽然已经绑定到 pool，但这个 pool 属于另一个模板类，控制器拒绝把它重新接入当前模板类。", attribute.String("bundle_id", bundleID), attribute.String("pool_id", existing.ID), attribute.String("requested_template_class_id", binding.TemplateClassID), attribute.String("existing_template_class_id", existing.TemplateClassID), attribute.String("error", err.Error()))
			return core.Pool{}, false, err
		}
		bindingItem := templatePoolBindingFromSKU(binding, existing.ID)
		if _, err := s.UpsertTemplatePoolBinding(ctx, bindingItem); err != nil {
			return core.Pool{}, false, err
		}
		return existing, false, nil
	} else if !errors.Is(err, core.ErrPoolNotFound) {
		return core.Pool{}, false, err
	}

	now := time.Now().UTC()
	desiredCap := sku.DefaultDesiredCapacity
	if desiredCap <= 0 {
		desiredCap = 1
	}
	pool := core.Pool{
		ID:                  poolID,
		Name:                derivedPoolName(sku.ID, bundle.ID),
		Description:         fmt.Sprintf("derived from sku %s", sku.ID),
		BaseImage:           firstNonEmptyString(strings.TrimSpace(sku.DesiredImageID), strings.TrimSpace(sku.BaseImage)),
		DesiredCap:          desiredCap,
		InstanceType:        firstNonEmptyString(strings.TrimSpace(sku.InstanceType), defaultInstanceType),
		Status:              core.PoolStatusActive,
		VpcID:               bundle.VpcID,
		SubnetID:            bundle.SubnetID,
		Zone:                bundle.Zone,
		SecurityGroups:      append([]string(nil), bundle.SecurityGroupIDs...),
		TemplateClassID:     binding.TemplateClassID,
		SKUID:               sku.ID,
		CapacityState:       core.PoolCapacityStateActive,
		CapacityBundleID:    bundle.ID,
		LastAutoscaleAction: "sku_capacity_growth",
		CreatedAt:           now,
	}
	pool, err = normalizePool(pool)
	if err != nil {
		return core.Pool{}, false, err
	}
	createdPool, err := s.store.CreatePool(ctx, pool)
	if err != nil {
		return core.Pool{}, false, err
	}
	bindingItem := templatePoolBindingFromSKU(binding, createdPool.ID)
	if _, err := s.UpsertTemplatePoolBinding(ctx, bindingItem); err != nil {
		return core.Pool{}, false, err
	}
	return createdPool, true, nil
}

func (s *Service) prepareTemplatePoolBinding(ctx context.Context, binding core.TemplatePoolBinding, templateClassID string, now time.Time) (core.TemplatePoolBinding, error) {
	if templateClassID != "" {
		binding.TemplateClassID = templateClassID
	}
	if binding.CreatedAt.IsZero() {
		binding.CreatedAt = now
	}
	binding.UpdatedAt = now
	var err error
	binding, err = normalizeTemplatePoolBinding(binding)
	if err != nil {
		return core.TemplatePoolBinding{}, err
	}
	if _, err := s.store.GetPool(ctx, binding.PoolID); err != nil {
		return core.TemplatePoolBinding{}, err
	}
	return binding, nil
}

func sortTemplatePoolBindings(bindings []core.TemplatePoolBinding) {
	sort.SliceStable(bindings, func(i, j int) bool {
		if bindings[i].Priority != bindings[j].Priority {
			return bindings[i].Priority < bindings[j].Priority
		}
		if bindings[i].Weight != bindings[j].Weight {
			return bindings[i].Weight > bindings[j].Weight
		}
		return bindings[i].PoolID < bindings[j].PoolID
	})
}

func (s *Service) nextID(prefix string) string {
	val := atomic.AddUint64(&s.idCounter, 1)
	return fmt.Sprintf("%s-%d-%d", prefix, time.Now().UnixNano(), val)
}

func derivedPoolName(skuID string, bundleID string) string {
	skuID = strings.TrimSpace(skuID)
	bundleID = strings.TrimSpace(bundleID)
	if skuID == "" {
		skuID = "sku"
	}
	if bundleID == "" {
		return skuID
	}
	suffix := bundleID
	if idx := strings.LastIndex(bundleID, "-"); idx >= 0 && idx+1 < len(bundleID) {
		suffix = bundleID[idx+1:]
	}
	return fmt.Sprintf("%s-%s", skuID, suffix)
}

func templatePoolBindingFromSKU(binding core.TemplateSkuBinding, poolID string) core.TemplatePoolBinding {
	return core.TemplatePoolBinding{
		TemplateClassID: binding.TemplateClassID,
		PoolID:          poolID,
		Priority:        binding.Priority,
		Weight:          binding.Weight,
		Role:            core.PoolBindingRolePrimary,
		AdmissionState:  core.BindingAdmissionStateActive,
	}
}

func isAllowed(current, target core.InstanceState) bool {
	nexts, ok := allowedTransitions[current]
	if !ok {
		return false
	}
	for _, n := range nexts {
		if n == target {
			return true
		}
	}
	return false
}
