package gateway

import (
	"context"
	"sort"
	"time"
)

func (s *MemoryStore) CreateShardExpansion(_ context.Context, expansion ShardExpansion) (ShardExpansion, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if id, ok := s.shardExpansionIdempotency[expansion.IdempotencyKey]; ok {
		return s.shardExpansions[id], false, nil
	}
	if _, ok := s.activeShardExpansions[expansion.ShardID]; ok {
		return ShardExpansion{}, false, ErrShardExpansionAlreadyActive
	}
	now := time.Now().UTC()
	if expansion.CreatedAt.IsZero() {
		expansion.CreatedAt = now
	}
	expansion.UpdatedAt = now
	if expansion.Version <= 0 {
		expansion.Version = 1
	}
	s.shardExpansions[expansion.ID] = expansion
	s.shardExpansionIdempotency[expansion.IdempotencyKey] = expansion.ID
	s.activeShardExpansions[expansion.ShardID] = expansion.ID
	return expansion, true, nil
}

func (s *MemoryStore) GetShardExpansion(_ context.Context, id string) (ShardExpansion, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	expansion, ok := s.shardExpansions[id]
	return expansion, ok, nil
}

func (s *MemoryStore) GetShardExpansionByIdempotencyKey(_ context.Context, key string) (ShardExpansion, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	id, ok := s.shardExpansionIdempotency[key]
	if !ok {
		return ShardExpansion{}, false, nil
	}
	expansion, ok := s.shardExpansions[id]
	return expansion, ok, nil
}

func (s *MemoryStore) ListShardExpansions(_ context.Context, options ShardExpansionListOptions) ([]ShardExpansion, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	wanted := make(map[string]bool, len(options.Statuses))
	for _, status := range options.Statuses {
		wanted[status] = true
	}
	result := make([]ShardExpansion, 0, len(s.shardExpansions))
	for _, expansion := range s.shardExpansions {
		if len(wanted) > 0 && !wanted[expansion.Status] {
			continue
		}
		result = append(result, expansion)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].CreatedAt.After(result[j].CreatedAt) })
	if options.Limit > 0 && len(result) > options.Limit {
		result = result[:options.Limit]
	}
	return result, nil
}

func (s *MemoryStore) UpdateShardExpansion(_ context.Context, expansion ShardExpansion, expectedVersion int64) (ShardExpansion, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	current, ok := s.shardExpansions[expansion.ID]
	if !ok || current.Version != expectedVersion {
		return ShardExpansion{}, false, nil
	}
	expansion.CreatedAt = current.CreatedAt
	expansion.Version = expectedVersion + 1
	expansion.UpdatedAt = time.Now().UTC()
	s.shardExpansions[expansion.ID] = expansion
	if shardExpansionTerminal(expansion.Status) {
		delete(s.activeShardExpansions, expansion.ShardID)
	} else {
		s.activeShardExpansions[expansion.ShardID] = expansion.ID
	}
	return expansion, true, nil
}

func shardExpansionTerminal(status string) bool {
	return status == ShardExpansionStatusReady || status == ShardExpansionStatusCancelled
}
