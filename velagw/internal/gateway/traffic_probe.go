package gateway

import (
	"context"
	"fmt"
	"strings"
)

const APIKeyPurposeTrafficProbe = "traffic_probe"

type TrafficProbeKeyResult struct {
	Binding APIKeyBinding
	Created bool
}

type DirectTrafficProbeTarget struct {
	UserID      string
	SetID       string
	BaseURL     string
	UpstreamKey string
}

func (s *Service) GetOrCreateTrafficProbeKey(ctx context.Context, externalUserID string) (TrafficProbeKeyResult, error) {
	externalUserID = strings.TrimSpace(externalUserID)
	if externalUserID == "" {
		return TrafficProbeKeyResult{}, fmt.Errorf("user_id is required")
	}
	if binding, ok, err := s.findTrafficProbeKey(ctx, externalUserID); err != nil || ok {
		return TrafficProbeKeyResult{Binding: binding}, err
	}
	userBinding, err := s.EnsureUserBinding(ctx, externalUserID)
	if err != nil {
		return TrafficProbeKeyResult{}, err
	}
	var result TrafficProbeKeyResult
	operation := "traffic-probe-key-" + hashExternalKey(externalUserID)[:24]
	err = s.withSetOperationLease(ctx, userBinding.SetID, operation, 1, func(leaseCtx context.Context) error {
		if binding, ok, findErr := s.findTrafficProbeKey(leaseCtx, externalUserID); findErr != nil {
			return findErr
		} else if ok {
			result.Binding = binding
			return nil
		}
		binding, createErr := s.createExternalKey(leaseCtx, externalUserID, APIKeyPurposeTrafficProbe)
		if createErr != nil {
			return createErr
		}
		result = TrafficProbeKeyResult{Binding: binding, Created: true}
		return nil
	})
	return result, err
}

func (s *Service) findTrafficProbeKey(ctx context.Context, externalUserID string) (APIKeyBinding, bool, error) {
	bindings, err := s.store.ListAPIKeyBindingsByUser(ctx, externalUserID)
	if err != nil {
		return APIKeyBinding{}, false, err
	}
	for _, binding := range bindings {
		if binding.Purpose != APIKeyPurposeTrafficProbe {
			continue
		}
		if strings.TrimSpace(binding.ExternalKey) == "" {
			return APIKeyBinding{}, false, fmt.Errorf("traffic probe key %q has no recoverable external key", binding.ExternalKeyID)
		}
		return binding, true, nil
	}
	return APIKeyBinding{}, false, nil
}

func (s *Service) ResolveDirectTrafficProbeTarget(ctx context.Context, externalKey string) (DirectTrafficProbeTarget, error) {
	externalKey = strings.TrimSpace(externalKey)
	if externalKey == "" {
		return DirectTrafficProbeTarget{}, fmt.Errorf("api_key is required")
	}
	binding, ok, err := s.store.GetAPIKeyBindingByExternalKey(ctx, externalKey)
	if err != nil {
		return DirectTrafficProbeTarget{}, err
	}
	if !ok {
		return DirectTrafficProbeTarget{}, fmt.Errorf("external key not found")
	}
	if strings.TrimSpace(binding.SetID) == "" || strings.TrimSpace(binding.UpstreamKey) == "" {
		return DirectTrafficProbeTarget{}, fmt.Errorf("external key route is incomplete")
	}
	set, ok, err := s.store.GetSet(ctx, binding.SetID)
	if err != nil {
		return DirectTrafficProbeTarget{}, err
	}
	if !ok {
		return DirectTrafficProbeTarget{}, fmt.Errorf("set %q not found", binding.SetID)
	}
	baseURL := strings.TrimRight(strings.TrimSpace(set.TrafficBaseURL), "/")
	if baseURL == "" {
		baseURL = strings.TrimRight(strings.TrimSpace(set.BaseURL), "/")
	}
	if baseURL == "" {
		return DirectTrafficProbeTarget{}, fmt.Errorf("set %q traffic base url is empty", binding.SetID)
	}
	return DirectTrafficProbeTarget{
		UserID:      binding.UserID,
		SetID:       binding.SetID,
		BaseURL:     baseURL,
		UpstreamKey: binding.UpstreamKey,
	}, nil
}
