package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"
)

var ErrAdminCommandConflict = errors.New("admin command idempotency conflict")

const APIKeyPurposeMaxLength = 32

func normalizeAPIKeyPurpose(purpose string) (string, error) {
	purpose = canonicalAPIKeyPurpose(purpose)
	if utf8.RuneCountInString(purpose) > APIKeyPurposeMaxLength {
		return "", fmt.Errorf("api key purpose must be at most %d characters", APIKeyPurposeMaxLength)
	}
	return purpose, nil
}

type createExternalKeyCommandPayload struct {
	ExternalUserID string `json:"user_id"`
	Purpose        string `json:"purpose,omitempty"`
}

type cancelSubscriptionCommandPayload struct {
	ExternalUserID string `json:"user_id"`
}

func (s *Service) CancelSubscriptionManaged(ctx context.Context, externalUserID string) (*AdminCommand, error) {
	externalUserID = strings.TrimSpace(externalUserID)
	if externalUserID == "" {
		return nil, fmt.Errorf("user_id is required")
	}
	set, paused, err := s.boundSetAdminWritesPaused(ctx, externalUserID)
	if err != nil {
		return nil, err
	}
	if !paused {
		return nil, s.CancelSubscription(ctx, externalUserID)
	}
	payload, err := json.Marshal(cancelSubscriptionCommandPayload{ExternalUserID: externalUserID})
	if err != nil {
		return nil, err
	}
	commandID := "cmd-" + randomSecret()
	command, _, err := s.store.EnqueueAdminCommand(ctx, AdminCommand{
		ID:        commandID,
		DedupeKey: fmt.Sprintf("cancel-subscription:%s:%s:%d", set.ID, externalUserID, set.AdminWritesPausedAt.UnixNano()),
		SetID:     set.ID, ExternalUserID: externalUserID, Kind: AdminCommandKindCancelSubscription,
		Payload: string(payload), Status: AdminCommandStatusPending, NextRunAt: s.nowUTC(),
	})
	if err != nil {
		return nil, err
	}
	return &command, nil
}

func (s *Service) ExtendSubscriptionManaged(ctx context.Context, req ExtendSubscriptionRequest) (ExtendSubscriptionResponse, *AdminCommand, error) {
	req.UserID = strings.TrimSpace(req.UserID)
	if req.UserID == "" || req.NewPeriodEnd.IsZero() {
		return ExtendSubscriptionResponse{}, nil, fmt.Errorf("user_id and new_period_end are required")
	}
	set, paused, err := s.boundSetAdminWritesPaused(ctx, req.UserID)
	if err != nil {
		return ExtendSubscriptionResponse{}, nil, err
	}
	if !paused {
		result, err := s.ExtendSubscription(ctx, req)
		return result, nil, err
	}
	payload, err := json.Marshal(req)
	if err != nil {
		return ExtendSubscriptionResponse{}, nil, err
	}
	commandID := "cmd-" + randomSecret()
	command, _, err := s.store.EnqueueAdminCommand(ctx, AdminCommand{
		ID:        commandID,
		DedupeKey: fmt.Sprintf("extend-subscription:%s:%s:%d", set.ID, req.UserID, req.NewPeriodEnd.UTC().UnixNano()),
		SetID:     set.ID, ExternalUserID: req.UserID, Kind: AdminCommandKindExtendSubscription,
		Payload: string(payload), Status: AdminCommandStatusPending, NextRunAt: s.nowUTC(),
	})
	if err != nil {
		return ExtendSubscriptionResponse{}, nil, err
	}
	return ExtendSubscriptionResponse{}, &command, nil
}

