package store

import (
	"context"
	"errors"
	"sort"
	"strings"
	"time"

	"cvm-mock-e2b/internal/core"
)

func (s *MemoryStore) RebindAllocatedInstance(_ context.Context, in RebindInstanceInput) (core.Instance, error) {
	instanceID := strings.TrimSpace(in.InstanceID)
	targetPoolID := strings.TrimSpace(in.TargetPoolID)
	if instanceID == "" || targetPoolID == "" {
		return core.Instance{}, errors.New("rebind requires instance id and target pool id")
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	inst, ok := s.instances[instanceID]
	if !ok {
		return core.Instance{}, core.ErrInstanceNotFound
	}
	if in.ExpectedState != "" && inst.State != in.ExpectedState {
		return core.Instance{}, core.ErrInvalidTransition
	}
	if inst.PoolID == targetPoolID {
		return inst, nil
	}

	now := time.Now().UTC()
	inst.PoolID = targetPoolID
	inst.UpdatedAt = now
	s.instances[instanceID] = inst

	for id, sb := range s.sandboxes {
		if sb.InstanceID != instanceID {
			continue
		}
		sb.PoolID = targetPoolID
		sb.TemplateClassID = in.TemplateClassID
		sb.ResolutionSource = in.ResolutionSource
		sb.UpdatedAt = now
		s.sandboxes[id] = sb
	}
	return inst, nil
}

func (s *MemoryStore) CreateModifyOperation(_ context.Context, op core.ModifyOperation) (core.ModifyOperation, bool, error) {
	if strings.TrimSpace(op.ID) == "" || strings.TrimSpace(op.IdempotencyKey) == "" {
		return core.ModifyOperation{}, false, errors.New("modify operation requires id and idempotency key")
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if existingID, ok := s.modifyOperationKeys[op.IdempotencyKey]; ok {
		existing := s.modifyOperations[existingID]
		if err := assertSameModifyTarget(existing, op); err != nil {
			return core.ModifyOperation{}, false, err
		}
		return existing, false, nil
	}
	s.modifyOperations[op.ID] = op
	s.modifyOperationKeys[op.IdempotencyKey] = op.ID
	return op, true, nil
}

func (s *MemoryStore) GetModifyOperation(_ context.Context, id string) (core.ModifyOperation, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	op, ok := s.modifyOperations[strings.TrimSpace(id)]
	if !ok {
		return core.ModifyOperation{}, core.ErrModifyOperationNotFound
	}
	return op, nil
}

func (s *MemoryStore) GetRunningModifyOperationByInstance(_ context.Context, instanceID string) (core.ModifyOperation, bool, error) {
	id := strings.TrimSpace(instanceID)
	s.mu.RLock()
	defer s.mu.RUnlock()

	var (
		oldest core.ModifyOperation
		found  bool
	)
	for _, op := range s.modifyOperations {
		if op.InstanceID != id || op.Status != core.ModifyOperationStatusRunning {
			continue
		}
		if !found || op.StartedAt.Before(oldest.StartedAt) {
			oldest, found = op, true
		}
	}
	return oldest, found, nil
}

func (s *MemoryStore) UpdateModifyOperationProgress(_ context.Context, in ModifyOperationProgress) (core.ModifyOperation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	op, ok := s.modifyOperations[strings.TrimSpace(in.ID)]
	if !ok {
		return core.ModifyOperation{}, core.ErrModifyOperationNotFound
	}
	op.Status = in.Status
	op.CurrentStep = in.CurrentStep
	op.LastError = in.LastError
	op.CompletedAt = in.CompletedAt
	op.UpdatedAt = time.Now().UTC()
	s.modifyOperations[op.ID] = op
	return op, nil
}

func (s *MemoryStore) ListModifyOperationsByStatus(ctx context.Context, status core.ModifyOperationStatus, limit int) ([]core.ModifyOperation, error) {
	total, index, sharded := shardFromContext(ctx)

	s.mu.RLock()
	defer s.mu.RUnlock()

	items := make([]core.ModifyOperation, 0, len(s.modifyOperations))
	for _, op := range s.modifyOperations {
		if op.Status != status {
			continue
		}
		if sharded && !shardMatch(op.ID, total, index) {
			continue
		}
		items = append(items, op)
	}
	sort.Slice(items, func(i, j int) bool { return items[i].StartedAt.Before(items[j].StartedAt) })
	if limit > 0 && len(items) > limit {
		items = items[:limit]
	}
	return items, nil
}
