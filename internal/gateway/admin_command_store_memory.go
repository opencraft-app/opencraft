package gateway

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"
)

func (s *MemoryStore) EnqueueAdminCommand(_ context.Context, command AdminCommand) (AdminCommand, bool, error) {
	command.ID = strings.TrimSpace(command.ID)
	command.DedupeKey = strings.TrimSpace(command.DedupeKey)
	if command.ID == "" || command.SetID == "" || command.Kind == "" || command.DedupeKey == "" {
		return AdminCommand{}, false, fmt.Errorf("admin command requires id, dedupe_key, set_id and kind")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if id, ok := s.adminCommandDedupe[command.DedupeKey]; ok {
		return s.adminCommands[id], false, nil
	}
	now := time.Now().UTC()
	if command.Status == "" {
		command.Status = AdminCommandStatusPending
	}
	if command.NextRunAt.IsZero() {
		command.NextRunAt = now
	}
	if command.CreatedAt.IsZero() {
		command.CreatedAt = now
	}
	command.UpdatedAt = now
	s.adminCommands[command.ID] = command
	s.adminCommandDedupe[command.DedupeKey] = command.ID
	return command, true, nil
}

func (s *MemoryStore) GetAdminCommand(_ context.Context, id string) (AdminCommand, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	command, ok := s.adminCommands[strings.TrimSpace(id)]
	return command, ok, nil
}

func (s *MemoryStore) ListAdminCommands(_ context.Context, opts AdminCommandListOptions) ([]AdminCommand, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	wanted := map[string]struct{}{}
	for _, status := range opts.Statuses {
		wanted[status] = struct{}{}
	}
	now := opts.Now
	if now.IsZero() {
		now = time.Now().UTC()
	}
	result := make([]AdminCommand, 0)
	for _, command := range s.adminCommands {
		if len(wanted) > 0 {
			if _, ok := wanted[command.Status]; !ok {
				continue
			}
		}
		if !command.NextRunAt.IsZero() && command.NextRunAt.After(now) {
			continue
		}
		result = append(result, command)
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].NextRunAt.Equal(result[j].NextRunAt) {
			return result[i].CreatedAt.Before(result[j].CreatedAt)
		}
		return result[i].NextRunAt.Before(result[j].NextRunAt)
	})
	if opts.Limit > 0 && len(result) > opts.Limit {
		result = result[:opts.Limit]
	}
	return result, nil
}

func (s *MemoryStore) TryAcquireAdminCommand(_ context.Context, id, owner string, ttl time.Duration, now time.Time) (AdminCommand, bool, error) {
	if strings.TrimSpace(owner) == "" || ttl <= 0 {
		return AdminCommand{}, false, fmt.Errorf("admin command lease requires owner and ttl")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	command, ok := s.adminCommands[strings.TrimSpace(id)]
	if !ok {
		return AdminCommand{}, false, nil
	}
	if command.Status == AdminCommandStatusSucceeded || command.Status == AdminCommandStatusUnknown {
		return command, false, nil
	}
	if command.Status == AdminCommandStatusRunning && command.LeaseUntil.After(now) && command.LeaseOwner != owner {
		return command, false, nil
	}
	if !command.NextRunAt.IsZero() && command.NextRunAt.After(now) {
		return command, false, nil
	}
	command.Status = AdminCommandStatusRunning
	command.Attempts++
	command.LeaseOwner = owner
	command.LeaseUntil = now.Add(ttl)
	command.UpdatedAt = now
	s.adminCommands[command.ID] = command
	return command, true, nil
}

func (s *MemoryStore) ReleaseAdminCommand(_ context.Context, command AdminCommand, now time.Time) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	current, ok := s.adminCommands[command.ID]
	if !ok || current.Status != AdminCommandStatusRunning || current.LeaseOwner != command.LeaseOwner {
		return false, nil
	}
	current.Status = AdminCommandStatusPending
	current.LeaseOwner = ""
	current.LeaseUntil = time.Time{}
	current.NextRunAt = now
	current.UpdatedAt = now
	s.adminCommands[current.ID] = current
	return true, nil
}

func (s *MemoryStore) CompleteAdminCommand(_ context.Context, command AdminCommand, status, result, lastError string, nextRunAt, now time.Time) (AdminCommand, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	current, ok := s.adminCommands[command.ID]
	if !ok {
		return AdminCommand{}, fmt.Errorf("admin command %q not found", command.ID)
	}
	if current.Status != AdminCommandStatusRunning || current.LeaseOwner != command.LeaseOwner {
		return current, fmt.Errorf("admin command %q lease lost", command.ID)
	}
	current.Status = status
	current.Result = result
	current.LastError = lastError
	current.NextRunAt = nextRunAt
	current.LeaseOwner = ""
	current.LeaseUntil = time.Time{}
	current.UpdatedAt = now
	s.adminCommands[current.ID] = current
	return current, nil
}