// ApplySubscriptionManaged keeps the synchronous behavior outside upgrade
// windows and persists a typed command when the user's admin master is paused.
func (s *Service) ApplySubscriptionManaged(ctx context.Context, req ApplySubscriptionRequest) (Subscription, *AdminCommand, error) {
	req.UserID = strings.TrimSpace(req.UserID)
	req.PlanID = strings.TrimSpace(req.PlanID)
	if req.UserID == "" || req.PlanID == "" {
		return Subscription{}, nil, fmt.Errorf("user_id and plan_id are required")
	}
	plan, err := s.activePlan(ctx, req.PlanID)
	if err != nil {
		return Subscription{}, nil, err
	}
	if _, err := s.resolvePlanTarget(ctx, req, plan); err != nil {
		return Subscription{}, nil, err
	}
	set, paused, err := s.boundSetAdminWritesPaused(ctx, req.UserID)
	if err != nil {
		return Subscription{}, nil, err
	}
	if !paused {
		subscription, err := s.ApplySubscription(ctx, req)
		return subscription, nil, err
	}
	commandID := "cmd-" + randomSecret()
	if strings.TrimSpace(req.IdempotencyKey) == "" {
		req.IdempotencyKey = "llmgateway:" + commandID
	}
	payload, err := json.Marshal(req)
	if err != nil {
		return Subscription{}, nil, err
	}
	command, _, err := s.store.EnqueueAdminCommand(ctx, AdminCommand{
		ID: commandID, DedupeKey: "subscription:" + req.IdempotencyKey,
		SetID: set.ID, ExternalUserID: req.UserID, Kind: AdminCommandKindApplySubscription,
		Payload: string(payload), Status: AdminCommandStatusPending, NextRunAt: s.nowUTC(),
	})
	if err != nil {
		return Subscription{}, nil, err
	}
	if command.Kind != AdminCommandKindApplySubscription || command.Payload != string(payload) {
		return Subscription{}, nil, fmt.Errorf("%w: %s", ErrAdminCommandConflict, req.IdempotencyKey)
	}
	return Subscription{}, &command, nil
}

func (s *Service) CreateExternalKeyManaged(ctx context.Context, externalUserID, purpose string) (APIKeyBinding, *AdminCommand, error) {
	externalUserID = strings.TrimSpace(externalUserID)
	if externalUserID == "" {
		return APIKeyBinding{}, nil, fmt.Errorf("external user id is required")
	}
	purpose, err := normalizeAPIKeyPurpose(purpose)
	if err != nil {
		return APIKeyBinding{}, nil, err
	}
	if err := s.ensureTenantCanWrite(ctx, externalUserID); err != nil {
		return APIKeyBinding{}, nil, err
	}
	if key, ok, err := s.getExternalKeyByPurpose(ctx, externalUserID, purpose); err != nil || ok {
		return key, nil, err
	}
	set, paused, err := s.boundSetAdminWritesPaused(ctx, externalUserID)
	if err != nil {
		return APIKeyBinding{}, nil, err
	}
	if !paused {
		key, err := s.createExternalKey(ctx, externalUserID, purpose)
		return key, nil, err
	}
	commandID := "cmd-" + randomSecret()
	payload, err := json.Marshal(createExternalKeyCommandPayload{ExternalUserID: externalUserID, Purpose: purpose})
	if err != nil {
		return APIKeyBinding{}, nil, err
	}
	command, _, err := s.store.EnqueueAdminCommand(ctx, AdminCommand{
		ID: commandID, DedupeKey: "external-key:" + commandID,
		SetID: set.ID, ExternalUserID: externalUserID, Kind: AdminCommandKindCreateExternalKey,
		Payload: string(payload), Status: AdminCommandStatusPending, NextRunAt: s.nowUTC(),
	})
	if err != nil {
		return APIKeyBinding{}, nil, err
	}
	return APIKeyBinding{}, &command, nil
}

func (s *Service) boundSetAdminWritesPaused(ctx context.Context, externalUserID string) (Set, bool, error) {
	binding, ok, err := s.store.GetUserBinding(ctx, strings.TrimSpace(externalUserID))
	if err != nil || !ok || binding.SetID == "" {
		return Set{}, false, err
	}
	set, ok, err := s.store.GetSet(ctx, binding.SetID)
	if err != nil {
		return Set{}, false, err
	}
	if !ok {
		return Set{}, false, fmt.Errorf("set %q not found", binding.SetID)
	}
	return set, set.AdminWritesPaused, nil
}

func (s *Service) GetAdminCommand(ctx context.Context, id string) (AdminCommand, error) {
	command, ok, err := s.store.GetAdminCommand(ctx, strings.TrimSpace(id))
	if err != nil {
		return AdminCommand{}, err
	}
	if !ok {
		return AdminCommand{}, fmt.Errorf("admin command %q not found", id)
	}
	return command, nil
}

// ProcessAdminCommandOnce claims at most one due command. Paused Sets are
// skipped before claiming so their attempt counters and leases stay quiet.
func (s *Service) ProcessAdminCommandOnce(ctx context.Context, owner string, leaseTTL time.Duration) (bool, error) {
	now := s.nowUTC()
	commands, err := s.store.ListAdminCommands(ctx, AdminCommandListOptions{
		Statuses: []string{AdminCommandStatusPending, AdminCommandStatusError}, Now: now, Limit: 64,
	})
	if err != nil {
		return false, err
	}
	for _, candidate := range commands {
		set, ok, err := s.store.GetSet(ctx, candidate.SetID)
		if err != nil {
			return false, err
		}
		if !ok || set.AdminWritesPaused || set.AdminHealthStatus == SetAdminHealthUnhealthy {
			continue
		}
		command, acquired, err := s.store.TryAcquireAdminCommand(ctx, candidate.ID, owner, leaseTTL, now)
		if err != nil {
			return false, err
		}
		if !acquired {
			continue
		}
		set, ok, err = s.store.GetSet(ctx, command.SetID)
		if err != nil || !ok || set.AdminWritesPaused || set.AdminHealthStatus == SetAdminHealthUnhealthy {
			_, releaseErr := s.store.ReleaseAdminCommand(context.WithoutCancel(ctx), command, s.nowUTC())
			return false, errors.Join(err, releaseErr)
		}
		return true, s.executeAdminCommand(ctx, command)
	}
	return false, nil
}

func (s *Service) executeAdminCommand(ctx context.Context, command AdminCommand) error {
	var result any
	var runErr error
	switch command.Kind {
	case AdminCommandKindApplySubscription:
		var req ApplySubscriptionRequest
		if err := json.Unmarshal([]byte(command.Payload), &req); err != nil {
			runErr = err
			break
		}
		result, runErr = s.ApplySubscription(ctx, req)
	case AdminCommandKindCancelSubscription:
		var req cancelSubscriptionCommandPayload
		if err := json.Unmarshal([]byte(command.Payload), &req); err != nil {
			runErr = err
			break
		}
		runErr = s.CancelSubscription(ctx, req.ExternalUserID)
		result = map[string]string{"status": "ok"}
	case AdminCommandKindExtendSubscription:
		var req ExtendSubscriptionRequest
		if err := json.Unmarshal([]byte(command.Payload), &req); err != nil {
			runErr = err
			break
		}
		result, runErr = s.ExtendSubscription(ctx, req)
	case AdminCommandKindCreateExternalKey:
		var req createExternalKeyCommandPayload
		if err := json.Unmarshal([]byte(command.Payload), &req); err != nil {
			runErr = err
			break
		}
		key, err := s.createExternalKey(ctx, req.ExternalUserID, req.Purpose)
		runErr = err
		if err == nil {
			result = map[string]any{
				"external_key": key.ExternalKey, "external_key_id": key.ExternalKeyID,
				"set_id": key.SetID, "upstream_key_id": key.UpstreamKeyID,
			}
		}
	default:
		runErr = fmt.Errorf("unsupported admin command kind %q", command.Kind)
	}
	now := s.nowUTC()
	if runErr != nil {
		_, completeErr := s.store.CompleteAdminCommand(context.WithoutCancel(ctx), command, AdminCommandStatusUnknown, "", runErr.Error(), time.Time{}, now)
		return errors.Join(runErr, completeErr)
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		_, completeErr := s.store.CompleteAdminCommand(context.WithoutCancel(ctx), command, AdminCommandStatusUnknown, "", err.Error(), time.Time{}, now)
		return errors.Join(err, completeErr)
	}
	_, err = s.store.CompleteAdminCommand(context.WithoutCancel(ctx), command, AdminCommandStatusSucceeded, string(encoded), "", time.Time{}, now)
	return err
}

func (s *Service) RunAdminCommandWorker(ctx context.Context, owner string, pollInterval, leaseTTL time.Duration) error {
	if pollInterval <= 0 {
		pollInterval = time.Second
	}
	if leaseTTL < 15*time.Second {
		leaseTTL = 15 * time.Second
	}
	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()
	for {
		if _, err := s.ProcessAdminCommandOnce(ctx, owner, leaseTTL); err != nil && !errors.Is(err, context.Canceled) {
			// The durable command carries the error; continue serving other Sets.
		}
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}
